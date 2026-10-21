package app.urbudget.nativeapp

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONObject

internal data class AssignmentDisplayRow(val id: String, val name: String, val amount: Long)
internal data class MoneyMoveDisplayRow(val description: String, val at: String, val amounts: List<Long>)

/** Presentation of the shared engine's assignments; no accounting is recalculated here. */
internal suspend fun assignmentDisplayRows(budget: JSONObject, result: JSONObject, month: String): List<AssignmentDisplayRow> {
    val context = currentCoroutineContext()
    fun assignments(source: JSONObject): Map<String, Long> {
        val rows = source.optJSONArray("assignments") ?: return emptyMap()
        return buildMap {
            for (index in 0 until rows.length()) {
                if (index % 128 == 0) context.ensureActive()
                val row = rows.optJSONObject(index) ?: continue
                if (row.optString("month") == month) put(row.optString("categoryId"), row.optLong("amount"))
            }
        }
    }
    val before = assignments(budget)
    val after = assignments(result.optJSONObject("budget") ?: result)
    val categories = budget.optJSONArray("categories") ?: return emptyList()
    return buildList {
        for (index in 0 until categories.length()) {
            if (index % 128 == 0) context.ensureActive()
            val category = categories.optJSONObject(index) ?: continue
            val id = category.optString("id")
            if ((before[id] ?: 0L) != (after[id] ?: 0L)) add(AssignmentDisplayRow(id, category.optString("name"), after[id] ?: 0L))
        }
    }
}

internal suspend fun moneyMoveDisplayRows(budget: JSONObject, month: String, categoryId: String): List<MoneyMoveDisplayRow> {
    val context = currentCoroutineContext()
    val moves = budget.optJSONArray("moneyMoves") ?: return emptyList()
    return buildList {
        for (index in moves.length() - 1 downTo 0) {
            if (index % 128 == 0) context.ensureActive()
            val move = moves.optJSONObject(index) ?: continue
            if (move.optString("month") != month) continue
            val changes = move.optJSONArray("changes") ?: continue
            val amounts = buildList {
                for (changeIndex in 0 until changes.length()) {
                    if (changeIndex % 128 == 0) context.ensureActive()
                    val change = changes.optJSONObject(changeIndex) ?: continue
                    if (change.optString("categoryId") == categoryId) add(change.optLong("amount"))
                }
            }
            if (amounts.isNotEmpty()) add(MoneyMoveDisplayRow(move.optString("description"), move.optString("at"), amounts))
        }
    }
}
