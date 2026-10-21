use urbudget_lib::{store::Store, ynab};
fn main() -> Result<(), String> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() < 3 {
        return Err("Usage: migrate source.json output.json [database.sqlite3]".into());
    }
    let source: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&args[1]).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let b = ynab::import_export(&source)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&b.extra["importAudit"]).unwrap()
    );
    std::fs::write(&args[2], serde_json::to_vec_pretty(&b).unwrap()).map_err(|e| e.to_string())?;
    let output_dir = std::path::Path::new(&args[2])
        .parent()
        .ok_or("Missing output directory")?;
    std::fs::write(
        output_dir.join("Register-roundtrip.csv"),
        ynab::export_register(&b)?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(
        output_dir.join("Plan-roundtrip.csv"),
        ynab::export_plan(&b)?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(
        output_dir.join("migration-audit.json"),
        serde_json::to_vec_pretty(&b.extra["importAudit"]).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    for key in [
        "accountDifferences",
        "categoryDifferences",
        "readyToAssignDifferences",
    ] {
        if !b.extra["importAudit"][key]
            .as_array()
            .ok_or("Invalid audit")?
            .is_empty()
        {
            return Err(format!("Migration stopped: review {key}"));
        }
    }
    if let Some(path) = args.get(3) {
        let mut store = Store::open(std::path::Path::new(path))?;
        println!("Backup: {}", store.backup()?);
        let token = store.status()?.token;
        store.save(&b, &token)?;
        let reloaded = store.load()?.budget;
        if reloaded != b {
            return Err("Database round-trip mismatch".into());
        }
        println!(
            "Imported and verified {} accounts, {} transactions.",
            b.accounts.len(),
            b.transactions.len()
        );
    }
    Ok(())
}
