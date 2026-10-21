package app.urbudget.nativeapp

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UncategorizedTest {
    private val budget = JSONObject()
        .put("accounts", JSONArray()
            .put(JSONObject().put("id", "checking").put("kind", "cash"))
            .put(JSONObject().put("id", "card").put("kind", "credit"))
            .put(JSONObject().put("id", "loan").put("kind", "tracking")))
        .put("categories", JSONArray()
            .put(JSONObject().put("id", "food").put("name", "Groceries"))
            .put(JSONObject().put("id", "ynab-uncat").put("name", "Uncategorized")))
    private fun tx(account: String, amount: Long, category: String?, date: String = "2026-10-10", transfer: String? = null, unassigned: Boolean? = null) =
        JSONObject().put("id", "t").put("date", date).put("accountId", account).put("amount", amount).put("payee", "Shop")
            .put("transferAccountId", transfer ?: JSONObject.NULL)
            .put("splits", JSONArray().put(JSONObject().put("amount", amount).put("categoryId", category ?: JSONObject.NULL).apply { if (unassigned != null) put("unassigned", unassigned) }))
    private val test = Uncategorized(budget, "2026-10-21")

    @Test fun spendingWithNoCategoryNeedsOne() {
        assertTrue(test.needs(tx("checking", -500, null)))
        assertTrue(test.needs(tx("card", -500, "ynab-uncat")))
        assertFalse(test.needs(tx("checking", -500, "food")))
    }

    @Test fun incomeTransfersTrackingAndFutureDoNot() {
        assertFalse(test.needs(tx("checking", 500, null)))
        assertFalse(test.needs(tx("checking", -500, null, unassigned = true)))
        assertFalse(test.needs(tx("checking", -500, null, transfer = "card")))
        assertFalse(test.needs(tx("loan", -500, null)))
        assertFalse(test.needs(tx("checking", -500, null, date = "2026-11-01")))
    }

    @Test fun transfersToTrackingNeedACategoryOnTheBudgetSide() {
        assertTrue(test.needs(tx("checking", -500, null, transfer = "loan")))
        // Seen from the tracking side, money arriving there left the budget.
        assertTrue(test.needs(tx("loan", 500, null, transfer = "checking")))
    }

    @Test fun countsByBudgetAccount() {
        val b = JSONObject(budget.toString()).put("transactions", JSONArray().put(tx("checking", -500, null)).put(tx("loan", 300, null, transfer = "card")).put(tx("checking", -100, "food")))
        val counts = test.counts(b)
        assertEquals(2, counts.total)
        assertEquals(800L, counts.amount)
        assertEquals(mapOf("checking" to 1, "card" to 1), counts.byAccount)
    }
}
