package app.urbudget.nativeapp

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Small immutable view records built away from composition; source JSON stays read-only. A
 * `locked` row is already imported and has nothing to decide. "review" is a decision still to make:
 * the import waits until no row has it.
 */
internal data class BankReviewRow(
    val source: JSONObject, val options: List<Pair<String, String>>, val initial: String, val manualImportId: String, val previouslyMatched: Set<String>,
    val key: String = manualImportId, val locked: Boolean = false, val date: String = "", val payee: String = "", val bankText: String? = null,
    val memo: String = "", val amount: Long = 0, val amountText: String = "", val duplicate: Boolean = false, val possibleDuplicate: Boolean = false,
    val idless: Boolean = false, val detail: String = "",
) {
    /** The row's decision, given the choices made so far. */
    fun decision(chosen: String?): String = if (locked) "skip" else chosen ?: initial
}

/** How many rows a review imports or matches, and how many still need a choice. */
internal fun bankReviewCounts(rows: List<BankReviewRow>, chosen: Map<Int, String>): Pair<Int, Int> {
    var importing = 0
    var undecided = 0
    rows.forEachIndexed { index, row ->
        when (row.decision(chosen[index])) { "skip" -> Unit; "review" -> undecided++; else -> importing++ }
    }
    return importing to undecided
}

/** The review's figures: rows already imported, rows a payee rule renamed, and what a note should say. */
internal data class BankReviewSummary(val rows: Int, val duplicates: Int, val renamed: Int, val idless: Boolean, val allIn: Boolean)

internal fun summarizeBankReview(rows: List<BankReviewRow>) = BankReviewSummary(rows.size, rows.count { it.duplicate },
    rows.count { !it.duplicate && it.bankText != null }, rows.any { it.possibleDuplicate || it.idless && it.duplicate },
    rows.size >= 3 && rows.all { it.amount > 0 })

/** Desktop's defaultChoice: skip known bank IDs; take a single match only when that account side was not imported before. */
internal fun defaultBankChoice(duplicate: Boolean, possibleDuplicate: Boolean, candidates: List<String>, previouslyMatched: Set<String>): String = when {
    duplicate -> "skip"
    possibleDuplicate -> "review"
    candidates.isEmpty() -> "new"
    candidates.size == 1 && candidates[0] !in previouslyMatched -> "match:${candidates[0]}"
    else -> "review"
}

private fun alreadyImportedOptions() = listOf("skip" to Words[R.string.bank_option_already_imported], "new" to Words[R.string.bank_option_add_separate])

private fun JSONObject.editorText(key: String) = if (isNull(key)) "" else optString(key)

/** Avoid a second boxed copy of every export byte while retaining the engine's u8 protocol. */
internal suspend fun encodeFileBytes(bytes: ByteArray): JSONArray {
    val context = currentCoroutineContext()
    context.ensureActive()
    return JSONArray().also { encoded ->
        bytes.forEachIndexed { index, byte ->
            if (index % 4096 == 0) context.ensureActive()
            encoded.put(byte.toInt() and 255)
        }
    }
}

/** One candidate pool's choices, built once and shared by every row that uses the pool. */
private class CandidateOptions(val matches: List<Pair<String, String>>, val candidates: List<String>, val previouslyMatched: Set<String>) {
    /** Choose, add, skip, then each match: the label of the undecided choice says why it's undecided. */
    val choose by lazy { listOf("review" to Words[R.string.bank_option_choose], "new" to Words[R.string.bank_option_add_new], "skip" to Words[R.string.bank_option_skip]) + matches }
    val possible by lazy { listOf("review" to Words[R.string.bank_option_possible], "new" to Words[R.string.bank_option_add_new], "skip" to Words[R.string.bank_option_skip]) + matches }
}

/** Candidates are a shared pool on Android; do not expand them once per bank row. */
internal suspend fun prepareBankReview(
    rows: List<JSONObject>, budget: JSONObject, allowIdlessDuplicate: Boolean, candidateSets: JSONArray? = null
): List<BankReviewRow> {
    val context = currentCoroutineContext()
    context.ensureActive()
    val currency = budget.editorText("currency").ifBlank { "SAR" }
    val transactions = budget.records("transactions").associateBy { it.editorText("id") }
    val preparedSets = mutableMapOf<Int, CandidateOptions>()
    val alreadyImported by lazy { alreadyImportedOptions() }
    val noPayee = Words[R.string.payee_none]
    fun prepareOptions(source: JSONObject): CandidateOptions {
        val details = source.records("candidateDetails").associateBy { it.editorText("id") }
        val previous = source.optJSONArray("previouslyMatchedCandidates")
        val previouslyMatched = HashSet<String>()
        for (i in 0 until (previous?.length() ?: 0)) {
            if (i % 128 == 0) context.ensureActive()
            previouslyMatched.add(previous!!.getString(i))
        }
        val candidates = source.optJSONArray("candidates") ?: JSONArray()
        val ids = ArrayList<String>(candidates.length())
        val matches = ArrayList<Pair<String, String>>(candidates.length())
        for (i in 0 until candidates.length()) {
            if (i % 128 == 0) context.ensureActive()
            val id = candidates.optString(i)
            ids += id
            val detail = details[id]
            val saved = transactions[detail?.editorText("transactionId")?.takeIf { it.isNotBlank() } ?: id]
            matches += "match:$id" to matchLabel(id, saved, detail, id in previouslyMatched)
        }
        return CandidateOptions(matches, ids, previouslyMatched)
    }
    return rows.mapIndexed { index, row ->
        if (index % 128 == 0) context.ensureActive()
        val set = if (row.has("candidateSet")) {
            val setIndex = row.optInt("candidateSet", -1)
            preparedSets.getOrPut(setIndex) { prepareOptions(requireNotNull(candidateSets?.optJSONObject(setIndex)) { Words[R.string.bank_match_details_missing] }) }
        } else prepareOptions(row)
        val duplicate = row.optBoolean("duplicate")
        val possible = row.optBoolean("possibleDuplicate")
        val idless = row.optBoolean("idless")
        // An already-imported row can only be added again when it has no bank ID and that's allowed.
        val separate = duplicate && allowIdlessDuplicate && idless
        val options = when {
            separate -> alreadyImported
            duplicate -> emptyList()
            possible -> set.possible
            else -> set.choose
        }
        val manual = "bank:manual:${UUID.randomUUID()}"
        val rename = row.editorText("rename").takeIf { it.isNotBlank() && it != row.editorText("payee") }
        BankReviewRow(smallBankRow(row), options, defaultBankChoice(duplicate, possible, set.candidates, set.previouslyMatched), manual, set.previouslyMatched,
            key = "$index:${row.editorText("id")}", locked = duplicate && !separate, date = Money.date(row.editorText("date")),
            payee = (rename ?: row.editorText("payee")).ifBlank { noPayee }, bankText = rename?.let { row.editorText("payee") },
            memo = row.editorText("memo"), amount = row.optLong("amount"), amountText = Money.format(row.optLong("amount"), currency),
            duplicate = duplicate, possibleDuplicate = possible, idless = idless,
            detail = Money.joined(listOf(Money.date(row.editorText("date")), row.editorText("memo")).filter { it.isNotBlank() }))
    }
}

