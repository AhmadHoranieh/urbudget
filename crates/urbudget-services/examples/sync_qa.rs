//! Sync between two installs, tried end to end on one computer. Two devices (each its own process
//! and data folder, as two computers are: the secrets vault is one per process) sign in to a local
//! server and sync one budget through what people do to it on both sides: edits apart and
//! together, conflicts and their answers, offline edits, races, a new passphrase, removing a
//! budget from sync, signing out, more budgets, undo, a large budget, and a long random run that
//! must end with both the same.
//!
//! Needs `wrangler dev` with DEV_LOGIN_CODES=1 (web/README.md › Local setup) and node, for
//! web/scripts/dev-webhook.mjs, which starts the account's sync plan:
//!
//!   cargo run -p urbudget-services --example sync_qa                  every scenario
//!   cargo run -p urbudget-services --example sync_qa -- stress 500    only the random run, longer
//!   cargo run -p urbudget-services --example sync_qa -- <name>…       some scenarios, by name
//!
//! URBUDGET_API (default http://127.0.0.1:8787) picks the server. `device <folder>` runs one
//! device: it answers {"method","params"} lines on stdin as the apps' service calls are answered.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::Instant;

const PASSPHRASE: &str = "correct horse battery staple";
const MONTH: &str = "2026-10";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("device") {
        return device(Path::new(&args[1]));
    }
    let api = std::env::var("URBUDGET_API").unwrap_or_else(|_| "http://127.0.0.1:8787".into());
    let (only, rounds): (Vec<String>, usize) = match args.first().map(String::as_str) {
        Some("stress") => (vec!["stress".into()], args.get(1).and_then(|n| n.parse().ok()).unwrap_or(300)),
        _ => (args.clone(), 200),
    };
    let mut qa = Qa::start(&api);
    let scenarios: Vec<(&str, fn(&mut Qa) -> Result<(), String>)> = vec![
        ("first_sync", first_sync),
        ("separate_edits", separate_edits),
        ("same_transaction_different_fields", same_transaction_different_fields),
        ("same_field_conflict", same_field_conflict),
        ("delete_while_edited", delete_while_edited),
        ("assignments_add_up", assignments_add_up),
        ("category_rename_and_regroup", category_rename_and_regroup),
        ("account_deleted_while_used", account_deleted_while_used),
        ("simultaneous_sync", simultaneous_sync),
        ("offline_edits", offline_edits),
        ("undo_after_sync", undo_after_sync),
        ("second_budget", second_budget),
        ("wrong_passphrase", wrong_passphrase),
        ("remove_and_track_again", remove_and_track_again),
        ("sign_out_and_in", sign_out_and_in),
        ("new_passphrase", new_passphrase),
        ("desktop_unsaved_draft", desktop_unsaved_draft),
        ("edit_during_sync", edit_during_sync),
        ("both_enter_due_schedule", both_enter_due_schedule),
        ("entered_schedule_deleted_elsewhere", entered_schedule_deleted_elsewhere),
        ("transfers_and_splits", transfers_and_splits),
        ("payee_rules_and_group_order", payee_rules_and_group_order),
        ("budget_settings", budget_settings),
        ("large_budget", large_budget),
        ("stress", stress_default),
    ];
    // Every scenario starts from the phone having the desktop's budget.
    if !only.is_empty() && !only.iter().any(|o| o == "first_sync") {
        first_sync(&mut qa).unwrap_or_else(|e| panic!("Bringing the budget to the phone failed: {e}"));
    }
    let mut failed = vec![];
    for (name, scenario) in scenarios {
        if !only.is_empty() && !only.iter().any(|o| o == name) {
            continue;
        }
        qa.rounds = rounds;
        let started = Instant::now();
        let result = scenario(&mut qa).and_then(|_| qa.settle().map(|_| ()));
        let took = started.elapsed().as_secs_f32();
        match result {
            Ok(()) => println!("PASS {name} ({took:.1}s)"),
            Err(e) => {
                println!("FAIL {name} ({took:.1}s): {e}");
                failed.push(name);
                // Leave both devices agreeing before the next scenario, whatever this one left.
                if let Err(e) = qa.recover() {
                    println!("     could not bring the devices back together: {e}");
                    break;
                }
            }
        }
    }
    println!("\n{} syncs, {} merges, {} conflicts answered, {} waits, {} errors, {} saves refused because sync changed the budget first",
             qa.stats.syncs, qa.stats.merged, qa.stats.conflicts, qa.stats.waits, qa.stats.errors, qa.stats.stale_saves);
    println!("Data folders: {}", qa.root.display());
    if !failed.is_empty() {
        println!("Failed: {}", failed.join(", "));
        std::process::exit(1);
    }
}

/// One device: the services on a data folder, answering one request per line. A request with an
/// "id" runs on a thread of its own and its answer carries the id, as the phone's service calls
/// run side by side (an edit while sync runs).
fn device(dir: &Path) {
    let runtime: &'static urbudget_services::runtime::Runtime =
        Box::leak(Box::new(urbudget_services::runtime::Runtime::new(dir).expect("the services must start")));
    let out = std::sync::Arc::new(std::sync::Mutex::new(std::io::stdout()));
    let answer = move |request: Value, out: &std::sync::Mutex<std::io::Stdout>| {
        let method = request["method"].as_str().unwrap_or_default().to_owned();
        let mut reply = match urbudget_services::block_on(runtime.dispatch(&method, request["params"].clone())) {
            Ok(value) => json!({ "ok": true, "value": value }),
            Err(error) => json!({ "ok": false, "error": error }),
        };
        if !request["id"].is_null() { reply["id"] = request["id"].clone(); }
        let mut out = out.lock().unwrap();
        writeln!(out, "{reply}").expect("the driver went away");
        out.flush().expect("the driver went away");
    };
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let request: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        if request["id"].is_null() {
            answer(request, &out);
        } else {
            let out = out.clone();
            std::thread::spawn(move || answer(request, &out));
        }
    }
}

