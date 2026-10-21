// The OFX, QFX and QBO to CSV converter on /tools/ofx-to-csv/. It reads a bank's statement file in
// the browser and writes its transactions as CSV. Nothing is uploaded: the page reads the file with
// the File API, and nothing in this script makes a network request.
//
// It follows the OFX 2.2 specification (published by the Financial Data Exchange):
//   2.2, 2.8.2  OFX 1.x starts with KEY:VALUE header lines (OFXHEADER:100, ENCODING, CHARSET) before
//               <OFX>; OFX 2.x starts with <?xml ...?> and <?OFX OFXHEADER="200" ...?>.
//   2.3.1.1     Special characters are entities (&lt; &gt; &amp;) or CDATA sections.
//   2.8         OFX 1.x (SGML) may leave elements without end tags; 2.x closes every tag.
//   2.4.2       Tag names are upper case (lower case is read here anyway).
//   3.2.8       Dates are YYYYMMDD, optionally with HHMMSS, .XXX and [gmt offset:tz name].
//   3.2.9.1     Amounts have a leading sign (+ may be left out), a decimal point or comma, and no
//               thousands punctuation.
//   11.4.4      Each posted transaction is a <STMTTRN>, signed from the customer's side (money out is
//               negative). Pending ones, <STMTTRNP>, aren't final and are left out.
// QFX (Quicken) and QBO (QuickBooks) are OFX with Intuit's extra tags, such as <INTU.BID>; those are
// ignored like everything else the CSV doesn't need.
//
// UrBudget's own importer (desktop/src-tauri/src/bank_import.rs) reads the same STMTTRN fields; this
// is a separate implementation for the browser.
//
// The page provides #ofx-form with #ofx-file (disabled in the HTML), #ofx-date, the "amounts"
// radios and #ofx-bom, a [data-drop] area around the file input, #ofx-status (aria-live) and
// #ofx-result, which holds #ofx-accounts, #ofx-preview-caption, the #ofx-preview table and a
// [data-download] button. Without JavaScript the file input stays disabled and the page explains why.

/** Files larger than this are refused before they're read: bank statement files are far smaller. */
export const MAX_BYTES = 50 * 1024 * 1024;
/** Rows shown in the preview table. */
export const PREVIEW_ROWS = 20;

// ---------- Character sets ----------

const LATIN = /^(?:1252|(?:windows|cp|ms|x-cp)-?1252|iso[-_ ]?8859-1|8859-1|latin-?1|l1)$/i;

/**
 * The TextDecoder label for an OFX file, from its header (the text before <OFX>). OFX 2.x names its
 * character set in the XML declaration (encoding="UTF-8"). OFX 1.x has ENCODING:USASCII or
 * ENCODING:UTF-8 and, with USASCII, CHARSET:1252, CHARSET:ISO-8859-1 or CHARSET:NONE.
 * Returns "windows-1252" for 1252 or ISO-8859-1 (browsers decode both as windows-1252) and
 * "utf-8" for everything else, plain ASCII included.
 */
