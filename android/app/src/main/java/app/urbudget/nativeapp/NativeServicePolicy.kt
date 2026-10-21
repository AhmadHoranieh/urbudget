package app.urbudget.nativeapp

/** Network/state work owns its own service locks; only budget commits occupy the edit queue. */
internal object NativeServicePolicy {
    private val bankState = setOf("simplefin_status", "simplefin_connect", "simplefin_accounts", "simplefin_disconnect", "simplefin_open", "simplefin_sync")
    private val reads = setOf("cloud_status", "account_overview", "billing_context", "sync_status", "sync_has_key",
        "native_budget_status", "database_status", "list_budgets", "list_backups", "backup_retention",
        "simplefin_status", "simplefin_accounts", "simplefin_sync", "ynab_tokens", "ynab_plans")
    fun coalesce(method: String) = method in reads
    fun independent(method: String) = method in bankState || method in reads || method in setOf("forget_ynab_token", "sync_ynab") ||
        method.startsWith("account_") || method.startsWith("billing_") || method.startsWith("sync_")
    fun budgetResult(method: String) = method in setOf("sync_ynab", "sync_now", "sync_resolve")
    fun review(method: String) = method == "simplefin_sync"
    fun budgetRead(method: String) = review(method) || method in setOf("native_budget_status", "database_status", "list_backups", "backup_retention")
}