struct Device {
    name: &'static str,
    dir: PathBuf,
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Device {
    fn start(name: &'static str, dir: &Path, api: &str) -> Self {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("device")
            .arg(dir)
            .env("URBUDGET_API", api)
            .env("LOCAL_BUDGET_DATA_DIR", dir)
            .env("COMPUTERNAME", name)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("a device must start");
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Device { name, dir: dir.to_path_buf(), child, input, output }
    }
    /// The same data folder in a new process, pointed at `api` (a dead port is offline).
    fn restart(&mut self, api: &str) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        *self = Device::start(self.name, &self.dir.clone(), api);
    }
    fn send(&mut self, method: &str, params: Value) {
        writeln!(self.input, "{}", json!({ "method": method, "params": params })).unwrap();
        self.input.flush().unwrap();
    }
    fn receive(&mut self) -> Result<Value, String> {
        let mut line = String::new();
        self.output.read_line(&mut line).map_err(|e| e.to_string())?;
        let reply: Value = serde_json::from_str(&line).map_err(|e| format!("{}: unreadable reply {line:?}: {e}", self.name))?;
        if reply["ok"].as_bool() == Some(true) { Ok(reply["value"].clone()) } else { Err(reply["error"].as_str().unwrap_or("?").to_owned()) }
    }
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.send(method, params);
        self.receive()
    }
    /// Sends requests that run side by side; answers come back in the order sent.
    fn together(&mut self, requests: &[(&str, Value)]) -> Vec<Result<Value, String>> {
        for (i, (method, params)) in requests.iter().enumerate() {
            writeln!(self.input, "{}", json!({ "method": method, "params": params, "id": i })).unwrap();
        }
        self.input.flush().unwrap();
        let mut answers: Vec<Option<Result<Value, String>>> = vec![None; requests.len()];
        for _ in 0..requests.len() {
            let mut line = String::new();
            if self.output.read_line(&mut line).is_err() { break; }
            let reply: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
            let i = reply["id"].as_u64().unwrap_or(0) as usize;
            answers[i] = Some(if reply["ok"].as_bool() == Some(true) { Ok(reply["value"].clone()) } else { Err(reply["error"].as_str().unwrap_or("?").to_owned()) });
        }
        answers.into_iter().map(|a| a.unwrap_or_else(|| Err("no answer".into()))).collect()
    }
    fn ok(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.call(method, params).map_err(|e| format!("{} {method}: {e}", self.name))
    }
    fn budget(&mut self) -> Result<Value, String> {
        Ok(self.ok("load_budget", json!({}))?["budget"].clone())
    }
    /// Changes the open budget and saves it, as an editor does.
    fn edit(&mut self, change: impl FnOnce(&mut Value)) -> Result<(), String> {
        let state = self.ok("load_budget", json!({}))?;
        let mut budget = state["budget"].clone();
        change(&mut budget);
        self.ok("save_budget", json!({ "budget": budget, "expectedToken": state["token"], "ackOnly": true }))?;
        Ok(())
    }
    fn open_id(&mut self) -> Result<String, String> {
        let list = self.ok("list_budgets", json!({}))?;
        let open = list.as_array().and_then(|l| l.iter().find(|b| b["current"] == json!(true))).ok_or("no budget is open")?;
        Ok(open["id"].as_str().unwrap_or_default().to_owned())
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct Stats { syncs: usize, merged: usize, conflicts: usize, waits: usize, errors: usize, stale_saves: usize }

struct Qa {
    api: String,
    root: PathBuf,
    email: String,
    /// The budget both devices sync.
    id: String,
    a: Device,
    b: Device,
    stats: Stats,
    rounds: usize,
    seed: u64,
}

/// Which device, for scenarios that do the same to either.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Side { A, B }

macro_rules! ensure {
    ($cond:expr, $($why:tt)+) => { if !$cond { return Err(format!($($why)+)); } };
}

impl Qa {
    fn start(api: &str) -> Self {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
        let root = std::env::temp_dir().join(format!("urbudget-sync-qa-{stamp}"));
        let email = format!("sync-qa-{stamp}@example.test");
        clear_rate_limits();
        let a = Device::start("Desktop (QA)", &root.join("desktop"), api);
        let b = Device::start("Phone (QA)", &root.join("phone"), api);
        let mut qa = Qa { api: api.into(), root, email, id: String::new(), a, b, stats: Stats::default(), rounds: 200, seed: stamp as u64 | 1 };
        qa.set_up().unwrap_or_else(|e| panic!("Setting up the two devices failed: {e}"));
        qa
    }

    fn dev(&mut self, side: Side) -> &mut Device {
        match side { Side::A => &mut self.a, Side::B => &mut self.b }
    }

    /// Signs both devices in to one account with the sync plan, sets the passphrase on the
    /// desktop and unlocks the phone with it, and brings the desktop's budget to the phone.
    fn set_up(&mut self) -> Result<(), String> {
        start_sync_plan(&self.email)?;
        let email = self.email.clone();
        sign_in(&mut self.a, &email)?;
        sign_in(&mut self.b, &email)?;
        self.id = self.a.open_id()?;
        self.a.edit(|b| {
            b["name"] = json!("Shared QA budget");
            b["accounts"] = json!([
                { "id": "checking", "name": "Checking", "kind": "cash", "openingBalance": 500000, "archived": false },
                { "id": "card", "name": "Card", "kind": "credit", "openingBalance": 0, "archived": false }
            ]);
            b["categories"] = json!([
                { "id": "groceries", "name": "Groceries", "group": "Everyday", "target": 0 },
                { "id": "fuel", "name": "Fuel", "group": "Everyday", "target": 0 },
                { "id": "rent", "name": "Rent", "group": "Bills", "target": 0 },
                { "id": "card-payment", "name": "Card", "group": "Credit Card Payments", "target": 0, "paymentAccountId": "card" }
            ]);
            b["transactions"] = json!([
                transaction("t1", "checking", "Market", -4500, "groceries"),
                transaction("t2", "checking", "Station", -12000, "fuel"),
                transaction("t3", "card", "Bakery", -900, "groceries")
            ]);
        })?;
        let created = self.a.ok("sync_setup", json!({ "passphrase": PASSPHRASE }))?;
        ensure!(created["created"] == json!(true), "the desktop should have created the passphrase: {created}");
        let unlocked = self.b.ok("sync_setup", json!({ "passphrase": PASSPHRASE }))?;
        ensure!(unlocked["created"] == json!(false), "the phone should have unlocked with the passphrase: {unlocked}");
        Ok(())
    }

    /// One sync on a device; returns this budget's state and the whole report.
    fn sync(&mut self, side: Side) -> Result<(String, Value), String> {
        let id = self.id.clone();
        let report = self.dev(side).ok("sync_now", json!({}))?;
        self.count(&report);
        if report["state"] != json!("ok") {
            return Ok((report["state"].as_str().unwrap_or("?").to_owned(), report));
        }
        let state = entry(&report, &id)["state"].as_str().unwrap_or("missing").to_owned();
        Ok((state, report))
    }

    fn count(&mut self, report: &Value) {
        self.stats.syncs += 1;
        for b in report["budgets"].as_array().into_iter().flatten() {
            match b["state"].as_str() {
                Some("merged") => self.stats.merged += 1,
                Some("waiting") => self.stats.waits += 1,
                Some("error") => self.stats.errors += 1,
                _ => {}
            }
        }
    }

    /// Syncs both devices until both say this budget is synced, then checks they're the same.
    fn settle(&mut self) -> Result<Value, String> {
        for _ in 0..6 {
            let (a, ra) = self.sync(Side::A)?;
            let (b, rb) = self.sync(Side::B)?;
            ensure!(a != "conflict" && b != "conflict", "an unexpected conflict while settling: desktop {}, phone {}", conflicts(&ra, &self.id), conflicts(&rb, &self.id));
            ensure!(a != "error" && b != "error", "sync failed while settling: desktop {}, phone {}", message(&ra, &self.id), message(&rb, &self.id));
            if a == "synced" && b == "synced" {
                return self.same();
            }
        }
        Err("the two devices never both said synced".into())
    }

    /// Both devices have the shared budget the same, and it's the open one on each.
    fn same(&mut self) -> Result<Value, String> {
        ensure!(self.a.open_id()? == self.id && self.b.open_id()? == self.id, "the shared budget isn't open on both devices");
        let (a, b) = (self.a.budget()?, self.b.budget()?);
        if a != b {
            return Err(format!("the devices differ after syncing: {}", difference(&a, &b)));
        }
        Ok(a)
    }

    /// After a failure: answer anything outstanding with this device's version and settle.
    fn recover(&mut self) -> Result<(), String> {
        for side in [Side::A, Side::B, Side::A, Side::B] {
            let (state, _) = self.sync(side)?;
            if state == "conflict" {
                let id = self.id.clone();
                let _ = self.dev(side).call("sync_resolve", json!({ "id": id, "keep": "merge", "choices": { "*": "local" } }));
                let _ = self.dev(side).call("sync_resolve", json!({ "id": id, "keep": "local" }));
            }
        }
        self.settle().map(|_| ())
    }

    /// Answers this device's conflicts on the shared budget, every one with `answer`.
    fn answer(&mut self, side: Side, answer: &str) -> Result<Value, String> {
        let id = self.id.clone();
        self.stats.conflicts += 1;
        let report = self.dev(side).ok("sync_resolve", json!({ "id": id, "keep": "merge", "choices": { "*": answer } }))?;
        self.count(&report);
        Ok(report)
    }

    fn random(&mut self) -> u64 {
        // xorshift64*: reproducible from the seed printed at the start of a stress run.
        self.seed ^= self.seed >> 12;
        self.seed ^= self.seed << 25;
        self.seed ^= self.seed >> 27;
        self.seed.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn below(&mut self, n: usize) -> usize { (self.random() % n as u64) as usize }
}

fn sign_in(device: &mut Device, email: &str) -> Result<(), String> {
    let started = device.ok("account_start", json!({ "email": email }))?;
    let code = started["devCode"].as_str().ok_or("the server sent no code: is DEV_LOGIN_CODES=1 set?")?.to_owned();
    device.ok("account_verify", json!({ "email": email, "code": code }))?;
    Ok(())
}

fn web_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web")
}

/// The account's sync plan, through the server's pretend Polar webhook.
fn start_sync_plan(email: &str) -> Result<(), String> {
    let output = Command::new("node").current_dir(web_dir()).args(["scripts/dev-webhook.mjs", "subscribe", email]).output().map_err(|e| format!("node: {e}"))?;
    ensure!(output.status.success(), "dev-webhook.mjs failed: {}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    Ok(())
}

/// Sign-in codes are limited per address and hour; repeated local runs would run out.
fn clear_rate_limits() {
    let _ = Command::new("npx")
        .current_dir(web_dir())
        .args(["wrangler", "d1", "execute", "urbudget", "--local", "--command", "DELETE FROM rate_limits"])
        .env("WRANGLER_SEND_METRICS", "false")
        .output();
}

fn transaction(id: &str, account: &str, payee: &str, amount: i64, category: &str) -> Value {
    json!({ "id": id, "date": "2026-10-15", "accountId": account, "payee": payee, "memo": "", "amount": amount,
            "status": "uncleared", "splits": [{ "categoryId": category, "amount": amount }],
            "transferAccountId": null, "transferStatus": null })
}

fn rows<'a>(budget: &'a mut Value, list: &str) -> &'a mut Vec<Value> {
    if !budget[list].is_array() { budget[list] = json!([]); }
    budget[list].as_array_mut().unwrap()
}
fn record<'a>(budget: &'a mut Value, list: &str, id: &str) -> Option<&'a mut Value> {
    rows(budget, list).iter_mut().find(|r| r["id"] == json!(id))
}
fn has(budget: &Value, list: &str, id: &str) -> bool {
    budget[list].as_array().is_some_and(|r| r.iter().any(|r| r["id"] == json!(id)))
}
fn field(budget: &Value, list: &str, id: &str, key: &str) -> Value {
    budget[list].as_array().and_then(|r| r.iter().find(|r| r["id"] == json!(id))).map(|r| r[key].clone()).unwrap_or(Value::Null)
}
/// A transaction's amount change keeps its one split adding up.
fn set_amount(budget: &mut Value, id: &str, amount: i64) {
    if let Some(t) = record(budget, "transactions", id) {
        t["amount"] = json!(amount);
        t["splits"][0]["amount"] = json!(amount);
    }
}
fn assigned(budget: &Value, category: &str) -> i64 {
    budget["assignments"].as_array().into_iter().flatten()
        .filter(|a| a["month"] == json!(MONTH) && a["categoryId"] == json!(category))
        .map(|a| a["amount"].as_i64().unwrap_or(0)).sum()
}
fn set_assigned(budget: &mut Value, category: &str, amount: i64) {
    let list = rows(budget, "assignments");
    list.retain(|a| !(a["month"] == json!(MONTH) && a["categoryId"] == json!(category)));
    list.push(json!({ "month": MONTH, "categoryId": category, "amount": amount }));
}

