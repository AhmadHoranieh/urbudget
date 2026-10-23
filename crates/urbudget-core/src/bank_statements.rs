//! Statements in the banks' own exchange formats: ISO 20022 CAMT.053 (XML) and SWIFT MT940, as
//! many European banks offer beside CSV, and which format a file is in, whatever it was chosen as.
use crate::bank_import::{money, BankTransaction};
use chrono::NaiveDate;

/// The format a statement is in, when its content says so: OFX, CAMT.053, MT940 or QIF.
pub fn sniff(content: &str) -> Option<&'static str> {
    let content = content.trim_start_matches('\u{feff}').trim_start();
    let head: String = content.chars().take(4096).collect::<String>().to_ascii_uppercase();
    if head.starts_with("OFXHEADER") || head.contains("<OFX>") {
        return Some("ofx");
    }
    // An account report (camt.052) reads the same way as a statement.
    if ["CAMT.053", "BKTOCSTMRSTMT>", "CAMT.052", "BKTOCSTMRACCTRPT>"].iter().any(|s| head.contains(s)) {
        return Some("camt053");
    }
    let lines = || content.lines().map(str::trim_start).take(400);
    if lines().any(|l| l.starts_with(":20:")) && lines().any(|l| l.starts_with(":61:")) {
        return Some("mt940");
    }
    let first = content.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").to_ascii_lowercase();
    if ["!type:", "!account", "!option:", "!clear:"].iter().any(|p| first.starts_with(p)) {
        return Some("qif");
    }
    None
}

