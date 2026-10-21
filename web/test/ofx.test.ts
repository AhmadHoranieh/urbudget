// The OFX, QFX and QBO to CSV converter (public/assets/ofx.js). Every expected value is written by
// hand from the made-up fixture files in test/fixtures/ofx/ and from the OFX 2.2 specification
// (sections 3.2.8 dates, 3.2.9 amounts, 2.2 and 2.8.2 headers, 11.4.4 STMTTRN), and from RFC 4180
// for the CSV, not taken from running the converter.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  accountLabel,
  csvField,
  csvTable,
  decodeEntities,
  decodeOfx,
  formatDate,
  ofxEncoding,
  parseOfx,
  parseOfxAmount,
  parseOfxDate,
  toCsv,
} from "../public/assets/ofx.js";

const fixtures = join(__dirname, "fixtures", "ofx");
const bytes = (name: string) => new Uint8Array(readFileSync(join(fixtures, name)));
const load = (name: string) => decodeOfx(bytes(name)).text;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = (text: string): any => {
  const result = parseOfx(text);
  if ("error" in result) throw new Error(`${result.error}: ${result.message}`);
  return result;
};
const parse = (name: string) => read(load(name));

const row = (
  date: string,
  amount: string,
  payee: string,
  memo: string,
  type: string,
  checkNumber: string,
  fitId: string,
  accountId: string,
) => ({ date, amount, payee, memo, type, checkNumber, fitId, accountId });

/** A minimal OFX 1.x file around some STMTTRN text, for one checking account 777. */
const sgml = (transactions: string) =>
  [
    "OFXHEADER:100",
    "DATA:OFXSGML",
    "VERSION:102",
    "SECURITY:NONE",
    "ENCODING:USASCII",
    "CHARSET:NONE",
    "COMPRESSION:NONE",
    "OLDFILEUID:NONE",
    "NEWFILEUID:NONE",
    "",
    "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD",
    "<BANKACCTFROM><BANKID>999999999<ACCTID>777<ACCTTYPE>CHECKING</BANKACCTFROM>",
    "<BANKTRANLIST>",
    transactions,
    "</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
  ].join("\n");

// ---------- The fixtures ----------

