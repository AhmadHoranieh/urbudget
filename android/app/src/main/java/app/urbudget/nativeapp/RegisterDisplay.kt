package app.urbudget.nativeapp

import org.json.JSONObject

/** Signed movement for the register's chosen account, including net split-transfer legs. */
internal fun registerAmount(transaction: JSONObject, account: String): Long {
    val amount = transaction.optLong("amount")
    if (account.isBlank() || transaction.displayText("accountId") == account) return amount
    if (transaction.displayText("transferAccountId") == account) return -amount
    return transaction.records("splits").filter { it.displayText("transferAccountId") == account }.sumOf { -it.optLong("amount") }
}

internal fun registerStatuses(transaction: JSONObject, account: String): List<String> {
    if (account.isBlank() || transaction.displayText("accountId") == account) return listOf(transaction.displayText("status"))
    if (transaction.displayText("transferAccountId") == account) return listOf(transaction.displayText("transferStatus", "uncleared"))
    return transaction.records("splits").filter { it.displayText("transferAccountId") == account }.map { it.displayText("transferStatus", "uncleared") }
}

private fun JSONObject.displayText(key: String, fallback: String = ""): String = if (isNull(key)) fallback else optString(key, fallback)
