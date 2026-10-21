package app.urbudget.nativeapp

import org.json.JSONObject
import java.time.LocalDate

/**
 * Spending with no category yet, as YNAB's "This needs a category" (desktop/src/uncategorized.ts).
 * Only money leaving the budget needs one: money coming in with none is income for Unassigned, and
 * a transfer between budget accounts needs none. Categories named "Uncategorized" (YNAB's) count
 * as none. Scheduled transactions aren't counted until they're entered.
 */
class Uncategorized(budget: JSONObject, private val today: String = LocalDate.now().toString()) {
    private val onBudget = HashMap<String, Boolean>()
    private val tracking = HashSet<String>()
    private val placeholders = HashSet<String>().apply { add("local-uncategorized") }

    init {
        budget.optJSONArray("accounts")?.let { accounts ->
            for (i in 0 until accounts.length()) {
                val a = accounts.optJSONObject(i) ?: continue
                val budgetSide = a.optString("kind") != "tracking" && a.optBoolean("onBudget", true)
                onBudget[a.optString("id")] = budgetSide
                if (!budgetSide) tracking.add(a.optString("id"))
            }
        }
        budget.optJSONArray("categories")?.let { categories ->
            for (i in 0 until categories.length()) {
                val c = categories.optJSONObject(i) ?: continue
                val name = c.optString("name")
                if (name == "Uncategorized" || name == "Uncategorized Transactions") placeholders.add(c.optString("id"))
            }
        }
    }

    private fun JSONObject.textOrNull(key: String) = if (isNull(key) || !has(key)) null else optString(key).ifBlank { null }

    /** Whether the line was left for Unassigned on purpose (income), as desktop's leftUnassigned. */
    private fun leftUnassigned(t: JSONObject, s: JSONObject, single: Boolean): Boolean {
        if (s.has("unassigned") && !s.isNull("unassigned")) return s.optBoolean("unassigned")
        val source = s.optJSONObject("source") ?: if (single) t.optJSONObject("source") else null
        val name = source?.optString("category_name")
        return name == "Inflow: Ready to Assign" || name == "Inflow: To be Budgeted" || t.optString("payee") == "Reconciliation adjustment"
    }

    /** How much a line spends with no category: its money out, seen from the budget, or 0. */
    fun missing(t: JSONObject, s: JSONObject): Long {
        if (t.optString("date") > today) return 0
        val self = onBudget[t.optString("accountId")] ?: false
        val peer = s.textOrNull("transferAccountId") ?: t.textOrNull("transferAccountId")
        val other = peer?.let { onBudget[it] ?: false }
        val line = s.optLong("amount")
        val amount = when {
            other == null -> if (self) line else 0
            self == other -> 0
            self -> line
            else -> -line
        }
        if (amount >= 0) return 0
        val category = s.textOrNull("categoryId")
        val splits = t.optJSONArray("splits")
        val none = if (category == null) !leftUnassigned(t, s, (splits?.length() ?: 0) == 1) else category in placeholders
        return if (none) -amount else 0
    }

    fun needs(t: JSONObject, s: JSONObject) = missing(t, s) > 0

    fun needs(t: JSONObject): Boolean {
        val splits = t.optJSONArray("splits") ?: return false
        for (i in 0 until splits.length()) if (missing(t, splits.optJSONObject(i) ?: continue) > 0) return true
        return false
    }

    /** How many entered transactions need a category, how much they spend, and how many per budget account. */
    data class Counts(val total: Int, val amount: Long, val byAccount: Map<String, Int>)

    fun counts(budget: JSONObject): Counts {
        val transactions = budget.optJSONArray("transactions") ?: return Counts(0, 0, emptyMap())
        var total = 0
        var amount = 0L
        val byAccount = HashMap<String, Int>()
        for (i in 0 until transactions.length()) {
            val t = transactions.optJSONObject(i) ?: continue
            val splits = t.optJSONArray("splits") ?: continue
            var spent = 0L
            val affected = HashSet<String>()
            for (j in 0 until splits.length()) {
                val s = splits.optJSONObject(j) ?: continue
                val m = missing(t, s)
                if (m <= 0) continue
                spent += m
                // A tracking-side split spends the budget account on the other side.
                val account = if (t.optString("accountId") in tracking) s.textOrNull("transferAccountId") ?: t.textOrNull("transferAccountId") else t.optString("accountId")
                if (account != null) affected.add(account)
            }
            if (spent == 0L) continue
            total++
            amount += spent
            affected.forEach { byAccount[it] = (byAccount[it] ?: 0) + 1 }
        }
        return Counts(total, amount, byAccount)
    }
}
