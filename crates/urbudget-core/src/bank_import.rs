use crate::{domain::*, ledger, workflows};
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{hash_map::DefaultHasher, BTreeMap, HashMap, HashSet};
use std::hash::{Hash, Hasher};
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub transaction_id: String,
    pub split_index: usize,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: String,
    pub date: String,
    pub payee: String,
    pub memo: String,
    pub amount: i64,
    #[serde(default)]
    pub duplicate: bool,
    #[serde(default)]
    pub candidates: Vec<String>,
    /// These account sides already have a bank identity. They may match another source,
    /// but only after an explicit choice, since a different receipt can have the same amount.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub previously_matched_candidates: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidate_details: Vec<Candidate>,
    /// Without a bank ID, identical rows in separate files cannot be distinguished for sure.
    #[serde(default)]
    pub idless: bool,
    /// An older import used an identity without the memo. Ask rather than discard or duplicate it.
    #[serde(default)]
    pub possible_duplicate: bool,
    /// Identity shared by indistinguishable ID-less rows, independent of their file position.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    /// Explicitly import another identical ID-less row. The window keeps this ID across retries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import_id: Option<String>,
    /// The payee a rule gives the row, when it differs from the bank's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rename: Option<String>,
    /// The category the payee rules give it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    /// When the bank says it happened (RFC 3339), for bank sync: imported, it's when the
    /// transaction was added. A file gives no time; its rows are added when they're imported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub row: Row,
    pub action: String,
    pub match_id: Option<String>,
}
/// A lossless pool of matching choices for native clients. Large statements commonly have
/// hundreds of rows sharing thousands of candidates; repeating those arrays exhausts a
/// phone's JSON heap before the first review row can render.
#[derive(Debug, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct CandidateSet {
    pub candidates: Vec<String>,
    pub previously_matched_candidates: Vec<String>,
    pub candidate_details: Vec<Candidate>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactRow {
    #[serde(flatten)]
    pub row: Row,
    pub candidate_set: usize,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactReview {
    pub items: Vec<CompactRow>,
    pub candidate_sets: Vec<CandidateSet>,
}
/// Currency signs banks write beside amounts. A sign such as "$" stands for several
/// currencies, so only a written code ("USD") is checked against the budget's.
const SIGNS: [&str; 15] = [
    "$", "€", "£", "¥", "₹", "₩", "₪", "₺", "₽", "₱", "฿", "₫", "₴", "ر.س", "د.إ",
];
/// A three-letter currency code at the start or end of an amount, and the amount without it.
fn code(t: &str) -> Option<(&str, &str)> {
    let is_code = |c: &str| c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase());
    let letter = |c: char| c.is_ascii_alphabetic();
    if let (Some(c), Some(rest)) = (t.get(..3), t.get(3..)) {
        if is_code(c) && !rest.starts_with(letter) {
            return Some((c, rest));
        }
    }
    let (rest, c) = t.split_at_checked(t.len().checked_sub(3)?)?;
    (is_code(c) && !rest.ends_with(letter)).then_some((c, rest))
}
/// An amount in cents: "1,234.56", "1.234,56", "1 234,56", "(12.34)", "12.34-", "$12.34" or
/// "12.34 USD". One that could be read two ways, such as "1.234", is refused, never guessed.
fn money(s: &str, currency: &str) -> Result<i64, String> {
    let bad = || format!("Invalid amount: {}", s.trim());
    let mut t = s.trim();
    let mut negative = false;
    if let Some(inner) = t.strip_prefix('(').and_then(|t| t.strip_suffix(')')) {
        negative = true;
        t = inner;
    }
    // Peel minus and plus signs, currency signs and codes off both ends.
    loop {
        let before = t;
        t = t.trim();
        if let Some(rest) = t.strip_prefix(['-', '−']).or(t.strip_suffix(['-', '−'])) {
            negative = true;
            t = rest;
        }
        t = t.strip_prefix('+').unwrap_or(t);
        for sign in SIGNS {
            t = t.strip_prefix(sign).or(t.strip_suffix(sign)).unwrap_or(t);
        }
        // "US$", "C$", "R$": a dollar sign with its country's letters.
        let letters = t.bytes().take_while(u8::is_ascii_uppercase).count();
        if (1..=3).contains(&letters) && t[letters..].starts_with('$') {
            t = &t[letters + 1..];
        }
        if let Some((c, rest)) = code(t) {
            if c != currency {
                return Err(format!(
                    "The amount ‘{}’ is in {c}, but this budget uses {currency}.",
                    s.trim()
                ));
            }
            t = rest;
        }
        if t == before {
            break;
        }
    }
    // The last dot or comma marks the cents, unless only grouping fits: "1,234" and
    // "1.234.567" have none. A single dot before three digits could be either.
    let (whole, frac, point) = match t.rfind(['.', ',']) {
        None => (t, "", None),
        Some(i) => {
            let mark = &t[i..i + 1];
            let other = if mark == "." { "," } else { "." };
            let (left, right) = (&t[..i], &t[i + 1..]);
            if left.contains(other) || !left.contains(mark) && right.len() != 3 {
                (left, right, Some(mark))
            } else if mark == "," || left.contains(mark) {
                (t, "", None)
            } else {
                return Err(format!(
                    "Cannot tell whether the dot in ‘{}’ separates thousands or cents.",
                    s.trim()
                ));
            }
        }
    };
    // Thousands may be grouped by the other mark, a space or an apostrophe, in groups of three
    // (or Indian lakhs, "1,23,456"). The mark used for cents can't appear among them.
    let groups: Vec<&str> = whole
        .split(|c: char| matches!(c, '.' | ',' | '\'' | '’') || c.is_whitespace())
        .collect();
    let grouped = groups.len() == 1
        || groups[0].len() <= 3
            && groups[1..].iter().all(|g| (2..=3).contains(&g.len()))
            && groups.last().is_some_and(|g| g.len() == 3);
    if !grouped
        || point.is_some_and(|p| whole.contains(p))
        || groups
            .iter()
            .any(|g| g.is_empty() || !g.bytes().all(|c| c.is_ascii_digit()))
        || frac.len() > 2
        || !frac.bytes().all(|c| c.is_ascii_digit())
    {
        return Err(bad());
    }
    let sign = if negative { -1 } else { 1 };
    let whole = groups
        .concat()
        .parse::<i64>()
        .map_err(|_| "Amount too large")?;
    let n = whole
        .checked_mul(100)
        .and_then(|n| n.checked_add(format!("{frac:0<2}").parse::<i64>().ok()?))
        .ok_or("Amount too large")?;
    if n > 1_000_000_000_000 {
        return Err("Amount exceeds supported range".into());
    }
    Ok(n * sign)
}
fn date(s: &str, format: &str) -> Result<String, String> {
    let raw = s.trim().replace('\'', "/").replace(' ', "");
    // Two-digit years first: %Y also reads "26" as the year 26, so "10/17/26" would become 0026.
    let patterns = match format {
        "dmy" => vec!["%d/%m/%y", "%d-%m-%y", "%d/%m/%Y", "%d-%m-%Y"],
        "mdy" => vec!["%m/%d/%y", "%m-%d-%y", "%m/%d/%Y", "%m-%d-%Y"],
        _ => vec!["%Y-%m-%d", "%Y/%m/%d"],
    };
    for pattern in std::iter::once("%Y-%m-%d").chain(patterns) {
        if let Ok(d) = NaiveDate::parse_from_str(&raw, pattern) {
            let normalized = d.format("%Y-%m-%d").to_string();
            if d.year() >= 1900 && valid_date(&normalized) {
                return Ok(normalized);
            }
        }
    }
    Err(format!(
        "Cannot read date ‘{s}’. Select the matching date format."
    ))
}
fn tag(s: &str, name: &str) -> Option<String> {
    let upper = s.to_ascii_uppercase();
    let needle = format!("<{name}>");
    let start = upper.find(&needle)? + needle.len();
    let text = s[start..].split('<').next()?.trim();
    Some(
        text.replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\""),
    )
}
pub fn preview(
    b: &Budget,
    account: &str,
    content: &str,
    format: &str,
    date_format: &str,
    flip_signs: bool,
) -> Result<Vec<Row>, String> {
    review(b, account, parse_file(b, account, content, format, date_format, flip_signs)?)
}

