package app.urbudget.nativeapp

import android.app.Activity
import app.urbudget.BillingCall
import app.urbudget.PlayBillingClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Play displays the sync subscription's localized price and checkout; the shared server verifier grants access. */
class BillingGateway(activity: Activity) : AutoCloseable {
    private val client = PlayBillingClient(activity)
    private suspend fun config() = withContext(Dispatchers.IO) { NativeServices.call("billing_context") as JSONObject }
    private suspend fun invoke(args: JSONObject, operation: (BillingCall) -> Unit): JSONObject = withContext(Dispatchers.Main) {
        suspendCancellableCoroutine { continuation ->
            operation(object : BillingCall {
                override val args = args
                override fun resolve(value: JSONObject) { if (continuation.isActive) continuation.resume(value) }
                override fun reject(message: String) { if (continuation.isActive) continuation.resumeWithException(IllegalStateException(message)) }
            })
        }
    }
    suspend fun products(): JSONObject = invoke(config(), client::products)
    suspend fun subscribe(): JSONObject {
        val config = config()
        val result = invoke(JSONObject().put("productId", config.getString("syncId")).put("accountId", config.getString("accountId"))
            .put("basePlanId", config.getString("basePlanId")), client::purchase)
        return withContext(Dispatchers.IO) { NativeServices.call("billing_verify", result) as JSONObject }
    }
    suspend fun restore(): JSONObject {
        val result = invoke(config(), client::restore)
        return withContext(Dispatchers.IO) { NativeServices.call("billing_verify", result) as JSONObject }
    }
    suspend fun manage() { invoke(JSONObject(), client::manage) }
    override fun close() { client.close() }
}
