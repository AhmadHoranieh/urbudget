//! The identical portable fixture is bundled in Android instrumentation tests.
use serde_json::{json, Value};
use urbudget_core::{domain::Budget, engine};

const FIXTURE: &str = include_str!("../../../shared/fixtures/native-roundtrip.json");
const EXPECTED: &str = include_str!("../../../shared/fixtures/native-expected.json");

#[test]
fn native_transport_and_desktop_share_credit_cash_and_tracking_results() {
    let budget: Budget = serde_json::from_str(FIXTURE).unwrap();
    let expected: Value = serde_json::from_str(EXPECTED).unwrap();
    let desktop = serde_json::to_value(engine::calculate_at(&budget, "2026-10", "2026-10").unwrap()).unwrap();
    let reply: Value = serde_json::from_str(&urbudget_android::invoke_json(&json!({
        "version": 1, "method": "calculate", "budget": serde_json::from_str::<Value>(FIXTURE).unwrap(),
        "params": {"month": "2026-10", "asOfMonth": "2026-10"}
    }).to_string())).unwrap();
    assert_eq!(reply["ok"], true, "{reply}");
    assert_eq!(reply["value"], desktop, "JNI must not reinterpret desktop calculations");
    assert_eq!(desktop["readyToAssign"], expected["readyToAssign"]);
    for category in desktop["categories"].as_array().unwrap() {
        assert_eq!(category["available"], expected["available"][category["id"].as_str().unwrap()]);
    }
    for account in desktop["accounts"].as_array().unwrap() {
        assert_eq!(account["balance"], expected["balances"][account["id"].as_str().unwrap()]);
    }
}

#[test]
fn native_workflow_preserves_fields_from_newer_clients() {
    let original: Value = serde_json::from_str(FIXTURE).unwrap();
    let reply: Value = serde_json::from_str(&urbudget_android::invoke_json(&json!({
        "version": 1, "method": "workflow", "budget": original,
        "params": {"action": {"type": "moveMoney", "month": "2026-10", "from": "food", "to": "utilities", "amount": 1000}}
    }).to_string())).unwrap();
    assert_eq!(reply["ok"], true, "{reply}");
    let updated = &reply["value"];
    for pointer in ["/futureClientMetadata", "/accounts/0/futureAccountField", "/categories/0/futureCategoryField",
        "/transactions/1/futureTransactionField", "/transactions/1/splits/0/futureSplitField",
        "/assignments/0/futureAssignmentField"] {
        assert_eq!(updated.pointer(pointer), original.pointer(pointer), "Lost field: {pointer}");
    }
    assert_eq!(updated["assignments"][0]["amount"], 19000);
    assert_eq!(updated["assignments"][1]["amount"], 11000);
}