pub fn preview_compact(
    b: &Budget,
    account: &str,
    content: &str,
    format: &str,
    date_format: &str,
    flip_signs: bool,
) -> Result<CompactReview, String> {
    review_compact(b, account, parse_file(b, account, content, format, date_format, flip_signs)?)
}

fn parse_file(
    b: &Budget,
    account: &str,
    content: &str,
    format: &str,
    date_format: &str,
    flip_signs: bool,
) -> Result<Vec<BankTransaction>, String> {
    validate(b)?;
    if !b.accounts.iter().any(|a| a.id == account) {
        return Err("Choose an account.".into());
    }
    if content.len() > 20_000_000 {
        return Err("Import a file smaller than 20 MB.".into());
    }
    let mut raw = vec![];
    match format {
        "csv" => {
            let first = content.lines().next().ok_or("Empty file")?;
            let delimiter = if first.contains('\t') {
                b'\t'
            } else if first.matches(';').count() > first.matches(',').count() {
                b';'
            } else {
                b','
            };
            let mut reader = csv::ReaderBuilder::new()
                .delimiter(delimiter)
                .trim(csv::Trim::All)
                .from_reader(content.trim_start_matches('\u{feff}').as_bytes());
            // Each header without case, spaces or punctuation ("Trans. Date" → "transdate"), and
            // the currency it names in capitals at the end ("Amount (USD)" → "amount", USD).
            let h: Vec<(String, Option<String>)> = reader
                .headers()
                .map_err(|e| e.to_string())?
                .iter()
                .map(|s| {
                    let named = s.trim().strip_suffix(')').and_then(|s| s.rsplit_once('('));
                    let (name, code) = match named {
                        Some((name, c))
                            if c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase()) =>
                        {
                            (name, Some(c.to_string()))
                        }
                        _ => (s, None),
                    };
                    (
                        name.to_lowercase()
                            .replace([' ', '_', '-', '.', '(', ')'], ""),
                        code,
                    )
                })
                .collect();
            let idx = |names: &[&str]| h.iter().position(|(s, _)| names.contains(&s.as_str()));
            // A money column that names a currency is read only in the budget's.
            let money_idx = |names: &[&str]| {
                h.iter().position(|(s, code)| {
                    names.contains(&s.as_str()) && code.as_ref().is_none_or(|c| *c == b.currency)
                })
            };
            // A transaction date beats a posting date, wherever each column is.
            let d = idx(&["date", "transactiondate", "posteddate", "transdate"])
                .or(idx(&["postingdate", "postdate"]))
                .ok_or(
                    "CSV needs Date, Payee/Description, and Amount (or Outflow/Inflow) headers.",
                )?;
            let p = idx(&[
                "payee",
                "name",
                "merchant",
                "description",
                "transactiondescription",
            ]);
            let memo = idx(&["memo", "notes"]);
            let amounts = ["amount", "transactionamount"];
            let (outflows, inflows) = (
                ["outflow", "debit", "withdrawal"],
                ["inflow", "credit", "deposit"],
            );
            let amt = money_idx(&amounts);
            let out = money_idx(&outflows);
            let input = money_idx(&inflows);
            let fit = idx(&["fitid", "transactionid", "id"]);
            if amt.is_none() && out.is_none() && input.is_none() {
                let all: Vec<&str> = [amounts.as_slice(), &outflows, &inflows].concat();
                if let Some(code) = h
                    .iter()
                    .find(|(s, _)| all.contains(&s.as_str()))
                    .and_then(|(_, c)| c.as_ref())
                {
                    return Err(format!(
                        "The file's amounts are in {code}, but this budget uses {}.",
                        b.currency
                    ));
                }
                return Err("CSV needs Amount or Outflow/Inflow columns.".into());
            }
            for result in reader.records() {
                let r = result.map_err(|e| e.to_string())?;
                let val = |i: Option<usize>| i.and_then(|i| r.get(i)).unwrap_or("");
                let amount = if amt.is_some() {
                    // Some card issuers write purchases as positive numbers in one Amount column.
                    let n = money(val(amt), &b.currency)?;
                    if flip_signs {
                        -n
                    } else {
                        n
                    }
                } else {
                    let n = |s: &str| {
                        if s.is_empty() {
                            Ok(0)
                        } else {
                            money(s, &b.currency)
                        }
                    };
                    n(val(input))? - n(val(out))?
                };
                raw.push(BankTransaction {
                    fit: val(fit).into(),
                    date: date(r.get(d).unwrap_or(""), date_format)?,
                    payee: val(p).into(),
                    memo: val(memo).into(),
                    amount,
                });
            }
        }
        "ofx" | "qfx" => {
            if let Some(currency) = tag(content, "CURDEF") {
                if currency != b.currency {
                    return Err(format!(
                        "File currency {currency} differs from {}.",
                        b.currency
                    ));
                }
            }
            let upper = content.to_ascii_uppercase();
            let starts: Vec<_> = upper.match_indices("<STMTTRN>").map(|(i, _)| i).collect();
            for (i, start) in starts.iter().enumerate() {
                let block = &content[*start..starts.get(i + 1).copied().unwrap_or(content.len())];
                let d = tag(block, "DTPOSTED").ok_or("Missing OFX posted date")?;
                let rawdate = d.get(..8).ok_or("Invalid OFX date")?;
                let date = NaiveDate::parse_from_str(rawdate, "%Y%m%d")
                    .map_err(|_| "Invalid OFX posted date")?
                    .format("%Y-%m-%d")
                    .to_string();
                raw.push(BankTransaction {
                    fit: tag(block, "FITID").unwrap_or_default(),
                    date,
                    payee: tag(block, "NAME").unwrap_or_default(),
                    memo: tag(block, "MEMO").unwrap_or_default(),
                    amount: money(
                        &tag(block, "TRNAMT").ok_or("Missing OFX amount")?,
                        &b.currency,
                    )?,
                });
            }
        }
        "qif" => {
            let mut fields = HashMap::new();
            for line in content.lines().map(str::trim).filter(|s| !s.is_empty()) {
                if line.starts_with('!') {
                    if line.starts_with("!Type:")
                        && !matches!(line, "!Type:Bank" | "!Type:CCard" | "!Type:Cash")
                    {
                        return Err(
                            "Only bank, cash, and credit-card QIF files are supported.".into()
                        );
                    }
                    continue;
                }
                if line == "^" {
                    let get = |c| fields.get(&c).map(String::as_str).unwrap_or("");
                    raw.push(BankTransaction {
                        fit: String::new(),
                        date: date(get('D'), date_format)?,
                        payee: get('P').into(),
                        memo: get('M').into(),
                        amount: money(get('T'), &b.currency)?,
                    });
                    fields.clear();
                } else {
                    let key = line.chars().next().unwrap();
                    if ['D', 'P', 'M', 'T'].contains(&key) {
                        fields.insert(key, line[1..].to_string());
                    }
                }
            }
            if !fields.is_empty() {
                return Err("Incomplete QIF record (missing ^ terminator).".into());
            }
        }
        _ => return Err("Choose CSV, OFX, QFX, or QIF.".into()),
    }
    if raw.is_empty() || raw.len() > 10000 {
        return Err("Choose a file containing 1–10,000 transactions.".into());
    }
    Ok(raw)
}
/// One transaction as the bank gave it, before the review.
pub struct BankTransaction {
    /// The bank's own id for it (an OFX FITID, a SimpleFIN transaction id), or "" when it has none.
    pub fit: String,
    /// YYYY-MM-DD.
    pub date: String,
    pub payee: String,
    pub memo: String,
    /// Cents, positive for money in.
    pub amount: i64,
}
/// The review's rows for transactions bound for `account`, however they arrived (a file, bank
/// sync, the assistant): an id that stays the same when the same transaction comes again, whether
/// it already did, the existing transactions it could match (same amount, within ten days), and
/// what the payee rules make of it.
fn bank_id(account: &str, signature: &str) -> String {
    format!("bank:{:x}", Sha256::digest(format!("{account}|{signature}").as_bytes()))
}

