//! Desktop commands share token storage, migration, redaction and ordering with Android.
pub use urbudget_services::credentials::SavedToken;
#[tauri::command]
pub fn ynab_tokens()->Result<Vec<SavedToken>,String>{urbudget_services::credentials::ynab_tokens()}
#[tauri::command]
pub fn forget_ynab_token(id:String)->Result<(),String>{urbudget_services::credentials::forget_ynab_token(id)}