describe("reading the fixture files", () => {
  it("reads OFX 1.x SGML with unclosed tags, CRLF line endings and windows-1252 text", () => {
    expect(decodeOfx(bytes("bank-sgml.ofx")).encoding).toBe("windows-1252");
    const result = parse("bank-sgml.ofx");
    expect(result.version).toBe(1);
    expect(result.count).toBe(5);
    expect(result.skipped).toEqual([]);
    expect(result.statements).toHaveLength(1);
    const [statement] = result.statements;
    expect(statement).toMatchObject({
      kind: "bank",
      accountId: "1234567890",
      accountType: "CHECKING",
      bankId: "999999999",
      currency: "USD",
    });
    const id = "1234567890";
    expect(statement.transactions).toEqual([
      row("2026-10-01", "-42.17", "CORNER GROCERY #114", "DEBIT CARD PURCHASE", "DEBIT", "", "202610010001", id),
      row("2026-10-02", "-150.00", "CHECK 1043", "", "CHECK", "1043", "202610020001", id),
      row("2026-10-03", "1850.00", "ACME WIDGETS PAYROLL", "PAYROLL OCT 1-15", "DIRECTDEP", "", "202610030001", id),
      row("2026-10-04", "-8.50", "JOE’S CAFÉ", "COFFEE & BAGEL", "POS", "", "202610040001", id),
      row("2026-10-05", "-2.00", "MONTHLY SERVICE FEE", "", "FEE", "", "202610050001", id),
    ]);
    expect(accountLabel(statement)).toBe("Checking 1234567890");
  });

  it("reads OFX 2.x XML: entities, CDATA, a PAYEE aggregate, a decimal comma, and no pending rows", () => {
    expect(decodeOfx(bytes("bank-xml.ofx")).encoding).toBe("utf-8");
    const result = parse("bank-xml.ofx");
    expect(result.version).toBe(2);
    expect(result.statements).toHaveLength(1);
    const [statement] = result.statements;
    expect(statement).toMatchObject({ kind: "bank", accountId: "SAV-000042", accountType: "SAVINGS", currency: "EUR" });
    const id = "SAV-000042";
    expect(statement.transactions).toEqual([
      row("2026-10-06", "-12.34", "Café Olé", "Müller & Söhne", "DEBIT", "", "X-1001", id),
      row("2026-10-07", "-845.00", "Smith & Sons Property", "Rent <October> & parking", "PAYMENT", "", "X-1002", id),
      row("2026-10-09", "0.42", 'Interest <Q4> "bonus" été', "", "INT", "", "X-1003", id),
    ]);
    // The <STMTTRNP> hold for -60.00 is pending (spec 11.4.4.2), so it isn't a row.
    expect(result.count).toBe(3);
    expect(accountLabel(statement)).toBe("Savings SAV-000042");
  });

  it("reads a QFX file with Quicken's INTU tags, with and without end tags", () => {
    const result = parse("quicken.qfx");
    const [statement] = result.statements;
    // The account is BANKACCTFROM's, not the transfer's BANKACCTTO inside the first STMTTRN.
    expect(statement).toMatchObject({ kind: "bank", accountId: "000987654321", accountType: "CHECKING", currency: "USD" });
    const id = "000987654321";
    expect(statement.transactions).toEqual([
      row("2026-10-08", "-250.00", "ONLINE TRANSFER TO SAVINGS", "TRANSFER", "XFER", "", "QFX-20261008-1", id),
      row("2026-10-11", "-60.00", "ATM WITHDRAWAL 5TH & MAIN", "", "ATM", "", "QFX-20261011-1", id),
      row("2026-10-14", "19.99", "REFUND, ONLINE STORE", 'RETURN "BLUE MUG"', "CREDIT", "", "QFX-20261014-1", id),
    ]);
  });

  it("reads a credit card statement and skips the row with an impossible date", () => {
    const result = parse("credit-card.ofx");
    const [statement] = result.statements;
    expect(statement).toMatchObject({ kind: "card", accountId: "XXXXXXXXXXXX9876", currency: "USD" });
    expect(accountLabel(statement)).toBe("Credit card XXXXXXXXXXXX9876");
    const id = "XXXXXXXXXXXX9876";
    expect(statement.transactions).toEqual([
      row("2026-10-02", "-64.99", "STREAMING SERVICE", "", "DEBIT", "", "CC0001", id),
      row("2026-10-12", "500.00", "PAYMENT - THANK YOU", "", "CREDIT", "", "CC0003", id),
      row("2026-10-13", "-1234.56", "AIRLINE TICKET", "REF 7Q2X", "DEBIT", "", "CC0004", id),
    ]);
    // November has 30 days, so 20261131 isn't a date.
    expect(result.skipped).toEqual([{ accountId: id, position: 2, fitId: "CC0002", field: "date", value: "20261131" }]);
    expect(result.count).toBe(3);
  });

  it("reads a file with two accounts, and adds an Account column to the CSV", () => {
    const result = parse("two-accounts.ofx");
    expect(result.statements.map((s: { accountId: string; accountType: string }) => [s.accountId, s.accountType])).toEqual([
      ["11110001", "CHECKING"],
      ["11110002", "SAVINGS"],
    ]);
    expect(result.statements[0].transactions).toEqual([
      row("2026-10-10", "-500.00", "TRANSFER TO 11110002", "", "XFER", "", "T-1", "11110001"),
      row("2026-10-11", "-31.20", "GAS STATION", "", "DEBIT", "", "T-2", "11110001"),
    ]);
    expect(result.statements[1].transactions).toEqual([
      row("2026-10-10", "500.00", "TRANSFER FROM 11110001", "", "XFER", "", "T-1", "11110002"),
    ]);
    expect(toCsv(result)).toBe(
      "Date,Payee,Memo,Amount,Type,Check number,Transaction ID,Account\r\n" +
        "2026-10-10,TRANSFER TO 11110002,,-500.00,XFER,,T-1,11110001\r\n" +
        "2026-10-11,GAS STATION,,-31.20,DEBIT,,T-2,11110001\r\n" +
        "2026-10-10,TRANSFER FROM 11110001,,500.00,XFER,,T-1,11110002\r\n",
    );
  });

  it("reads the same rows whatever the line endings", () => {
    const xml = load("bank-xml.ofx");
    expect(read(xml.replace(/\r?\n/g, "\r\n"))).toEqual(read(xml.replace(/\r\n/g, "\n")));
    // Built here rather than relying on the fixture's own line endings, which depend on the checkout.
    const sgml = load("bank-sgml.ofx").replace(/\r?\n/g, "\r\n");
    expect(read(sgml.replace(/\r\n/g, "\n"))).toEqual(read(sgml));
  });
});