fn import_ids(b: &Budget) -> HashSet<String> {
    b.transactions.iter().flat_map(|t| {
        std::iter::once(t.id.as_str()).chain(t.extra.get("bankImportIds")
            .and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str))
    }).chain(crate::fresh_start::bank_import_ids(b)).map(str::to_owned).collect()
}

/// One account's matches, indexed once by amount and day. Source rows use the saved parent
/// total; receiving split transfers each have their own identity, never the parent's total.
struct Matches {
    days: HashMap<i64, BTreeMap<NaiveDate, Vec<String>>>,
    targets: HashMap<String, (usize, Option<usize>)>,
    previously_matched: HashSet<String>,
}
impl Matches {
    fn new(b: &Budget, account: &str) -> Self {
        let mut out = Self { days: HashMap::new(), targets: HashMap::new(), previously_matched: HashSet::new() };
        let mut reserved: HashSet<String> = b.transactions.iter().map(|t| t.id.clone()).collect();
        for (i, t) in b.transactions.iter().enumerate() {
            let Ok(day) = NaiveDate::parse_from_str(&t.date, "%Y-%m-%d") else { continue };
            let side_matched = t.extra.get("bankImportMatches").and_then(|v| v.get(account)).is_some();
            let mut add = |id: String, amount: i64, split: Option<usize>, matched: bool| {
                out.days.entry(amount).or_default().entry(day).or_default().push(id.clone());
                if matched { out.previously_matched.insert(id.clone()); }
                out.targets.insert(id, (i, split));
            };
            if t.account_id == account {
                add(t.id.clone(), t.amount, None, side_matched);
            } else if t.transfer_account_id.as_deref() == Some(account) {
                add(t.id.clone(), -t.amount, None, side_matched);
            } else {
                for (j, part) in t.splits.iter().enumerate().filter(|(_, s)| ledger::transfer(s) == Some(account)) {
                    let matched = part.extra.get("bankImportIds").and_then(Value::as_array).is_some_and(|ids| !ids.is_empty());
                    // Include the part's content so a reordered/edited split cannot silently
                    // receive a choice made against an older preview. Clearing it is harmless.
                    let mut content = part.clone();
                    content.extra.remove("transferStatus");
                    content.extra.remove("bankImportIds");
                    let key = json!([t.id, j, content]).to_string();
                    let base = format!("bank-leg:{:x}", Sha256::digest(key.as_bytes()));
                    let mut id = base.clone();
                    let mut attempt = 0;
                    while !reserved.insert(id.clone()) {
                        attempt += 1;
                        id = format!("{base}:{attempt}");
                    }
                    add(id, -part.amount, Some(j), matched);
                }
            }
        }
        out
    }
    fn candidates(&self, amount: i64, day: NaiveDate) -> Vec<String> {
        let mut ids: Vec<String> = self.days.get(&amount).into_iter()
            .flat_map(|days| days.range(day - chrono::Duration::days(10)..=day + chrono::Duration::days(10)))
            .flat_map(|(_, ids)| ids.iter().cloned()).collect();
        ids.sort();
        ids
    }
    fn candidate_set(&self, b: &Budget, amount: i64, day: NaiveDate) -> CandidateSet {
        let candidates = self.candidates(amount, day);
        let previously_matched_candidates = candidates.iter()
            .filter(|id| self.previously_matched.contains(*id)).cloned().collect();
        let candidate_details = candidates.iter().filter_map(|id| {
            let &(i, split) = self.targets.get(id)?;
            Some(Candidate { id: id.clone(), transaction_id: b.transactions[i].id.clone(), split_index: split? })
        }).collect();
        CandidateSet { candidates, previously_matched_candidates, candidate_details }
    }
}

pub fn review(b: &Budget, account: &str, raw: Vec<BankTransaction>) -> Result<Vec<Row>, String> {
    let mut rows = Vec::with_capacity(raw.len());
    review_each(b, account, raw, |mut row, matches, day| {
        let choices = matches.candidate_set(b, row.amount, day);
        row.candidates = choices.candidates;
        row.previously_matched_candidates = choices.previously_matched_candidates;
        row.candidate_details = choices.candidate_details;
        rows.push(row);
    })?;
    Ok(rows)
}

pub fn review_compact(b: &Budget, account: &str, raw: Vec<BankTransaction>) -> Result<CompactReview, String> {
    let mut review = CompactReview { items: Vec::with_capacity(raw.len()), candidate_sets: vec![] };
    let mut windows = HashMap::new();
    let mut buckets: HashMap<u64, Vec<usize>> = HashMap::new();
    review_each(b, account, raw, |row, matches, day| {
        let candidate_set = *windows.entry((row.amount, day)).or_insert_with(|| {
            let choices = matches.candidate_set(b, row.amount, day);
            let mut hash = DefaultHasher::new();
            choices.hash(&mut hash);
            let bucket = buckets.entry(hash.finish()).or_default();
            // Hashes only locate a bucket: compare every identifier/detail before sharing,
            // so a collision cannot substitute another row's matching choices.
            if let Some(&index) = bucket.iter().find(|&&index| review.candidate_sets[index] == choices) {
                index
            } else {
                let index = review.candidate_sets.len();
                review.candidate_sets.push(choices);
                bucket.push(index);
                index
            }
        });
        review.items.push(CompactRow { row, candidate_set });
    })?;
    Ok(review)
}

