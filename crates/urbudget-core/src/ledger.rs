//! Expand split transfer legs for accounting without duplicating saved records.
use crate::domain::*;
use serde_json::{json, Value};
use std::borrow::Cow;
use std::collections::HashMap;
pub const UNCATEGORIZED_CATEGORY: &str = "__uncategorized";

/// A split's budget-side role. Missing categorization is not a deliberate RTA adjustment.
#[derive(Debug, PartialEq, Eq)]
pub enum Flow<'a> { Income, Expense(&'a str), Uncategorized, Opening }

pub fn explicitly_unassigned(t: &Transaction, s: &Split) -> bool {
    if let Some(chosen) = s.extra.get("unassigned").and_then(Value::as_bool) { return chosen; }
    let source = s.extra.get("source").filter(|v| !v.is_null()).or_else(|| {
        (t.splits.len() == 1).then(|| t.extra.get("source")).flatten()
    });
    // An arbitrary imported category ID may describe an envelope the user cleared.
    // Import normalization resolves proven RTA IDs into the boolean above.
    source.is_some_and(|v| matches!(v["category_name"].as_str(), Some("Inflow: Ready to Assign" | "Inflow: To be Budgeted")))
        || t.payee == "Reconciliation adjustment"
}

pub fn starting_balance(t: &Transaction) -> bool {
    // Imports normalize this marker before source metadata is hidden from the UI.
    // A historical payee label by itself does not establish an opening entry.
    let marked = t.extra.get("startingBalance").and_then(Value::as_bool) == Some(true);
    let payee = t.extra.get("parentPayee").and_then(Value::as_str).unwrap_or(&t.payee);
    marked && payee == "Starting Balance" && t.transfer_account_id.is_none()
        && !t.splits.is_empty() && t.splits.iter().all(|s| s.category_id.is_none()
            && transfer(s).is_none() && s.extra.get("unassigned").and_then(Value::as_bool) != Some(false))
}

pub fn classify<'a>(t: &Transaction, s: &'a Split, amount: i64) -> Flow<'a> {
    if let Some(category) = s.category_id.as_deref() { Flow::Expense(category) }
    else if starting_balance(t) { Flow::Opening }
    else if amount < 0 && !explicitly_unassigned(t, s) { Flow::Uncategorized }
    else { Flow::Income }
}