fn entry<'a>(report: &'a Value, id: &str) -> &'a Value {
    report["budgets"].as_array().and_then(|b| b.iter().find(|b| b["id"] == json!(id))).unwrap_or(&Value::Null)
}
fn conflicts(report: &Value, id: &str) -> String {
    let e = entry(report, id);
    format!("{} {}", e["conflicts"], e["message"])
}
fn message(report: &Value, id: &str) -> String {
    let e = entry(report, id);
    if e.is_null() { format!("{} {}", report["state"], report["message"]) } else { format!("{} {}", e["state"], e["message"]) }
}

/// Where two budgets differ: the top-level fields, and for lists the ids that differ.
fn difference(a: &Value, b: &Value) -> String {
    let mut out = vec![];
    let keys: std::collections::BTreeSet<&String> = a.as_object().into_iter().flatten().chain(b.as_object().into_iter().flatten()).map(|(k, _)| k).collect();
    for k in keys {
        if a[k] == b[k] { continue; }
        match (a[k].as_array(), b[k].as_array()) {
            (Some(x), Some(y)) => {
                let key = |r: &Value| r["id"].as_str().map(str::to_owned).unwrap_or_else(|| format!("{}:{}", r["month"], r["categoryId"]));
                let only_a: Vec<String> = x.iter().filter(|r| !y.contains(r)).map(key).collect();
                let only_b: Vec<String> = y.iter().filter(|r| !x.contains(r)).map(key).collect();
                out.push(format!("{k}: desktop has {only_a:?}, phone has {only_b:?}"));
            }
            _ => out.push(format!("{k}: desktop {} vs phone {}", short(&a[k]), short(&b[k]))),
        }
    }
    out.join("; ")
}
fn short(v: &Value) -> String {
    let s = v.to_string();
    if s.len() > 120 { format!("{}…", &s[..120]) } else { s }
}

// MARK: Scenarios

/// The desktop's budget, uploaded, then brought to the phone and opened there.
fn first_sync(t: &mut Qa) -> Result<(), String> {
    let (state, _) = t.sync(Side::A)?;
    ensure!(state == "uploaded", "the desktop's first sync should upload, not {state}");
    let (_, report) = t.sync(Side::B)?;
    let id = t.id.clone();
    ensure!(entry(&report, &id)["state"] == json!("cloud_only"), "the phone should see the budget in the cloud: {}", message(&report, &id));
    ensure!(entry(&report, &id)["device"] == json!("Desktop (QA)"), "the cloud copy should say which device uploaded it: {}", entry(&report, &id));
    t.b.ok("sync_download", json!({ "id": id }))?;
    t.b.ok("open_budget", json!({ "id": id }))?;
    let budget = t.b.budget()?;
    ensure!(budget["name"] == json!("Shared QA budget") && budget["transactions"].as_array().map(Vec::len) == Some(3), "the phone's copy isn't the desktop's: {}", short(&budget));
    Ok(())
}

/// Each side adds a transaction: both end up with both.
fn separate_edits(t: &mut Qa) -> Result<(), String> {
    t.a.edit(|b| rows(b, "transactions").push(transaction("a1", "checking", "Desktop shop", -1500, "groceries")))?;
    t.b.edit(|b| rows(b, "transactions").push(transaction("b1", "card", "Phone shop", -2500, "fuel")))?;
    let (a, _) = t.sync(Side::A)?;
    ensure!(a == "uploaded", "desktop: {a}");
    let (b, _) = t.sync(Side::B)?;
    ensure!(b == "merged", "the phone should merge the desktop's change with its own, not {b}");
    let budget = t.settle()?;
    ensure!(has(&budget, "transactions", "a1") && has(&budget, "transactions", "b1"), "a transaction was lost");
    Ok(())
}