export function ofxEncoding(header) {
  const text = String(header ?? "");
  const xml = /<\?xml\b[^>]*?\bencoding\s*=\s*["']\s*([^"'\s]+)/i.exec(text);
  if (xml) return LATIN.test(xml[1]) ? "windows-1252" : "utf-8";
  const encoding = /\bENCODING\s*:\s*([^\s<]*)/i.exec(text)?.[1] ?? "";
  if (/^(?:UTF-?8|UNICODE)$/i.test(encoding)) return "utf-8";
  const charset = /\bCHARSET\s*:\s*([^\s<]*)/i.exec(text)?.[1] ?? "";
  return LATIN.test(charset) ? "windows-1252" : "utf-8";
}

// Windows-1252's characters for the bytes 0x80 to 0x9F. Browsers' TextDecoder("windows-1252")
// already decodes them this way; some other runtimes give ISO-8859-1's control codes instead, so
// they're mapped again. 0x81, 0x8D, 0x8F, 0x90 and 0x9D have no character and stay as they are.
const CP1252_HIGH =
  "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f" +
  "\u0090‘’“”•–—˜™š›œ\u009džŸ";

function decode1252(bytes) {
  return new TextDecoder("windows-1252")
    .decode(bytes)
    .replace(/[\u0080-\u009f]/g, (c) => CP1252_HIGH[c.charCodeAt(0) - 0x80]);
}

function strictUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The text before the <OFX> tag, where both header styles live. */
function headerOf(text) {
  const start = text.search(/<OFX[\s>]/i);
  return start >= 0 ? text.slice(0, start) : text.slice(0, 2048);
}

/**
 * Reads an OFX file's bytes as text, in the character set its header names (ofxEncoding).
 * Two common slips are caught: a file whose header says 1252 but whose bytes are valid UTF-8 with
 * accented letters is read as UTF-8, and a file that says UTF-8 (or nothing) but isn't valid
 * UTF-8 is read as windows-1252. Returns { text, encoding }, encoding being the label used.
 */
export function decodeOfx(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8" };
  }
  const declared = ofxEncoding(headerOf(decode1252(bytes.subarray(0, 4096))));
  const utf8 = strictUtf8(bytes);
  if (declared === "utf-8") {
    return utf8 === null ? { text: decode1252(bytes), encoding: "windows-1252" } : { text: utf8, encoding: "utf-8" };
  }
  let ascii = true;
  for (let i = 0; i < bytes.length && ascii; i++) ascii = bytes[i] < 0x80;
  if (utf8 !== null && !ascii) return { text: utf8, encoding: "utf-8" };
  return { text: decode1252(bytes), encoding: "windows-1252" };
}

// ---------- Values ----------

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * Decodes &amp; &lt; &gt; &quot; &apos;, &nbsp; (as a plain space) and numeric entities such as
 * &#233; and &#xE9;. Anything else, a bare & included, is left as it is.
 */
export function decodeEntities(text) {
  return String(text ?? "").replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]+);/g, (whole, name) => {
    if (name[0] !== "#") return NAMED[name.toLowerCase()] ?? whole;
    const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
    return valid ? String.fromCodePoint(code) : whole;
  });
}

const daysIn = (year, month) =>
  month === 2
    ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      ? 29
      : 28
    : [4, 6, 9, 11].includes(month)
      ? 30
      : 31;

/**
 * DTPOSTED → "YYYY-MM-DD", or null when it isn't a real date in OFX's format: YYYYMMDD, optionally
 * followed by a time (HH, HHMM or HHMMSS), a fraction such as .000 and a time zone such as
 * [-5:EST]. Only the date is kept, as the bank wrote it; it isn't moved by the time zone.
 */
export function parseOfxDate(text) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(?:(\d{2})(?:(\d{2})(?:\.\d+)?)?)?)?\s*(?:\[[^\]]*\])?$/.exec(
    String(text ?? "").trim(),
  );
  if (!m) return null;
  const [, y, mo, d, hh = "0", mm = "0", ss = "0"] = m;
  const [year, month, day] = [Number(y), Number(mo), Number(d)];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null;
  if (Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 60) return null;
  return `${y}-${mo}-${d}`;
}

/**
 * TRNAMT → a plain decimal string ("-12.50", "1850.00"), or null when it isn't an amount.
 * OFX amounts have an optional sign, digits and a decimal point or comma; with no decimal mark the
 * amount is whole ("550" is 550.00, and so is "550."). The spec allows no thousands punctuation, but
 * some banks add it, so "1,000.00" and "1.000,00" are read too: with both marks there's no doubt.
 * "1,000" could be 1000 or 1.000, so it's refused rather than guessed. At least two decimals are
 * written; more are kept when the file has them ("0.125").
 */