/// An element of an XML document, by its local name (namespace prefixes dropped).
#[derive(Default, Debug)]
struct Node {
    name: String,
    attrs: Vec<(String, String)>,
    text: String,
    children: Vec<Node>,
}
impl Node {
    fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|c| c.name == name)
    }
    fn all<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> + 'a {
        self.children.iter().filter(move |c| c.name == name)
    }
    /// The element at a path of child names.
    fn at(&self, path: &[&str]) -> Option<&Node> {
        path.iter().try_fold(self, |n, name| n.child(name))
    }
    fn text_at(&self, path: &[&str]) -> Option<&str> {
        self.at(path).map(|n| n.text.trim()).filter(|t| !t.is_empty())
    }
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
    /// The text of this element and everything in it.
    fn deep_text(&self) -> String {
        let mut out = self.text.trim().to_string();
        for c in &self.children {
            out.push_str(&c.deep_text());
        }
        out
    }
    /// Every element below with this name, at any depth.
    fn find_all<'a>(&'a self, name: &str, out: &mut Vec<&'a Node>) {
        for c in &self.children {
            if c.name == name {
                out.push(c);
            } else {
                c.find_all(name, out);
            }
        }
    }
}
fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest.find(';').filter(|&e| e <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let c = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .or(entity.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match c {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}
fn local(name: &str) -> String {
    name.rsplit(':').next().unwrap_or(name).to_string()
}
/// A forgiving reader for the XML banks write: elements, attributes, text and CDATA; comments,
/// declarations and processing instructions are passed over, and unclosed elements close at the
/// end.
fn xml(s: &str) -> Result<Node, String> {
    let mut stack = vec![Node::default()];
    let mut rest = s;
    while !rest.is_empty() {
        let Some(lt) = rest.find('<') else {
            stack.last_mut().unwrap().text.push_str(&unescape(rest));
            break;
        };
        stack.last_mut().unwrap().text.push_str(&unescape(&rest[..lt]));
        rest = &rest[lt..];
        if let Some(cdata) = rest.strip_prefix("<![CDATA[") {
            let end = cdata.find("]]>").ok_or("The XML file ends inside a CDATA section.")?;
            stack.last_mut().unwrap().text.push_str(&cdata[..end]);
            rest = &cdata[end + 3..];
            continue;
        }
        if rest.starts_with("<!--") {
            rest = rest.find("-->").map_or("", |e| &rest[e + 3..]);
            continue;
        }
        let gt = rest.find('>').ok_or("The XML file ends inside a tag.")?;
        let inner = &rest[1..gt];
        rest = &rest[gt + 1..];
        if inner.starts_with('?') || inner.starts_with('!') {
            continue;
        }
        if let Some(name) = inner.strip_prefix('/') {
            let name = local(name.trim());
            // Close back to the matching element, tolerating ones never closed.
            if let Some(depth) = stack.iter().rposition(|n| n.name == name).filter(|&d| d > 0) {
                while stack.len() > depth {
                    let node = stack.pop().unwrap();
                    stack.last_mut().unwrap().children.push(node);
                }
            }
            continue;
        }
        let empty = inner.ends_with('/');
        let inner = inner.trim_end_matches('/');
        let (name, mut attrs_text) = inner.split_once(|c: char| c.is_whitespace()).unwrap_or((inner, ""));
        let mut node = Node { name: local(name), ..Node::default() };
        while let Some(eq) = attrs_text.find('=') {
            let key = local(attrs_text[..eq].trim());
            let after = attrs_text[eq + 1..].trim_start();
            let Some(quote) = after.chars().next().filter(|c| *c == '"' || *c == '\'') else { break };
            let Some(close) = after[1..].find(quote) else { break };
            node.attrs.push((key, unescape(&after[1..1 + close])));
            attrs_text = &after[close + 2..];
        }
        if empty {
            stack.last_mut().unwrap().children.push(node);
        } else if stack.len() > 64 {
            // Statements nest a dozen deep; this deep is a file that isn't one.
            return Err("This XML file is nested too deeply to be a bank statement.".into());
        } else {
            stack.push(node);
        }
    }
    while stack.len() > 1 {
        let node = stack.pop().unwrap();
        stack.last_mut().unwrap().children.push(node);
    }
    Ok(stack.pop().unwrap())
}

fn iso_date(s: &str) -> Option<String> {
    let day = s.trim().get(..10)?;
    NaiveDate::parse_from_str(day, "%Y-%m-%d").ok().map(|d| d.format("%Y-%m-%d").to_string())
}
fn tidy(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A CAMT.053 bank-to-customer statement: its first account's booked entries (a pending one is
/// read once booked). An entry that books several payments at once (a batch) becomes one row for
/// each, when their amounts add up to it. The payee is the other party: the creditor of money
/// out, the debtor of money in.
pub(crate) fn camt(content: &str, currency: &str) -> Result<Vec<BankTransaction>, String> {
    let root = xml(content.trim_start_matches('\u{feff}'))?;
    let mut statements = vec![];
    root.find_all("Stmt", &mut statements);
    if statements.is_empty() {
        root.find_all("Rpt", &mut statements);
    }
    let statement = *statements.first().ok_or("This XML file has no CAMT.053 statement in it.")?;
    // Several statements for the one account (a day each) are all its; another account's aren't.
    let account = |s: &Node| s.at(&["Acct", "Id"]).map(Node::deep_text);
    let first = account(statement);
    let mut out = vec![];
    for s in statements.iter().filter(|s| account(s) == first) {
        for entry in s.all("Ntry") {
            let status = entry.text_at(&["Sts", "Cd"]).or(entry.text_at(&["Sts"])).unwrap_or("BOOK");
            if !status.eq_ignore_ascii_case("BOOK") {
                continue;
            }
            let date = entry.text_at(&["BookgDt", "Dt"]).or(entry.text_at(&["BookgDt", "DtTm"]))
                .or(entry.text_at(&["ValDt", "Dt"])).or(entry.text_at(&["ValDt", "DtTm"]))
                .and_then(iso_date).ok_or("A CAMT.053 entry has no booking date.")?;
            let out_of = entry.text_at(&["CdtDbtInd"]).is_some_and(|i| i.eq_ignore_ascii_case("DBIT"));
            // A reversal keeps the parties of what it reverses: a direct debit coming back names its
            // creditor still.
            let reversal = entry.text_at(&["RvslInd"]).is_some_and(|r| r.eq_ignore_ascii_case("true"));
            let other_is_creditor = out_of != reversal;
            let amount = |amt: &Node| -> Result<i64, String> {
                if let Some(code) = amt.attr("Ccy").filter(|c| !c.eq_ignore_ascii_case(currency)) {
                    return Err(format!("The file's amounts are in {code}, but this budget uses {currency}."));
                }
                let n = money(amt.text.trim(), currency)?.abs();
                Ok(if out_of { -n } else { n })
            };
            let total = amount(entry.child("Amt").ok_or("A CAMT.053 entry has no amount.")?)?;
            let details: Vec<&Node> = entry.all("NtryDtls").flat_map(|d| d.all("TxDtls")).collect();
            let party = |tx: &Node| {
                let side = if other_is_creditor { "Cdtr" } else { "Dbtr" };
                let base = tx.at(&["RltdPties", side]);
                base.and_then(|p| p.text_at(&["Nm"]).or(p.text_at(&["Pty", "Nm"])).map(String::from))
                    .or_else(|| tx.text_at(&["RltdPties", if other_is_creditor { "UltmtCdtr" } else { "UltmtDbtr" }, "Nm"]).map(String::from))
            };
            let purpose = |tx: &Node| {
                let lines: Vec<String> = tx.child("RmtInf").map(|r| r.all("Ustrd").map(|u| u.text.clone()).collect()).unwrap_or_default();
                let text = tidy(&lines.join(" "));
                if text.is_empty() { tx.text_at(&["AddtlTxInf"]).map(tidy).unwrap_or_default() } else { text }
            };
            let reference = |n: &Node| {
                [&["AcctSvcrRef"][..], &["Refs", "AcctSvcrRef"], &["NtryRef"]].iter()
                    .filter_map(|p| n.text_at(p)).find(|r| known(r)).unwrap_or("").to_string()
            };
            let general = entry.text_at(&["AddtlNtryInf"]).map(tidy).unwrap_or_default();
            let parts: Option<Vec<i64>> = details.iter()
                .map(|tx| tx.at(&["AmtDtls", "TxAmt", "Amt"]).or(tx.child("Amt")).map(|a| amount(a)).transpose().ok().flatten())
                .collect();
            let split = details.len() > 1 && parts.as_ref().is_some_and(|p| p.iter().sum::<i64>() == total);
            if split {
                for (tx, part) in details.iter().zip(parts.unwrap()) {
                    let (payee, memo) = (party(tx).unwrap_or_default(), purpose(tx));
                    let tx_ref = tx.text_at(&["Refs", "AcctSvcrRef"]).or(tx.text_at(&["Refs", "EndToEndId"])).filter(|r| known(r));
                    let fit = tx_ref.map(|r| format!("{}/{r}", reference(entry))).unwrap_or_default();
                    out.push(row(fit, &date, payee, memo, part, &general));
                }
            } else {
                let tx = details.first().copied();
                let payee = tx.and_then(party).unwrap_or_default();
                let memo = tx.map(purpose).filter(|m| !m.is_empty()).unwrap_or_else(|| general.clone());
                out.push(row(reference(entry), &date, payee, memo, total, &general));
            }
        }
    }
    Ok(out.into_iter().filter(|t| t.amount != 0).collect())
}
/// A reference that tells transactions apart: not a placeholder for none.
fn known(r: &str) -> bool {
    !r.is_empty() && !["NONREF", "NOTPROVIDED", "NONE", "N/A"].contains(&r.to_ascii_uppercase().as_str())
}
/// A transaction with the bank's reference, as an ID with its date and amount: a bank that uses
/// one reference for a mandate or a day's entries doesn't make next month's charge a duplicate.
fn row(fit: String, date: &str, payee: String, memo: String, amount: i64, general: &str) -> BankTransaction {
    let fit = if fit.is_empty() { fit } else { format!("{date}/{amount}/{fit}") };
    let (payee, memo) = if payee.trim().is_empty() {
        let text = if memo.is_empty() { general.to_string() } else { memo };
        (text, String::new())
    } else {
        (tidy(&payee), memo)
    };
    BankTransaction { fit, date: date.to_string(), payee, memo, amount }
}

/// An MT940 statement: every `:61:` line of the first account's statements (a file often holds
/// one for each day), with its `:86:` text. German banks structure that text in `?nn` fields:
/// `?00` the kind of payment, `?20`–`?29` and `?60`–`?63` the purpose (SEPA keys such as `SVWZ+`),
/// `?32`/`?33` the other party's name.
pub(crate) fn mt940(content: &str, currency: &str) -> Result<Vec<BankTransaction>, String> {
    // Fields start with :tag: at the start of a line; their text runs on over the next lines.
    let mut fields: Vec<(String, String)> = vec![];
    for line in content.trim_start_matches('\u{feff}').lines() {
        let line = line.trim_end_matches('\r');
        let trimmed = line.trim_start();
        if trimmed.starts_with('{') || trimmed == "-" || trimmed == "-}" {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix(':') {
            if let Some((tag, value)) = rest.split_once(':').filter(|(t, _)| t.len() <= 3 && t.chars().all(|c| c.is_ascii_alphanumeric())) {
                fields.push((tag.to_ascii_uppercase(), value.to_string()));
                continue;
            }
        }
        if let Some((_, value)) = fields.last_mut() {
            value.push('\n');
            value.push_str(line);
        }
    }
    let mut out = vec![];
    let mut account: Option<String> = None;
    let mut ours = true;
    let mut pending: Option<BankTransaction> = None;
    let flush = |pending: &mut Option<BankTransaction>, out: &mut Vec<BankTransaction>| {
        if let Some(t) = pending.take() {
            if t.amount != 0 {
                out.push(t);
            }
        }
    };
    for (tag, value) in &fields {
        // An :86: belongs to the :61: just before it; one after the closing balance sums the day.
        if tag != "86" {
            flush(&mut pending, &mut out);
        }
        match tag.as_str() {
            "25" => {
                let id = value.trim().to_string();
                ours = account.get_or_insert(id.clone()) == &id;
            }
            "60F" | "60M" => {
                // C or D, the date, then the currency.
                let code: String = value.trim().chars().skip(7).take(3).collect();
                if code.len() == 3 && !code.eq_ignore_ascii_case(currency) {
                    return Err(format!("The file's amounts are in {code}, but this budget uses {currency}."));
                }
            }
            "61" if ours => pending = Some(statement_line(value, currency)?),
            "86" if ours => {
                if let Some(t) = pending.as_mut() {
                    let (payee, memo) = details(value);
                    t.payee = payee;
                    t.memo = memo;
                }
            }
            _ => {}
        }
    }
    flush(&mut pending, &mut out);
    Ok(out)
}
/// A `:61:` line: value date YYMMDD, booking date MMDD, C/D (RC/RD reverse them), a funds code
/// letter, the amount with a decimal comma, then the type and references.
fn statement_line(value: &str, currency: &str) -> Result<BankTransaction, String> {
    let text: String = value.lines().next().unwrap_or("").trim().to_string();
    let bad = || format!("Cannot read the MT940 line ‘:61:{text}’.");
    let value_date = NaiveDate::parse_from_str(text.get(..6).ok_or_else(bad)?, "%y%m%d").map_err(|_| bad())?;
    let mut rest = &text[6..];
    let mut date = value_date;
    if rest.get(..4).is_some_and(|s| s.bytes().all(|b| b.is_ascii_digit())) {
        let (m, d) = (rest[..2].parse::<u32>().map_err(|_| bad())?, rest[2..4].parse::<u32>().map_err(|_| bad())?);
        // The booking date has no year: the value date's, or the next or last one across New Year.
        let year = chrono::Datelike::year(&value_date);
        date = [year, year + 1, year - 1].iter()
            .filter_map(|y| NaiveDate::from_ymd_opt(*y, m, d))
            .min_by_key(|b| (*b - value_date).num_days().abs())
            .ok_or_else(bad)?;
        rest = &rest[4..];
    }
    let (sign, after) = if let Some(r) = rest.strip_prefix("RC") {
        (-1, r)
    } else if let Some(r) = rest.strip_prefix("RD") {
        (1, r)
    } else if let Some(r) = rest.strip_prefix('C') {
        (1, r)
    } else if let Some(r) = rest.strip_prefix('D') {
        (-1, r)
    } else {
        return Err(bad());
    };
    let after = after.strip_prefix(|c: char| c.is_ascii_alphabetic()).unwrap_or(after);
    let number: String = after.chars().take_while(|c| c.is_ascii_digit() || *c == ',' || *c == '.').collect();
    let amount = money(&number.replace('.', ","), currency)?.abs() * sign;
    let reference = after[number.len()..].get(4..).unwrap_or("");
    // The bank's reference after //, else the customer's before it.
    let mut parts = reference.splitn(2, "//");
    let (customer, bank) = (parts.next().unwrap_or("").trim(), parts.next().unwrap_or("").trim());
    let fit = [bank, customer].into_iter().find(|r| known(r)).unwrap_or("").to_string();
    Ok(row(fit, &date.format("%Y-%m-%d").to_string(), String::new(), String::new(), amount, ""))
}
/// The payee and memo in a `:86:` field: numbered subfields (`?nn` in Germany and Austria, `~nn`
/// or `^nn` in Poland), Dutch `/NAME/…/REMI/…` keys, or free text as the payee.
fn details(value: &str) -> (String, String) {
    let joined: String = value.lines().collect();
    // Free text broken over lines: the breaks were spaces.
    let spaced = value.lines().map(str::trim).collect::<Vec<_>>().join(" ");
    let b = joined.as_bytes();
    let digits = |r: std::ops::Range<usize>| b.get(r).is_some_and(|d| d.iter().all(u8::is_ascii_digit));
    let marks = |i: usize| b.get(i).copied().filter(|c| b"?~^<>|".contains(c) && digits(i + 1..i + 3));
    // The subfields start after the transaction code (`105?00…`), or at once (`?00…`).
    let Some(sep) = marks(3).filter(|_| digits(0..3)).or(marks(0)) else {
        return keyed(&joined).unwrap_or_else(|| (tidy(&spaced), String::new()));
    };
    let (mut kind, mut purpose, mut name) = (String::new(), String::new(), String::new());
    for part in joined.split(sep as char).skip(1) {
        let (code, text) = (part.get(..2).unwrap_or(""), part.get(2..).unwrap_or(""));
        match code {
            "00" => kind.push_str(text),
            "20" | "21" | "22" | "23" | "24" | "25" | "26" | "27" | "28" | "29" | "60" | "61" | "62" | "63" => purpose.push_str(text),
            "32" | "33" => name.push_str(text),
            _ => {}
        }
    }
    // SEPA keys in the purpose: the remittance text (SVWZ+) is what people write.
    let memo = purpose.find("SVWZ+").map(|i| &purpose[i + 5..]).map(|s| {
        let end = ["ABWA+", "ABWE+", "IBAN+", "BIC+", "EREF+", "KREF+", "MREF+", "CRED+"].iter()
            .filter_map(|k| s.find(k)).min().unwrap_or(s.len());
        s[..end].to_string()
    }).unwrap_or(purpose);
    let payee = if name.trim().is_empty() { kind } else { name };
    (tidy(&payee), tidy(&memo))
}
/// Dutch banks' `:86:` keys: `/TRTP/SEPA OVERBOEKING/IBAN/…/NAME/J Jansen/REMI/USTD//Factuur 12/`,
/// or ING's `/CNTP/account/BIC/name/city/`.
fn keyed(text: &str) -> Option<(String, String)> {
    const KEYS: [&str; 24] = [
        "TRTP", "IBAN", "BIC", "NAME", "REMI", "EREF", "MARF", "CSID", "ORDP", "BENM", "ULTC", "ULTD", "PURP", "RTRN",
        "ADDR", "CNTP", "ISDT", "PREF", "KREF", "SVCL", "OCMT", "CHGS", "EXCH", "BUSP",
    ];
    let text = text.trim();
    if !text.starts_with('/') {
        return None;
    }
    let mut at: Vec<(usize, usize, &str)> = KEYS.iter()
        .flat_map(|k| text.match_indices(&format!("/{k}/")).map(move |(i, m)| (i, i + m.len(), *k)).collect::<Vec<_>>())
        .collect();
    at.sort();
    if !at.iter().any(|(_, _, k)| ["NAME", "REMI", "TRTP", "CNTP"].contains(k)) {
        return None;
    }
    let value = |key: &str| {
        let i = at.iter().position(|(_, _, k)| *k == key)?;
        let (end, next) = (at[i].1, at.get(i + 1).map_or(text.len(), |n| n.0));
        Some(text.get(end..next.max(end)).unwrap_or("").trim_matches('/').to_string())
    };
    let name = value("NAME").filter(|n| !n.trim().is_empty())
        .or_else(|| value("CNTP").and_then(|c| c.split('/').nth(2).map(String::from)))
        .filter(|n| !n.trim().is_empty())
        .or_else(|| value("TRTP"))
        .unwrap_or_default();
    let remi = value("REMI").unwrap_or_default();
    let remi = remi.strip_prefix("USTD//").or(remi.strip_prefix("USTD/")).unwrap_or(&remi);
    let remi = remi.strip_prefix("STRD/CUR/").or(remi.strip_prefix("STRD/")).unwrap_or(remi);
    Some((tidy(&name), tidy(remi.trim_matches('/'))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_camt053_booked_entries_batches_and_parties() {
        let doc = r#"<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
 <BkToCstmrStmt><Stmt><Id>1</Id>
  <Acct><Id><IBAN>DE00123456780000000000</IBAN></Id><Ccy>EUR</Ccy></Acct>
  <Ntry><Amt Ccy="EUR">64.20</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts>
   <BookgDt><Dt>2026-10-01</Dt></BookgDt><ValDt><Dt>2026-10-01</Dt></ValDt><AcctSvcrRef>REF-1</AcctSvcrRef>
   <NtryDtls><TxDtls><RltdPties><Dbtr><Nm>Max Mustermann</Nm></Dbtr><Cdtr><Nm>Stadtwerke &amp; Co</Nm></Cdtr></RltdPties>
    <RmtInf><Ustrd>Abschlag Strom</Ustrd><Ustrd>Oktober</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
  <Ntry><Amt Ccy="EUR">12.90</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>PDNG</Sts><BookgDt><Dt>2026-10-02</Dt></BookgDt></Ntry>
  <Ntry><Amt Ccy="EUR">300.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><DtTm>2026-10-03T10:00:00</DtTm></BookgDt>
   <AcctSvcrRef>BATCH</AcctSvcrRef>
   <NtryDtls>
    <TxDtls><Refs><EndToEndId>A</EndToEndId></Refs><AmtDtls><TxAmt><Amt Ccy="EUR">100.00</Amt></TxAmt></AmtDtls><RltdPties><Dbtr><Pty><Nm>Anna</Nm></Pty></Dbtr></RltdPties></TxDtls>
    <TxDtls><Refs><EndToEndId>B</EndToEndId></Refs><AmtDtls><TxAmt><Amt Ccy="EUR">200.00</Amt></TxAmt></AmtDtls><RltdPties><Dbtr><Pty><Nm>Ben</Nm></Pty></Dbtr></RltdPties></TxDtls>
   </NtryDtls></Ntry>
 </Stmt></BkToCstmrStmt></Document>"#;
        assert_eq!(sniff(doc), Some("camt053"));
        let rows = camt(doc, "EUR").unwrap();
        let read: Vec<_> = rows.iter().map(|t| (t.date.as_str(), t.payee.as_str(), t.memo.as_str(), t.amount)).collect();
        assert_eq!(read, [
            ("2026-10-01", "Stadtwerke & Co", "Abschlag Strom Oktober", -6420),
            ("2026-10-03", "Anna", "", 10000),
            ("2026-10-03", "Ben", "", 20000),
        ]);
        assert_eq!((rows[0].fit.as_str(), rows[1].fit.as_str()), ("2026-10-01/-6420/REF-1", "2026-10-03/10000/BATCH/A"));
        assert!(camt(&doc.replace("Ccy=\"EUR\">64.20", "Ccy=\"USD\">64.20"), "EUR").err().unwrap().contains("USD"));
    }

    #[test]
    fn reads_mt940_with_german_structured_details_across_days() {
        let sta = ":20:STARTUMS\r\n:25:12345678/0012345678\r\n:28C:00001/001\r\n:60F:C261001EUR1000,00\r\n\
:61:2610011001DR64,20NDDTNONREF//4711\r\n:86:105?00BASISLASTSCHRIFT?20EREF+4711-2026-10?21SVWZ+Abschlag Strom Ok\r\ntober?22MREF+M-1?30BYLADEM1001?31DE00987654320000000011?32Stadtwerke Beispiel?33stadt\r\n\
:62F:C261001EUR935,80\r\n-\r\n:20:STARTUMS\r\n:25:12345678/0012345678\r\n:28C:00002/001\r\n:60F:C261001EUR935,80\r\n\
:61:2612311231CR2450,00NTRFNONREF\r\n:86:Gehalt Dezember Arbeitgeber GmbH\r\n:61:2701020102RD12,90NMSCNONREF\r\n:86:166?00GUTSCHRIFT\r\n:62F:C270102EUR3398,70\r\n-";
        assert_eq!(sniff(sta), Some("mt940"));
        let rows = mt940(sta, "EUR").unwrap();
        let read: Vec<_> = rows.iter().map(|t| (t.date.as_str(), t.payee.as_str(), t.memo.as_str(), t.amount)).collect();
        assert_eq!(read, [
            ("2026-10-01", "Stadtwerke Beispielstadt", "Abschlag Strom Oktober", -6420),
            ("2026-12-31", "Gehalt Dezember Arbeitgeber GmbH", "", 245000),
            ("2027-01-02", "GUTSCHRIFT", "", 1290),
        ]);
        assert_eq!(rows[0].fit, "2026-10-01/-6420/4711");
        // A booking date in January for a value date in December belongs to the next year.
        let wrap = ":20:X\n:25:A\n:60F:C261231EUR0,00\n:61:2612310102D5,00NMSCNONREF\n:86:Fee\n";
        assert_eq!(mt940(wrap, "EUR").unwrap()[0].date, "2027-01-02");
    }

    #[test]
    fn reads_the_details_dutch_and_polish_banks_write() {
        // ING and ABN AMRO: keys and values between slashes.
        let ing = "/TRTP/SEPA OVERBOEKING/IBAN/NL00INGB0001234567/BIC/INGBNL2A/NAME/J. Jansen/REMI/USTD//Huur oktober/EREF/NOTPROVIDED";
        assert_eq!(details(ing), ("J. Jansen".into(), "Huur oktober".into()));
        let rabo = "/ORDP//NAME/Albert Heijn 1234/ADDR/Amsterdam/REMI/STRD/CUR/1234567890/";
        assert_eq!(details(rabo), ("Albert Heijn 1234".into(), "1234567890".into()));
        let cntp = "/CNTP/NL00RABO0123456789/RABONL2U/Stichting Voorbeeld/UTRECHT/REMI/USTD//Gift/";
        assert_eq!(details(cntp), ("Stichting Voorbeeld".into(), "Gift".into()));
        // Polish banks number the subfields after ~ or ^.
        assert_eq!(details("020~00VE02~20Faktura 12/2026~21za paliwo~32ORLEN SA~33Stacja 4"), ("ORLEN SAStacja 4".into(), "Faktura 12/2026za paliwo".into()));
        assert_eq!(details("^00PRZELEW^20Czynsz^32Spółdzielnia"), ("Spółdzielnia".into(), "Czynsz".into()));
        // Free text, slashes and all.
        assert_eq!(details("BEA   NR:1234   01.10.26/12.34 ALBERT HEIJN"), ("BEA NR:1234 01.10.26/12.34 ALBERT HEIJN".into(), String::new()));
    }

    #[test]
    fn sniffs_formats_and_reads_forgiving_xml() {
        assert_eq!(sniff("OFXHEADER:100\nDATA:OFXSGML"), Some("ofx"));
        assert_eq!(sniff("\u{feff}  !Type:Bank\nD10/14/2026"), Some("qif"));
        assert_eq!(sniff("Date,Payee,Amount\n2026-10-14,Shop,-1.00"), None);
        let n = xml("<a x='1'><b>one &lt;two&gt; &#x20AC;</b><c/><d><e>unclosed</d><![CDATA[<raw>]]></a>").unwrap();
        let a = n.child("a").unwrap();
        assert_eq!((a.attr("x"), a.text_at(&["b"])), (Some("1"), Some("one <two> €")));
        assert_eq!(a.text_at(&["d", "e"]), Some("unclosed"));
        assert!(a.text.contains("<raw>"));
    }
}