/// One side changes a transaction's memo, the other its amount: both changes stay, no question.
fn same_transaction_different_fields(t: &mut Qa) -> Result<(), String> {
    t.a.edit(|b| { record(b, "transactions", "t1").unwrap()["memo"] = json!("weekly shop"); })?;
    t.b.edit(|b| set_amount(b, "t1", -4800))?;
    t.sync(Side::A)?;
    let (b, report) = t.sync(Side::B)?;
    ensure!(b == "merged", "phone: {b} {}", conflicts(&report, &t.id.clone()));
    let budget = t.settle()?;
    ensure!(field(&budget, "transactions", "t1", "memo") == json!("weekly shop") && field(&budget, "transactions", "t1", "amount") == json!(-4800), "a field change was lost: {}", short(&field(&budget, "transactions", "t1", "memo")));
    Ok(())
}

/// Both rename the same payee differently: a question, answered with the cloud's on the phone.
fn same_field_conflict(t: &mut Qa) -> Result<(), String> {
    t.a.edit(|b| { record(b, "transactions", "t2").unwrap()["payee"] = json!("Station (desktop)"); })?;
    t.b.edit(|b| { record(b, "transactions", "t2").unwrap()["payee"] = json!("Station (phone)"); })?;
    t.sync(Side::A)?;
    let (b, report) = t.sync(Side::B)?;
    let id = t.id.clone();
    ensure!(b == "conflict", "the phone should ask, not {b}");
    let asked = &entry(&report, &id)["conflicts"];
    ensure!(asked.as_array().map(Vec::len) == Some(1) && asked[0]["field"] == json!("payee"), "it should ask about the payee only: {asked}");
    // The question shows the person both values.
    ensure!(asked[0]["local"] == json!("Station (phone)") && asked[0]["remote"] == json!("Station (desktop)"), "the question's values: {asked}");
    // Until answered, the phone's budget keeps its own value.
    ensure!(field(&t.b.budget()?, "transactions", "t2", "payee") == json!("Station (phone)"), "an unanswered conflict changed the phone's budget");
    let answered = t.answer(Side::B, "cloud")?;
    ensure!(entry(&answered, &id)["state"] != json!("conflict"), "answering didn't settle it: {}", conflicts(&answered, &id));
    let budget = t.settle()?;
    ensure!(field(&budget, "transactions", "t2", "payee") == json!("Station (desktop)"), "the answer wasn't kept");
    Ok(())
}

/// The desktop deletes a transaction the phone edited: a question; keeping the phone's edit keeps it.
fn delete_while_edited(t: &mut Qa) -> Result<(), String> {
    t.a.edit(|b| rows(b, "transactions").retain(|r| r["id"] != json!("t3")))?;
    t.b.edit(|b| { record(b, "transactions", "t3").unwrap()["memo"] = json!("keep this one"); })?;
    t.sync(Side::A)?;
    let (b, report) = t.sync(Side::B)?;
    let id = t.id.clone();
    ensure!(b == "conflict", "deleting an edited transaction should ask, not {b}");
    let asked = &entry(&report, &id)["conflicts"][0];
    ensure!(asked["field"].is_null() && asked["remote"].is_null(), "it should say the cloud deleted it: {asked}");
    t.answer(Side::B, "local")?;
    let budget = t.settle()?;
    ensure!(field(&budget, "transactions", "t3", "memo") == json!("keep this one"), "the kept edit was lost");
    // And the other way round: deleting it without an edit elsewhere just deletes it.
    t.b.edit(|b| rows(b, "transactions").retain(|r| r["id"] != json!("t3")))?;
    let budget = t.settle()?;
    ensure!(!has(&budget, "transactions", "t3"), "an uncontested delete didn't reach the other device");
    Ok(())
}

/// Money assigned on both sides to the same category in the same month adds up.
fn assignments_add_up(t: &mut Qa) -> Result<(), String> {
    let before = assigned(&t.a.budget()?, "groceries");
    t.a.edit(|b| set_assigned(b, "groceries", before + 10000))?;
    t.b.edit(|b| set_assigned(b, "groceries", before + 5000))?;
    t.sync(Side::A)?;
    let (b, report) = t.sync(Side::B)?;
    ensure!(b == "merged", "phone: {b} {}", conflicts(&report, &t.id.clone()));
    let budget = t.settle()?;
    ensure!(assigned(&budget, "groceries") == before + 15000, "both assignments should add up to {}, not {}", before + 15000, assigned(&budget, "groceries"));
    Ok(())
}

/// One side renames a category, the other moves it to another group: both stay.
fn category_rename_and_regroup(t: &mut Qa) -> Result<(), String> {
    t.a.edit(|b| { record(b, "categories", "fuel").unwrap()["name"] = json!("Fuel & parking"); })?;
    t.b.edit(|b| { record(b, "categories", "fuel").unwrap()["group"] = json!("Car"); })?;
    let budget = t.settle()?;
    ensure!(field(&budget, "categories", "fuel", "name") == json!("Fuel & parking") && field(&budget, "categories", "fuel", "group") == json!("Car"), "a category change was lost");
    Ok(())
}

/// The desktop deletes an account the phone just added a transaction to: the account stays.
fn account_deleted_while_used(t: &mut Qa) -> Result<(), String> {
    t.a.edit(|b| rows(b, "accounts").push(json!({ "id": "savings", "name": "Savings", "kind": "cash", "openingBalance": 0, "archived": false })))?;
    t.settle()?;
    t.a.edit(|b| rows(b, "accounts").retain(|r| r["id"] != json!("savings")))?;
    t.b.edit(|b| rows(b, "transactions").push(transaction("s1", "savings", "Interest", 300, "groceries")))?;
    t.sync(Side::A)?;
    t.sync(Side::B)?;
    let budget = t.settle()?;
    ensure!(has(&budget, "accounts", "savings") && has(&budget, "transactions", "s1"), "the account (or its new transaction) was lost");
    Ok(())
}

/// Both devices sync changes at the same moment: one wins the upload, the other merges after.
fn simultaneous_sync(t: &mut Qa) -> Result<(), String> {
    for round in 0..5 {
        let (x, y) = (format!("race-a{round}"), format!("race-b{round}"));
        t.a.edit(|b| rows(b, "transactions").push(transaction(&x, "checking", "Race desktop", -100, "groceries")))?;
        t.b.edit(|b| rows(b, "transactions").push(transaction(&y, "card", "Race phone", -200, "fuel")))?;
        t.a.send("sync_now", json!({}));
        t.b.send("sync_now", json!({}));
        let ra = t.a.receive().map_err(|e| format!("desktop: {e}"))?;
        let rb = t.b.receive().map_err(|e| format!("phone: {e}"))?;
        t.count(&ra);
        t.count(&rb);
        let id = t.id.clone();
        for (who, r) in [("desktop", &ra), ("phone", &rb)] {
            let state = entry(r, &id)["state"].as_str().unwrap_or("?");
            ensure!(["uploaded", "merged", "waiting", "synced", "downloaded"].contains(&state), "{who} after a race: {}", message(r, &id));
        }
        let budget = t.settle()?;
        ensure!(has(&budget, "transactions", &x) && has(&budget, "transactions", &y), "a racing change was lost in round {round}");
    }
    Ok(())
}