export function parseOfxAmount(text) {
  const s = String(text ?? "").trim();
  const negative = s[0] === "-";
  const body = s[0] === "-" || s[0] === "+" ? s.slice(1) : s;
  let whole;
  let fraction = "";
  let m;
  if ((m = /^(\d*)\.(\d*)$/.exec(body)) || /^\d+$/.test(body)) {
    [whole, fraction = ""] = m ? [m[1], m[2]] : [body];
  } else if ((m = /^(\d*),(\d*)$/.exec(body))) {
    if (/^[1-9]\d{0,2},\d{3}$/.test(body)) return null;
    [whole, fraction] = [m[1], m[2]];
  } else if (/^[1-9]\d{0,2}(?:,\d{3}){2,}$/.test(body) || /^[1-9]\d{0,2}(?:\.\d{3}){2,}$/.test(body)) {
    whole = body.replace(/[.,]/g, "");
  } else if ((m = /^([1-9]\d{0,2}(?:,\d{3})+)\.(\d*)$/.exec(body) || /^([1-9]\d{0,2}(?:\.\d{3})+),(\d*)$/.exec(body))) {
    [whole, fraction] = [m[1].replace(/[.,]/g, ""), m[2]];
  } else {
    return null;
  }
  if (!whole && !fraction) return null;
  whole = whole.replace(/^0+(?=\d)/, "") || "0";
  fraction = fraction.replace(/0+$/, "").padEnd(2, "0");
  const zero = /^0+$/.test(whole + fraction);
  return `${negative && !zero ? "-" : ""}${whole}.${fraction}`;
}

// ---------- Reading the file ----------

/**
 * Builds a tree of { name, value, children } from OFX 1.x SGML or 2.x XML. An element followed by
 * text is a leaf with that text as its value (children null), whether or not an end tag follows.
 * Anything else is an aggregate, closed by its end tag; an end tag also closes anything left open
 * inside it, and an end tag that matches nothing open is ignored. An element never contains another
 * of the same name in OFX, so opening one closes the open one first (a missing </STMTTRN>).
 */
