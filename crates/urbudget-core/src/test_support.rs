//! Deterministic fixtures shared by desktop and core regression tests.
use crate::domain::*;
use serde_json::Map;

pub fn sample() -> Budget {
    Budget {
        accounts: vec![
            Account {
                extra: Map::new(),
                id: "cash".into(),
                name: "Cash".into(),
                kind: AccountKind::Cash,
                opening_balance: 100_000,
                archived: false,
            },
            Account {
                extra: Map::new(),
                id: "card".into(),
                name: "Card".into(),
                kind: AccountKind::Credit,
                opening_balance: -10_000,
                archived: false,
            },
        ],
        categories: vec![
            Category {
                extra: Map::new(),
                id: "food".into(),
                name: "Food".into(),
                group: "Living".into(),
                target: 20_000,
            },
            Category {
                extra: serde_json::json!({"paymentAccountId":"card"})
                    .as_object()
                    .unwrap()
                    .clone(),
                id: "payment".into(),
                name: "Card payment".into(),
                group: "Credit Card Payments".into(),
                target: 0,
            },
        ],
        assignments: vec![Assignment { extra: Default::default(),
            month: "2026-10".into(),
            category_id: "food".into(),
            amount: 20_000,
        }],
        ..Budget::default()
    }
}
pub fn purchase() -> Transaction {
    Transaction {
        extra: Default::default(),
        id: "tx".into(),
        date: "2026-10-15".into(),
        account_id: "card".into(),
        payee: "Shop".into(),
        memo: String::new(),
        amount: -5_000,
        status: Cleared::Cleared,
        splits: vec![Split {
            extra: Default::default(),
            category_id: Some("food".into()),
            amount: -5_000,
        }],
        transfer_account_id: None,
        transfer_status: None,
    }
}