/**
 * "Match: 3 Oct 2026 · Shop · Split 2 · memo · Previously imported", as the desktop labels a match.
 * The payee and memo keep their own direction inside a right-to-left label.
 */
private fun matchLabel(id: String, saved: JSONObject?, detail: JSONObject?, previously: Boolean): String {
    val previous = if (previously) Words[R.string.bank_previously_imported] else null
    if (saved == null) return Words[R.string.bank_match, listOfNotNull(Money.own(id), previous).joinToString(" · ")]
    val part = detail?.let { saved.records("splits").getOrNull(it.optInt("splitIndex")) }
    val memo = part?.editorText("memo")?.ifBlank { null } ?: saved.editorText("memo")
    return Words[R.string.bank_match, listOfNotNull(
        Money.date(saved.editorText("date")),
        saved.editorText("payee").ifBlank { null }?.let(Money::own) ?: Words[R.string.transfer_label],
        detail?.let { Words[R.string.bank_match_split, (it.optInt("splitIndex") + 1).toString()] },
        memo.ifBlank { null }?.let(Money::own),
        previous,
    ).joinToString(" · ")]
}

/** Matching revalidates against the current ledger; only the selected prior match is needed. */
private fun smallBankRow(source: JSONObject): JSONObject = JSONObject().also { row ->
    source.keys().forEach { key ->
        if (key != "candidateSet" && key != "candidates" && key != "candidateDetails" && key != "previouslyMatchedCandidates") row.put(key, source.get(key))
    }
}

internal suspend fun bankReviewChoices(rows: List<BankReviewRow>, overrides: Map<Int, String>, allowIdlessDuplicate: Boolean): JSONArray {
    val context = currentCoroutineContext()
    context.ensureActive()
    val choices = JSONArray()
    rows.forEachIndexed { index, prepared ->
        if (index % 128 == 0) context.ensureActive()
        // The review screens wait until no row is undecided; any other caller never imports or
        // matches a row nobody decided on.
        val decision = prepared.decision(overrides[index]).let { if (it == "review") "skip" else it }
        val source = prepared.source
        val row = smallBankRow(source)
        if (allowIdlessDuplicate && decision == "new" && source.optBoolean("idless") && (source.optBoolean("duplicate") || source.optBoolean("possibleDuplicate"))) row.put("importId", prepared.manualImportId)
        val matchId = if (decision.startsWith("match:")) decision.removePrefix("match:") else null
        if (matchId != null && matchId in prepared.previouslyMatched) row.put("previouslyMatchedCandidates", JSONArray().put(matchId))
        choices.put(JSONObject().put("row", row).put("action", if (matchId != null) "match" else decision)
            .put("matchId", matchId ?: JSONObject.NULL))
    }
    return choices
}

internal suspend fun preparePayees(budget: JSONObject): List<JSONObject> {
    val context = currentCoroutineContext()
    context.ensureActive()
    val saved = budget.records("payees").associateBy { it.editorText("name") }.toMutableMap()
    val names = linkedSetOf<String>()
    fun add(value: JSONObject, key: String) { if (!value.isNull(key)) value.optString(key).takeIf { it.isNotBlank() }?.let(names::add) }
    var visited = 0
    fun transaction(record: JSONObject) {
        if (++visited % 128 == 0) context.ensureActive()
        add(record, "payee")
        record.records("splits").forEach { add(it, "payee") }
    }
    val transactions = budget.optJSONArray("transactions")
    for (i in 0 until (transactions?.length() ?: 0)) transactions?.optJSONObject(i)?.let(::transaction)
    budget.records("schedules").forEach { it.optJSONObject("transaction")?.let(::transaction) }
    budget.records("payeeRules").forEach { add(it, "payee") }
    names.forEach { name -> if (name !in saved) saved[name] = JSONObject().put("id", UUID.nameUUIDFromBytes(("payee:" + name).toByteArray(Charsets.UTF_8)).toString()).put("name", name) }
    context.ensureActive()
    return saved.values.sortedBy { it.editorText("name") }
}
