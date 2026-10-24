//! Statements in the layouts real banks export (made-up transactions), read as an import would:
//! the date order and signs the file suggests, then every row. Each file's total matches the
//! balances the bank printed in it, where it printed them, and one payee shows the right column.
//! Each file's bytes become text as the apps have the engine do it (`bank_csv::read_statement`):
//! some are in Shift_JIS, GBK or Windows-1251, as those banks write them, some are Excel workbooks
//! or a ZIP of statements. Beside the CSVs, statements in the
//! banks' exchange formats: CAMT.052/053, MT940, OFX and QIF.
mod common;

use common::*;
use urbudget_core::bank_csv;
use urbudget_core::bank_import::{self, Row};

/// A bank's CSV or workbook read as an import would: the date order and signs the file suggests.
fn read_bank(file: &str, currency: &str, account: &str) -> Vec<Row> {
    let csv = text(&csv_name(file));
    let b = budget(currency);
    let layout = bank_csv::layout(&b, account, &csv, None).unwrap();
    let order = layout.date_format.unwrap_or_else(|| "ymd".into());
    bank_import::preview(&b, account, &csv, "csv", &order, layout.flip_signs).unwrap_or_else(|e| panic!("{file}: {e}"))
}
fn read_statement(file: &str, format: &str, order: &str, currency: &str) -> Vec<Row> {
    bank_import::preview(&budget(currency), "main", &text(file), format, order, false).unwrap_or_else(|e| panic!("{file}: {e}"))
}

#[test]
fn reads_banks_exports_as_they_come() {
    for &(file, currency, account, count, total, payee) in BANKS {
        let rows = read_bank(file, currency, account);
        assert_eq!(rows.len(), count, "{file}");
        assert_eq!(rows.iter().map(|r| r.amount).sum::<i64>(), total, "{file}");
        assert!(rows.iter().any(|r| r.payee == payee), "{file}: no {payee:?} in {:?}", rows.iter().map(|r| &r.payee).collect::<Vec<_>>());
        assert!(rows.iter().all(|r| r.date.starts_with("2026-")), "{file}");
    }
}

#[test]
fn reads_banks_statement_formats() {
    for &(file, format, order, currency, count, total, payee) in STATEMENTS {
        let text = text(file);
        // Chosen as a CSV, the file says what it is.
        assert_eq!(bank_csv::layout(&budget(currency), "main", &text, None).unwrap().format, format.replace("qfx", "ofx"), "{file}");
        let rows = read_statement(file, format, order, currency);
        assert_eq!(rows.len(), count, "{file}");
        assert_eq!(rows.iter().map(|r| r.amount).sum::<i64>(), total, "{file}");
        assert!(rows.iter().any(|r| r.payee == payee), "{file}: no {payee:?} in {:?}", rows.iter().map(|r| &r.payee).collect::<Vec<_>>());
        assert!(rows.iter().all(|r| r.date.starts_with("2026-")), "{file}");
        assert!(rows.iter().all(|r| !r.duplicate), "{file}");
    }
}

/// Every row's identity, date, amount and payee, as imports have given them: a change to how
/// files are read must not give a transaction already imported a new id (it would come in twice)
/// or another row's. `UPDATE_BANK_IDS=1` writes the file anew after a deliberate change.
#[test]
fn imported_rows_keep_their_ids_and_values() {
    let mut now = serde_json::Map::new();
    let rows = |rows: Vec<Row>| serde_json::json!(rows.iter().map(|r| serde_json::json!([r.id, r.date, r.amount, r.payee])).collect::<Vec<_>>());
    for &(file, currency, account, ..) in BANKS {
        now.insert(csv_name(file), rows(read_bank(file, currency, account)));
    }
    for &(file, format, order, currency, ..) in STATEMENTS {
        now.insert(file.to_string(), rows(read_statement(file, format, order, currency)));
    }
    let path = format!("{}/../../shared/fixtures/bank-files/ids.json", env!("CARGO_MANIFEST_DIR"));
    if std::env::var("UPDATE_BANK_IDS").is_ok() {
        // A row a line, so a change shows as the rows it touched.
        let files: Vec<String> = now.iter().map(|(file, rows)| {
            let lines: Vec<String> = rows.as_array().unwrap().iter().map(|r| format!("    {r}")).collect();
            format!("  {}: [\n{}\n  ]", serde_json::json!(file), lines.join(",\n"))
        }).collect();
        std::fs::write(&path, format!("{{\n{}\n}}\n", files.join(",\n"))).unwrap();
        return;
    }
    let kept: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e} (run with UPDATE_BANK_IDS=1)"))).unwrap();
    for (file, rows) in &now {
        assert_eq!(Some(rows), kept.get(file), "{file}: ids or values changed");
    }
    assert_eq!(now.len(), kept.len(), "files added or removed: run with UPDATE_BANK_IDS=1");
}
