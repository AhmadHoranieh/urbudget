package app.urbudget.nativeapp

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONObject
import java.util.Locale

/** Read-only presentation index, prepared on a worker once per published budget snapshot. */
internal class RegisterIndex private constructor(private val entries: List<Entry>) {
    data class Entry(
        val transaction: JSONObject, val id: String, val date: String, val created: String,
        val payeeOrder: String, val amount: Long, val accountAmounts: Map<String, Long>,
        val status: String, val accountStatuses: Map<String, List<String>>, val approved: Boolean,
        val categories: Set<String>, val flag: String, val searchFields: List<String>,
        /** Which lines need a category (desktop's uncategorized rule), by split index. */
        val needsCategory: Set<Int> = emptySet(),
    ) {
        fun amountFor(account: String) = if (account.isBlank()) amount else accountAmounts[account] ?: 0L
    }

    data class Filter(
        val account: String = "", val status: String = "", val category: String = "", val flag: String = "",
        val from: String = "", val through: String = "", val minimum: Long? = null, val maximum: Long? = null,
        val invalidAmount: Boolean = false, val search: String = "", val order: String = "newest",
    )

    /** How many transactions wait for approval in an account (or all of them). */
    fun awaitingApproval(account: String = "") = entries.count { !it.approved && (account.isBlank() || account in it.accountAmounts) }

    suspend fun matching(filter: Filter): List<Entry> {
        val context = currentCoroutineContext()
        context.ensureActive()
        if (filter.invalidAmount) return emptyList()
        val found = ArrayList<Entry>()
        val terms = filter.search.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
        entries.forEachIndexed { index, row ->
            if (index % 256 == 0) context.ensureActive()
            if (filter.account.isNotEmpty() && filter.account !in row.accountAmounts) return@forEachIndexed
            val statuses = if (filter.account.isBlank()) listOf(row.status) else row.accountStatuses[filter.account].orEmpty()
            when (filter.status) {
                "" -> Unit
                "approval" -> if (row.approved) return@forEachIndexed
                "notReconciled" -> if ("reconciled" in statuses) return@forEachIndexed
                else -> if (filter.status !in statuses) return@forEachIndexed
            }
            if (filter.category.isNotEmpty() && filter.category !in row.categories) return@forEachIndexed
            when (filter.flag) {
                "" -> Unit
                "__any" -> if (row.flag.isEmpty()) return@forEachIndexed
                "__none" -> if (row.flag.isNotEmpty()) return@forEachIndexed
                else -> if (row.flag != filter.flag) return@forEachIndexed
            }
            if (filter.from.isNotBlank() && row.date < filter.from || filter.through.isNotBlank() && row.date > filter.through) return@forEachIndexed
            // Amounts match by size, so a range finds outflows and inflows alike, as on the desktop.
            val size = kotlin.math.abs(row.amountFor(filter.account))
            if (filter.minimum != null && size < kotlin.math.abs(filter.minimum) || filter.maximum != null && size > kotlin.math.abs(filter.maximum)) return@forEachIndexed
            // Every word must appear in some field.
            if (terms.isNotEmpty() && terms.any { term -> row.searchFields.none { it.contains(term, ignoreCase = true) } }) return@forEachIndexed
            found.add(row)
        }
        val comparison = when (filter.order) {
            "oldest" -> compareBy<Entry> { it.date }
            "amount" -> compareBy { it.amountFor(filter.account) }
            "payee" -> compareBy { it.payeeOrder }
            else -> compareByDescending<Entry> { it.date }.thenByDescending { it.created }
        }
        var comparisons = 0
        found.sortWith { a, b ->
            if (++comparisons % 1024 == 0) context.ensureActive()
            comparison.compare(a, b)
        }
        context.ensureActive()
        return found
    }

    companion object {
        suspend fun build(budget: JSONObject): RegisterIndex {
            val context = currentCoroutineContext()
            val accounts = budget.records("accounts").associate { it.indexText("id") to it.indexText("name") }
            val categories = budget.records("categories").associate { it.indexText("id") to it.indexText("name") }
            val uncategorized = Uncategorized(budget)
            val transactions = budget.optJSONArray("transactions")
            val entries = ArrayList<Entry>(transactions?.length() ?: 0)
            for (index in 0 until (transactions?.length() ?: 0)) {
                if (index % 128 == 0) context.ensureActive()
                val transaction = transactions?.optJSONObject(index) ?: continue
                val splits = transaction.records("splits")
                val accountIds = buildSet {
                    add(transaction.indexText("accountId"))
                    transaction.indexText("transferAccountId").takeIf { !transaction.isNull("transferAccountId") && it.isNotBlank() }?.let(::add)
                    splits.forEach { part -> part.indexText("transferAccountId").takeIf { !part.isNull("transferAccountId") && it.isNotBlank() }?.let(::add) }
                }
                val needs = HashSet<Int>()
                val tags = buildSet {
                    splits.forEachIndexed { i, part ->
                        if (part.optBoolean("unassigned")) add("__rta")
                        val category = part.indexText("categoryId").takeUnless { part.isNull("categoryId") || it.isBlank() }
                        if (category != null) add(category)
                        // "Uncategorized" means what desktop counts: money leaving the budget with no category.
                        if (uncategorized.needs(transaction, part)) { add("__none"); needs.add(i) }
                    }
                }
                val amount = transaction.optLong("amount")
                entries.add(Entry(transaction, transaction.indexText("id"), transaction.indexText("date"), transaction.indexText("createdAt"),
                    transaction.indexText("payee").lowercase(Locale.ROOT), amount,
                    accountIds.associateWith { registerAmount(transaction, it) }, transaction.indexText("status"),
                    accountIds.associateWith { registerStatuses(transaction, it) }, transaction.optBoolean("approved", true), tags,
                    if (transaction.isNull("flag")) "" else transaction.indexText("flag"),
                    listOf(transaction.indexText("payee"), transaction.indexText("memo"), transaction.indexText("date"),
                        accounts[transaction.indexText("accountId")].orEmpty(), accounts[transaction.indexText("transferAccountId")].orEmpty(),
                        splits.joinToString(" ") { "${categories[it.indexText("categoryId")].orEmpty()} ${it.indexText("memo")} ${it.indexText("payee")}" },
                        Money.editable(kotlin.math.abs(amount)), Money.format(kotlin.math.abs(amount), budget.optString("currency"))),
                    needs))
            }
            context.ensureActive()
            return RegisterIndex(entries)
        }
    }
}

private fun JSONObject.indexText(key: String, fallback: String = ""): String = if (isNull(key)) fallback else optString(key, fallback)