/// The phone edits while offline: sync says so, the edits stay, and they go up once it's back.
fn offline_edits(t: &mut Qa) -> Result<(), String> {
    t.b.restart("http://127.0.0.1:9");
    t.b.edit(|b| rows(b, "transactions").push(transaction("off1", "card", "Offline cafe", -700, "groceries")))?;
    let (state, report) = t.sync(Side::B)?;
    ensure!(state == "offline", "offline sync should say offline, not {state}: {}", report["message"]);
    t.b.edit(|b| { record(b, "transactions", "t1").unwrap()["memo"] = json!("edited offline"); })?;
    // Meanwhile the desktop changes something else.
    t.a.edit(|b| rows(b, "transactions").push(transaction("on1", "checking", "Online shop", -300, "fuel")))?;
    t.sync(Side::A)?;
    let api = t.api.clone();
    t.b.restart(&api);
    let budget = t.settle()?;
    ensure!(has(&budget, "transactions", "off1") && has(&budget, "transactions", "on1"), "an offline or online change was lost");
    ensure!(field(&budget, "transactions", "t1", "memo") == json!("edited offline"), "the offline edit was lost");
    Ok(())
}

/// An edit, synced, then undone on the desktop: the undo syncs too.
fn undo_after_sync(t: &mut Qa) -> Result<(), String> {
    t.a.edit(|b| { record(b, "transactions", "t2").unwrap()["memo"] = json!("to be undone"); })?;
    t.settle()?;
    t.a.ok("undo_budget", json!({}))?;
    let budget = t.settle()?;
    ensure!(field(&budget, "transactions", "t2", "memo") != json!("to be undone"), "the undo didn't reach the phone");
    Ok(())
}

/// A second budget made on the desktop syncs once tracked, and changes to it reach the phone
/// while the phone has the shared budget open (a budget that isn't open syncs too).
fn second_budget(t: &mut Qa) -> Result<(), String> {
    let budget = json!({ "schemaVersion": 2, "name": "Holiday fund", "currency": "SAR", "accounts": [], "categories": [], "transactions": [], "assignments": [] });
    let second = t.a.ok("create_budget", json!({ "budget": budget }))?.as_str().unwrap_or_default().to_owned();
    let (_, report) = t.sync(Side::A)?;
    ensure!(entry(&report, &second)["state"] == json!("local_only"), "a new budget should wait to be added to sync: {}", message(&report, &second));
    t.a.ok("sync_track", json!({ "ids": [second.clone()] }))?;
    let (_, report) = t.sync(Side::A)?;
    ensure!(entry(&report, &second)["state"] == json!("uploaded"), "tracking it should upload it: {}", message(&report, &second));
    t.b.ok("sync_download", json!({ "id": second.clone() }))?;
    // Change the second budget on the desktop while both have the shared one open.
    t.a.ok("open_budget", json!({ "id": second.clone() }))?;
    t.a.edit(|b| { b["categories"] = json!([{ "id": "trip", "name": "Trip", "group": "Goals", "target": 0 }]); })?;
    let id = t.id.clone();
    t.a.ok("open_budget", json!({ "id": id }))?;
    t.sync(Side::A)?;
    let (_, report) = t.sync(Side::B)?;
    ensure!(entry(&report, &second)["state"] == json!("downloaded"), "the phone's closed copy should update: {}", message(&report, &second));
    t.b.ok("open_budget", json!({ "id": second.clone() }))?;
    ensure!(has(&t.b.budget()?, "categories", "trip"), "the change to the closed budget didn't arrive");
    t.b.ok("open_budget", json!({ "id": id }))?;
    // Both remove it from sync so later scenarios have one budget to watch.
    t.a.ok("sync_remove", json!({ "id": second }))?;
    Ok(())
}

/// A third install with the wrong passphrase can't unlock, and nothing changes for the others.
fn wrong_passphrase(t: &mut Qa) -> Result<(), String> {
    let mut c = Device::start("Laptop (QA)", &t.root.join("laptop"), &t.api);
    let email = t.email.clone();
    sign_in(&mut c, &email)?;
    let wrong = c.call("sync_setup", json!({ "passphrase": "not the passphrase" }));
    ensure!(wrong.as_ref().is_err_and(|e| e.contains("isn't the sync passphrase")), "a wrong passphrase should be refused: {wrong:?}");
    let short = c.call("sync_setup", json!({ "passphrase": "short" }));
    ensure!(short.is_err(), "a short passphrase should be refused");
    let report = c.ok("sync_now", json!({}))?;
    ensure!(report["state"] == json!("locked"), "a device that never unlocked should say locked: {}", report["state"]);
    // The right one lets it see the shared budget, which it can bring down unchanged.
    c.ok("sync_setup", json!({ "passphrase": PASSPHRASE }))?;
    let id = t.id.clone();
    c.ok("sync_download", json!({ "id": id.clone() }))?;
    c.ok("open_budget", json!({ "id": id }))?;
    let (mine, theirs) = (c.budget()?, t.a.budget()?);
    ensure!(mine == theirs, "a third device's download differs: {}", difference(&theirs, &mine));
    c.ok("account_sign_out", json!({}))?;
    Ok(())
}

/// Removed from sync on the desktop: the phone keeps its copy and says so. Tracked again, the
/// two copies (still the same) come together without a question.
fn remove_and_track_again(t: &mut Qa) -> Result<(), String> {
    t.settle()?;
    let id = t.id.clone();
    t.a.ok("sync_remove", json!({ "id": id.clone() }))?;
    let (state, report) = t.sync(Side::B)?;
    ensure!(state == "local_only", "the phone should keep a budget removed elsewhere: {state}");
    ensure!(entry(&report, &id)["message"].as_str().is_some_and(|m| m.contains("Removed from sync")), "the phone should say why: {}", message(&report, &id));
    ensure!(t.b.budget()?["transactions"].as_array().is_some_and(|r| !r.is_empty()), "the phone lost its copy");
    t.a.ok("sync_track", json!({ "ids": [id.clone()] }))?;
    let (state, _) = t.sync(Side::A)?;
    ensure!(state == "uploaded", "tracking again should upload: {state}");
    // The phone has the same budget but no longer tracks it: it merges without a base.
    let (state, report) = t.sync(Side::B)?;
    ensure!(state != "conflict", "identical copies shouldn't ask anything: {}", conflicts(&report, &t.id.clone()));
    Ok(())
}

/// The phone signs out, edits, and signs in again: its edit and the desktop's meanwhile both
/// survive, as questions only where they really differ.
fn sign_out_and_in(t: &mut Qa) -> Result<(), String> {
    t.settle()?;
    t.b.ok("account_sign_out", json!({}))?;
    let (state, _) = t.sync(Side::B)?;
    ensure!(state == "signed_out", "a signed-out device should say so: {state}");
    t.b.edit(|b| rows(b, "transactions").push(transaction("out1", "card", "While signed out", -50, "groceries")))?;
    t.a.edit(|b| rows(b, "transactions").push(transaction("in1", "checking", "Meanwhile", -60, "fuel")))?;
    t.sync(Side::A)?;
    let email = t.email.clone();
    sign_in(&mut t.b, &email)?;
    t.b.ok("sync_setup", json!({ "passphrase": PASSPHRASE }))?;
    let (state, report) = t.sync(Side::B)?;
    if state == "conflict" {
        // Without a base, the phone's added transaction and the desktop's each look like a
        // difference; keeping both versions' records means answering "local" for the phone's.
        let asked = entry(&report, &t.id.clone())["conflicts"].clone();
        println!("     sign-in again asked {} question(s): {}", asked.as_array().map_or(0, Vec::len), short(&asked));
        t.answer(Side::B, "local")?;
    }
    let budget = t.settle()?;
    ensure!(has(&budget, "transactions", "out1"), "the edit made while signed out was lost");
    ensure!(has(&budget, "transactions", "in1"), "the desktop's change made meanwhile was lost");
    Ok(())
}

