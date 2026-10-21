package app.urbudget.nativeapp

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class NativeEngineTest {
    private fun asset(name: String): String = InstrumentationRegistry.getInstrumentation().context.assets.open(name)
        .bufferedReader().use { it.readText() }

    private fun call(method: String, budget: JSONObject, params: JSONObject = JSONObject()): JSONObject {
        val response = JSONObject(NativeBridge.invoke(JSONObject().put("version", 1).put("method", method)
            .put("budget", budget).put("params", params).toString()))
        assertTrue(response.optString("error"), response.getBoolean("ok"))
        return response.getJSONObject("value")
    }

    @Test fun desktopFixtureHasIdenticalBalancesAndEnvelopeMathThroughJni() {
        val budget = JSONObject(asset("native-roundtrip.json"))
        val expected = JSONObject(asset("native-expected.json"))
        val summary = call("calculate", budget, JSONObject().put("month", expected.getString("month"))
            .put("asOfMonth", expected.getString("asOfMonth")))
        assertEquals(expected.getLong("readyToAssign"), summary.getLong("readyToAssign"))
        summary.records("accounts").forEach { row ->
            assertEquals(expected.getJSONObject("balances").getLong(row.getString("id")), row.getLong("balance"))
        }
        summary.records("categories").forEach { row ->
            assertEquals(expected.getJSONObject("available").getLong(row.getString("id")), row.getLong("available"))
        }
    }

    @Test fun durableRepositoryRoundTripPreservesDesktopExtensions(): Unit = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        // Use an isolated private directory; never overwrite the application's budget in a test.
        val directory = File(context.cacheDir, "jni-repository-test").apply { mkdirs() }
        val storage = AtomicBudgetStorage(context, directory)
        val repository = BudgetRepository(storage, initialMonth = "2026-10")
        repository.importBudget(asset("native-roundtrip.json"))
        repository.edit { it.upsertRecord("accounts", JSONObject().put("id", "checking").put("name", "Renamed")) }
        val loaded = BudgetRepository(storage, initialMonth = "2026-10").load().budget!!
        assertEquals("Renamed", loaded.records("accounts").first().getString("name"))
        assertEquals("preserve", loaded.records("accounts").first().getString("futureAccountField"))
        assertEquals("preserve", loaded.records("assignments").first().getString("futureAssignmentField"))
        assertTrue(loaded.getJSONObject("futureClientMetadata").getJSONArray("keep").getJSONObject(2).getBoolean("three"))
        directory.deleteRecursively()
    }

    @Test fun invalidProtocolIsReportedWithoutCrossingJniWithAnException() {
        val result = JSONObject(NativeBridge.invoke("""{"version":999,"method":"validate","params":{}}"""))
        assertFalse(result.getBoolean("ok"))
        assertTrue(result.getString("error").contains("version"))
    }
}
