package app.urbudget.nativeapp

import android.content.Context
import org.json.JSONObject

/** Android shares desktop's revision-checked SQLite commits, automatic backups and sync bases. */
class SqliteBudgetStorage(private val context: Context) : BudgetStorage {
    private val legacy = AtomicBudgetStorage(context)
    private var token = ""
    private var isNew = true
    private var cached: String? = null
    private var hasSnapshot = false
    override var identity: String? = null; private set
    override val revision: String? get() = token.takeIf(String::isNotBlank)
    override val managesHistory = true
    override var canUndo = false; private set
    override var canRedo = false; private set

    override fun read(): String? {
        NativeServices.initialize(context)
        if (hasSnapshot && !isNew) {
            val status = NativeServices.call("native_budget_status") as JSONObject
            if (status.getString("token") == token) { update(status); return cached }
        }
        var snapshot = NativeServices.call("load_budget") as JSONObject
        update(snapshot)
        if (isNew) {
            // Keep the original file for recovery. A failed migration never marks it complete.
            legacy.read()?.let { json ->
                // Give the repository the original bytes for a recovery export if validation
                // fails. A valid file still requires a durable SQLite commit before publishing.
                val parsed = runCatching { JSONObject(json) }.getOrNull() ?: return json
                val validation = JSONObject(NativeBridge.invoke(JSONObject().put("version", 1).put("method", "validate").put("budget", parsed).toString()))
                if (!validation.optBoolean("ok")) return json
                snapshot = NativeServices.call("save_budget", JSONObject().put("budget", parsed).put("expectedToken", token)) as JSONObject
                update(snapshot)
            }
        }
        return if (isNew) null else cached
    }

    override fun write(json: String) {
        val answer = NativeServices.call("save_budget", JSONObject().put("budget", JSONObject(json)).put("expectedToken", token).put("ackOnly", true)) as JSONObject
        update(answer)
        cached = json; hasSnapshot = true
    }

    override fun create(json: String) {
        if (isNew) { write(json); return }
        val id = NativeServices.call("create_budget", JSONObject().put("budget", JSONObject(json))) as String
        update(NativeServices.call("open_budget", JSONObject().put("id", id)) as JSONObject)
    }

    override fun undo() { update(NativeServices.call("undo_budget", JSONObject().put("expectedToken", token)) as JSONObject) }
    override fun redo() { update(NativeServices.call("redo_budget", JSONObject().put("expectedToken", token)) as JSONObject) }
    override fun retainRecovery(json: String) = legacy.retainRecovery(json)
    override fun readRecovery() = legacy.readRecovery()
    override fun hasRecovery() = legacy.hasRecovery()

    private fun update(snapshot: JSONObject) {
        snapshot.optJSONObject("budget")?.let { cached = it.toString(); hasSnapshot = true }
        token = snapshot.getString("token")
        identity = snapshot.optString("databasePath").ifBlank { null }
        isNew = snapshot.optBoolean("isNew")
        canUndo = snapshot.optBoolean("undoAvailable")
        canRedo = snapshot.optBoolean("redoAvailable")
    }
}