// ---------- Robust reading ----------

describe("reading untidy files", () => {
  it("accepts lower-case tags, extra whitespace, an empty element and a missing </STMTTRN>", () => {
    const messy = [
      "OFXHEADER:100",
      "DATA:OFXSGML",
      "VERSION:102",
      "",
      "<ofx>",
      "<bankmsgsrsv1><stmttrnrs><stmtrs>",
      "  <curdef> usd ",
      "  <bankacctfrom>  <acctid>   42-7   </acctid><accttype>savings</bankacctfrom>",
      "  <banktranlist>",
      "    <stmttrn>",
      "      <trntype>  debit  ",
      "      <dtposted>  20261001  ",
      "      <trnamt>  -5.00  ",
      "      <name>",
      "      <memo>  first  ",
      "      <fitid>a1",
      "    <stmttrn>",
      "      <TRNTYPE>CREDIT</TRNTYPE>",
      "      <DTPOSTED>20261002</DTPOSTED>",
      "      <TRNAMT>3</TRNAMT>",
      "      <NAME>Second</NAME>",
      "      <FITID>a2</FITID>",
      "    </stmttrn>",
      "  </banktranlist>",
      "</stmtrs></stmttrnrs></bankmsgsrsv1></ofx>",
    ].join("\r\n");
    const result = read(messy);
    const [statement] = result.statements;
    expect(statement).toMatchObject({ kind: "bank", accountId: "42-7", accountType: "SAVINGS", currency: "USD" });
    expect(statement.transactions).toEqual([
      row("2026-10-01", "-5.00", "", "first", "DEBIT", "", "a1", "42-7"),
      row("2026-10-02", "3.00", "Second", "", "CREDIT", "", "a2", "42-7"),
    ]);
  });

  it("takes the payee from EXTDNAME when there's no NAME", () => {
    const result = read(sgml("<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261001<TRNAMT>-1.00<FITID>e1<EXTDNAME>A LONGER NAME FROM THE BANK</STMTTRN>"));
    expect(result.statements[0].transactions[0].payee).toBe("A LONGER NAME FROM THE BANK");
  });

  it("decodes the XML entities, &nbsp; and numeric entities, and leaves anything else alone", () => {
    expect(decodeEntities("A &amp; B")).toBe("A & B");
    expect(decodeEntities("&lt;x&gt;")).toBe("<x>");
    expect(decodeEntities("&quot;q&quot; &apos;s")).toBe("\"q\" 's");
    expect(decodeEntities("caf&#233; caf&#xE9; caf&#XE9;")).toBe("café café café");
    expect(decodeEntities("&#x1F600;")).toBe("\u{1F600}");
    expect(decodeEntities("A&nbsp;B")).toBe("A B");
    expect(decodeEntities("AT&T &bogus; &#0; &#xD800; 5 & 6")).toBe("AT&T &bogus; &#0; &#xD800; 5 & 6");
    // In a file: a bare & (common in SGML files) survives, and &amp;lt; decodes only once.
    const result = read(sgml("<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261001<TRNAMT>-1<FITID>n1<NAME>AT&T &amp;lt;1&amp;gt;</STMTTRN>"));
    expect(result.statements[0].transactions[0].payee).toBe("AT&T &lt;1&gt;");
  });
});

// ---------- Dates and amounts ----------