/// A new passphrase on the desktop: the phone is locked out until it enters it, then syncs on.
fn new_passphrase(t: &mut Qa) -> Result<(), String> {
    t.settle()?;
    t.b.edit(|b| rows(b, "transactions").push(transaction("before-reset", "card", "Before the reset", -80, "groceries")))?;
    t.a.ok("sync_reset", json!({ "passphrase": "a brand new passphrase" }))?;
    let (state, _) = t.sync(Side::A)?;
    ensure!(state == "uploaded", "after a reset the desktop should upload again: {state}");
    let (state, report) = t.sync(Side::B)?;
    ensure!(state == "locked", "the phone should be locked after a reset elsewhere: {state} {}", report["message"]);
    let old = t.b.call("sync_setup", json!({ "passphrase": PASSPHRASE }));
    ensure!(old.is_err(), "the old passphrase should no longer unlock");
    t.b.ok("sync_setup", json!({ "passphrase": "a brand new passphrase" }))?;
    let (state, report) = t.sync(Side::B)?;
    if state == "conflict" {
        let asked = entry(&report, &t.id.clone())["conflicts"].clone();
        println!("     after the reset the phone asked {} question(s): {}", asked.as_array().map_or(0, Vec::len), short(&asked));
        t.answer(Side::B, "local")?;
    }
    let budget = t.settle()?;
    ensure!(has(&budget, "transactions", "before-reset"), "the phone's edit from before the reset was lost");
    Ok(())
}

/// Five thousand transactions up and back down, timed.
fn large_budget(t: &mut Qa) -> Result<(), String> {
    t.a.edit(|b| {
        let list = rows(b, "transactions");
        for i in 0..5000 {
            let mut tx = transaction(&format!("bulk{i}"), if i % 2 == 0 { "checking" } else { "card" }, &format!("Payee {}", i % 97), -(100 + i as i64), if i % 3 == 0 { "rent" } else { "groceries" });
            tx["date"] = json!(format!("2026-{:02}-{:02}", 1 + i % 10, 1 + i % 28));
            tx["memo"] = json!(format!("bulk import {i}"));
            list.push(tx);
        }
    })?;
    let started = Instant::now();
    let (state, _) = t.sync(Side::A)?;
    let up = started.elapsed().as_secs_f32();
    ensure!(state == "uploaded", "desktop: {state}");
    let started = Instant::now();
    let (state, _) = t.sync(Side::B)?;
    let down = started.elapsed().as_secs_f32();
    ensure!(state == "downloaded", "phone: {state}");
    println!("     5,000 transactions: upload {up:.2}s, download and merge {down:.2}s");
    // An edit on each side of a big budget still merges.
    t.a.edit(|b| { record(b, "transactions", "bulk10").unwrap()["memo"] = json!("desktop"); })?;
    t.b.edit(|b| { record(b, "transactions", "bulk20").unwrap()["memo"] = json!("phone"); })?;
    let started = Instant::now();
    let budget = t.settle()?;
    println!("     merging one edit each on 5,000 transactions settled in {:.2}s", started.elapsed().as_secs_f32());
    ensure!(field(&budget, "transactions", "bulk10", "memo") == json!("desktop") && field(&budget, "transactions", "bulk20", "memo") == json!("phone"), "an edit in the big budget was lost");
    // Back to a small budget for what follows.
    t.a.edit(|b| rows(b, "transactions").retain(|r| !r["id"].as_str().unwrap_or_default().starts_with("bulk")))?;
    t.settle()?;
    Ok(())
}

fn stress_default(t: &mut Qa) -> Result<(), String> {
    let rounds = t.rounds;
    stress(t, rounds)
}

/// Random edits on both devices with syncs in between, some at the same moment, conflicts
/// answered either way. At the end the two must be the same, and every transaction either side
/// added and nobody deleted must be there.
fn stress(t: &mut Qa, rounds: usize) -> Result<(), String> {
    println!("     seed {}", t.seed);
    // A weekly schedule from July that either device enters as the days go by. "Today" starts
    // after every test transaction's date: entering schedules first turns transactions dated
    // later than today into schedules, as the apps do.
    t.a.edit(|b| {
        let mut weekly = schedule("stress-s", "2026-07-03", "Subscription", -999);
        weekly["frequency"] = json!("weekly");
        rows(b, "schedules").push(weekly);
    })?;
    t.settle()?;
    let mut day = 0;
    let mut alive: Vec<String> = t.a.budget()?["transactions"].as_array().unwrap().iter().filter_map(|r| r["id"].as_str().map(str::to_owned)).collect();
    let mut deleted: Vec<String> = vec![];
    let mut next = 0;
    for round in 0..rounds {
        if t.below(10) == 0 { day += 1; }
        let side = if t.below(2) == 0 { Side::A } else { Side::B };
        let roll = t.below(100);
        let pick = if alive.is_empty() { None } else { Some(alive[t.below(alive.len())].clone()) };
        let value = t.below(100_000) as i64;
        match (roll, pick) {
            (25..=29, _) => {
                // A device opening: due schedules are entered there.
                let today = chrono_day(day);
                t.dev(side).ok("apply_due_schedules", json!({ "through": today }))?;
                for posted in posted_from(&t.dev(side).budget()?, "stress-s") {
                    let id = posted["id"].as_str().unwrap().to_owned();
                    if !alive.contains(&id) && !deleted.contains(&id) { alive.push(id); }
                }
            }
            (0..=24, _) | (_, None) => {
                let id = format!("r{next}-{side:?}");
                next += 1;
                let account = if value % 2 == 0 { "checking" } else { "card" };
                t.dev(side).edit(|b| rows(b, "transactions").push(transaction(&id, account, &format!("Random {value}"), -value, "groceries")))?;
                alive.push(id);
            }
            (30..=49, Some(id)) => t.dev(side).edit(|b| { if let Some(r) = record(b, "transactions", &id) { r["memo"] = json!(format!("memo {value}")); } })?,
            (50..=59, Some(id)) => t.dev(side).edit(|b| set_amount(b, &id, -value))?,
            (60..=64, Some(id)) => t.dev(side).edit(|b| { if let Some(r) = record(b, "transactions", &id) { r["status"] = json!(if value % 2 == 0 { "cleared" } else { "uncleared" }); } })?,
            (65..=69, Some(id)) => {
                t.dev(side).edit(|b| rows(b, "transactions").retain(|r| r["id"] != json!(id)))?;
                alive.retain(|x| x != &id);
                deleted.push(id);
            }
            (70..=74, _) => t.dev(side).edit(|b| { let now = assigned(b, "fuel"); set_assigned(b, "fuel", now + value); })?,
            (75..=79, _) => t.dev(side).edit(|b| { record(b, "categories", "rent").unwrap()["target"] = json!(value); })?,
            (80..=89, _) => {
                let (state, _) = t.sync(side)?;
                if state == "conflict" {
                    let answer = if t.below(2) == 0 { "local" } else { "cloud" };
                    let report = t.answer(side, answer)?;
                    let id = t.id.clone();
                    ensure!(entry(&report, &id)["state"] != json!("error"), "round {round}: answering failed: {}", message(&report, &id));
                } else {
                    ensure!(state != "error", "round {round}: sync failed on {side:?}");
                }
            }
            _ => {
                t.a.send("sync_now", json!({}));
                t.b.send("sync_now", json!({}));
                let (ra, rb) = (t.a.receive()?, t.b.receive()?);
                t.count(&ra);
                t.count(&rb);
                for (s, r) in [(Side::A, ra), (Side::B, rb)] {
                    let id = t.id.clone();
                    let state = entry(&r, &id)["state"].as_str().unwrap_or("?").to_owned();
                    ensure!(state != "error", "round {round}: simultaneous sync failed on {s:?}: {}", message(&r, &id));
                    if state == "conflict" {
                        t.answer(s, "local")?;
                    }
                }
            }
        }
    }
    // Settle, answering whatever is still open.
    for _ in 0..6 {
        let mut asked = false;
        for side in [Side::A, Side::B] {
            let (state, _) = t.sync(side)?;
            if state == "conflict" {
                asked = true;
                t.answer(side, "local")?;
            }
        }
        if !asked { break; }
    }
    let budget = t.settle()?;
    // A deleted transaction may come back only through an answer that kept an edit to it.
    let present: Vec<String> = budget["transactions"].as_array().unwrap().iter().filter_map(|r| r["id"].as_str().map(str::to_owned)).collect();
    let lost: Vec<&String> = alive.iter().filter(|id| !present.contains(id)).collect();
    let back = deleted.iter().filter(|id| present.contains(id)).count();
    println!("     {rounds} rounds: {} transactions, {back} deleted ones kept by an answer, {} lost", present.len(), lost.len());
    // Only a transaction someone deleted may be missing; one nobody deleted must be there.
    ensure!(lost.is_empty(), "transactions nobody deleted disappeared: {lost:?}");
    Ok(())
}