function parseTree(source) {
  const root = { name: "#root", value: null, children: [] };
  const stack = [root];
  let pieces = [];
  const top = () => stack[stack.length - 1];
  const settle = () => {
    const node = top();
    if (node.fresh) {
      delete node.fresh;
      const value = joinText(pieces);
      if (value !== null) {
        node.value = value;
        node.children = null;
        stack.pop();
      }
    }
    pieces = [];
  };
  const close = (name) => {
    for (let i = stack.length - 1; i > 0; i--) {
      if (stack[i].name === name) {
        stack.length = i;
        return;
      }
    }
  };
  const n = source.length;
  let i = 0;
  while (i < n) {
    const lt = source.indexOf("<", i);
    if (lt < 0) {
      pieces.push({ raw: source.slice(i) });
      break;
    }
    if (lt > i) pieces.push({ raw: source.slice(i, lt) });
    if (source.startsWith("<![CDATA[", lt)) {
      const end = source.indexOf("]]>", lt + 9);
      pieces.push({ raw: source.slice(lt + 9, end < 0 ? n : end), cdata: true });
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    const gt = source.indexOf(">", lt + 1);
    if (gt < 0) break;
    const inner = source.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (inner[0] === "?" || inner[0] === "!") continue; // <?xml ?>, <?OFX ?>, <!DOCTYPE>
    const closing = inner[0] === "/";
    const name = /^[^\s/>]+/.exec(closing ? inner.slice(1).trim() : inner)?.[0].toUpperCase();
    if (!name) continue;
    settle();
    if (closing) {
      close(name);
    } else if (inner.endsWith("/")) {
      top().children.push({ name, value: "", children: null });
    } else {
      close(name);
      const node = { name, value: null, children: [], fresh: true };
      top().children.push(node);
      stack.push(node);
    }
  }
  settle();
  return root;
}

/** The text after a tag: outer whitespace trimmed, entities decoded, CDATA kept as it is. */
function joinText(pieces) {
  if (!pieces.length) return null;
  const parts = pieces.map((p) => ({ ...p }));
  if (!parts[0].cdata) parts[0].raw = parts[0].raw.replace(/^\s+/, "");
  const last = parts[parts.length - 1];
  if (!last.cdata) last.raw = last.raw.replace(/\s+$/, "");
  const value = parts.map((p) => (p.cdata ? p.raw : decodeEntities(p.raw))).join("");
  return value === "" && !parts.some((p) => p.cdata) ? null : value;
}

/** The nearest element named `name` under `node`, not looking inside `skip` elements. */
function find(node, name, skip) {
  const queue = [...(node.children ?? [])];
  for (let k = 0; k < queue.length; k++) {
    const child = queue[k];
    if (child.name === name) return child;
    if (child.children && child.name !== skip) queue.push(...child.children);
  }
  return null;
}

/** The text of the nearest `name` element: "" when it's missing or empty. */
const text = (node, name, skip) => (node ? (find(node, name, skip)?.value ?? "") : "");

function walk(node, visit) {
  for (const child of node.children ?? []) if (child.children && visit(child) !== false) walk(child, visit);
}

const ACCOUNT_TYPES = {
  CHECKING: "Checking",
  SAVINGS: "Savings",
  MONEYMRKT: "Money market",
  CREDITLINE: "Line of credit",
  CD: "CD",
};

/** "Checking 1234567890", "Credit card XXXXXXXXXXXX9876": how the page names a statement's account. */
export function accountLabel(statement) {
  const type = statement.kind === "card" ? "Credit card" : (ACCOUNT_TYPES[statement.accountType] ?? "Account");
  return statement.accountId ? `${type} ${statement.accountId}` : type;
}

function notOfxMessage(source) {
  const start = source.trimStart();
  if (!start) return "This file is empty. Download it again from your bank.";
  if (start.startsWith("%PDF")) {
    return "This is a PDF, not an OFX file. Look for a download in OFX, QFX or Quicken format instead of a statement PDF.";
  }
  if (/^<(?:!doctype\s+html|html)[\s>]/i.test(start)) {
    return "This is a web page, not an OFX file. Sign in to your bank's website and download the file again.";
  }
  if (/^!(?:Type|Account|Option)/i.test(start)) {
    return "This is a QIF file, not OFX, so the converter can't read it. Download OFX, QFX or CSV from your bank if it offers them.";
  }
  const first = start.split(/\r?\n/, 1)[0];
  if (!first.includes("<") && /[,;\t]/.test(first)) return "This looks like a CSV file already, so there's nothing to convert. Open it in your spreadsheet as it is.";
  return "This doesn't look like an OFX, QFX or QBO file. An OFX file starts with OFXHEADER:100, or with <?xml followed by <?OFX.";
}

/**
 * Reads an OFX, QFX or QBO file's text. Returns
 *   { version: 1 | 2, statements, skipped, count }
 * with one statement per account statement in the file:
 *   { kind: "bank" | "card", accountId, accountType, bankId, currency, transactions },
 * each transaction being { date ("YYYY-MM-DD"), amount ("-12.50"), payee, memo, type,
 * checkNumber, fitId, accountId }. Payee is NAME (or PAYEE's NAME), else EXTDNAME.
 * A transaction whose date or amount can't be read is left out and listed in skipped as
 * { accountId, position (1 for the statement's first transaction), fitId, field, value }.
 * On failure returns { error, message }: "not-ofx", "no-transactions", "investment" (an investment
 * statement only) or "unreadable" (no transaction could be read; skipped is included).
 */
export function parseOfx(input) {
  const source = String(input ?? "").replace(/^﻿/, "");
  const header = headerOf(source);
  const start = source.search(/<OFX[\s>]/i);
  if (start < 0 && !/OFXHEADER\s*[:=]/i.test(header)) return { error: "not-ofx", message: notOfxMessage(source) };
  const version = /<\?xml|OFXHEADER\s*=\s*["']?\s*2/i.test(header) ? 2 : 1;
  const root = parseTree(start >= 0 ? source.slice(start) : source);

  const blocks = [];
  const loose = [];
  let investment = 0;
  let pending = 0;
  walk(root, (node) => {
    if (node.name === "STMTRS" || node.name === "CCSTMTRS") {
      const card = node.name === "CCSTMTRS";
      const from = find(node, card ? "CCACCTFROM" : "BANKACCTFROM", "STMTTRN");
      const trns = [];
      walk(node, (inner) => {
        if (inner.name === "STMTTRN") trns.push(inner);
        else if (inner.name === "STMTTRNP") pending++;
        return inner.name !== "STMTTRN" && inner.name !== "STMTTRNP";
      });
      blocks.push({
        kind: card ? "card" : "bank",
        accountId: text(from, "ACCTID"),
        accountType: card ? "" : text(from, "ACCTTYPE").toUpperCase(),
        bankId: card ? "" : text(from, "BANKID"),
        currency: text(node, "CURDEF", "STMTTRN").toUpperCase(),
        trns,
      });
      return false;
    }
    if (node.name === "INVSTMTRS") investment++;
    if (node.name === "STMTTRN") loose.push(node);
    return node.name !== "INVSTMTRS" && node.name !== "STMTTRN";
  });
  // Transactions outside any statement (a damaged file): kept as one statement with no account.
  if (!blocks.length && loose.length) {
    blocks.push({ kind: "bank", accountId: "", accountType: "", bankId: "", currency: "", trns: loose });
  }

  const total = blocks.reduce((sum, b) => sum + b.trns.length, 0);
  if (!total) {
    if (investment && !blocks.length) {
      return {
        error: "investment",
        message: "This file holds an investment account statement. The converter reads bank and credit card statements only.",
      };
    }
    return {
      error: "no-transactions",
      message: pending
        ? "This file has only pending transactions, which aren't final, so there's nothing to convert yet. Download it again once they've posted."
        : "This OFX file has no transactions in it. Download it again from your bank with a date range that has some.",
    };
  }

  const skipped = [];
  const statements = blocks.map(({ trns, ...account }) => {
    const transactions = [];
    trns.forEach((trn, index) => {
      const rawDate = text(trn, "DTPOSTED");
      const rawAmount = text(trn, "TRNAMT");
      const date = parseOfxDate(rawDate);
      const amount = parseOfxAmount(rawAmount);
      const fitId = text(trn, "FITID");
      if (date === null || amount === null) {
        const [field, value] = date === null ? ["date", rawDate] : ["amount", rawAmount];
        skipped.push({ accountId: account.accountId, position: index + 1, fitId, field, value });
        return;
      }
      transactions.push({
        date,
        amount,
        payee: text(trn, "NAME") || text(trn, "EXTDNAME"),
        memo: text(trn, "MEMO"),
        type: text(trn, "TRNTYPE").toUpperCase(),
        checkNumber: text(trn, "CHECKNUM"),
        fitId,
        accountId: account.accountId,
      });
    });
    return { ...account, transactions };
  });
  const count = total - skipped.length;
  if (!count) {
    return {
      error: "unreadable",
      message: `None of the ${total === 1 ? "file's transaction" : `${total} transactions`} could be read: the dates or amounts aren't in OFX's format.`,
      skipped,
    };
  }
  return { version, statements, skipped, count };
}

// ---------- Writing CSV ----------

/** The date formats the CSV can use. */
export const DATE_FORMATS = { ymd: "YYYY-MM-DD", mdy: "MM/DD/YYYY", dmy: "DD/MM/YYYY" };

/** "2026-10-03" → "2026-10-03" (ymd), "10/03/2026" (mdy) or "03/10/2026" (dmy). */
export function formatDate(iso, format = "ymd") {
  const [y, m, d] = iso.split("-");
  if (format === "mdy") return `${m}/${d}/${y}`;
  if (format === "dmy") return `${d}/${m}/${y}`;
  return iso;
}

/** One CSV field, per RFC 4180: quoted when it holds a comma, a double quote or a line break, with inner quotes doubled. */
export function csvField(value) {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const accountKey = (statement) => `${statement.kind}:${statement.accountId}`;

/**
 * The CSV's header and rows, as arrays of strings (the preview shows the same). Columns: Date,
 * Payee, Memo, Amount (or Outflow and Inflow), Type, Check number, Transaction ID, and Account when
 * the rows come from more than one account. Options: dateFormat "ymd" (default), "mdy" or "dmy";
 * amounts "signed" (default: one Amount column, negative for money out) or "split" (Outflow and
 * Inflow, both positive, the other one left empty).
 */
export function csvTable(result, { dateFormat = "ymd", amounts = "signed" } = {}) {
  const used = result.statements.filter((s) => s.transactions.length);
  const withAccount = new Set(used.map(accountKey)).size > 1;
  const split = amounts === "split";
  const header = [
    "Date",
    "Payee",
    "Memo",
    ...(split ? ["Outflow", "Inflow"] : ["Amount"]),
    "Type",
    "Check number",
    "Transaction ID",
    ...(withAccount ? ["Account"] : []),
  ];
  const rows = [];
  used.forEach((statement, index) => {
    const account = statement.accountId || `Account ${index + 1}`;
    for (const t of statement.transactions) {
      const money = !split ? [t.amount] : t.amount.startsWith("-") ? [t.amount.slice(1), ""] : ["", t.amount];
      rows.push([
        formatDate(t.date, dateFormat),
        t.payee,
        t.memo,
        ...money,
        t.type,
        t.checkNumber,
        t.fitId,
        ...(withAccount ? [account] : []),
      ]);
    }
  });
  return { header, rows };
}

/**
 * The CSV file's text: csvTable's header and rows, RFC 4180 quoting, CRLF after every line. With
 * bom, it starts with a byte order mark (U+FEFF), which tells Excel the file is UTF-8.
 */
export function toCsv(result, options = {}) {
  const { header, rows } = csvTable(result, options);
  const lines = [header, ...rows].map((row) => row.map(csvField).join(","));
  return `${options.bom ? "﻿" : ""}${lines.join("\r\n")}\r\n`;
}

// ---------- The page ----------

const plural = (n, word) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
const MONEY_COLUMNS = new Set(["Amount", "Outflow", "Inflow"]);
const WRAP_COLUMNS = new Set(["Payee", "Memo"]);

function init() {
  const form = document.getElementById("ofx-form");
  const input = document.getElementById("ofx-file");
  const status = document.getElementById("ofx-status");
  const output = document.getElementById("ofx-result");
  if (!form || !input || !status || !output) return;
  const list = document.getElementById("ofx-accounts");
  const table = document.getElementById("ofx-preview");
  const caption = document.getElementById("ofx-preview-caption");
  const download = output.querySelector("[data-download]");
  const drop = form.querySelector("[data-drop]");
  let result = null;
  let baseName = "transactions";

  // Disabled in the HTML, so nothing happens with a file until this script runs.
  input.disabled = false;

  const options = () => ({
    dateFormat: document.getElementById("ofx-date")?.value || "ymd",
    amounts: form.querySelector('input[name="amounts"]:checked')?.value || "signed",
    bom: Boolean(document.getElementById("ofx-bom")?.checked),
  });
  const el = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const fail = (message) => {
    result = null;
    output.hidden = true;
    if (download) download.disabled = true;
    status.replaceChildren(el("p", "calc-problem", message));
  };

  const warning = (skipped) => {
    const box = el("div", "ofx-warning");
    const n = skipped.length;
    box.append(
      el(
        "p",
        null,
        `${plural(n, "transaction")} ${n === 1 ? "was" : "were"} left out because ${n === 1 ? "its" : "their"} date or amount couldn't be read. Check ${n === 1 ? "it" : "them"} on your bank's website:`,
      ),
    );
    const items = el("ul");
    for (const s of skipped.slice(0, 10)) {
      const where = s.accountId ? ` in account ${s.accountId}` : "";
      const id = s.fitId ? ` (ID ${s.fitId})` : "";
      const value = s.value ? `"${s.value}"` : "missing";
      items.append(el("li", null, `Transaction ${s.position}${where}${id}: ${s.field} ${value}`));
    }
    if (n > 10) items.append(el("li", null, `and ${plural(n - 10, "more")}`));
    box.append(items);
    return box;
  };

  const render = () => {
    if (!result) return;
    const opts = options();
    list?.replaceChildren(
      ...result.statements.map((statement) => {
        const item = el("li");
        const dates = statement.transactions.map((t) => t.date).sort();
        const facts = [plural(statement.transactions.length, "transaction")];
        const [first, last] = [dates[0], dates[dates.length - 1]];
        if (first) facts.push(first === last ? formatDate(first, opts.dateFormat) : `${formatDate(first, opts.dateFormat)} to ${formatDate(last, opts.dateFormat)}`);
        if (statement.currency) facts.push(statement.currency);
        item.append(el("b", null, accountLabel(statement)), el("span", null, facts.join(" · ")));
        return item;
      }),
    );
    const { header, rows } = csvTable(result, opts);
    const head = el("thead");
    const headRow = el("tr");
    for (const name of header) {
      const th = el("th", MONEY_COLUMNS.has(name) ? "is-num" : WRAP_COLUMNS.has(name) ? "is-wrap" : null, name);
      th.scope = "col";
      headRow.append(th);
    }
    head.append(headRow);
    const body = el("tbody");
    for (const row of rows.slice(0, PREVIEW_ROWS)) {
      const tr = el("tr");
      row.forEach((value, k) => {
        const name = header[k];
        tr.append(el("td", MONEY_COLUMNS.has(name) ? "is-num" : WRAP_COLUMNS.has(name) ? "is-wrap" : null, value));
      });
      body.append(tr);
    }
    table?.replaceChildren(head, body);
    if (caption) {
      caption.textContent =
        rows.length > PREVIEW_ROWS
          ? `Preview: the first ${PREVIEW_ROWS} of ${plural(rows.length, "row")}`
          : `Preview: ${rows.length === 1 ? "the only row" : `all ${plural(rows.length, "row")}`}`;
    }
  };

  const load = async (file) => {
    if (!file) return;
    baseName = file.name.replace(/\.[^.]*$/, "").replace(/[\\/:*?"<>|]+/g, "-").trim() || "transactions";
    if (file.size > MAX_BYTES) {
      return fail(`${file.name} is larger than 50 MB. Bank statement files are much smaller, so check that it's the right file.`);
    }
    status.replaceChildren(el("p", null, `Reading ${file.name}…`));
    let bytes;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      return fail(`${file.name} couldn't be read. Choose it again.`);
    }
    const parsed = parseOfx(decodeOfx(bytes).text);
    if (parsed.error) {
      fail(`${file.name}: ${parsed.message}`);
      if (parsed.skipped?.length) status.append(warning(parsed.skipped));
      return;
    }
    result = parsed;
    output.hidden = false;
    if (download) download.disabled = false;
    render();
    const accounts = result.statements.length;
    const done = el(
      "p",
      "ofx-done",
      `${file.name}: ${plural(result.count, "transaction")}${accounts > 1 ? ` from ${plural(accounts, "account")}` : ""}, ready to download as CSV.`,
    );
    status.replaceChildren(done);
    if (result.skipped.length) status.append(warning(result.skipped));
  };

  form.addEventListener("submit", (event) => event.preventDefault());
  input.addEventListener("change", () => load(input.files?.[0]));
  form.addEventListener("change", (event) => {
    if (event.target !== input) render();
  });
  if (drop) {
    drop.addEventListener("dragover", (event) => {
      event.preventDefault();
      drop.classList.add("is-over");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
    drop.addEventListener("drop", (event) => {
      event.preventDefault();
      drop.classList.remove("is-over");
      load(event.dataTransfer?.files?.[0]);
    });
  }
  download?.addEventListener("click", () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([toCsv(result, options())], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${baseName}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}

if (typeof document !== "undefined") init();
