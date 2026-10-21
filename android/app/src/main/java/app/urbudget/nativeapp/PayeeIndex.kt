package app.urbudget.nativeapp

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

private fun JSONObject.str(key: String) = if (isNull(key)) "" else optString(key)

/**
 * A payee as the Payees page lists it (desktop payees.ts): how often and when it was last used,
 * its saved default category, and the category its latest single-category transaction used.
 * A category is "__rta" for Unassigned and blank for spending left without one; `lastUsed` is null
 * when no transaction says.
 */
internal data class PayeeInfo(val name: String, val record: JSONObject, val count: Int, val last: String, val lastUsed: String?, val default: String?) {
    /** The default, else the category used last (payees.ts's categoryId). */
    val category: String? get() = default ?: lastUsed
    val fixed: Boolean get() = default != null
}

/** Every payee with usage counts, most used first; payees only in schedules, splits or rules come last. */
internal suspend fun payeeIndex(budget: JSONObject): List<PayeeInfo> {
    val context = currentCoroutineContext()
    context.ensureActive()
    class Usage(var count: Int = 0, var last: String = "", var category: String? = null)
    val usage = LinkedHashMap<String, Usage>()
    val others = LinkedHashSet<String>()
    val transactions = budget.optJSONArray("transactions") ?: JSONArray()
    for (i in 0 until transactions.length()) {
        if (i % 256 == 0) context.ensureActive()
        val t = transactions.optJSONObject(i) ?: continue
        t.records("splits").forEach { s -> s.str("payee").trim().takeIf { it.isNotEmpty() }?.let(others::add) }
        val name = t.str("payee").trim()
        if (name.isEmpty() || t.str("transferAccountId").isNotBlank()) continue
        val info = usage.getOrPut(name) { Usage() }
        info.count++
        val date = t.str("date")
        if (date >= info.last) {
            info.last = date
            val splits = t.records("splits")
            val only = splits.singleOrNull()
            if (only != null && only.str("transferAccountId").isBlank())
                info.category = only.str("categoryId").ifBlank { if (only.optBoolean("unassigned") || t.optLong("amount") > 0) "__rta" else "" }
        }
    }
    budget.records("schedules").forEach { s -> s.optJSONObject("transaction")?.str("payee")?.trim()?.takeIf { it.isNotEmpty() }?.let(others::add) }
    budget.records("payeeRules").forEach { r -> r.str("payee").trim().takeIf { it.isNotEmpty() }?.let(others::add) }
    val categories = budget.records("categories").map { it.str("id") }.toSet()
    val saved = HashMap<String, JSONObject>()
    val fixed = HashMap<String, String>()
    for (p in budget.records("payees")) {
        val name = p.str("name")
        // YNAB's own transfer payees ("Transfer : Savings") are offered as real transfers instead.
        if (name.isBlank() || p.str("transfer_account_id").isNotBlank() || p.optBoolean("deleted") || name.startsWith("Transfer : ")) continue
        saved.putIfAbsent(name, p)
        usage.getOrPut(name) { Usage() }
        val category = p.str("categoryId")
        // A default category (skipped if that category has since been deleted) beats the last one used.
        if (category.isNotBlank() && (category == "__rta" || category in categories) && name !in fixed) fixed[name] = category
    }
    context.ensureActive()
    fun record(name: String) = saved[name] ?: JSONObject().put("id", UUID.nameUUIDFromBytes(("payee:$name").toByteArray(Charsets.UTF_8)).toString()).put("name", name)
    val listed = usage.map { (name, info) -> PayeeInfo(name, record(name), info.count, info.last, info.category, fixed[name]) }
        .sortedWith(compareBy<PayeeInfo>({ -it.count }, { it.name.lowercase() }, { it.name }))
    val extra = others.filter { it !in usage }.sortedWith(compareBy<String>({ it.lowercase() }, { it }))
        .map { PayeeInfo(it, record(it), 0, "", null, null) }
    return listed + extra
}

/** One of a payee's recent transactions, as its page lists them. */
internal data class PayeeRecent(val id: String, val date: String, val accountId: String, val splits: Int, val categoryId: String, val amount: Long)

/** A payee's page: how many transactions, their total, and the latest six. */
internal data class PayeeDetail(val count: Int, val total: Long, val recent: List<PayeeRecent>)