/// The desktop has unsaved edits in its window while the phone's change arrives: sync waits for
/// them instead of merging under them, and once they're saved both changes are kept.
fn desktop_unsaved_draft(t: &mut Qa) -> Result<(), String> {
    t.settle()?;
    t.b.edit(|b| rows(b, "transactions").push(transaction("from-phone", "card", "From the phone", -330, "fuel")))?;
    t.sync(Side::B)?;
    let state = t.a.ok("load_budget", json!({}))?;
    let mut draft = state["budget"].clone();
    record(&mut draft, "transactions", "t1").unwrap()["memo"] = json!("typed on the desktop, not saved yet");
    t.a.ok("replace_draft", json!({ "budget": draft }))?;
    let (state_a, report) = t.sync(Side::A)?;
    ensure!(state_a == "waiting", "the desktop should wait for its unsaved edits, not {state_a}: {}", message(&report, &t.id.clone()));
    // The window's draft (what the desktop shows) is untouched, and nothing merged under it.
    let draft = t.a.ok("snapshot_budget", json!({}))?;
    ensure!(field(&draft, "transactions", "t1", "memo") == json!("typed on the desktop, not saved yet"), "sync touched the unsaved edits");
    ensure!(!has(&draft, "transactions", "from-phone"), "sync merged under unsaved edits");
    // (load_budget would reload the saved budget over the draft; the window never calls it while editing.)
    let token = t.a.ok("database_status", json!({}))?["token"].clone();
    t.a.ok("commit_budget", json!({ "expectedToken": token }))?;
    let saved = t.a.budget()?;
    ensure!(field(&saved, "transactions", "t1", "memo") == json!("typed on the desktop, not saved yet"), "saving the draft didn't save it: memo {}", field(&saved, "transactions", "t1", "memo"));
    let budget = t.settle()?;
    ensure!(has(&budget, "transactions", "from-phone"), "the phone's change was lost once the draft was saved");
    ensure!(field(&budget, "transactions", "t1", "memo") == json!("typed on the desktop, not saved yet"), "the desktop's saved draft was lost: memo {}", field(&budget, "transactions", "t1", "memo"));
    Ok(())
}

/// The phone saves an edit while its sync is bringing in the desktop's change. Either the save
/// goes first and the sync waits for it, or the sync goes first and the save is refused as
/// stale (the app then shows "Your budget changed while saving"). Nothing may be lost silently.
fn edit_during_sync(t: &mut Qa) -> Result<(), String> {
    t.settle()?;
    let mut refused = 0;
    for round in 0..20 {
        let (x, y) = (format!("ds-a{round}"), format!("ds-b{round}"));
        t.a.edit(|b| rows(b, "transactions").push(transaction(&x, "checking", "Desktop during sync", -10, "groceries")))?;
        t.sync(Side::A)?;
        let state = t.b.ok("load_budget", json!({}))?;
        let mut budget = state["budget"].clone();
        rows(&mut budget, "transactions").push(transaction(&y, "card", "Phone during sync", -20, "fuel"));
        let save = json!({ "budget": budget, "expectedToken": state["token"], "ackOnly": true });
        let answers = t.b.together(&[("sync_now", json!({})), ("save_budget", save)]);
        if let Ok(report) = &answers[0] { t.count(report); }
        match &answers[1] {
            Ok(_) => {}
            Err(e) if e.contains("CONFLICT") => {
                refused += 1;
                t.stats.stale_saves += 1;
                // As the app does after "Your budget changed while saving": the person makes it again.
                t.b.edit(|b| rows(b, "transactions").push(transaction(&y, "card", "Phone during sync", -20, "fuel")))?;
            }
            Err(e) => return Err(format!("round {round}: the phone's save failed: {e}")),
        }
        ensure!(answers[0].is_ok(), "round {round}: sync failed: {:?}", answers[0]);
        let budget = t.settle()?;
        ensure!(has(&budget, "transactions", &x) && has(&budget, "transactions", &y), "round {round}: a change was lost");
    }
    println!("     20 edits saved during a sync: {refused} refused as stale and made again");
    Ok(())
}

fn schedule(id: &str, next: &str, payee: &str, amount: i64) -> Value {
    let mut template = transaction(&format!("{id}-template"), "checking", payee, amount, "rent");
    template["date"] = json!(next);
    json!({ "id": id, "nextDate": next, "anchorDate": next, "frequency": "monthly", "paused": false, "transaction": template })
}

fn posted_from<'a>(budget: &'a Value, schedule: &str) -> Vec<&'a Value> {
    budget["transactions"].as_array().into_iter().flatten().filter(|t| t["scheduleId"] == json!(schedule)).collect()
}

/// A schedule both devices enter on their own before syncing (each when it opens): one
/// transaction, not two.
fn both_enter_due_schedule(t: &mut Qa) -> Result<(), String> {
    t.a.edit(|b| rows(b, "schedules").push(schedule("rent-s", "2026-10-01", "Landlord", -250000)))?;
    t.settle()?;
    t.a.ok("apply_due_schedules", json!({ "through": "2026-10-21" }))?;
    t.b.ok("apply_due_schedules", json!({ "through": "2026-10-21" }))?;
    let (a, b) = (t.a.budget()?, t.b.budget()?);
    ensure!(posted_from(&a, "rent-s").len() == 1 && posted_from(&b, "rent-s").len() == 1, "each device should have entered it once");
    let budget = t.settle()?;
    let posted = posted_from(&budget, "rent-s");
    ensure!(posted.len() == 1, "the schedule entered on both devices should be one transaction, not {}", posted.len());
    ensure!(field(&budget, "schedules", "rent-s", "nextDate") == json!("2026-11-01"), "the schedule should move on to November once: {}", field(&budget, "schedules", "rent-s", "nextDate"));
    // Each then edits the entered transaction: different fields both stay.
    let id = posted[0]["id"].as_str().unwrap().to_owned();
    t.a.edit(|b| { record(b, "transactions", &id).unwrap()["memo"] = json!("October rent"); })?;
    t.b.edit(|b| { record(b, "transactions", &id).unwrap()["status"] = json!("cleared"); })?;
    let budget = t.settle()?;
    ensure!(field(&budget, "transactions", &id, "memo") == json!("October rent") && field(&budget, "transactions", &id, "status") == json!("cleared"), "an edit to the entered transaction was lost");
    Ok(())
}

