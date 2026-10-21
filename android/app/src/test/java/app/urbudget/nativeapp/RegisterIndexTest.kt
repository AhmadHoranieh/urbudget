package app.urbudget.nativeapp

import app.urbudget.nativeapp.ui.PreviewJobs
import kotlinx.coroutines.Job
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RegisterIndexTest {
    @Test fun preparedFiltersPreserveTransferSidesSplitCategoriesAndSearch() = runTest {
        val budget = JSONObject("""{"accounts":[{"id":"cash","name":"Checking"},{"id":"savings","name":"Savings"}],
            "categories":[{"id":"food","name":"Groceries"}],"transactions":[
            {"id":"transfer","date":"2026-10-15","accountId":"cash","transferAccountId":"savings","amount":-10000,"payee":"Move","status":"cleared","transferStatus":"uncleared","splits":[]},
            {"id":"split","date":"2026-10-16","accountId":"cash","amount":-5000,"payee":"Market","memo":"Weekend","status":"uncleared","approved":false,"flag":"blue","splits":[
            {"amount":-3000,"categoryId":"food"},{"amount":-2000,"categoryId":null,"transferAccountId":"savings","transferStatus":"reconciled"}]}]}""")
        val before = budget.toString()
        val index = RegisterIndex.build(budget)
        assertEquals(listOf("split", "transfer"), index.matching(RegisterIndex.Filter(account = "savings", minimum = 1000, order = "amount")).map { it.id })
        assertEquals(listOf("transfer"), index.matching(RegisterIndex.Filter(account = "savings", status = "uncleared")).map { it.id })
        assertEquals(listOf("split"), index.matching(RegisterIndex.Filter(category = "food", flag = "blue", search = "groceries", status = "approval")).map { it.id })
        assertEquals(listOf("split"), index.matching(RegisterIndex.Filter(search = "weekend", from = "2026-10-16", through = "2026-10-16")).map { it.id })
        assertTrue(index.matching(RegisterIndex.Filter(invalidAmount = true)).isEmpty())
        assertEquals("Preparing and filtering must not mutate a published snapshot", before, budget.toString())
    }

    @Test fun indexIsRebuiltForNewBudgetWithoutChangingItsPreviousSnapshot() = runTest {
        val source = JSONObject("""{"accounts":[],"categories":[],"transactions":[{"id":"a","date":"2026-10-01","accountId":"cash","amount":10,"payee":"Before"}]}""")
        val first = RegisterIndex.build(source)
        val changed = JSONObject(source.toString()).also { it.getJSONArray("transactions").getJSONObject(0).put("payee", "After") }
        val second = RegisterIndex.build(changed)
        assertEquals(1, first.matching(RegisterIndex.Filter(search = "before")).size)
        assertTrue(second.matching(RegisterIndex.Filter(search = "before")).isEmpty())
        assertEquals(1, second.matching(RegisterIndex.Filter(search = "after")).size)
        val oldScope = Any(); val newScope = Any()
        assertNull(ScopedResult(oldScope, first).forScope(newScope))
    }

    @Test fun obsoletePreviewGroupCancelsAllPendingWorkIncludingLateRegistrations() {
        val previews = PreviewJobs()
        val first = Job(); val second = Job()
        previews.track(first); previews.track(second); previews.cancel()
        assertTrue(first.isCancelled); assertTrue(second.isCancelled)
        val late = Job(); previews.track(late); assertTrue(late.isCancelled)
    }

    @Test fun jsonNullOptionalValuesRemainEmptyForSearchAndSort() = runTest {
        val budget = JSONObject("""{"accounts":[],"categories":[],"transactions":[
            {"id":"empty","accountId":"cash","date":"2026-10-01","amount":1,"payee":null,"memo":null,"createdAt":null},
            {"id":"dated","accountId":"cash","date":"2026-10-01","amount":1,"payee":"Shop","createdAt":"2026-10-01T12:00:00Z"}]}""")
        val index = RegisterIndex.build(budget)
        assertTrue(index.matching(RegisterIndex.Filter(search = "null")).isEmpty())
        assertEquals(listOf("dated", "empty"), index.matching(RegisterIndex.Filter()).map { it.id })
    }
}
