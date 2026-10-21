package app.urbudget.nativeapp

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject

private fun JSONObject.str(key: String) = if (isNull(key)) "" else optString(key)

/**
 * Account types as the desktop reads them (desktop/src/accounts.ts): the type chosen, else the
 * type a YNAB import gave the account, else a guess from its kind, tracking accounts by the sign
 * of their balance. The type sets the kind; a kind is never changed by reading a type.
 */
internal object AccountTypes {
    private val known = setOf("checking", "savings", "cash", "investment", "retirement", "property", "vehicle", "receivable", "otherAsset",
        "creditCard", "lineOfCredit", "mortgage", "autoLoan", "studentLoan", "personalLoan", "medicalDebt", "otherDebt")
    private val liabilities = setOf("creditCard", "lineOfCredit", "mortgage", "autoLoan", "studentLoan", "personalLoan", "medicalDebt", "otherDebt")

    fun kindFor(type: String) = when (type) {
        "checking", "savings", "cash" -> "cash"
        "creditCard", "lineOfCredit" -> "credit"
        else -> "tracking"
    }

    fun isLiability(type: String) = type in liabilities

    /** Debts tracked outside the budget (mortgages, loans): the types with loan details and a payoff planner. */
    fun isLoanType(type: String) = isLiability(type) && kindFor(type) == "tracking"

    /** The account's type, as accounts.ts's accountType reads it. */
    fun infer(account: JSONObject, balance: Long = account.optLong("openingBalance")): String {
        val chosen = account.str("accountType")
        if (chosen in known) return chosen
        val imported = account.optJSONObject("source")?.opt("type") as? String ?: ""
        if (imported == "otherLiability") return "otherDebt"
        if (imported in known) return imported
        return when (account.str("kind")) {
            "credit" -> "creditCard"
            "cash" -> "checking"
            else -> if (balance < 0) "otherDebt" else "otherAsset"
        }
    }

    /**
     * The type an account form starts with. An imported description can differ from the stored
     * accounting kind (a tracked card); editing the account must not move its history into or out
     * of the budget, so a type of another kind falls back to the guess from the kind alone.
     */
    fun forEditing(account: JSONObject, balance: Long): String {
        val selected = infer(account, balance)
        if (kindFor(selected) == account.str("kind")) return selected
        return infer(JSONObject().put("kind", account.str("kind")).put("openingBalance", account.optLong("openingBalance")), balance)
    }

    /** Tracking accounts can opt out of net worth; nothing else does. */
    fun inNetWorth(account: JSONObject) = account.opt("netWorth") != false

    /** Whether the account's money is in the budget. */
    fun onBudget(account: JSONObject) = account.str("kind") != "tracking" && account.opt("onBudget") != false

    /** A tracking debt, or any account with loan details saved (Planning.tsx's hasLoan). */
    fun hasLoan(account: JSONObject, balance: Long, loanAccounts: Set<String>) =
        account.str("id") in loanAccounts || account.str("kind") == "tracking" && isLoanType(infer(account, balance))

    /**
     * The accounts with `id` moved next to `neighbour` (after it when `after`), as the desktop's
     * Move up and Move down keep the order: in the accounts list itself.
     */
    fun moveAccount(accounts: List<JSONObject>, id: String, neighbour: String, after: Boolean): List<JSONObject> {
        val moving = accounts.firstOrNull { it.str("id") == id } ?: return accounts
        val rest = accounts.filter { it !== moving }.toMutableList()
        val at = rest.indexOfFirst { it.str("id") == neighbour }
        if (at < 0 || id == neighbour) return accounts
        rest.add(at + if (after) 1 else 0, moving)
        return rest
    }

    fun moveAccount(accounts: JSONArray, id: String, neighbour: String, after: Boolean): JSONArray =
        JSONArray(moveAccount((0 until accounts.length()).mapNotNull(accounts::optJSONObject), id, neighbour, after))
}

/** What an account row marks: transactions waiting for approval, and spending that needs a category. */
internal data class AccountBadges(val approvals: Map<String, Int>, val uncategorized: Map<String, Int>)

/**
 * Per-account marks, as the desktop's phone accounts list counts them: imported transactions not
 * yet approved, and (uncategorized.ts) money leaving the budget, dated today or earlier, with no
 * category, counted once for each budget account whose money it spends.
 */
internal suspend fun accountBadges(budget: JSONObject, today: String): AccountBadges {
    val context = currentCoroutineContext()
    context.ensureActive()
    val accounts = budget.records("accounts")
    val onBudget = accounts.associate { it.str("id") to AccountTypes.onBudget(it) }
    val tracking = accounts.filter { !AccountTypes.onBudget(it) }.map { it.str("id") }.toSet()
    val empty = budget.records("categories").filter { it.str("name") == "Uncategorized" || it.str("name") == "Uncategorized Transactions" }
        .map { it.str("id") }.toHashSet().apply { add("local-uncategorized") }
    val approvals = HashMap<String, Int>()
    val uncategorized = HashMap<String, Int>()
    val transactions = budget.optJSONArray("transactions") ?: JSONArray()
    for (i in 0 until transactions.length()) {
        if (i % 256 == 0) context.ensureActive()
        val t = transactions.optJSONObject(i) ?: continue
        val account = t.str("accountId")
        if (t.opt("approved") == false) approvals[account] = (approvals[account] ?: 0) + 1
        if (t.str("date") > today) continue
        val splits = t.optJSONArray("splits") ?: continue
        val affected = HashSet<String>(2)
        for (j in 0 until splits.length()) {
            val s = splits.optJSONObject(j) ?: continue
            if (!needsCategory(t, s, splits.length(), onBudget, empty)) continue
            val owner = if (account in tracking) s.str("transferAccountId").ifBlank { t.str("transferAccountId") } else account
            if (owner.isNotBlank()) affected.add(owner)
        }
        for (owner in affected) uncategorized[owner] = (uncategorized[owner] ?: 0) + 1
    }
    return AccountBadges(approvals, uncategorized)
}

/** One line of a transaction spends money out of the budget with no category (uncategorizedTest). */
private fun needsCategory(t: JSONObject, s: JSONObject, lines: Int, onBudget: Map<String, Boolean>, empty: Set<String>): Boolean {
    val self = onBudget[t.str("accountId")] ?: false
    val peer = s.str("transferAccountId").ifBlank { t.str("transferAccountId") }
    val amount = s.optLong("amount")
    // The line's amount seen from the budget: categories only ever apply on the budget side.
    val budgetAmount = if (peer.isBlank()) { if (self) amount else 0 } else {
        val other = onBudget[peer] ?: false
        if (self == other) 0 else if (self) amount else -amount
    }
    if (budgetAmount >= 0) return false
    val category = s.str("categoryId")
    return if (category.isBlank()) !leftUnassigned(t, s, lines) else category in empty
}

/** Money deliberately left in Unassigned (accounting.ts's leftUnassigned). */
private fun leftUnassigned(t: JSONObject, s: JSONObject, lines: Int): Boolean {
    val flag = s.opt("unassigned")
    if (flag is Boolean) return flag
    val source = s.optJSONObject("source") ?: if (lines == 1) t.optJSONObject("source") else null
    val name = source?.str("category_name")
    return name == "Inflow: Ready to Assign" || name == "Inflow: To be Budgeted" || t.str("payee") == "Reconciliation adjustment"
}