internal suspend fun payeeDetail(budget: JSONObject, name: String): PayeeDetail {
    val context = currentCoroutineContext()
    context.ensureActive()
    val matching = ArrayList<JSONObject>()
    val transactions = budget.optJSONArray("transactions") ?: JSONArray()
    for (i in 0 until transactions.length()) {
        if (i % 256 == 0) context.ensureActive()
        val t = transactions.optJSONObject(i) ?: continue
        if (t.str("payee") == name) matching.add(t)
    }
    val newest = matching.sortedWith(compareByDescending<JSONObject> { it.str("date") }.thenByDescending { it.str("createdAt") })
    return PayeeDetail(matching.size, matching.sumOf { it.optLong("amount") }, newest.take(6).map { t ->
        val splits = t.records("splits")
        PayeeRecent(t.str("id"), t.str("date"), t.str("accountId"), splits.size, splits.firstOrNull()?.str("categoryId").orEmpty(), t.optLong("amount"))
    })
}

/**
 * The payee rules as Rust runs them (workflows.rs), mirrored to say what a rule would change
 * before it runs (desktop bankNames.ts). The engine stays the authority when they're applied.
 */
internal object PayeeRules {
    private val separators = Regex("[^\\p{IsAlphabetic}\\p{N}]+")

    /** Bank text as rules read it: lower case, with punctuation and runs of spaces as one space. */
    fun normalize(text: String) = text.lowercase().replace(separators, " ").trim()

    private class Pattern(val rule: JSONObject, val text: String, val length: Int)

    private fun patterns(rules: List<JSONObject>) = rules.map { rule ->
        val text = normalize(rule.str("match"))
        Pattern(rule, text, text.codePointCount(0, text.length))
    }

    /** Of the rules whose text the bank text contains from the start of a word, the longest; ties go in list order. */
    private fun best(list: List<Pattern>, text: String): JSONObject? {
        val padded = " ${normalize(text)}"
        var found: JSONObject? = null
        var length = 0
        for (p in list) if (p.text.isNotEmpty() && p.length > length && padded.contains(" ${p.text}")) { found = p.rule; length = p.length }
        return found
    }

    private fun placeholder(categories: Map<String, String>, id: String) =
        id == "local-uncategorized" || categories[id].let { it == "Uncategorized" || it == "Uncategorized Transactions" }

    /**
     * How many transactions running `rules` again would rename or categorize; with `only`, just
     * where a transaction's best rule is one of those ids.
     */
    suspend fun changes(budget: JSONObject, rules: List<JSONObject>, only: Set<String>? = null): Int {
        val context = currentCoroutineContext()
        context.ensureActive()
        val list = patterns(rules)
        if (list.none { it.text.isNotEmpty() }) return 0
        val categories = budget.records("categories").associate { it.str("id") to it.str("name") }
        val onBudget = budget.records("accounts").associate { it.str("id") to AccountTypes.onBudget(it) }
        val defaults = HashMap<String, String>()
        budget.records("payees").forEach { p -> if (p.str("name") !in defaults) defaults[p.str("name")] = p.str("categoryId") }
        var count = 0
        val transactions = budget.optJSONArray("transactions") ?: JSONArray()
        for (i in 0 until transactions.length()) {
            if (i % 256 == 0) context.ensureActive()
            val t = transactions.optJSONObject(i) ?: continue
            if (t.str("transferAccountId").isNotBlank()) continue
            val imported = if (t.has("importedPayee") && !t.isNull("importedPayee")) t.optString("importedPayee") else null
            val rule = best(list, if (!imported.isNullOrBlank()) imported else t.str("payee"))
            if (only != null && (rule == null || rule.str("id") !in only)) continue
            val name = rule?.str("payee")?.trim()?.ifEmpty { null }
            val payee = name ?: t.str("payee")
            val splits = t.records("splits")
            val split = splits.firstOrNull()
            val before = split?.str("categoryId").orEmpty()
            var category = before
            if (split != null && splits.size == 1 && onBudget[t.str("accountId")] == true && split.str("transferAccountId").isBlank()) {
                // An inflow without a category is in Ready to Assign, which may be on purpose.
                val empty = if (before.isEmpty()) t.optLong("amount") < 0 else placeholder(categories, before)
                val fallback = if (name != null || imported != null) defaults[payee]?.ifBlank { null } else null
                val pick = rule?.str("categoryId")?.ifBlank { null } ?: fallback
                if (empty && pick != null && !placeholder(categories, pick) && pick in categories) category = pick
            }
            if (payee != t.str("payee") || category != before) count++
        }
        return count
    }
}
