//! A bank file as lines, each with what became of it: read, needing attention (a cell that doesn't
//! read, with why), or left out (pending, another account, a balance… with why). Nothing a line
//! holds stops the others from reading; only problems with the whole file (no date column, an
//! unreadable file) are errors.
use serde::{Deserialize, Serialize};

/// A part of a transaction a line gives.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Field {
    Date,
    Payee,
    Memo,
    Amount,
}

/// Why a line isn't imported unless someone includes it (where that makes sense).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    /// Not booked yet: it can come back booked on another day or for another sum.
    Pending,
    /// Declined, failed, reversed or cancelled: the money never moved.
    Declined,
    /// Another account's, in a file with several.
    OtherAccount,
    /// In another currency than the budget's.
    OtherCurrency,
    /// Money moved between the holder's own balances (Alipay's 不计收支, WeChat's "/").
    OwnBalances,
    /// An opening or closing balance, or a total, written as a row.
    Balance,
    /// Above the header row: an account summary or a title.
    AboveHeader,
    /// No date where the date goes: a note, or a pending row without its date yet.
    NoDate,
    /// No amount: a row that states something rather than moving money.
    NoAmount,
    /// Nothing moved: a card check, a statement closing.
    Zero,
    /// A correction removed it (OFX), or it corrects another.
    Corrected,
    /// The header row again, as some banks write before each account's rows.
    RepeatedHeader,
    /// One of a batch's payments, imported as the batch's one entry.
    InWholeBatch,
}
impl Reason {
    /// Whether "Include anyway" makes sense: the line then reads like any other, and needs fixing
    /// where it still lacks something (a date, an amount in the budget's currency).
    pub fn includable(self) -> bool {
        matches!(self, Reason::Pending | Reason::Declined | Reason::OtherCurrency | Reason::OwnBalances | Reason::Balance | Reason::NoDate | Reason::NoAmount)
    }
}

/// What became of a line.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Status {
    Ready,
    /// A part that doesn't read, in which column where the file has columns, and why.
    #[serde(rename_all = "camelCase")]
    Attention { field: Field, column: Option<usize>, reason: String },
    #[serde(rename_all = "camelCase")]
    LeftOut { reason: Reason, detail: String },
}

/// Words a state column uses for a payment that never went through, rather than one not booked
/// yet (after `plain`).
pub(crate) const DECLINED: &[&str] = &[
    "reverted", "declined", "failed", "cancelled", "canceled", "rejected", "void", "voided", "storniert", "abgelehnt",
    "geweigerd", "交易关闭",
];
