//! A proposal is a change the assistant prepared on a copy of the budget, waiting for the user.
//! It keeps the change itself (so it can run again on the budget as it is when applied) and the
//! patch it made when proposed. Applying runs the change again: if the patch is the same, it is
//! applied; if the budget moved underneath it, the card is refreshed for another look instead.
use super::attachments::{Expected, ImportRow};
use super::tools::Names;
use super::workbook::WorkbookDoc;
use super::{money, new_id};
use crate::domain::*;
use crate::i18n::{comma, list_separator};
use crate::patch::Patch;
use crate::{bank_import, engine, ledger, loans, t, workflows};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Move {
    /// None is Ready to Assign.
    pub from: Option<String>,
    pub to: Option<String>,
    pub amount: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub id: String,
    /// Some(None) sets Ready to Assign.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payee: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleared: Option<bool>,
    #[serde(default)]
    pub approve: bool,
    /// Some(None) removes the flag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flag: Option<Option<String>>,
    #[serde(default)]
    pub unsure: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NewTransaction {
    /// Chosen once, so applying later makes the same records the card showed.
    pub id: String,
    pub date: String,
    pub payee: String,
    pub memo: String,
    pub amount: i64,
    pub cleared: bool,
    /// (category, amount, memo); a None category is Ready to Assign.
    pub splits: Vec<(Option<String>, i64, String)>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rename {
    pub from: String,
    pub to: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    pub id: String,
    #[serde(rename = "match")]
    pub matching: String,
    pub payee: String,
    pub category: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Change {
    Moves { month: String, moves: Vec<Move> },
    AutoAssign { month: String, method: String, categories: Vec<String> },
    Edits { edits: Vec<Edit>, rules: Vec<Rule> },
    #[serde(rename_all = "camelCase")]
    Add { account: String, transactions: Vec<NewTransaction>, from_file: bool },
    Payees { renames: Vec<Rename>, rules: Vec<Rule> },
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Proposed,
    Applied,
    Discarded,
    Undone,
    /// The budget changed and the change can't be made any more.
    Failed,
}

/// A converted statement, ready for the import review.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportFile {
    pub account: String,
    pub source: String,
    pub rows: Vec<ImportRow>,
}
impl ImportFile {
    /// The CSV the bank import reads: ISO dates and one signed amount column.
    pub fn csv(&self) -> Result<String, String> {
        let mut w = csv::Writer::from_writer(vec![]);
        w.write_record(["Date", "Payee", "Memo", "Amount"]).map_err(|e| e.to_string())?;
        for r in &self.rows {
            w.write_record([r.date.as_str(), r.payee.as_str(), r.memo.as_str(), money(r.amount).as_str()])
                .map_err(|e| e.to_string())?;
        }
        String::from_utf8(w.into_inner().map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// A signed amount: the change for budget moves, the transaction amount otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
    /// "warn" for a badge the user should look at.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<String>,
    #[serde(default)]
    pub indent: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<i64>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub month: Option<String>,
    #[serde(default)]
    pub categories: Vec<String>,
    #[serde(default)]
    pub transactions: Vec<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub kicker: String,
    pub rows: Vec<Row>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<Row>,
    #[serde(default)]
    pub stats: Vec<Stat>,
    /// A check that passed (true) or failed (false), with what it compared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<(bool, String)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Rows left off the card.
    #[serde(default)]
    pub more: usize,
    #[serde(default)]
    pub highlight: Highlight,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub title: String,
    /// "budget", "transactions", "payees", "import", "report" or "spreadsheet".
    pub kind: String,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change: Option<Change>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import: Option<ImportFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub report: Option<ReportDoc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workbook: Option<WorkbookDoc>,
    /// The spreadsheet file last saved from this card, reused by Open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved: Option<String>,
    /// The patch the change made when proposed, without timestamps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<Value>,
    pub card: Card,
    /// What the model is told about the card.
    pub summary: Value,
    /// Why it couldn't be applied, when it can't.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

const MAX_ROWS: usize = 12;

/// A report the assistant wrote, for the user to preview and save as a PDF.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReportDoc {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period: Option<String>,
    /// Markdown: headings, paragraphs, lists and tables.
    pub body: String,
    pub created: String,
}

/// A report card: its sections as rows, ready to preview or save.
pub fn build_report(title: String, period: Option<String>, body: String) -> Proposal {
    let sections: Vec<String> = body
        .lines()
        .filter_map(|l| l.trim_start().strip_prefix('#'))
        .map(|h| h.trim_start_matches('#').trim().trim_end_matches('#').trim().to_owned())
        .filter(|h| !h.is_empty())
        .collect();
    let tables = body.lines().filter(|l| l.trim_start().starts_with("|---") || l.trim_start().starts_with("| ---")).count();
    let mut rows: Vec<Row> = sections.iter().map(|s| Row { label: s.clone(), ..Row::default() }).collect();
    let more = rows.len().saturating_sub(MAX_ROWS);
    rows.truncate(MAX_ROWS);
    let words = body.split_whitespace().count();
    let mut stats = vec![];
    if let Some(p) = &period {
        stats.push(Stat { label: t!("Period"), text: Some(p.clone()), amount: None });
    }
    stats.push(Stat { label: t!("Length"), text: Some(t!("{n} words", n = words)), amount: None });
    if tables > 0 {
        stats.push(Stat { label: t!("Tables"), text: Some(tables.to_string()), amount: None });
    }
    let card = Card {
        kicker: t!("Report"),
        rows,
        stats,
        note: Some(t!("Preview it, then save it as a PDF from the print dialog.")),
        more,
        ..Card::default()
    };
    let summary = json!({ "title": title, "sections": sections, "words": words });
    Proposal {
        id: new_id("p"),
        title: title.clone(),
        kind: "report".into(),
        status: Status::Proposed,
        change: None,
        import: None,
        report: Some(ReportDoc { title, period, body, created: super::now() }),
        workbook: None,
        saved: None,
        expected: None,
        card,
        summary,
        problem: None,
    }
}

impl Change {
    pub fn kind(&self) -> &'static str {
        match self {
            Change::Moves { .. } | Change::AutoAssign { .. } => "budget",
            Change::Edits { .. } | Change::Add { .. } => "transactions",
            Change::Payees { .. } => "payees",
        }
    }
    /// The budget after the change, or why it can't be made.
    pub fn run(&self, mut b: Budget) -> Result<Budget, String> {
        match self {
            Change::Moves { month, moves } => {
                for m in moves {
                    let source = Names::new(&b).category_shown(m.from.as_deref());
                    b = workflows::apply(
                        b,
                        &json!({
                            "type": "moveMoney",
                            "month": month,
                            "from": m.from.as_deref().unwrap_or("__rta"),
                            "to": m.to.as_deref().unwrap_or("__rta"),
                            "amount": m.amount,
                        }),
                    )
                    .map_err(|e| t!("Moving {amount} from {source}: {problem}", amount = money(m.amount), source, problem = e))?;
                }
            }
            Change::AutoAssign { month, method, categories } => {
                b = workflows::apply(
                    b,
                    &json!({ "type": "autoAssign", "month": month, "mode": method, "categories": categories }),
                )?;
            }
            Change::Edits { edits, rules } => {
                for e in edits {
                    let t = b
                        .transactions
                        .iter_mut()
                        .find(|t| t.id == e.id)
                        .ok_or_else(|| t!("A transaction in this proposal was deleted."))?;
                    if let Some(category) = &e.category {
                        if t.transfer_account_id.is_some() || t.splits.len() != 1 || ledger::transfer(&t.splits[0]).is_some() {
                            return Err(t!("{payee} on {date} is now a split or a transfer.", payee = t.payee, date = t.date));
                        }
                        t.splits[0].category_id = category.clone();
                    }
                    if let Some(p) = &e.payee {
                        t.payee = p.clone();
                    }
                    if let Some(m) = &e.memo {
                        t.memo = m.clone();
                    }
                    if let Some(c) = e.cleared {
                        if t.status != Cleared::Reconciled {
                            t.status = if c { Cleared::Cleared } else { Cleared::Uncleared };
                        }
                    }
                    if e.approve {
                        t.extra.insert("approved".into(), json!(true));
                    }
                    if let Some(flag) = &e.flag {
                        t.extra.insert("flag".into(), json!(flag));
                    }
                }
                add_rules(&mut b, rules);
            }
            Change::Add { account, transactions, .. } => {
                let mut ids = HashSet::new();
                let now = stamp_now();
                for n in transactions {
                    let mut t = Transaction {
                        extra: serde_json::Map::from_iter([
                            ("approved".to_string(), json!(true)),
                            ("createdAt".to_string(), json!(now)),
                        ])
                        .into(),
                        id: n.id.clone(),
                        date: n.date.clone(),
                        account_id: account.clone(),
                        payee: n.payee.clone(),
                        memo: n.memo.clone(),
                        amount: n.amount,
                        status: if n.cleared { Cleared::Cleared } else { Cleared::Uncleared },
                        splits: n
                            .splits
                            .iter()
                            .map(|(category, amount, memo)| Split {
                                extra: if memo.is_empty() {
                                    Default::default()
                                } else {
                                    serde_json::Map::from_iter([("memo".to_string(), json!(memo))]).into()
                                },
                                category_id: category.clone(),
                                amount: *amount,
                            })
                            .collect(),
                        transfer_account_id: None,
                        transfer_status: None,
                    };
                    workflows::apply_payee_rules(&b, &mut t);
                    ids.insert(t.id.clone());
                    b.transactions.push(t);
                }
                loans::apply_new_payments(&mut b, &ids)?;
            }
            Change::Payees { renames, rules } => {
                for r in renames {
                    b = workflows::apply(b, &json!({ "type": "renamePayee", "from": r.from, "to": r.to }))?;
                }
                add_rules(&mut b, rules);
            }
        }
        validate(&b)?;
        Ok(b)
    }
}

fn add_rules(b: &mut Budget, rules: &[Rule]) {
    if rules.is_empty() {
        return;
    }
    let list = b.extra.entry("payeeRules").or_insert(json!([]));
    if !list.is_array() {
        *list = json!([]);
    }
    if let Some(list) = list.as_array_mut() {
        for r in rules {
            list.push(json!({ "id": r.id, "match": r.matching, "payee": r.payee, "categoryId": r.category }));
        }
    }
}

/// The patch as JSON, without the timestamps budget moves log or the times new transactions
/// were added, for comparing two runs.
pub fn normalize(patch: &Patch) -> Value {
    let mut v = serde_json::to_value(patch).unwrap_or(Value::Null);
    if let Some(set) = v.pointer_mut("/extras/set").and_then(Value::as_object_mut) {
        set.remove("moneyMoves");
    }
    if let Some(upsert) = v.pointer_mut("/transactions/upsert").and_then(Value::as_array_mut) {
        for t in upsert.iter_mut().filter_map(Value::as_object_mut) {
            t.remove("createdAt");
        }
    }
    v
}

pub fn build(change: Change, title: String, before: &Budget) -> Result<Proposal, String> {
    let after = change.run(before.clone())?;
    let patch = Patch::diff(before, &after);
    if patch.is_empty() {
        return Err(t!("That wouldn't change anything."));
    }
    let card = card(&change, before, &after)?;
    let summary = summary(&title, &card);
    Ok(Proposal {
        id: new_id("p"),
        title,
        kind: change.kind().into(),
        status: Status::Proposed,
        expected: Some(normalize(&patch)),
        import: None,
        report: None,
        workbook: None,
        saved: None,
        change: Some(change),
        card,
        summary,
        problem: None,
    })
}

pub enum Recheck {
    /// Still the same change: apply this patch.
    Same(Patch),
    /// The budget moved; the proposal now looks like this.
    Changed(Proposal),
}

/// Runs a proposal again on the budget as it is now.
pub fn recheck(p: &Proposal, current: &Budget) -> Recheck {
    let mut refreshed = p.clone();
    let Some(change) = &p.change else {
        refreshed.status = Status::Failed;
        refreshed.problem = Some(if p.report.is_some() { t!("A report doesn't change the budget.") } else { t!("Open the import review to add these.") });
        return Recheck::Changed(refreshed);
    };
    match change.run(current.clone()) {
        Ok(after) => {
            let patch = Patch::diff(current, &after);
            let normalized = normalize(&patch);
            if p.expected.as_ref() == Some(&normalized) {
                return Recheck::Same(patch);
            }
            if patch.is_empty() {
                refreshed.status = Status::Failed;
                refreshed.problem = Some(t!("Your budget already has these changes."));
                return Recheck::Changed(refreshed);
            }
            match card(change, current, &after) {
                Ok(c) => {
                    refreshed.summary = summary(&refreshed.title, &c);
                    refreshed.card = c;
                    refreshed.expected = Some(normalized);
                    refreshed.problem = Some(t!("Your budget changed since this was proposed, so it was updated. Check it, then apply."));
                }
                Err(e) => {
                    refreshed.status = Status::Failed;
                    refreshed.problem = Some(e);
                }
            }
            Recheck::Changed(refreshed)
        }
        Err(e) => {
            refreshed.status = Status::Failed;
            refreshed.problem = Some(t!("This can't be applied any more: {problem}", problem = e));
            Recheck::Changed(refreshed)
        }
    }
}

fn summary(title: &str, card: &Card) -> Value {
    let row = |r: &Row| {
        let mut v = json!({ "label": r.label });
        if let Some(d) = &r.detail {
            v["detail"] = json!(d);
        }
        if let Some(a) = r.amount {
            v["amount"] = json!(money(a));
        }
        if let (Some(b), Some(a)) = (r.before, r.after) {
            v["before"] = json!(money(b));
            v["after"] = json!(money(a));
        }
        if let Some(b) = &r.badge {
            v["badge"] = json!(b);
        }
        v
    };
    json!({
        "title": title,
        "rows": card.rows.iter().map(row).collect::<Vec<_>>(),
        "total": card.total.as_ref().map(row),
        "rowsNotShown": card.more,
        "stats": card.stats.iter().map(|s| json!({ "label": s.label, "value": s.text.clone().or(s.amount.map(money)) })).collect::<Vec<_>>(),
        "check": card.check.as_ref().map(|(ok, text)| json!({ "passed": ok, "text": text })),
        "warning": card.warning,
        "note": card.note,
    })
}

fn card(change: &Change, before: &Budget, after: &Budget) -> Result<Card, String> {
    let names = Names::new(after);
    match change {
        Change::Moves { month, .. } | Change::AutoAssign { month, .. } => {
            let (sb, sa) = (engine::calculate(before, month)?, engine::calculate(after, month)?);
            let mut rows = vec![];
            for c in &after.categories {
                let (Some(b), Some(a)) = (
                    sb.categories.iter().find(|s| s.id == c.id),
                    sa.categories.iter().find(|s| s.id == c.id),
                ) else {
                    continue;
                };
                if a.assigned != b.assigned {
                    rows.push(Row {
                        label: c.name.clone(),
                        amount: Some(a.assigned - b.assigned),
                        before: Some(b.available),
                        after: Some(a.available),
                        ..Row::default()
                    });
                }
            }
            if rows.is_empty() {
                return Err(t!("That wouldn't change any category."));
            }
            let highlight = Highlight {
                month: Some(month.clone()),
                categories: after
                    .categories
                    .iter()
                    .filter(|c| rows.iter().any(|r| r.label == c.name))
                    .map(|c| c.id.clone())
                    .collect(),
                transactions: vec![],
            };
            let more = rows.len().saturating_sub(MAX_ROWS);
            rows.truncate(MAX_ROWS);
            Ok(Card {
                kicker: t!("Proposal · Budget"),
                rows,
                total: Some(Row {
                    label: t!("Ready to assign"),
                    amount: Some(sa.ready_to_assign - sb.ready_to_assign),
                    before: Some(sb.ready_to_assign),
                    after: Some(sa.ready_to_assign),
                    ..Row::default()
                }),
                warning: (sa.ready_to_assign < 0 && sb.ready_to_assign >= 0)
                    .then(|| t!("This would assign more than you have ready to assign.")),
                more,
                highlight,
                ..Card::default()
            })
        }
        Change::Edits { edits, rules } => {
            let by_id: std::collections::HashMap<&str, &Transaction> =
                before.transactions.iter().map(|t| (t.id.as_str(), t)).collect();
            let mut rows = vec![];
            let mut ruled = HashSet::new();
            for e in edits {
                let Some(old) = by_id.get(e.id.as_str()) else { continue };
                let new = after.transactions.iter().find(|t| t.id == e.id).unwrap_or(old);
                let mut parts = vec![];
                if e.category.is_some() {
                    parts.push(names.category_label_shown(new));
                }
                if e.payee.is_some() && new.payee != old.payee {
                    parts.push(t!("Payee: {payee}", payee = new.payee));
                }
                if e.memo.is_some() {
                    parts.push(if new.memo.is_empty() { t!("Clear memo") } else { t!("Memo: {memo}", memo = super::tools::truncate(&new.memo, 30)) });
                }
                if let Some(c) = e.cleared {
                    parts.push(if c { t!("Cleared") } else { t!("Uncleared") });
                }
                if e.approve {
                    parts.push(t!("Approve"));
                }
                if let Some(f) = &e.flag {
                    parts.push(f.as_ref().map_or_else(|| t!("Remove flag"), |f| flag_label(f)));
                }
                let rule = rules.iter().find(|r| new.payee.to_lowercase().contains(&r.matching.to_lowercase()));
                if let Some(r) = rule {
                    ruled.insert(r.id.clone());
                }
                rows.push(Row {
                    label: format!("{} · {}", new.payee, short_date(&new.date)),
                    detail: Some(parts.join(" · ")),
                    amount: Some(new.amount),
                    badge: if e.unsure {
                        Some(t!("Check this"))
                    } else {
                        rule.map(|_| t!("+ rule"))
                    },
                    tone: e.unsure.then(|| "warn".into()),
                    ..Row::default()
                });
            }
            for r in rules.iter().filter(|r| !ruled.contains(&r.id)) {
                rows.push(rule_row(r, &names));
            }
            let more = rows.len().saturating_sub(MAX_ROWS);
            rows.truncate(MAX_ROWS);
            let unsure = edits.iter().filter(|e| e.unsure).count();
            Ok(Card {
                kicker: t!("Proposal · Transactions"),
                rows,
                note: (unsure > 0).then(|| t!("{n|# is|# are} marked to check.", n = unsure)),
                more,
                highlight: Highlight { transactions: edits.iter().map(|e| e.id.clone()).collect(), ..Highlight::default() },
                ..Card::default()
            })
        }
        Change::Add { account, transactions, from_file } => {
            let mut rows = vec![];
            for n in transactions {
                let t = after.transactions.iter().find(|t| t.id == n.id).ok_or_else(|| t!("Missing new transaction"))?;
                if transactions.len() == 1 {
                    for s in &t.splits {
                        rows.push(Row {
                            label: names.category_shown(s.category_id.as_deref()),
                            detail: s.extra.get("memo").and_then(Value::as_str).map(str::to_owned),
                            amount: Some(s.amount),
                            ..Row::default()
                        });
                    }
                } else {
                    rows.push(Row {
                        label: format!("{} · {}", t.payee, short_date(&t.date)),
                        detail: Some(names.category_label_shown(t)),
                        amount: Some(t.amount),
                        ..Row::default()
                    });
                }
            }
            let more = rows.len().saturating_sub(MAX_ROWS);
            rows.truncate(MAX_ROWS);
            let mut stats = vec![];
            if transactions.len() == 1 {
                let t = &transactions[0];
                stats.push(Stat { label: t!("Payee"), text: Some(t.payee.clone()), amount: None });
                stats.push(Stat { label: t!("Date"), text: Some(short_date(&t.date)), amount: None });
                stats.push(Stat { label: t!("Amount"), text: None, amount: Some(t.amount) });
            }
            Ok(Card {
                kicker: t!("Proposal · {account}", account = names.account(account)),
                rows,
                stats,
                warning: from_file.then(|| t!("Read from a file. Check the amounts.")),
                more,
                ..Card::default()
            })
        }
        Change::Payees { renames, rules } => {
            let mut rows = vec![];
            for r in renames {
                let count = before.transactions.iter().filter(|t| t.payee == r.from).count();
                rows.push(Row {
                    label: t!("{from} → {to}", from = r.from, to = r.to),
                    detail: Some(t!("{n|# transaction|# transactions}", n = count)),
                    ..Row::default()
                });
            }
            for r in rules {
                rows.push(rule_row(r, &names));
            }
            let more = rows.len().saturating_sub(MAX_ROWS);
            rows.truncate(MAX_ROWS);
            Ok(Card { kicker: t!("Proposal · Payees"), rows, more, ..Card::default() })
        }
    }
}

fn rule_row(r: &Rule, names: &Names) -> Row {
    let mut parts = vec![];
    if !r.payee.is_empty() {
        parts.push(t!("rename to {payee}", payee = r.payee));
    }
    if r.category.is_some() {
        parts.push(names.category_shown(r.category.as_deref()));
    }
    Row {
        label: t!("New rule: payees containing \u{201c}{text}\u{201d}", text = r.matching),
        detail: (!parts.is_empty()).then(|| parts.join(" · ")),
        badge: Some(t!("rule")),
        ..Row::default()
    }
}
/// A flag as a card names it: "Red flag".
fn flag_label(color: &str) -> String {
    match color {
        "red" => t!("Red flag"),
        "orange" => t!("Orange flag"),
        "yellow" => t!("Yellow flag"),
        "green" => t!("Green flag"),
        "blue" => t!("Blue flag"),
        "purple" => t!("Purple flag"),
        other => t!("{color} flag", color = capitalize(other)),
    }
}
fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next().map_or(String::new(), |f| f.to_uppercase().collect::<String>() + c.as_str())
}
fn short_date(date: &str) -> String {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_or_else(|_| date.to_owned(), crate::i18n::day_month)
}

/// A proposal to open the import review with converted rows.
#[allow(clippy::too_many_arguments)]
pub fn build_import(
    account: &str,
    account_name: &str,
    source: &str,
    rows: Vec<ImportRow>,
    expected: Expected,
    skipped: Vec<String>,
    mapped: bool,
    budget: &Budget,
) -> Result<Proposal, String> {
    let file = ImportFile { account: account.into(), source: source.into(), rows };
    let outflow: i64 = file.rows.iter().filter(|r| r.amount < 0).map(|r| -r.amount).sum();
    let inflow: i64 = file.rows.iter().filter(|r| r.amount > 0).map(|r| r.amount).sum();
    let first = file.rows.iter().map(|r| r.date.as_str()).min().unwrap_or_default();
    let last = file.rows.iter().map(|r| r.date.as_str()).max().unwrap_or_default();
    let preview = bank_import::preview(budget, account, &file.csv()?, "csv", "ymd", false)?;
    let duplicates = preview.iter().filter(|r| r.duplicate).count();
    let matches = preview.iter().filter(|r| !r.duplicate && !r.candidates.is_empty()).count();
    let mut problems = vec![];
    if let Some(n) = expected.count.filter(|n| *n != file.rows.len()) {
        problems.push(t!("{expected} rows expected, {found} found", expected = n, found = file.rows.len()));
    }
    if let Some(x) = expected.outflow.filter(|x| *x != outflow) {
        problems.push(t!("money out {expected} expected, {found} found", expected = money(x), found = money(outflow)));
    }
    if let Some(x) = expected.inflow.filter(|x| *x != inflow) {
        problems.push(t!("money in {expected} expected, {found} found", expected = money(x), found = money(inflow)));
    }
    let checked = expected.count.is_some() || expected.outflow.is_some() || expected.inflow.is_some();
    let check = if checked {
        Some(if problems.is_empty() {
            (true, t!("Totals match the statement"))
        } else {
            (false, t!("Doesn't match the statement: {problems}", problems = problems.join(list_separator())))
        })
    } else if mapped {
        Some((true, t!("Every row converted from the sheet's own columns")))
    } else {
        None
    };
    let mut notes = vec![];
    if duplicates + matches > 0 {
        let mut parts = vec![];
        if duplicates > 0 {
            parts.push(t!("{n|# looks like a duplicate|# look like duplicates}", n = duplicates));
        }
        if matches > 0 {
            parts.push(t!("{n|# matches an existing entry|# match existing entries}", n = matches));
        }
        notes.push(t!("In the review: {parts}.", parts = parts.join(comma())));
    } else {
        notes.push(t!("The import review shows each row before anything is added."));
    }
    if !skipped.is_empty() {
        let shown: Vec<_> = skipped.iter().take(4).cloned().collect();
        let rows = format!("{}{}", shown.join(list_separator()), if skipped.len() > 4 { "…" } else { "" });
        notes.push(t!("Left out {n|# row|# rows}: {rows}.", n = skipped.len(), rows));
    }
    let card = Card {
        kicker: t!("Import file · {account}", account = account_name),
        rows: vec![],
        stats: vec![
            Stat { label: t!("Dates"), text: Some(format!("{} – {}", short_date(first), short_date(last))), amount: None },
            Stat { label: t!("Outflow"), text: None, amount: Some(outflow) },
            Stat { label: t!("Inflow"), text: None, amount: Some(inflow) },
        ],
        check,
        warning: (!mapped).then(|| t!("Read by the assistant. Check the amounts in the review.")),
        note: Some(notes.join(" ")),
        ..Card::default()
    };
    let title = t!("{n|# transaction|# transactions} ready to review", n = file.rows.len());
    let mut summary = summary(&title, &card);
    summary["duplicates"] = json!(duplicates);
    summary["matchesExisting"] = json!(matches);
    summary["skippedRows"] = json!(skipped);
    Ok(Proposal {
        id: new_id("p"),
        title,
        kind: "import".into(),
        status: Status::Proposed,
        change: None,
        import: Some(file),
        report: None,
        workbook: None,
        saved: None,
        expected: None,
        card,
        summary,
        problem: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assistant::tools::tests::sample;

    #[test]
    fn covering_overspending_shows_before_and_after() {
        let b = sample();
        let change = Change::Moves {
            month: "2026-10".into(),
            moves: vec![Move { from: None, to: Some("dining".into()), amount: 24000 }],
        };
        let p = build(change, "Cover dining".into(), &b).unwrap();
        assert_eq!(p.card.rows[0].label, "Dining out");
        assert_eq!(p.card.rows[0].before, Some(-24000));
        assert_eq!(p.card.rows[0].after, Some(0));
        assert_eq!(p.card.total.as_ref().unwrap().amount, Some(-24000));
        assert_eq!(p.card.highlight.categories, vec!["dining".to_string()]);
    }

    #[test]
    fn applying_again_on_the_same_budget_is_the_same_change() {
        let b = sample();
        let change = Change::Moves {
            month: "2026-10".into(),
            moves: vec![Move { from: None, to: Some("dining".into()), amount: 24000 }],
        };
        let p = build(change, "Cover dining".into(), &b).unwrap();
        match recheck(&p, &b) {
            Recheck::Same(patch) => {
                let mut after = b.clone();
                patch.apply(&mut after);
                assert_eq!(engine::calculate(&after, "2026-10").unwrap().categories.iter().find(|c| c.id == "dining").unwrap().available, 0);
            }
            Recheck::Changed(_) => panic!("expected the same change"),
        }
    }

    #[test]
    fn an_edit_to_the_same_row_makes_the_proposal_out_of_date() {
        let b = sample();
        let change = Change::Edits {
            edits: vec![Edit {
                id: "t2".into(),
                category: Some(Some("coffee".into())),
                payee: None,
                memo: None,
                cleared: None,
                approve: true,
                flag: None,
                unsure: false,
            }],
            rules: vec![Rule { id: "r1".into(), matching: "bakery".into(), payee: String::new(), category: Some("coffee".into()) }],
        };
        let p = build(change, "Categorize".into(), &b).unwrap();
        assert_eq!(p.card.rows[0].badge.as_deref(), Some("+ rule"));
        let mut edited = b.clone();
        edited.transactions[1].memo = "changed".into();
        assert!(matches!(recheck(&p, &edited), Recheck::Changed(_)));
        assert!(matches!(recheck(&p, &b), Recheck::Same(_)));
    }

    #[test]
    fn a_new_receipt_keeps_its_id_and_splits() {
        let b = sample();
        let change = Change::Add {
            account: "checking".into(),
            transactions: vec![NewTransaction {
                id: "new1".into(),
                date: "2026-10-15".into(),
                payee: "Corner Market".into(),
                memo: String::new(),
                amount: -18640,
                cleared: false,
                splits: vec![(Some("groceries".into()), -14290, String::new()), (Some("dining".into()), -4350, String::new())],
            }],
            from_file: true,
        };
        let p = build(change, "Receipt".into(), &b).unwrap();
        assert_eq!(p.card.rows.len(), 2);
        assert!(p.card.warning.is_some());
        let Recheck::Same(patch) = recheck(&p, &b) else { panic!() };
        // It's added when it's applied; that time isn't part of what was proposed.
        let mut later = patch.clone();
        let new = &mut later.transactions.as_mut().unwrap().upsert[0];
        assert!(new.created_at().is_some());
        new.set_created_at("2099-01-01T00:00:00.000Z");
        assert_eq!(normalize(&later), normalize(&patch));
        let mut after = b.clone();
        patch.apply(&mut after);
        assert!(after.transactions.iter().any(|t| t.id == "new1" && t.splits.len() == 2));
        // Once applied, applying again can't add it twice.
        assert!(matches!(recheck(&p, &after), Recheck::Changed(ref r) if r.status == Status::Failed));
    }

    #[test]
    fn imports_check_totals_against_the_statement() {
        let b = sample();
        let rows = vec![
            ImportRow { date: "2026-10-01".into(), payee: "Salary".into(), memo: String::new(), amount: 500000 },
            ImportRow { date: "2026-10-03".into(), payee: "Bistro".into(), memo: String::new(), amount: -124000 },
        ];
        let p = build_import(
            "checking",
            "Everyday",
            "statement.xlsx",
            rows.clone(),
            Expected { count: Some(2), outflow: Some(124000), inflow: Some(500000) },
            vec![],
            true,
            &b,
        )
        .unwrap();
        assert_eq!(p.card.check, Some((true, "Totals match the statement".into())));
        let bad = build_import("checking", "Everyday", "s", rows, Expected { count: Some(3), ..Expected::default() }, vec![], false, &b).unwrap();
        assert!(!bad.card.check.unwrap().0);
        assert!(p.import.unwrap().csv().unwrap().starts_with("Date,Payee,Memo,Amount"));
    }
}