fn review_each(
    b: &Budget,
    account: &str,
    raw: Vec<BankTransaction>,
    mut emit: impl FnMut(Row, &Matches, NaiveDate),
) -> Result<(), String> {
    // File previews and bank-sync snapshots share this boundary. Validate before the
    // match index negates transfer amounts or applies its ten-day date window.
    validate(b)?;
    if !b.accounts.iter().any(|a| a.id == account) {
        return Err("Choose an account.".into());
    }
    if raw.iter().any(|t| !valid_date(&t.date)
        || !(-1_000_000_000_000..=1_000_000_000_000).contains(&t.amount)) {
        return Err("A bank transaction has an invalid date or amount.".into());
    }
    let imported: HashSet<&str> = b
        .transactions
        .iter()
        .flat_map(|t| {
            let ids = t.extra.get("bankImportIds").and_then(Value::as_array);
            std::iter::once(t.id.as_str()).chain(ids.into_iter().flatten().filter_map(Value::as_str))
        })
        .chain(crate::fresh_start::bank_import_ids(b))
        .collect();
    let matches = Matches::new(b, account);
    let mut occurrences = HashMap::new();
    let mut legacy_occurrences = HashMap::new();
    for BankTransaction { fit, date, payee, memo, amount } in raw {
        let idless = fit.is_empty();
        let legacy = if idless {
            let key = format!("{date}|{payee}|{amount}");
            let n = legacy_occurrences.entry(key.clone()).or_insert(0);
            *n += 1;
            Some(bank_id(account, &format!("{key}|{n}")))
        } else { None };
        let mut group_id = None;
        let signature = if idless {
            // Structured encoding avoids delimiter collisions; memo distinguishes independent
            // receipts. Only truly identical rows share the per-file occurrence counter.
            let key = json!([date, payee, memo, amount]).to_string();
            group_id = Some(bank_id(account, &format!("idless:group:v2:{key}")));
            let n = occurrences.entry(key.clone()).or_insert(0);
            *n += 1;
            format!("idless:v2:{key}:{n}")
        } else {
            format!("fit:{fit}")
        };
        let id = bank_id(account, &signature);
        let duplicate = imported.contains(id.as_str());
        let possible_duplicate = !duplicate && (legacy.is_some_and(|id| imported.contains(id.as_str()))
            || group_id.as_ref().is_some_and(|id| imported.contains(id.as_str())));
        let d = NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|_| "Invalid bank transaction date")?;
        let mut row = Row {
            id,
            date,
            payee,
            memo,
            amount,
            duplicate,
            candidates: vec![],
            previously_matched_candidates: vec![],
            candidate_details: vec![],
            idless,
            possible_duplicate,
            group_id,
            import_id: None,
            rename: None,
            category_id: None,
            at: None,
        };
        let t = new_transaction(b, account, &row);
        row.rename = Some(t.payee).filter(|p| *p != row.payee);
        row.category_id = t.splits[0].category_id.clone();
        emit(row, &matches, d);
    }
    Ok(())
}
/// A new transaction for an imported row, keeping the bank's payee text, with the payee rules applied.
fn new_transaction(b: &Budget, account: &str, r: &Row) -> Transaction {
    let mut extra = json!({"approved": false, "bankImportIds": [r.id], "bankImportMatches": {account: r.id}});
    if let Some(group) = &r.group_id {
        extra["bankImportIds"].as_array_mut().unwrap().push(json!(group));
    }
    if !r.payee.trim().is_empty() {
        extra["importedPayee"] = json!(r.payee);
    }
    let mut t = Transaction {
        id: r.id.clone(),
        date: r.date.clone(),
        account_id: account.into(),
        payee: r.payee.clone(),
        memo: r.memo.clone(),
        amount: r.amount,
        status: Cleared::Cleared,
        splits: vec![Split {
            category_id: None,
            amount: r.amount,
            extra: Default::default(),
        }],
        transfer_account_id: None,
        transfer_status: None,
        extra: extra.as_object().unwrap().clone().into(),
    };
    workflows::apply_payee_rules(b, &mut t);
    t
}
pub fn apply(mut b: Budget, account: &str, choices: Vec<Choice>) -> Result<Budget, String> {
    validate(&b)?;
    if !b.accounts.iter().any(|a| a.id == account) {
        return Err("Account not found".into());
    }
    let mut imported = import_ids(&b);
    let matches = Matches::new(&b, account);
    let mut used = HashSet::new();
    let now = Utc::now();
    // Rows without the bank's time are added now, a millisecond apart, so the register shows a
    // day's rows in the order the statement does: a newest-first file's first row is the newest.
    let count = choices.len();
    let newest_first = {
        let steps = choices.windows(2).map(|w| w[1].row.date.cmp(&w[0].row.date));
        let (back, forward) = steps.fold((0, 0), |(b, f), o| match o {
            std::cmp::Ordering::Less => (b + 1, f),
            std::cmp::Ordering::Greater => (b, f + 1),
            std::cmp::Ordering::Equal => (b, f),
        });
        back > forward
    };
    for (i, c) in choices.into_iter().enumerate() {
        let offset = if newest_first { count - 1 - i } else { i };
        if c.action == "skip" {
            continue;
        }
        let r = c.row;
        if let Some(id) = &r.import_id {
            if !r.idless || c.action != "new" || !id.starts_with("bank:manual:") || id.len() > 100 || id.len() < 24 {
                return Err("Preview this file again before importing a separate transaction.".into());
            }
        }
        let identity = r.import_id.as_deref().unwrap_or(&r.id);
        if imported.contains(identity) {
            continue;
        }
        if c.action == "match" {
            let id = c
                .match_id
                .as_ref()
                .ok_or("Choose the matching transaction")?;
            if !used.insert(id.clone()) {
                return Err("Two imported rows cannot match the same local transaction. Review the selections.".into());
            }
            let &(index, split) = matches.targets.get(id)
                .ok_or("Matching transaction changed or was already matched. Preview again.")?;
            // A default match from an older preview must not silently consume another
            // payment that was imported meanwhile. Refreshed previews allow explicit matches.
            if matches.previously_matched.contains(id) && !r.previously_matched_candidates.contains(id) {
                return Err("Matching transaction was imported since this preview. Preview again.".into());
            }
            let t = &mut b.transactions[index];
            let date_a =
                NaiveDate::parse_from_str(&t.date, "%Y-%m-%d").map_err(|_| "Invalid date")?;
            let date_b =
                NaiveDate::parse_from_str(&r.date, "%Y-%m-%d").map_err(|_| "Invalid date")?;
            if (date_a - date_b).num_days().abs() > 10 {
                return Err("Matching transaction is more than ten days apart.".into());
            }
            if let Some(split) = split {
                let part = &mut t.splits[split];
                if ledger::transfer(part) != Some(account) || -part.amount != r.amount {
                    return Err("Matching account or amount changed. Preview again.".into());
                }
                if ledger::status(part) != Cleared::Reconciled {
                    part.extra.insert("transferStatus".into(), json!("cleared"));
                }
                part.extra.entry("bankImportIds").or_insert(json!([]))
                    .as_array_mut().ok_or("Invalid bank identifiers")?.push(json!(r.id));
            } else if t.account_id == account && t.amount == r.amount {
                if t.status != Cleared::Reconciled {
                    t.status = Cleared::Cleared
                }
            } else if t.transfer_account_id.as_deref() == Some(account) && -t.amount == r.amount {
                if t.transfer_status != Some(Cleared::Reconciled) {
                    t.transfer_status = Some(Cleared::Cleared)
                }
            } else {
                return Err("Matching account or amount changed. Preview again.".into());
            }
            if split.is_none() {
                t.extra.entry("bankImportMatches").or_insert(json!({}))
                    .as_object_mut().ok_or("Invalid bank matches")?.insert(account.into(), json!(r.id));
            }
            t.extra
                .entry("bankImportIds")
                .or_insert(json!([]))
                .as_array_mut()
                .ok_or("Invalid bank identifiers")?
                .push(json!(r.id));
            if let Some(group) = &r.group_id {
                let ids = t.extra.get_mut("bankImportIds").and_then(Value::as_array_mut).expect("checked above");
                if !ids.iter().any(|id| id.as_str() == Some(group)) { ids.push(json!(group)); }
            }
            if t.account_id == account && !r.payee.trim().is_empty() {
                t.extra.entry("importedPayee").or_insert_with(|| json!(r.payee));
            }
            t.extra.insert("approved".into(), json!(false));
        } else if c.action == "new" {
            let mut t = new_transaction(&b, account, &r);
            t.id = identity.to_owned();
            // When the bank says it happened, or else now plus the row's offset.
            let at = r.at.as_deref().and_then(|at| DateTime::parse_from_rfc3339(at).ok());
            let at = at.map_or(now + chrono::Duration::milliseconds(offset as i64), |at| at.with_timezone(&Utc));
            t.set_created_at(&stamp(at));
            if t.amount < 0
                && t.splits[0].category_id.is_none()
                && b.accounts.iter().any(|a| a.id == account && a.on_budget())
            {
                let category = b
                    .categories
                    .iter()
                    .find(|c| c.name == "Uncategorized" || c.name == "Uncategorized Transactions")
                    .map(|c| c.id.clone())
                    .unwrap_or("local-uncategorized".into());
                if !b.categories.iter().any(|c| c.id == category) {
                    b.categories.push(Category {
                        id: category.clone(),
                        name: "Uncategorized".into(),
                        group: "Needs review".into(),
                        target: 0,
                        extra: Default::default(),
                    });
                }
                t.splits[0].category_id = Some(category);
            }
            b.transactions.push(t);
        } else {
            return Err("Review every imported row before saving.".into());
        }
        imported.insert(identity.to_owned());
        if let Some(group) = r.group_id { imported.insert(group); }
        imported.insert(r.id);
    }
    validate(&b)?;
    Ok(b)
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::tests::*;
    fn add_rows(b: Budget, rows: Vec<Row>, account: &str) -> Budget {
        apply(b, account, rows.into_iter().map(|row| Choice { row, action: "new".into(), match_id: None }).collect()).unwrap()
    }
    fn file(memo: &str) -> String {
        format!("Date,Payee,Memo,Amount\n2026-10-15,Shop,{memo},-50.00")
    }
    #[test]
    fn bank_reviews_reject_unsupported_dates_and_invalid_ledgers_before_matching() {
        let b = sample();
        for date in ["+262142-12-31", "+10000-01-01", "not-a-date", "2026-02-30"] {
            let csv = format!("Date,Payee,Amount\n{date},Shop,-50.00");
            assert!(preview(&b, "cash", &csv, "csv", "ymd", false).is_err(), "{date}");
            let raw = BankTransaction { fit: "bank-id".into(), date: date.into(),
                payee: "Shop".into(), memo: String::new(), amount: -5000 };
            assert!(review(&b, "cash", vec![raw]).is_err(), "{date}");
        }
        // Bank-sync reviews also receive the current, possibly invalid, UI draft.
        let mut invalid = b.clone();
        let mut transfer = purchase();
        transfer.transfer_account_id = Some("cash".into());
        transfer.transfer_status = Some(Cleared::Uncleared);
        transfer.amount = i64::MIN;
        transfer.splits[0].amount = i64::MIN;
        invalid.transactions.push(transfer);
        assert!(review(&invalid, "cash", vec![]).is_err(), "do not negate an unchecked transfer amount");
        let raw = BankTransaction { fit: "bank-id".into(), date: "2026-10-15".into(),
            payee: "Shop".into(), memo: String::new(), amount: i64::MIN };
        assert!(review(&b, "cash", vec![raw]).is_err());
        assert!(review(&b, "missing", vec![]).is_err());
        // A supported upper date remains safe when the matching window extends past year 9999.
        let csv = "Date,Payee,Amount\n9999-12-31,Shop,-50.00";
        assert_eq!(preview(&b, "cash", csv, "csv", "ymd", false).unwrap()[0].date, "9999-12-31");
    }
    #[test]
    fn idless_receipts_keep_distinct_memos_and_reimports_remain_idempotent() {
        let mut b = sample();
        for memo in ["Receipt A", "Receipt B"] {
            let rows = preview(&b, "cash", &file(memo), "csv", "ymd", false).unwrap();
            assert!(!rows[0].duplicate && !rows[0].possible_duplicate);
            assert_eq!(rows[0].candidates, rows[0].previously_matched_candidates,
                "an already imported payment must require an explicit choice before absorbing another receipt");
            b = add_rows(b, rows, "cash");
        }
        assert_eq!(b.transactions.len(), 2);
        let combined = "Date,Payee,Memo,Amount\n2026-10-15,Shop,Receipt B,-50.00\n2026-10-15,Shop,Receipt A,-50.00";
        let rows = preview(&b, "cash", combined, "csv", "ymd", false).unwrap();
        assert!(rows.iter().all(|r| r.duplicate));
        assert_eq!(add_rows(b.clone(), rows, "cash"), b);
    }
    #[test]
    fn csv_payments_can_explicitly_match_ofx_and_bank_sync_ids_without_duplicating() {
        let b = sample();
        let csv = file("Original receipt");
        let rows = preview(&b, "cash", &csv, "csv", "ymd", false).unwrap();
        let mut b = add_rows(b, rows, "cash");
        let id = b.transactions[0].id.clone();
        b.transactions[0].status = Cleared::Reconciled;
        b.transactions[0].memo = "Keep my memo".into();
        b.transactions[0].splits[0].category_id = Some("food".into());
        let ofx = "<OFX><CURDEF>SAR<STMTTRN><TRNAMT>-50.00<DTPOSTED>20261015000000<FITID>ofx-id<NAME>Shop</STMTTRN></OFX>";
        let ofx_row = preview(&b, "cash", ofx, "ofx", "ymd", false).unwrap().remove(0);
        let sync_row = review(&b, "cash", vec![incoming("simplefin-id", -5000)]).unwrap().remove(0);
        for row in [ofx_row, sync_row] {
            assert!(!row.duplicate);
            assert_eq!(row.candidates, [id.clone()]);
            assert_eq!(row.previously_matched_candidates, [id.clone()]);
            b = apply(b, "cash", vec![Choice { row: row.clone(), action: "match".into(), match_id: Some(id.clone()) }]).unwrap();
            assert_eq!(apply(b.clone(), "cash", vec![Choice { row, action: "match".into(), match_id: Some(id.clone()) }]).unwrap(), b);
        }
        assert_eq!(b.transactions.len(), 1);
        let t = &b.transactions[0];
        assert_eq!(t.status, Cleared::Reconciled);
        assert_eq!(t.memo, "Keep my memo");
        assert_eq!(t.splits[0].category_id.as_deref(), Some("food"));
        assert!(preview(&b, "cash", &csv, "csv", "ymd", false).unwrap()[0].duplicate);
        assert!(preview(&b, "cash", ofx, "ofx", "ymd", false).unwrap()[0].duplicate);
        assert!(review(&b, "cash", vec![incoming("simplefin-id", -5000)]).unwrap()[0].duplicate);
    }
    #[test]
    fn direct_transfer_sides_can_each_match_more_than_one_import_source() {
        let mut b = sample();
        let mut t = purchase();
        t.account_id = "cash".into();
        t.transfer_account_id = Some("card".into());
        t.status = Cleared::Reconciled;
        t.transfer_status = Some(Cleared::Reconciled);
        t.splits.clear();
        b.transactions.push(t);
        for source in ["file", "sync"] {
            for (account, amount) in [("cash", -5000), ("card", 5000)] {
                let row = review(&b, account, vec![incoming(source, amount)]).unwrap().remove(0);
                assert_eq!(row.candidates, ["tx"]);
                assert_eq!(row.previously_matched_candidates.is_empty(), source == "file");
                b = apply(b, account, vec![Choice { row, action: "match".into(), match_id: Some("tx".into()) }]).unwrap();
            }
        }
        assert_eq!(b.transactions.len(), 1);
        assert_eq!(b.transactions[0].status, Cleared::Reconciled);
        assert_eq!(b.transactions[0].transfer_status, Some(Cleared::Reconciled));
        for (account, amount) in [("cash", -5000), ("card", 5000)] {
            assert!(review(&b, account, vec![incoming("file", amount), incoming("sync", amount)]).unwrap().iter().all(|r| r.duplicate));
        }
    }
    #[test]
    fn matching_rejects_reusing_an_account_side_in_one_batch_and_newly_imported_stale_choices() {
        for split in [false, true] {
            let mut b = if split { split_budget(false) } else { sample() };
            if !split { b.transactions.push(purchase()); }
            let (account, amount) = if split { ("savings", 1000) } else { ("card", -5000) };
            let rows = review(&b, account, vec![incoming("first", amount), incoming("second", amount)]).unwrap();
            let choices = || rows.iter().cloned().map(|row| Choice { match_id: Some(row.candidates[0].clone()), row, action: "match".into() }).collect();
            assert!(apply(b.clone(), account, choices()).unwrap_err().contains("Two imported rows"));
            let id = rows[0].candidates[0].clone();
            b = apply(b, account, vec![Choice { row: rows[0].clone(), action: "match".into(), match_id: Some(id.clone()) }]).unwrap();
            assert!(apply(b.clone(), account, vec![Choice { row: rows[1].clone(), action: "match".into(), match_id: Some(id.clone()) }]).unwrap_err().contains("since this preview"));
            let fresh = review(&b, account, vec![incoming("second", amount)]).unwrap().remove(0);
            assert_eq!(fresh.previously_matched_candidates, [id.clone()]);
            b = apply(b, account, vec![Choice { row: fresh, action: "match".into(), match_id: Some(id) }]).unwrap();
            assert_eq!(b.transactions.len(), 1);
            assert!(review(&b, account, vec![incoming("first", amount), incoming("second", amount)]).unwrap().iter().all(|r| r.duplicate));
        }
    }
    #[test]
    fn legacy_idless_imports_require_a_choice_including_after_a_fresh_start() {
        let legacy_id = bank_id("cash", "2026-10-15|Shop|-5000|1");
        let mut b = sample();
        let mut t = purchase();
        t.account_id = "cash".into();
        t.id = legacy_id.clone();
        t.memo = "Receipt A".into();
        b.transactions.push(t);
        for memo in ["Receipt A", "Receipt B"] {
            let row = preview(&b, "cash", &file(memo), "csv", "ymd", false).unwrap().remove(0);
            assert!(!row.duplicate && row.possible_duplicate);
        }
        // A deliberate add has a new identity, and cannot disappear behind the legacy alias.
        let rows = preview(&b, "cash", &file("Receipt B"), "csv", "ymd", false).unwrap();
        let b = add_rows(b, rows, "cash");
        assert_eq!(b.transactions.len(), 2);
        assert!(preview(&b, "cash", &file("Receipt B"), "csv", "ymd", false).unwrap()[0].duplicate);
        let mut fresh = sample();
        fresh.extra.insert("freshStartHistory".into(), json!({"bankImportIds":[legacy_id]}));
        assert!(preview(&fresh, "cash", &file("Receipt A"), "csv", "ymd", false).unwrap()[0].possible_duplicate);
    }
    #[test]
    fn a_partial_import_of_identical_rows_is_ambiguous_when_exported_alone() {
        let b = sample();
        let csv = "Date,Payee,Memo,Amount\n2026-10-15,Shop,Receipt,-50.00\n2026-10-15,Shop,Receipt,-50.00";
        let rows = preview(&b, "cash", csv, "csv", "ymd", false).unwrap();
        // The first row was skipped. A later export contains only the second identical row,
        // numbered first again. It must not silently become another payment.
        let b = add_rows(b, vec![rows[1].clone()], "cash");
        let row = preview(&b, "cash", &file("Receipt"), "csv", "ymd", false).unwrap().remove(0);
        assert!(!row.duplicate && row.possible_duplicate);
        assert!(preview(&b, "cash", csv, "csv", "ymd", false).unwrap()[1].duplicate);
    }
    #[test]
    fn explicit_idless_duplicate_override_is_stable_on_retry_and_forbidden_for_bank_ids() {
        let b = sample();
        let rows = preview(&b, "cash", &file("same receipt"), "csv", "ymd", false).unwrap();
        let b = add_rows(b, rows, "cash");
        let mut row = preview(&b, "cash", &file("same receipt"), "csv", "ymd", false).unwrap().remove(0);
        assert!(row.duplicate && row.idless);
        row.import_id = Some("bank:manual:explicit-stable-retry-id".into());
        let b = add_rows(b, vec![row.clone()], "cash");
        assert_eq!(b.transactions.len(), 2);
        assert_eq!(add_rows(b.clone(), vec![row.clone()], "cash"), b);
        row.idless = false;
        assert!(apply(b, "cash", vec![Choice { row, action: "new".into(), match_id: None }]).is_err());
    }
    fn split_budget(equal: bool) -> Budget {
        let mut b = sample();
        let mut peer = b.accounts[0].clone();
        peer.id = "savings".into();
        peer.name = "Savings".into();
        b.accounts.push(peer);
        let mut t = purchase();
        t.account_id = "cash".into();
        t.status = Cleared::Uncleared;
        t.amount = if equal { -2000 } else { -3000 };
        t.splits = serde_json::from_value(json!([
            {"amount":-1000,"categoryId":null,"memo":"First leg","transferAccountId":"savings","transferStatus":"uncleared"},
            {"amount":if equal {-1000} else {-2000},"categoryId":null,"memo":"Second leg","transferAccountId":"savings","transferStatus":"uncleared"}
        ])).unwrap();
        b.transactions.push(t);
        validate(&b).unwrap();
        b
    }
    fn incoming(fit: &str, amount: i64) -> BankTransaction {
        BankTransaction { fit: fit.into(), date: "2026-10-15".into(), payee: "Transfer".into(), memo: String::new(), amount }
    }
    #[test]
    fn compact_reviews_expand_losslessly_including_split_and_previous_match_evidence() {
        let mut b = split_budget(true);
        let first = review(&b, "savings", vec![incoming("already-imported", 1000)]).unwrap().remove(0);
        let chosen = first.candidates[0].clone();
        b = apply(b, "savings", vec![Choice { row: first, action: "match".into(), match_id: Some(chosen.clone()) }]).unwrap();
        let raw = || {
            let mut next_day = incoming("another-day", 1000);
            next_day.date = "2026-10-16".into();
            vec![incoming("already-imported", 1000), incoming("new-source", 1000), next_day, incoming("other-amount", 2000)]
        };
        let full = review(&b, "savings", raw()).unwrap();
        let compact = review_compact(&b, "savings", raw()).unwrap();
        assert_eq!(compact.candidate_sets.len(), 2, "different date windows with identical choices share their pool");
        for (expected, item) in full.iter().zip(&compact.items) {
            let choices = &compact.candidate_sets[item.candidate_set];
            let mut expanded = item.row.clone();
            expanded.candidates = choices.candidates.clone();
            expanded.candidate_details = choices.candidate_details.clone();
            expanded.previously_matched_candidates = choices.previously_matched_candidates.clone();
            assert_eq!(serde_json::to_value(expected).unwrap(), serde_json::to_value(expanded).unwrap());
        }
        let mut selected = compact.items[1].row.clone();
        assert!(apply(b.clone(), "savings", vec![Choice { row: selected.clone(), action: "match".into(), match_id: Some(chosen.clone()) }]).unwrap_err().contains("since this preview"));
        // The compact submit only needs the explicitly chosen acknowledgement. Matching still
        // revalidates the account, amount, date and split identity against the current budget.
        selected.previously_matched_candidates.push(chosen.clone());
        let saved = apply(b.clone(), "savings", vec![Choice { row: selected.clone(), action: "match".into(), match_id: Some(chosen.clone()) }]).unwrap();
        assert_eq!(saved.transactions.len(), b.transactions.len());
        b.transactions[0].splits.swap(0, 1);
        assert!(apply(b, "savings", vec![Choice { row: selected, action: "match".into(), match_id: Some(chosen) }]).is_err());
    }
    #[test]
    fn compact_statement_keeps_all_ten_thousand_choices_without_repeating_them_per_row() {
        let mut b = sample();
        b.transactions = (0..10_000).map(|i| {
            let mut transaction = purchase();
            transaction.id = format!("candidate-{i:05}");
            transaction
        }).collect();
        let content = format!("Date,Payee,Amount,Id\n{}", (0..1000).map(|i| format!("2026-10-15,Shop,-50.00,receipt-{i}\n")).collect::<String>());
        let compact = preview_compact(&b, "card", &content, "csv", "ymd", false).unwrap();
        assert_eq!(compact.items.len(), 1000);
        assert_eq!(compact.candidate_sets.len(), 1);
        assert_eq!(compact.candidate_sets[0].candidates.len(), 10_000);
        assert!(compact.items.iter().all(|row| row.candidate_set == 0 && row.row.candidates.is_empty()));
        assert!(serde_json::to_vec(&compact).unwrap().len() < 1_000_000, "transport must scale with unique choices plus rows, not their product");
        let last = compact.candidate_sets[0].candidates.last().unwrap().clone();
        let row = compact.items.into_iter().next().unwrap().row;
        let saved = apply(b, "card", vec![Choice { row, action: "match".into(), match_id: Some(last.clone()) }]).unwrap();
        assert_eq!(saved.transactions.len(), 10_000);
        assert_eq!(saved.transactions.iter().find(|t| t.id == last).unwrap().status, Cleared::Cleared);
    }
    #[test]
    fn split_source_totals_and_each_receiving_leg_match_without_duplicate_transactions() {
        let b = split_budget(false);
        let source = review(&b, "cash", vec![incoming("source", -3000)]).unwrap().remove(0);
        assert_eq!(source.candidates, ["tx"]);
        let rows = review(&b, "savings", vec![incoming("first", 1000), incoming("second", 2000)]).unwrap();
        assert_eq!(rows[0].candidates.len(), 1);
        assert_ne!(rows[0].candidates, rows[1].candidates);
        assert_eq!(rows[1].candidate_details[0].split_index, 1);
        let choices = rows.into_iter().map(|row| Choice { match_id: Some(row.candidates[0].clone()), row, action: "match".into() }).collect();
        let b = apply(b, "savings", choices).unwrap();
        assert!(b.transactions[0].splits.iter().all(|s| ledger::status(s) == Cleared::Cleared));
        let b = apply(b, "cash", vec![Choice { row: source, action: "match".into(), match_id: Some("tx".into()) }]).unwrap();
        assert_eq!(b.transactions.len(), 1);
        assert_eq!(b.transactions[0].status, Cleared::Cleared);
        assert!(review(&b, "savings", vec![incoming("first", 1000), incoming("second", 2000)]).unwrap().iter().all(|r| r.duplicate));
    }
    #[test]
    fn equal_receiving_legs_match_separately_and_stale_leg_choices_are_rejected() {
        let mut b = split_budget(true);
        let row = review(&b, "savings", vec![incoming("first", 1000)]).unwrap().remove(0);
        assert_eq!(row.candidates.len(), 2);
        let first = row.candidate_details.iter().find(|d| d.split_index == 0).unwrap().id.clone();
        let mut reordered = b.clone();
        reordered.transactions[0].splits.swap(0, 1);
        assert!(apply(reordered, "savings", vec![Choice { row: row.clone(), action: "match".into(), match_id: Some(first.clone()) }]).is_err());
        b = apply(b, "savings", vec![Choice { row, action: "match".into(), match_id: Some(first) }]).unwrap();
        let row = review(&b, "savings", vec![incoming("second", 1000)]).unwrap().remove(0);
        assert_eq!(row.candidates.len(), 2);
        let matched = row.candidate_details.iter().find(|d| d.split_index == 1).unwrap().id.clone();
        assert!(!row.previously_matched_candidates.contains(&matched));
        assert_eq!(row.previously_matched_candidates.len(), 1);
        b = apply(b, "savings", vec![Choice { row, action: "match".into(), match_id: Some(matched) }]).unwrap();
        assert!(b.transactions[0].splits.iter().all(|s| ledger::status(s) == Cleared::Cleared));
        // The same two legs from a different bank source remain independently matchable.
        let rows = review(&b, "savings", vec![incoming("sync-first", 1000), incoming("sync-second", 1000)]).unwrap();
        let choices = rows.into_iter().enumerate().map(|(i, row)| {
            assert_eq!(row.candidates, row.previously_matched_candidates);
            let id = row.candidate_details.iter().find(|d| d.split_index == i).unwrap().id.clone();
            Choice { row, action: "match".into(), match_id: Some(id) }
        }).collect();
        b = apply(b, "savings", choices).unwrap();
        assert_eq!(b.transactions.len(), 1);
        assert!(b.transactions[0].splits.iter().all(|s| s.extra["bankImportIds"].as_array().unwrap().len() == 2));
        assert!(review(&b, "savings", vec![incoming("first", 1000), incoming("second", 1000), incoming("sync-first", 1000), incoming("sync-second", 1000)]).unwrap().iter().all(|r| r.duplicate));
    }
    #[test]
    fn a_files_rows_on_one_day_are_added_in_the_files_order() {
        let b = sample();
        let csv = "Date,Payee,Amount\n2026-10-14,Other day,-9.00\n2026-10-15,First,-1.00\n2026-10-15,Second,-2.00\n2026-10-15,Third,-3.00";
        let rows = preview(&b, "cash", csv, "csv", "ymd", false).unwrap();
        let before = stamp_now();
        let choices = rows.into_iter().map(|row| Choice { row, action: "new".into(), match_id: None }).collect();
        let b = apply(b, "cash", choices).unwrap();
        assert!(b.transactions.iter().all(|t| t.created_at().is_some_and(|at| at >= before.as_str())));
        // Newest first, the file's last row on the day is on top.
        let mut list: Vec<&Transaction> = b.transactions.iter().collect();
        sort_newest_first(&mut list);
        let payees: Vec<&str> = list.iter().map(|t| t.payee.as_str()).collect();
        assert_eq!(payees, ["Third", "Second", "First", "Other day"]);
    }
    #[test]
    fn a_newest_first_files_rows_on_one_day_show_in_the_files_order() {
        let b = sample();
        let csv = "Date,Payee,Amount\n2026-10-16,Next day,-9.00\n2026-10-15,First,-1.00\n2026-10-15,Second,-2.00\n2026-10-15,Third,-3.00\n2026-10-14,Day before,-4.00";
        let rows = preview(&b, "cash", csv, "csv", "ymd", false).unwrap();
        let choices = rows.into_iter().map(|row| Choice { row, action: "new".into(), match_id: None }).collect();
        let b = apply(b, "cash", choices).unwrap();
        let mut list: Vec<&Transaction> = b.transactions.iter().collect();
        sort_newest_first(&mut list);
        let payees: Vec<&str> = list.iter().map(|t| t.payee.as_str()).collect();
        assert_eq!(payees, ["Next day", "First", "Second", "Third", "Day before"]);
    }
    #[test]
    fn csv_matches_manual_entries_and_reimport_is_idempotent() {
        let mut b = sample();
        let mut t = purchase();
        t.account_id = "cash".into();
        t.status = Cleared::Uncleared;
        b.transactions.push(t);
        let rows = preview(
            &b,
            "cash",
            "Date,Payee,Amount\n2026-10-15,Shop,-50.00",
            "csv",
            "ymd",
            false,
        )
        .unwrap();
        assert_eq!(rows[0].candidates, vec!["tx"]);
        let b = apply(
            b,
            "cash",
            vec![Choice {
                row: rows[0].clone(),
                action: "match".into(),
                match_id: Some("tx".into()),
            }],
        )
        .unwrap();
        assert_eq!(b.transactions.len(), 1);
        assert_eq!(b.transactions[0].status, Cleared::Cleared);
        assert!(
            preview(
                &b,
                "cash",
                "Date,Payee,Amount\n2026-10-15,Shop,-50.00",
                "csv",
                "ymd",
                false
            )
            .unwrap()[0]
                .duplicate
        );
    }
    #[test]
    fn keeps_the_bank_text_and_previews_what_the_rules_do() {
        let mut b = sample();
        b.extra.insert(
            "payeeRules".into(),
            json!([{"id":"r","match":"sq blue bottle","payee":"Blue Bottle","categoryId":null}]),
        );
        b.extra.insert("payees".into(), json!([{"id":"p","name":"Blue Bottle","categoryId":"food"}]));
        let mut manual = purchase();
        manual.account_id = "cash".into();
        manual.payee = "Corner Shop".into();
        b.transactions.push(manual);
        let file = "Date,Payee,Amount
2026-10-15,SQ *BLUE BOTTLE 0042,-6.50
2026-10-15,SHOP 12,-50.00
2026-10-16,ELSEWHERE,-1.00";
        let rows = preview(&b, "cash", file, "csv", "ymd", false).unwrap();
        assert_eq!(rows[0].rename.as_deref(), Some("Blue Bottle"));
        assert_eq!(rows[0].category_id.as_deref(), Some("food"));
        assert_eq!((rows[2].rename.as_deref(), rows[2].category_id.as_deref()), (None, None));
        let choices = vec![
            Choice { row: rows[0].clone(), action: "new".into(), match_id: None },
            Choice { row: rows[1].clone(), action: "match".into(), match_id: Some("tx".into()) },
        ];
        let b = apply(b, "cash", choices).unwrap();
        let new = b.transactions.iter().find(|t| t.id == rows[0].id).unwrap();
        assert_eq!((new.payee.as_str(), new.splits[0].category_id.as_deref()), ("Blue Bottle", Some("food")));
        assert_eq!(new.extra["importedPayee"], "SQ *BLUE BOTTLE 0042");
        // A transaction matched to a bank row keeps its payee and learns the bank's text.
        let matched = b.transactions.iter().find(|t| t.id == "tx").unwrap();
        assert_eq!((matched.payee.as_str(), &matched.extra["importedPayee"]), ("Corner Shop", &json!("SHOP 12")));
    }
    #[test]
    fn reads_two_digit_years_as_this_century() {
        assert_eq!(date("10/17/26", "mdy").unwrap(), "2026-10-17");
        assert_eq!(date("17/10/26", "dmy").unwrap(), "2026-10-17");
        assert_eq!(date("10-17-26", "mdy").unwrap(), "2026-10-17");
        // QIF writes the year after an apostrophe.
        assert_eq!(date("10/17'26", "mdy").unwrap(), "2026-10-17");
        assert_eq!(date(" 1/ 5/26", "mdy").unwrap(), "2026-01-05");
        assert_eq!(date("10/17/2026", "mdy").unwrap(), "2026-10-17");
        assert_eq!(date("2026-10-17", "dmy").unwrap(), "2026-10-17");
        // A year that can only be read as the year 26 isn't one.
        assert!(date("26-10-17", "ymd").is_err());
        let b = sample();
        let r = preview(&b, "cash", "!Type:Bank\nD10/17'26\nT-1.25\nPShop\n^", "qif", "mdy", false).unwrap();
        assert_eq!(r[0].date, "2026-10-17");
        let r = preview(&b, "cash", "Date,Payee,Amount\n10/17/26,Shop,-1.25", "csv", "mdy", false).unwrap();
        assert_eq!(r[0].date, "2026-10-17");
    }
    #[test]
    fn reads_sgml_ofx_and_qif_with_explicit_date_order() {
        let b = sample();
        let r=preview(&b,"cash","<OFX><CURDEF>SAR<STMTTRN><TRNAMT>-1.25<DTPOSTED>20261015000000<FITID>abc<NAME>A &amp; B</STMTTRN></OFX>","ofx","ymd",false).unwrap();
        assert_eq!(r[0].amount, -125);
        assert_eq!(r[0].payee, "A & B");
        let r = preview(
            &b,
            "cash",
            "!Type:Bank\nD15/10/2026\nT-1.25\nPShop\n^",
            "qif",
            "dmy",
            false,
        )
        .unwrap();
        assert_eq!(r[0].date, "2026-10-15");
        assert!(money("1.001", "SAR").is_err());
    }

    #[test]
    fn reads_decimal_commas_and_refuses_amounts_it_cannot_tell_apart() {
        // A comma before the last one or two digits, with no dot, marks the cents.
        assert_eq!(money("12,34", "SAR"), Ok(1234));
        assert_eq!(money("-12,5", "SAR"), Ok(-1250));
        assert_eq!(money("1.234,56", "SAR"), Ok(123456));
        assert_eq!(money("1\u{a0}234,56", "SAR"), Ok(123456));
        assert_eq!(money("1.234.567", "SAR"), Ok(123456700));
        // Commas before groups of three still separate thousands, Indian grouping included.
        assert_eq!(money("1,234", "SAR"), Ok(123400));
        assert_eq!(money("-1,234,567.89", "SAR"), Ok(-123456789));
        assert_eq!(money("1,23,456.78", "SAR"), Ok(12345678));
        assert_eq!(money("(12.34)", "SAR"), Ok(-1234));
        assert_eq!(money("12.34-", "SAR"), Ok(-1234));
        // Anything else is refused rather than guessed.
        for s in [
            "12,3456",
            "1.234",
            "1,234.567",
            "1.234,567",
            "1,23,45",
            "1,2,345",
            "12.34.56",
        ] {
            assert!(money(s, "SAR").is_err(), "{s}");
        }
        // Through a whole file: a European bank's CSV, and an OFX amount with a decimal comma.
        let b = sample();
        let r = preview(
            &b,
            "cash",
            "Date;Payee;Amount\n15/10/2026;Shop;-1.234,56\n16/10/2026;Cafe;-12,34",
            "csv",
            "dmy",
            false,
        )
        .unwrap();
        assert_eq!([r[0].amount, r[1].amount], [-123456, -1234]);
        let r = preview(
            &b,
            "cash",
            "<OFX><STMTTRN><TRNAMT>-1,25<DTPOSTED>20261015<FITID>a</STMTTRN></OFX>",
            "ofx",
            "ymd",
            false,
        )
        .unwrap();
        assert_eq!(r[0].amount, -125);
    }
    #[test]
    fn reads_amounts_written_with_a_currency_sign_or_code() {
        assert_eq!(money("$12.34", "USD"), Ok(1234));
        assert_eq!(money("-$1,234.56", "USD"), Ok(-123456));
        assert_eq!(money("$-5.00", "USD"), Ok(-500));
        assert_eq!(money("($5.00)", "USD"), Ok(-500));
        assert_eq!(money("US$12.34", "USD"), Ok(1234));
        assert_eq!(money("€5", "EUR"), Ok(500));
        assert_eq!(money("-12,34 €", "EUR"), Ok(-1234));
        assert_eq!(money("£1,000.00", "GBP"), Ok(100000));
        assert_eq!(money("12.34 USD", "USD"), Ok(1234));
        assert_eq!(money("SAR -7.50", "SAR"), Ok(-750));
        // A written code has to be the budget's own currency.
        let wrong = money("12.34 EUR", "USD").unwrap_err();
        assert!(wrong.contains("EUR") && wrong.contains("USD"), "{wrong}");
        assert!(money("12.34 DR", "USD").is_err());
        let mut b = sample();
        b.currency = "USD".into();
        let r = preview(
            &b,
            "cash",
            "Date,Payee,Amount\n2026-10-15,Shop,\"-$1,234.56\"",
            "csv",
            "ymd",
            false,
        )
        .unwrap();
        assert_eq!(r[0].amount, -123456);
    }
    #[test]
    fn finds_the_columns_under_the_names_banks_give_them() {
        let mut b = sample();
        b.currency = "USD".into();
        let read = |csv: &str| {
            let r = preview(&b, "cash", csv, "csv", "mdy", false).unwrap();
            (r[0].date.clone(), r[0].payee.clone(), r[0].amount)
        };
        let shop = || ("2026-10-14".to_string(), "Shop".to_string(), -5000);
        assert_eq!(read("Details,Posting Date,Description,Amount,Type,Balance\nDEBIT,10/14/2026,Shop,-50.00,DEBIT_CARD,100.00"), shop());
        assert_eq!(
            read("Post Date,Transaction Description,Amount\n10/14/2026,Shop,-50.00"),
            shop()
        );
        assert_eq!(
            read("Trans Date,Description,Amount\n10/14/2026,Shop,-50.00"),
            shop()
        );
        // A transaction date wins over a posting date, whichever comes first.
        assert_eq!(
            read("Post Date,Trans. Date,Description,Amount\n10/15/2026,10/14/2026,Shop,-50.00"),
            shop()
        );
        assert_eq!(
            read("Trans. Date,Post Date,Description,Amount\n10/14/2026,10/15/2026,Shop,-50.00"),
            shop()
        );
        // Apple Card's layout, with the amount column named for its currency.
        assert_eq!(
            read("Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD),Purchased By\n10/14/2026,10/15/2026,Shop,Shop Inc,Other,Purchase,-50.00,Me"),
            shop()
        );
        // The column in the budget's currency is the one read.
        assert_eq!(
            read("Date,Payee,Amount (EUR),Amount (USD)\n10/14/2026,Shop,-46.00,-50.00"),
            shop()
        );
        let wrong = preview(
            &b,
            "cash",
            "Date,Payee,Amount (EUR)\n10/14/2026,Shop,-46.00",
            "csv",
            "mdy",
            false,
        )
        .err()
        .unwrap();
        assert!(wrong.contains("EUR") && wrong.contains("USD"), "{wrong}");
    }
    #[test]
    fn flips_signs_for_cards_that_write_purchases_as_positive() {
        let b = sample();
        let csv = "Date,Description,Amount\n2026-10-15,Shop,50.00\n2026-10-16,Payment,-20.00";
        let r = preview(&b, "cash", csv, "csv", "ymd", true).unwrap();
        assert_eq!([r[0].amount, r[1].amount], [-5000, 2000]);
        let r = preview(&b, "cash", csv, "csv", "ymd", false).unwrap();
        assert_eq!([r[0].amount, r[1].amount], [5000, -2000]);
        // Outflow and Inflow columns already say which way the money went.
        let r = preview(
            &b,
            "cash",
            "Date,Payee,Outflow,Inflow\n2026-10-15,Shop,50.00,",
            "csv",
            "ymd",
            true,
        )
        .unwrap();
        assert_eq!(r[0].amount, -5000);
    }
}
