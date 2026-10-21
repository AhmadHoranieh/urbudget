//! Shared authenticated receipt verification. The platform client never grants entitlements.
use crate::cloud::{Cloud, Session};
use serde_json::{json, Value};

pub async fn context(cloud: &Cloud) -> Result<Value, String> {
    Ok(cloud.call(reqwest::Method::GET, "/billing/google/context", None, true).await?)
}

pub async fn verify(cloud: &Cloud, result: Value) -> Result<Value, String> {
    // All receipts in a restore/purchase operation belong to its original login. Changing
    // accounts while the server responds must never rebind a later receipt to another user.
    let session = cloud.session()?;
    let captured = &session;
    verify_for_session(cloud, captured, result, |body| async move {
        cloud.call_session(reqwest::Method::POST, "/billing/google/verify", Some(body), Some(captured), None).await.map_err(String::from)
    }).await
}

pub(crate) async fn verify_for_session<F, Fut>(cloud: &Cloud, session: &Session, result: Value, mut send: F) -> Result<Value, String>
where F: FnMut(Value) -> Fut, Fut: std::future::Future<Output = Result<Value, String>> {
    let mut restored = 0;
    let mut pending = false;
    if let Some(purchases) = result["purchases"].as_array() {
        for purchase in purchases {
            if purchase["state"] != "purchased" && purchase["state"] != "pending" { continue; }
            cloud.check_session(session)?;
            let token = purchase["token"].as_str().filter(|s| !s.is_empty()).ok_or("Google Play returned no purchase token.")?;
            let answer = send(json!({"token":token,"products":purchase["products"]})).await?;
            cloud.check_session(session)?;
            pending |= answer["pending"].as_bool().unwrap_or(false);
            if answer["active"].as_bool().unwrap_or(false) { restored += 1; }
        }
    }
    Ok(json!({"cancelled":result["cancelled"].as_bool().unwrap_or(false),"restored":restored,"pending":pending}))
}
