use urbudget_lib::{import_sync, store::Store, ynab};
use std::time::Instant;
fn main() -> Result<(), String> {
    let path = std::env::args()
        .nth(1)
        .ok_or("Provide a saved YNAB API export")?;
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let start = Instant::now();
    let source: serde_json::Value =
        serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let parse = start.elapsed();
    let b = ynab::import_export(&source)?;
    let validated = start.elapsed();
    for k in [
        "accountDifferences",
        "categoryDifferences",
        "readyToAssignDifferences",
    ] {
        assert!(
            b.extra["importAudit"][k].as_array().unwrap().is_empty(),
            "Financial mismatch"
        );
    }
    let mut store = Store::open(&temp.path().join("budget.sqlite3"))?;
    let token = store.status()?.token;
    store.save(&b, &token)?;
    let first = start.elapsed();
    let mut local = store.load()?.budget;
    let original = local.transactions[0].memo.clone();
    local.transactions[0].memo = "Local memo preserved in benchmark".into();
    let refresh = Instant::now();
    let incoming = ynab::import_export(&source)?;
    let merged = import_sync::merge_local(&local, incoming)?;
    assert_eq!(
        merged.transactions[0].memo,
        "Local memo preserved in benchmark"
    );
    assert_eq!(merged.transactions.len(), b.transactions.len());
    store.backup()?;
    let token = store.status()?.token;
    store.save(&merged, &token)?;
    let reloaded = store.load()?.budget;
    assert_eq!(reloaded.transactions.len(), b.transactions.len());
    let refresh_time = refresh.elapsed();
    let id = source
        .pointer("/data/plan/id")
        .or_else(|| source.pointer("/data/budget/id"))
        .unwrap();
    let delta = serde_json::json!({"data":{"server_knowledge":source["data"]["server_knowledge"],"plan":{"id":id}}});
    let start_delta = Instant::now();
    let delta_source = import_sync::merge_delta(&source, &delta)?;
    assert_eq!(delta_source["data"]["plan"], source["data"]["plan"]);
    let delta_time = start_delta.elapsed();
    let _ = original;
    println!(
        "{}",
        serde_json::json!({"sourceTransactions":b.extra["importCounts"]["sourceTransactions"],"parseMs":parse.as_secs_f64()*1000.,"parseAndValidateMs":validated.as_secs_f64()*1000.,"firstImportAndSaveMs":first.as_secs_f64()*1000.,"refreshValidateMergeBackupSaveReloadMs":refresh_time.as_secs_f64()*1000.,"unchangedDeltaMergeMs":delta_time.as_secs_f64()*1000.,"networkIncluded":false,"financialAudit":b.extra["importAudit"]})
    );
    Ok(())
}