/// The desktop enters a due schedule, syncs, and the person deletes that entry there. The phone,
/// offline all along, entered the same occurrence when it opened. Does the deleted entry return?
fn entered_schedule_deleted_elsewhere(t: &mut Qa) -> Result<(), String> {
    t.a.edit(|b| rows(b, "schedules").push(schedule("gym-s", "2026-10-05", "Gym", -15000)))?;
    t.settle()?;
    t.a.ok("apply_due_schedules", json!({ "through": "2026-10-21" }))?;
    t.sync(Side::A)?;
    t.b.ok("apply_due_schedules", json!({ "through": "2026-10-21" }))?;
    let id = posted_from(&t.a.budget()?, "gym-s").first().map(|p| p["id"].as_str().unwrap().to_owned()).ok_or("the desktop didn't enter it")?;
    t.a.edit(|b| rows(b, "transactions").retain(|r| r["id"] != json!(id)))?;
    t.sync(Side::A)?;
    let (state, report) = t.sync(Side::B)?;
    if state == "conflict" {
        println!("     the phone asked: {}", short(&entry(&report, &t.id.clone())["conflicts"]));
        t.answer(Side::B, "cloud")?;
    }
    let budget = t.settle()?;
    let back = has(&budget, "transactions", &id);
    println!("     a scheduled entry deleted on the desktop, entered again by the offline phone: {}", if back { "it came back" } else { "it stayed deleted" });
    ensure!(!back, "the entry deleted on the desktop came back from the phone's own copy of the same occurrence");
    Ok(())
}

/// A transfer between the two accounts edited on both sides (its memo here, the other side's
/// cleared status there), and a split transaction whose splits both change.
fn transfers_and_splits(t: &mut Qa) -> Result<(), String> {
    t.a.edit(|b| {
        let mut transfer = transaction("pay-card", "checking", "", -20000, "groceries");
        transfer["splits"] = json!([{ "categoryId": null, "amount": -20000 }]);
        transfer["transferAccountId"] = json!("card");
        transfer["transferStatus"] = json!("uncleared");
        rows(b, "transactions").push(transfer);
        let mut split = transaction("split1", "checking", "Supermarket", -9000, "groceries");
        split["splits"] = json!([{ "categoryId": "groceries", "amount": -6000 }, { "categoryId": "fuel", "amount": -3000 }]);
        rows(b, "transactions").push(split);
    })?;
    t.settle()?;
    t.a.edit(|b| { record(b, "transactions", "pay-card").unwrap()["memo"] = json!("October card payment"); })?;
    t.b.edit(|b| { record(b, "transactions", "pay-card").unwrap()["transferStatus"] = json!("cleared"); })?;
    let budget = t.settle()?;
    ensure!(field(&budget, "transactions", "pay-card", "memo") == json!("October card payment") && field(&budget, "transactions", "pay-card", "transferStatus") == json!("cleared"), "a transfer edit was lost");
    // Splits change on both sides: amount and splits are one field, so it asks.
    t.a.edit(|b| { record(b, "transactions", "split1").unwrap()["splits"] = json!([{ "categoryId": "groceries", "amount": -5000 }, { "categoryId": "fuel", "amount": -4000 }]); })?;
    t.b.edit(|b| { record(b, "transactions", "split1").unwrap()["splits"] = json!([{ "categoryId": "groceries", "amount": -7000 }, { "categoryId": "rent", "amount": -2000 }]); })?;
    t.sync(Side::A)?;
    let (state, _) = t.sync(Side::B)?;
    ensure!(state == "conflict", "two different splits should ask, not {state}");
    t.answer(Side::B, "local")?;
    let budget = t.settle()?;
    let splits = field(&budget, "transactions", "split1", "splits");
    ensure!(splits[1]["categoryId"] == json!("rent") && splits.as_array().unwrap().iter().map(|s| s["amount"].as_i64().unwrap()).sum::<i64>() == -9000, "the chosen split didn't stay whole: {splits}");
    Ok(())
}

/// Payee rules added on both sides, and the group order changed on one while the other adds a group.
fn payee_rules_and_group_order(t: &mut Qa) -> Result<(), String> {
    t.a.edit(|b| {
        rows(b, "payeeRules").push(json!({ "id": "rule-a", "match": "amzn mktp", "payee": "Amazon", "categoryId": null }));
        b["groupOrder"] = json!(["Bills", "Everyday", "Car"]);
    })?;
    t.b.edit(|b| {
        rows(b, "payeeRules").push(json!({ "id": "rule-b", "match": "sq blue bottle", "payee": "Blue Bottle", "categoryId": "groceries" }));
        rows(b, "categories").push(json!({ "id": "gifts", "name": "Gifts", "group": "Goals", "target": 0 }));
        // As the app adds a group: the order shown so far, then the new group at the end.
        let mut order: Vec<Value> = b["groupOrder"].as_array().cloned().unwrap_or_default();
        if order.is_empty() {
            for c in b["categories"].as_array().unwrap() {
                if c["group"] != json!("Goals") && !order.contains(&c["group"]) { order.push(c["group"].clone()); }
            }
        }
        order.push(json!("Goals"));
        b["groupOrder"] = json!(order);
    })?;
    let budget = t.settle()?;
    ensure!(has(&budget, "payeeRules", "rule-a") && has(&budget, "payeeRules", "rule-b"), "a payee rule was lost");
    let order: Vec<&str> = budget["groupOrder"].as_array().map(|o| o.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    // Neither side had synced an order before, so the two orders interleave; no group may be
    // lost and the desktop's move of Bills ahead of Everyday must hold.
    let at = |g: &str| order.iter().position(|x| *x == g);
    ensure!(at("Goals").is_some() && at("Bills") < at("Everyday"), "the group order lost a change: {order:?}");
    if order.last() != Some(&"Goals") { println!("     group order after both changed it: {order:?} (the phone added Goals at the end)"); }
    Ok(())
}

/// A setting changed on one side merges; the same setting changed differently asks.
fn budget_settings(t: &mut Qa) -> Result<(), String> {
    t.a.edit(|b| { b["dateFormat"] = json!("dmy"); })?;
    let budget = t.settle()?;
    ensure!(budget["dateFormat"] == json!("dmy"), "a setting didn't reach the phone");
    t.a.edit(|b| { b["dateFormat"] = json!("mdy"); })?;
    t.b.edit(|b| { b["dateFormat"] = json!("iso"); })?;
    t.sync(Side::A)?;
    let (state, _) = t.sync(Side::B)?;
    ensure!(state == "conflict", "the same setting changed differently should ask, not {state}");
    t.answer(Side::B, "cloud")?;
    let budget = t.settle()?;
    ensure!(budget["dateFormat"] == json!("mdy"), "the answer for the setting wasn't kept: {}", budget["dateFormat"]);
    Ok(())
}

/// 16 October 2026 plus `days`, as a date.
fn chrono_day(days: u32) -> String {
    let lengths = [31, 30, 31, 31, 28, 31, 30, 31, 30, 31, 31, 30];
    let (mut year, mut month, mut day) = (2026, 10, 16 + days);
    let mut i = 0;
    while day > lengths[i % 12] {
        day -= lengths[i % 12];
        month += 1;
        if month > 12 { month = 1; year += 1; }
        i += 1;
    }
    format!("{year}-{month:02}-{day:02}")
}