describe("posted dates", () => {
  it("keeps the date part of every form the spec allows (3.2.8.2)", () => {
    expect(parseOfxDate("20261003")).toBe("2026-10-03");
    expect(parseOfxDate("202610031200")).toBe("2026-10-03");
    expect(parseOfxDate("20261003120000")).toBe("2026-10-03");
    expect(parseOfxDate("20261003120000.000")).toBe("2026-10-03");
    expect(parseOfxDate("19961005132200.124[-5:EST]")).toBe("1996-10-05"); // the spec's own example
    expect(parseOfxDate("20261003000000[+5.30:IST]")).toBe("2026-10-03");
    expect(parseOfxDate("  20261003  ")).toBe("2026-10-03");
  });

  it("doesn't move the date by the time zone", () => {
    // 11 p.m. at GMT-12 is the next day in GMT; the bank's date is kept.
    expect(parseOfxDate("20261231230000[-12:XX]")).toBe("2026-12-31");
    expect(parseOfxDate("20261001003000[+14:LINT]")).toBe("2026-10-01");
  });

  it("refuses dates that don't exist or aren't in OFX's format", () => {
    expect(parseOfxDate("20240229")).toBe("2024-02-29");
    expect(parseOfxDate("20000229")).toBe("2000-02-29");
    expect(parseOfxDate("19000229")).toBeNull();
    expect(parseOfxDate("20250229")).toBeNull();
    expect(parseOfxDate("20261131")).toBeNull();
    expect(parseOfxDate("20261301")).toBeNull();
    expect(parseOfxDate("20261000")).toBeNull();
    expect(parseOfxDate("20261003250000")).toBeNull();
    expect(parseOfxDate("2026-10-03")).toBeNull();
    expect(parseOfxDate("10/03/2026")).toBeNull();
    expect(parseOfxDate("20261003 120000")).toBeNull();
    expect(parseOfxDate("202610")).toBeNull();
    expect(parseOfxDate("")).toBeNull();
  });
});

describe("amounts", () => {
  it("reads the spec's format: a sign, a decimal point or comma, no thousands marks (3.2.9.1)", () => {
    expect(parseOfxAmount("-12.5")).toBe("-12.50");
    expect(parseOfxAmount("+1850.00")).toBe("1850.00");
    expect(parseOfxAmount("550")).toBe("550.00");
    expect(parseOfxAmount("550.")).toBe("550.00");
    expect(parseOfxAmount(".5")).toBe("0.50");
    expect(parseOfxAmount("-12,34")).toBe("-12.34");
    expect(parseOfxAmount("-0,99")).toBe("-0.99");
    expect(parseOfxAmount("1234,567")).toBe("1234.567");
    expect(parseOfxAmount("0.125")).toBe("0.125");
    expect(parseOfxAmount("12.500")).toBe("12.50");
    expect(parseOfxAmount("007.10")).toBe("7.10");
    expect(parseOfxAmount("  -3.00  ")).toBe("-3.00");
    expect(parseOfxAmount("-0.00")).toBe("0.00");
  });

  it("reads thousands marks when both marks leave no doubt", () => {
    expect(parseOfxAmount("+1,000.00")).toBe("1000.00");
    expect(parseOfxAmount("-1.000,00")).toBe("-1000.00");
    expect(parseOfxAmount("12,345,678.90")).toBe("12345678.90");
    expect(parseOfxAmount("1,234,567")).toBe("1234567.00");
  });

  it("refuses an amount it would have to guess at, or that isn't one", () => {
    expect(parseOfxAmount("1,000")).toBeNull(); // 1000, or 1.000 with a decimal comma?
    expect(parseOfxAmount("-12,345")).toBeNull();
    expect(parseOfxAmount("1,0000.00")).toBeNull();
    expect(parseOfxAmount("12.34.56")).toBeNull();
    expect(parseOfxAmount("$12.00")).toBeNull();
    expect(parseOfxAmount("(12.00)")).toBeNull();
    expect(parseOfxAmount("1 000")).toBeNull();
    expect(parseOfxAmount("N/A")).toBeNull();
    expect(parseOfxAmount("-")).toBeNull();
    expect(parseOfxAmount(".")).toBeNull();
    expect(parseOfxAmount("")).toBeNull();
  });

  it("skips rows with a bad amount or date and counts them, instead of writing bad data", () => {
    const result = read(
      sgml(
        [
          "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261001<TRNAMT>N/A<FITID>b1<NAME>ONE</STMTTRN>",
          "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261002<TRNAMT>12.34.56<FITID>b2<NAME>TWO</STMTTRN>",
          "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261003<TRNAMT>-1,000<FITID>b3<NAME>THREE</STMTTRN>",
          "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261004<FITID>b4<NAME>FOUR</STMTTRN>",
          "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>2026-10-05<TRNAMT>-1.00<FITID>b5<NAME>FIVE</STMTTRN>",
          "<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261006<TRNAMT>-9.99<FITID>b6<NAME>SIX</STMTTRN>",
        ].join("\n"),
      ),
    );
    expect(result.count).toBe(1);
    expect(result.statements[0].transactions).toEqual([row("2026-10-06", "-9.99", "SIX", "", "DEBIT", "", "b6", "777")]);
    expect(result.skipped).toEqual([
      { accountId: "777", position: 1, fitId: "b1", field: "amount", value: "N/A" },
      { accountId: "777", position: 2, fitId: "b2", field: "amount", value: "12.34.56" },
      { accountId: "777", position: 3, fitId: "b3", field: "amount", value: "-1,000" },
      { accountId: "777", position: 4, fitId: "b4", field: "amount", value: "" },
      { accountId: "777", position: 5, fitId: "b5", field: "date", value: "2026-10-05" },
    ]);
    expect(toCsv(result).split("\r\n")).toHaveLength(3); // the header, one row, and the final line break
  });
});