pub fn split_payee<'a>(t: &'a Transaction, s: &'a Split) -> &'a str {
    s.extra.get("payee").and_then(Value::as_str).filter(|p| !p.is_empty()).unwrap_or(&t.payee)
}
pub fn parent_id(t: &Transaction) -> &str {
    t.extra.get("parentId").and_then(Value::as_str).unwrap_or(&t.id)
}
/// Only expanded legs use parentId. A saved transaction's provider metadata
/// cannot override its own identity in report counts or cash aging.
pub fn saved_id<'a>(entry: &'a Cow<'_, Transaction>) -> &'a str {
    match entry {
        Cow::Borrowed(t) => &t.id,
        Cow::Owned(t) => parent_id(t),
    }
}
pub fn transfer(s: &Split) -> Option<&str> {
    s.extra.get("transferAccountId").and_then(Value::as_str)
}
pub fn status(s: &Split) -> Cleared {
    s.extra
        .get("transferStatus")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or(Cleared::Uncleared)
}
/// Saved transactions are borrowed; only split-transfer legs are built.
pub fn transactions(b: &Budget) -> Vec<Cow<'_, Transaction>> {
    let mut out = Vec::with_capacity(b.transactions.len());
    // Most transactions are borrowed, so build the account index only if expansion needs it.
    let mut accounts: Option<HashMap<&str, bool>> = None;
    for t in &b.transactions {
        if !t.splits.iter().any(|s| transfer(s).is_some()) {
            out.push(Cow::Borrowed(t));
            continue;
        }
        let accounts = accounts.get_or_insert_with(|| b.accounts.iter()
            .map(|a| (a.id.as_str(), a.on_budget())).collect());
        let on_budget = accounts.get(t.account_id.as_str()).copied().unwrap_or(false);
        let opening = starting_balance(t);
        out.reserve(t.splits.len());
        for (i, s) in t.splits.iter().enumerate() {
            let peer = transfer(s);
            let same_budget_side = peer.is_some_and(|other| {
                on_budget == accounts.get(other).copied().unwrap_or(false)
            });
            let splits = if same_budget_side {
                vec![]
            } else {
                let mut part = s.clone();
                if part.category_id.is_none() {
                    part.extra.insert("unassigned".into(), json!(explicitly_unassigned(t, s)));
                }
                part.extra.remove("transferAccountId");
                part.extra.remove("transferStatus");
                vec![part]
            };
            let mut extra = t.extra.clone();
            extra.insert("parentId".into(), json!(t.id));
            extra.insert("parentPayee".into(), json!(t.payee));
            extra.insert("startingBalance".into(), json!(opening));
            extra.insert("transferSource".into(),
                s.extra.get("transferSource").cloned().unwrap_or(Value::Null));
            // Construct only this leg: cloning the parent would copy all S splits S times.
            out.push(Cow::Owned(Transaction {
                id: format!("{}:leg:{i}", t.id),
                date: t.date.clone(),
                account_id: t.account_id.clone(),
                payee: split_payee(t, s).into(),
                memo: s.extra.get("memo").and_then(Value::as_str).unwrap_or(&t.memo).into(),
                amount: s.amount,
                status: t.status,
                splits,
                transfer_account_id: peer.map(String::from),
                transfer_status: peer.map(|_| status(s)),
                extra,
            }));
        }
    }
    out
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::tests::*;
    #[test]
    fn ordinary_transactions_are_borrowed_and_split_metadata_is_preserved() {
        let mut b = sample();
        b.transactions.push(purchase());
        let mut t = purchase();
        t.id = "split".into();
        t.account_id = "cash".into();
        t.memo = "Parent memo".into();
        t.status = Cleared::Reconciled;
        t.extra.insert("custom".into(), json!({"preserved":true}));
        t.splits = serde_json::from_value(json!([
            {"categoryId":"food", "amount":-3000, "memo":"Split memo", "payee":"Shop"},
            {"categoryId":null, "amount":-2000, "transferAccountId":"card",
             "transferStatus":"cleared", "transferSource":{"id":"destination"}}
        ])).unwrap();
        b.transactions.push(t);
        let before = b.clone();
        let legs = transactions(&b);
        assert_eq!(legs.len(), 3);
        assert!(matches!(&legs[0], Cow::Borrowed(t) if std::ptr::eq(*t, &b.transactions[0])));
        let expense = &legs[1];
        assert_eq!((expense.id.as_str(), expense.account_id.as_str(), expense.date.as_str()),
            ("split:leg:0", "cash", b.transactions[1].date.as_str()));
        assert_eq!((&*expense.memo, &*expense.payee, expense.status),
            ("Split memo", "Shop", Cleared::Reconciled));
        assert_eq!(expense.extra["custom"], json!({"preserved":true}));
        assert_eq!(expense.splits, b.transactions[1].splits[..1]);
        let payment = &legs[2];
        assert_eq!(payment.transfer_account_id.as_deref(), Some("card"));
        assert_eq!(payment.transfer_status, Some(Cleared::Cleared));
        assert_eq!(payment.memo, "Parent memo");
        assert_eq!(payment.extra["transferSource"], json!({"id":"destination"}));
        assert!(payment.splits.is_empty());
        assert_eq!(b, before, "expansion must never alter stored transactions or metadata");
    }
    #[test]
    #[ignore = "synthetic ledger timing; run explicitly with --ignored --nocapture"]
    fn benchmark_split_expansion() {
        for parts in [1, 10, 100] {
            let mut b = sample();
            for i in 0..1000 {
                let mut t = purchase();
                t.id = format!("synthetic-{i}");
                t.amount = -(parts as i64) * 100;
                t.splits = (0..parts).map(|n| Split {
                    category_id: (n != 0).then(|| "food".into()),
                    amount: -100,
                    extra: if n == 0 {
                        json!({"transferAccountId":"cash", "transferStatus":"uncleared"})
                            .as_object().unwrap().clone().into()
                    } else { Default::default() },
                }).collect();
                b.transactions.push(t);
            }
            validate(&b).unwrap();
            let start = std::time::Instant::now();
            let mut count = 0;
            for _ in 0..5 {
                let legs = transactions(std::hint::black_box(&b));
                count += legs.len();
                std::hint::black_box(&legs);
            }
            assert_eq!(count, 5 * 1000 * parts);
            println!("ledger expansion: 1000 parents x {parts} splits, mean {:.3} ms",
                start.elapsed().as_secs_f64() * 1000.0 / 5.0);
        }
    }
    #[test]
    fn intentional_rta_flags_and_starting_balances_survive_legacy_metadata() {
        let mut t = purchase();
        t.splits[0].category_id = None;
        assert_eq!(classify(&t, &t.splits[0], -5000), Flow::Uncategorized);
        assert_eq!(classify(&t, &t.splits[0], 5000), Flow::Income);
        t.extra.insert("source".into(), json!({"category_id":"inflow", "category_name":"Inflow: Ready to Assign"}));
        assert_eq!(classify(&t, &t.splits[0], -5000), Flow::Income);
        t.extra.insert("source".into(), json!({"category_id":"ordinary-envelope"}));
        assert_eq!(classify(&t, &t.splits[0], -5000), Flow::Uncategorized);
        t.extra.insert("source".into(), json!({"category_name":"Inflow: To be Budgeted"}));
        t.splits[0].extra.insert("source".into(), Value::Null);
        assert_eq!(classify(&t, &t.splits[0], -5000), Flow::Income);
        t.splits[0].extra.insert("unassigned".into(), json!(false));
        assert_eq!(classify(&t, &t.splits[0], -5000), Flow::Uncategorized, "a deliberate clear overrides old import metadata");
        t.splits[0].extra.remove("unassigned");
        t.extra.remove("source");
        t.payee = "Reconciliation adjustment".into();
        assert_eq!(classify(&t, &t.splits[0], -5000), Flow::Income);
        t.splits[0].extra.insert("unassigned".into(), json!(false));
        assert_eq!(classify(&t, &t.splits[0], -5000), Flow::Uncategorized);
        t.splits[0].extra.remove("unassigned");
        t.payee = "Starting Balance".into();
        t.extra.insert("source".into(), json!({"payee_name":"Starting Balance"}));
        assert_eq!(classify(&t, &t.splits[0], 5000), Flow::Income, "unverified source labels do not hide ordinary income");
        t.extra.insert("startingBalance".into(), json!(true));
        assert_eq!(classify(&t, &t.splits[0], 5000), Flow::Opening);
        t.splits[0].extra.insert("unassigned".into(), json!(false));
        assert_eq!(classify(&t, &t.splits[0], -5000), Flow::Uncategorized);
        t.splits[0].extra.remove("unassigned");
        t.payee = "Employer".into();
        assert_eq!(classify(&t, &t.splits[0], 5000), Flow::Income);
        t.payee = "Starting Balance".into();
        t.splits[0].category_id = Some("food".into());
        assert_eq!(classify(&t, &t.splits[0], 5000), Flow::Expense("food"));
        t.splits[0].category_id = None;
        t.transfer_account_id = Some("cash".into());
        assert!(!starting_balance(&t));
    }
    #[test]
    fn expanded_legs_keep_parent_classification_and_independent_payees() {
        let mut b = sample();
        let mut t = purchase();
        t.payee = "Starting Balance".into();
        t.extra.insert("startingBalance".into(), json!(true));
        t.extra.insert("source".into(), json!({"category_id":"parent-category", "category_name":"Inflow: Ready to Assign"}));
        t.splits = serde_json::from_value(json!([
            {"categoryId":"food", "amount":-1000, "payee":"Shop"},
            {"categoryId":null, "amount":-2000, "payee":"Unknown"},
            {"categoryId":null,"amount":-2000,"transferAccountId":"cash","transferStatus":"uncleared","payee":"Move"}
        ])).unwrap();
        b.transactions.push(t);
        let legs = transactions(&b);
        assert_eq!(legs.len(), 3);
        assert_eq!(legs[0].payee, "Shop");
        assert_eq!(parent_id(&legs[0]), "tx");
        assert!(!starting_balance(&legs[0]), "partial categorization invalidates the entire opening marker");
        assert_eq!(classify(&legs[1], &legs[1].splits[0], -2000), Flow::Uncategorized,
            "expansion must not make a split inherit the original multi-part parent's category");
        // The transfer is internal and carries no income/expense split.
        assert!(legs[2].splits.is_empty());
    }
    #[test]
    fn split_transfer_conserves_cash_and_clears_independently() {
        let mut b = sample();
        let mut t = purchase();
        t.account_id = "cash".into();
        t.amount = -7000;
        t.splits.push(Split {
            category_id: None,
            amount: -2000,
            extra: json!({"transferAccountId":"card","transferStatus":"uncleared"})
                .as_object()
                .unwrap()
                .clone().into(),
        });
        b.transactions.push(t);
        let s = calculate(&b, "2026-10").unwrap();
        assert_eq!(s.accounts[0].balance, 93000);
        assert_eq!(s.accounts[1].balance, -8000);
        assert_eq!(s.accounts[1].uncleared, 2000);
        assert_eq!(s.net_worth, 85000);
        assert_eq!(s.categories[0].available, 15000);
        assert_eq!(s.categories[1].activity, -2000);
        let b = reconcile(b, "card", -10000, "2026-10-15", "adjust").unwrap();
        assert_eq!(status(&b.transactions[0].splits[1]), Cleared::Uncleared);
    }
    #[test]
    fn invalid_split_transfer_is_rejected() {
        let mut b = sample();
        let mut t = purchase();
        t.splits[0]
            .extra
            .insert("transferAccountId".into(), json!("missing"));
        b.transactions.push(t);
        assert!(validate(&b).is_err());
    }
    #[test]
    fn mixed_refund_split_and_tracking_leg_preserve_net_worth() {
        let mut b = sample();
        let mut a = b.accounts[0].clone();
        a.id = "invest".into();
        a.kind = AccountKind::Tracking;
        a.opening_balance = 0;
        b.accounts.push(a);
        let mut t = purchase();
        t.account_id = "cash".into();
        t.amount = -5500;
        t.splits[0].amount = -5000;
        t.splits.push(Split {
            category_id: Some("food".into()),
            amount: 500,
            extra: Default::default(),
        });
        t.splits.push(Split {
            category_id: Some("food".into()),
            amount: -1000,
            extra: json!({"transferAccountId":"invest","transferStatus":"cleared"})
                .as_object()
                .unwrap()
                .clone().into(),
        });
        b.transactions.push(t);
        let s = calculate(&b, "2026-10").unwrap();
        assert_eq!(s.net_worth, 85500);
        assert_eq!(s.categories[0].activity, -5500);
        assert_eq!(s.accounts[2].cleared, 1000);
    }
}
