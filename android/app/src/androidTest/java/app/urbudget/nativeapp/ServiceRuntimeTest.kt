package app.urbudget.nativeapp

import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.urbudget.SecretStore
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/** A single isolated process runtime shared by service instrumentation tests. No live accounts. */
object ServiceTestRuntime {
    private var initialized = false
    @Synchronized fun call(method: String, params: JSONObject = JSONObject()): Any? {
        if (!initialized) {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            check(context.packageName.endsWith(".nativeapp")) { "Service tests require the isolated debug app." }
            val directory = File(context.cacheDir, "service-tests-${UUID.randomUUID()}")
            decode(NativeBridge.initialize(context, directory.absolutePath))
            initialized = true
        }
        return decode(NativeBridge.service(JSONObject().put("version", 1).put("method", method).put("params", params).toString()))
    }
    fun fixture(): JSONObject {
        val context = InstrumentationRegistry.getInstrumentation().context
        return JSONObject(context.assets.open("native-roundtrip.json").bufferedReader().use { it.readText() })
    }
    fun openFixture(): JSONObject {
        val id = call("create_budget", JSONObject().put("budget", fixture())) as String
        return call("open_budget", JSONObject().put("id", id)) as JSONObject
    }
    private fun decode(raw: String): Any? {
        val response = JSONObject(raw)
        check(response.optBoolean("ok")) { response.optString("error") }
        return response.opt("value").takeUnless { it == JSONObject.NULL }
    }
}

@RunWith(AndroidJUnit4::class)
class ServiceRuntimeTest {
    private fun canonical(value: Any?): String = when (value) {
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(prefix = "{", postfix = "}") { JSONObject.quote(it) + ":" + canonical(value.get(it)) }
        is JSONArray -> (0 until value.length()).joinToString(prefix = "[", postfix = "]") { canonical(value.get(it)) }
        is String -> JSONObject.quote(value)
        else -> value.toString()
    }
    @Test fun sqliteCommitRejectsStaleWritesAndUndoRedoAreRevisionBound() {
        val first = ServiceTestRuntime.openFixture()
        val budget = first.getJSONObject("budget").put("name", "Synthetic Android edit")
        val saved = ServiceTestRuntime.call("save_budget", JSONObject().put("budget", budget).put("expectedToken", first.getString("token"))) as JSONObject
        assertTrue(saved.optBoolean("undoAvailable"))
        assertThrows(IllegalStateException::class.java) {
            ServiceTestRuntime.call("save_budget", JSONObject().put("budget", budget.put("name", "Stale overwrite")).put("expectedToken", first.getString("token")))
        }
        val intact = ServiceTestRuntime.call("load_budget") as JSONObject
        assertEquals("Synthetic Android edit", intact.getJSONObject("budget").getString("name"))
        val undone = ServiceTestRuntime.call("undo_budget", JSONObject().put("expectedToken", intact.getString("token"))) as JSONObject
        assertTrue(undone.optBoolean("redoAvailable"))
        val redone = ServiceTestRuntime.call("redo_budget", JSONObject().put("expectedToken", undone.getString("token"))) as JSONObject
        assertEquals("Synthetic Android edit", redone.getJSONObject("budget").getString("name"))
        assertThrows(IllegalStateException::class.java) {
            ServiceTestRuntime.call("undo_budget", JSONObject().put("expectedToken", intact.getString("token")))
        }
    }

    @Test fun nativeLibraryAndBackupsKeepCompleteDesktopMetadata() {
        val first = ServiceTestRuntime.openFixture()
        val original = first.getJSONObject("budget")
        val export = ServiceTestRuntime.call("export_budget") as String
        assertEquals(canonical(original), canonical(JSONObject(export)))
        val path = ServiceTestRuntime.call("backup_database") as String
        assertTrue(File(path).isFile)
        assertEquals(canonical(original), canonical(JSONObject(File(path).readText())))
        val id = ServiceTestRuntime.call("create_budget", JSONObject().put("budget", ServiceTestRuntime.fixture().put("name", "Separate synthetic budget"))) as String
        val separate = ServiceTestRuntime.call("open_budget", JSONObject().put("id", id)) as JSONObject
        assertEquals("Separate synthetic budget", separate.getJSONObject("budget").getString("name"))
        assertNotEquals(first.getString("databasePath"), separate.getString("databasePath"))
    }

    @Test fun androidKeystoreAuthenticatesSecretsAndSignedOutSyncIsSafe() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "native-test-${UUID.randomUUID()}"
        val secret = "synthetic credential only".toByteArray()
        assertTrue(SecretStore.save(context, name, secret))
        assertArrayEquals(secret, SecretStore.read(context, name))
        val path = File(context.noBackupFilesDir, "secrets/$name")
        val encrypted = path.readBytes()
        assertFalse(encrypted.toString(Charsets.UTF_8).contains("synthetic credential"))
        path.writeBytes(encrypted.clone().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() })
        assertThrows(Exception::class.java) { SecretStore.read(context, name) }
        path.writeBytes(encrypted)
        assertTrue(SecretStore.delete(context, name))
        assertNull(SecretStore.read(context, name))
        val status = ServiceTestRuntime.call("sync_now") as JSONObject
        assertEquals("signed_out", status.getString("state"))
    }
}