// ---------- Character sets ----------

describe("character set", () => {
  const header = (lines: string[]) => ["OFXHEADER:100", "DATA:OFXSGML", "VERSION:102", "SECURITY:NONE", ...lines].join("\r\n");

  it("picks windows-1252 for CHARSET:1252 and ISO-8859-1, UTF-8 otherwise", () => {
    expect(ofxEncoding(header(["ENCODING:USASCII", "CHARSET:1252"]))).toBe("windows-1252");
    expect(ofxEncoding(header(["ENCODING:USASCII", "CHARSET:ISO-8859-1"]))).toBe("windows-1252");
    expect(ofxEncoding(header(["encoding:usascii", "charset:1252"]))).toBe("windows-1252");
    expect(ofxEncoding(header(["ENCODING:USASCII", "CHARSET:NONE"]))).toBe("utf-8");
    expect(ofxEncoding(header(["ENCODING:UTF-8", "CHARSET:NONE"]))).toBe("utf-8");
    // CHARSET only applies to USASCII; a UTF-8 file stays UTF-8.
    expect(ofxEncoding(header(["ENCODING:UTF-8", "CHARSET:1252"]))).toBe("utf-8");
    expect(ofxEncoding("")).toBe("utf-8");
  });

  it("reads OFX 2.x's XML declaration", () => {
    const pi = '<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>';
    expect(ofxEncoding(`<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${pi}`)).toBe("utf-8");
    expect(ofxEncoding(`<?xml version="1.0" encoding="windows-1252"?>\n${pi}`)).toBe("windows-1252");
    expect(ofxEncoding(`<?xml version='1.0' encoding='ISO-8859-1'?>\n${pi}`)).toBe("windows-1252");
    expect(ofxEncoding(`<?xml version="1.0"?>\n${pi}`)).toBe("utf-8");
  });

  it("decodes the bytes in the character set the header names", () => {
    // bank-sgml.ofx holds the bytes 0x92 (’) and 0xC9 (É) of windows-1252.
    const sgmlFile = decodeOfx(bytes("bank-sgml.ofx"));
    expect(sgmlFile).toMatchObject({ encoding: "windows-1252" });
    expect(sgmlFile.text).toContain("<NAME>JOE’S CAFÉ");
    expect(decodeOfx(bytes("bank-xml.ofx")).text).toContain("<NAME>Café Olé</NAME>");
  });

  it("reads UTF-8 bytes as UTF-8 even when the header says 1252, and bad UTF-8 as 1252", () => {
    const head = header(["ENCODING:USASCII", "CHARSET:1252", "", "<OFX><NAME>"]);
    const utf8 = new TextEncoder().encode(`${head}Crème brûlée</OFX>`);
    expect(decodeOfx(utf8)).toEqual({ text: `${head}Crème brûlée</OFX>`, encoding: "utf-8" });

    const none = header(["ENCODING:USASCII", "CHARSET:NONE", "", "<OFX><NAME>CAF"]);
    const latin = new Uint8Array([...new TextEncoder().encode(none), 0xc9, 0x3c]); // "CAFÉ<"
    expect(decodeOfx(latin)).toEqual({ text: `${none}É<`, encoding: "windows-1252" });

    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("OFXHEADER:100\n<OFX>é")]);
    expect(decodeOfx(bom)).toEqual({ text: "OFXHEADER:100\n<OFX>é", encoding: "utf-8" });
  });
});

