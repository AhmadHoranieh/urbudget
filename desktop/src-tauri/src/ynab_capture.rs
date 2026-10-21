//! Tauri adapters; import download, delta merge, audits and conflict reviews live in services.
use crate::Database;
use tauri::{Manager,State};
use std::collections::BTreeMap;
pub use urbudget_services::ynab_capture::{PendingImport,ImportResult,PlanChoice};
use urbudget_services::ynab_capture as service;
#[tauri::command]
pub async fn ynab_plans(token:String,saved_token:Option<String>)->Result<Vec<PlanChoice>,String>{service::ynab_plans(token,saved_token).await}
#[tauri::command]
pub async fn sync_ynab(app:tauri::AppHandle,db:State<'_,Database>,token:String,plan_id:String,expected_token:String,replace:bool,remember_token:Option<bool>,token_label:Option<String>,saved_token:Option<String>)->Result<ImportResult,String>{
 service::sync_ynab(&db,&app.state::<PendingImport>(),token,plan_id,expected_token,replace,remember_token,token_label,saved_token).await
}
#[tauri::command]
pub async fn accept_ynab_import(app:tauri::AppHandle,review_id:String,expected_token:String)->Result<ImportResult,String>{
 service::accept_ynab_import(&app.state::<Database>(),&app.state::<PendingImport>(),review_id,expected_token).await
}
#[tauri::command]
pub async fn resolve_ynab(app:tauri::AppHandle,review_id:String,choices:BTreeMap<String,String>,expected_token:String)->Result<ImportResult,String>{
 service::resolve_ynab(&app.state::<Database>(),&app.state::<PendingImport>(),review_id,choices,expected_token).await
}
