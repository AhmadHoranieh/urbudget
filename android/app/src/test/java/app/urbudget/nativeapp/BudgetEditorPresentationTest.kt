package app.urbudget.nativeapp

import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class BudgetEditorPresentationTest {
    @Test fun assignmentReviewShowsExactEngineValuesIncludingResetsAndKeepsCategoryOrder() = runTest {
        val budget = JSONObject("""{"categories":[{"id":"b","name":"Second"},{"id":"a","name":"First"},{"id":"c","name":"Unchanged"}],"assignments":[{"month":"2026-10","categoryId":"b","amount":123},{"month":"2026-10","categoryId":"a","amount":25}]}""")
        val result = JSONObject("""{"budget":{"assignments":[{"month":"2026-10","categoryId":"a","amount":999999999999},{"month":"2026-09","categoryId":"b","amount":500}]}}""")
        assertEquals(listOf(AssignmentDisplayRow("b", "Second", 0), AssignmentDisplayRow("a", "First", 999999999999L)), assignmentDisplayRows(budget, result, "2026-10"))
        assertEquals(123L, budget.getJSONArray("assignments").getJSONObject(0).getLong("amount"))
    }

    @Test fun historyFiltersCategoryAndMonthAndRetainsAllMatchingChangesNewestFirst() = runTest {
        val budget = JSONObject("""{"moneyMoves":[
          {"month":"2026-10","description":"older","at":"one","changes":[{"categoryId":"food","amount":-123},{"categoryId":"rent","amount":123}]},
          {"month":"2026-09","description":"different month","changes":[{"categoryId":"food","amount":42}]},
          {"month":"2026-10","description":"newer","at":"two","changes":[{"categoryId":"food","amount":10},{"categoryId":"food","amount":20}]}
        ]}""")
        assertEquals(listOf(MoneyMoveDisplayRow("newer", "two", listOf(10L, 20L)), MoneyMoveDisplayRow("older", "one", listOf(-123L))), moneyMoveDisplayRows(budget, "2026-10", "food"))
    }
}