// ---------- CSV ----------

describe("CSV", () => {
  it("quotes fields with commas, quotes or line breaks and doubles inner quotes (RFC 4180)", () => {
    expect(csvField("plain text")).toBe("plain text");
    expect(csvField("Smith, Jones")).toBe('"Smith, Jones"');
    expect(csvField('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvField("line one\nline two")).toBe('"line one\nline two"');
    expect(csvField("cr\rlf")).toBe('"cr\rlf"');
    expect(csvField("  padded  ")).toBe("  padded  ");
    expect(csvField("")).toBe("");
  });

  it("writes CRLF after every record and keeps line breaks inside quoted fields", () => {
    const result = {
      version: 1,
      count: 2,
      skipped: [],
      statements: [
        {
          kind: "bank",
          accountId: "1",
          accountType: "CHECKING",
          bankId: "",
          currency: "USD",
          transactions: [
            row("2026-10-01", "-5.00", "Smith, Jones & Co", 'He said "hi"', "DEBIT", "", "a", "1"),
            row("2026-10-02", "7.25", "Line one\nLine two", "CR\r\nLF", "CREDIT", "", "b", "1"),
          ],
        },
      ],
    };
    expect(toCsv(result)).toBe(
      "Date,Payee,Memo,Amount,Type,Check number,Transaction ID\r\n" +
        '2026-10-01,"Smith, Jones & Co","He said ""hi""",-5.00,DEBIT,,a\r\n' +
        '2026-10-02,"Line one\nLine two","CR\r\nLF",7.25,CREDIT,,b\r\n',
    );
  });

  it("writes the QFX fixture with its comma and quotes quoted", () => {
    expect(toCsv(parse("quicken.qfx"))).toBe(
      "Date,Payee,Memo,Amount,Type,Check number,Transaction ID\r\n" +
        "2026-10-08,ONLINE TRANSFER TO SAVINGS,TRANSFER,-250.00,XFER,,QFX-20261008-1\r\n" +
        "2026-10-11,ATM WITHDRAWAL 5TH & MAIN,,-60.00,ATM,,QFX-20261011-1\r\n" +
        '2026-10-14,"REFUND, ONLINE STORE","RETURN ""BLUE MUG""",19.99,CREDIT,,QFX-20261014-1\r\n',
    );
  });

  it("starts with a UTF-8 byte order mark only when asked", () => {
    const result = parse("bank-sgml.ofx");
    const plain = toCsv(result);
    const marked = toCsv(result, { bom: true });
    expect(plain.startsWith("Date,")).toBe(true);
    expect(marked).toBe(`﻿${plain}`);
    expect([...new TextEncoder().encode(marked).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    // Saved as UTF-8 (as a Blob saves a string), É is the two bytes C3 89.
    const encoded = [...new TextEncoder().encode(marked)];
    const at = encoded.indexOf(0xc3);
    expect(encoded.slice(at, at + 2)).toEqual([0xc3, 0x89]);
  });

  it("writes each date format", () => {
    expect(formatDate("2026-10-03")).toBe("2026-10-03");
    expect(formatDate("2026-10-03", "mdy")).toBe("10/03/2026");
    expect(formatDate("2026-10-03", "dmy")).toBe("03/10/2026");
    const result = parse("bank-sgml.ofx");
    const firstDates = (format: string) =>
      toCsv(result, { dateFormat: format })
        .split("\r\n")
        .slice(1, 3)
        .map((line) => line.split(",")[0]);
    expect(firstDates("ymd")).toEqual(["2026-10-01", "2026-10-02"]);
    expect(firstDates("mdy")).toEqual(["10/01/2026", "10/02/2026"]);
    expect(firstDates("dmy")).toEqual(["01/10/2026", "02/10/2026"]);
  });

  it("splits amounts into Outflow and Inflow, both positive", () => {
    expect(toCsv(parse("bank-sgml.ofx"), { amounts: "split" })).toBe(
      "Date,Payee,Memo,Outflow,Inflow,Type,Check number,Transaction ID\r\n" +
        "2026-10-01,CORNER GROCERY #114,DEBIT CARD PURCHASE,42.17,,DEBIT,,202610010001\r\n" +
        "2026-10-02,CHECK 1043,,150.00,,CHECK,1043,202610020001\r\n" +
        "2026-10-03,ACME WIDGETS PAYROLL,PAYROLL OCT 1-15,,1850.00,DIRECTDEP,,202610030001\r\n" +
        "2026-10-04,JOE’S CAFÉ,COFFEE & BAGEL,8.50,,POS,,202610040001\r\n" +
        "2026-10-05,MONTHLY SERVICE FEE,,2.00,,FEE,,202610050001\r\n",
    );
    const { header, rows } = csvTable(parse("two-accounts.ofx"), { amounts: "split", dateFormat: "mdy" });
    expect(header).toEqual(["Date", "Payee", "Memo", "Outflow", "Inflow", "Type", "Check number", "Transaction ID", "Account"]);
    expect(rows[2]).toEqual(["10/10/2026", "TRANSFER FROM 11110001", "", "", "500.00", "XFER", "", "T-1", "11110002"]);
  });

  it("writes the XML fixture's entities and CDATA as plain text", () => {
    const lines = toCsv(parse("bank-xml.ofx")).split("\r\n");
    expect(lines[1]).toBe("2026-10-06,Café Olé,Müller & Söhne,-12.34,DEBIT,,X-1001");
    expect(lines[2]).toBe("2026-10-07,Smith & Sons Property,Rent <October> & parking,-845.00,PAYMENT,,X-1002");
    expect(lines[3]).toBe('2026-10-09,"Interest <Q4> ""bonus"" été",,0.42,INT,,X-1003');
  });
});

// ---------- Files it can't convert ----------

describe("files it can't convert", () => {
  it("says when an OFX file has no transactions", () => {
    expect(parseOfx(load("no-transactions.ofx"))).toMatchObject({ error: "no-transactions" });
    const pendingOnly = load("bank-xml.ofx").replace(/<BANKTRANLIST>[\s\S]*<\/BANKTRANLIST>/, "");
    const result = parseOfx(pendingOnly);
    expect(result).toMatchObject({ error: "no-transactions" });
    expect("message" in result && result.message).toMatch(/pending/);
  });

  it("says when a file isn't OFX at all", () => {
    const csv = "Date,Description,Amount\r\n10/01/2026,CORNER GROCERY,-42.17\r\n";
    const qif = "!Type:Bank\nD10/01/2026\nT-42.17\nPCORNER GROCERY\n^\n";
    const html = "<!DOCTYPE html><html><head><title>Sign in</title></head><body></body></html>";
    for (const text of [csv, qif, html, "%PDF-1.7", "", "just some text"]) {
      expect(parseOfx(text)).toMatchObject({ error: "not-ofx" });
    }
    expect(parseOfx(qif)).toMatchObject({ message: expect.stringContaining("QIF") });
    expect(parseOfx(csv)).toMatchObject({ message: expect.stringContaining("CSV") });
  });

  it("says when no transaction could be read", () => {
    const result = parseOfx(sgml("<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>yesterday<TRNAMT>-1.00<FITID>u1</STMTTRN>"));
    expect(result).toMatchObject({
      error: "unreadable",
      skipped: [{ accountId: "777", position: 1, fitId: "u1", field: "date", value: "yesterday" }],
    });
  });

  it("doesn't read investment statements as bank transactions", () => {
    const investment = [
      "OFXHEADER:100",
      "",
      "<OFX><INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><CURDEF>USD",
      "<INVACCTFROM><BROKERID>example.com<ACCTID>9</INVACCTFROM>",
      "<INVTRANLIST><INVBANKTRAN><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261001<TRNAMT>10<FITID>i1</STMTTRN>",
      "<SUBACCTFUND>CASH</INVBANKTRAN></INVTRANLIST></INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1></OFX>",
    ].join("\n");
    expect(parseOfx(investment)).toMatchObject({ error: "investment" });
  });
});
