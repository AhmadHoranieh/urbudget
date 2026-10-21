package app.urbudget

import android.app.Activity
import com.android.billingclient.api.*
import org.json.JSONArray
import org.json.JSONObject

interface BillingCall {
    val args: JSONObject
    fun resolve(value: JSONObject = JSONObject())
    fun reject(message: String)
}

internal fun matchesActivePurchase(products: List<String>, accountId: String?, productId: String, expectedAccountId: String) =
    productId in products && accountId == expectedAccountId

/** Play owns payment UI for the sync subscription. Only the server verifies, grants and acknowledges purchases. */
class PlayBillingClient(private val activity: Activity) : AutoCloseable {
    private data class ActivePurchase(val invoke: BillingCall, val productId: String, val accountId: String)
    private var buying: ActivePurchase? = null
    private var connecting = false
    @Volatile private var closed = false
    private val waiting = mutableListOf<Pair<BillingCall, () -> Unit>>()
    private val client = BillingClient.newBuilder(activity)
        .setListener { result, purchases ->
            val active = buying
            if (active != null) {
                val invoke = active.invoke
                when (result.responseCode) {
                    BillingClient.BillingResponseCode.OK -> {
                        val matching = purchases.orEmpty().filter {
                            matchesActivePurchase(it.products, it.accountIdentifiers?.obfuscatedAccountId, active.productId, active.accountId)
                        }
                        // An earlier pending purchase can complete while this checkout is open.
                        // Only this checkout's receipt may finish its invocation.
                        if (matching.isNotEmpty()) {
                            buying = null
                            invoke.resolve(purchaseResult(matching))
                        } else if (purchases.isNullOrEmpty()) {
                            buying = null
                            invoke.reject("Google Play returned no purchase. Try restoring purchases.")
                        }
                    }
                    BillingClient.BillingResponseCode.USER_CANCELED -> {
                        buying = null
                        invoke.resolve(JSONObject().put("cancelled", true).put("purchases", JSONArray()))
                    }
                    BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED -> { buying = null; restore(invoke) }
                    else -> { buying = null; fail(invoke, result) }
                }
            }
            // A completion delivered without an outstanding purchase call is picked up by
            // queryPurchasesAsync when the frontend resumes/restores. Never acknowledge here.
        }
        // Play requires one-time pending purchases to be enabled, though only the subscription is sold.
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .enableAutoServiceReconnection()
        .build()

    private fun fail(invoke: BillingCall, result: BillingResult) =
        invoke.reject("Google Play billing is unavailable (${result.responseCode}). Try again in Google Play, or restore purchases later.")

    private fun connected(invoke: BillingCall, action: () -> Unit) {
        activity.runOnUiThread {
            if (closed) { invoke.reject("The billing screen closed. Reopen Account & sync to continue."); return@runOnUiThread }
            if (client.isReady) { action(); return@runOnUiThread }
            waiting.add(invoke to action)
            if (connecting) return@runOnUiThread
            connecting = true
            client.startConnection(object : BillingClientStateListener {
                override fun onBillingSetupFinished(result: BillingResult) {
                    activity.runOnUiThread {
                        connecting = false
                        val queue = waiting.toList()
                        waiting.clear()
                        queue.forEach { (call, work) ->
                            if (result.responseCode == BillingClient.BillingResponseCode.OK) work() else fail(call, result)
                        }
                    }
                }
                override fun onBillingServiceDisconnected() { /* automatic reconnection */ }
            })
        }
    }

    private fun query(id: String, invoke: BillingCall, unavailable: ((String) -> Unit)? = null, done: (ProductDetails) -> Unit) {
        val params = QueryProductDetailsParams.newBuilder().setProductList(listOf(
            QueryProductDetailsParams.Product.newBuilder().setProductId(id).setProductType(BillingClient.ProductType.SUBS).build()
        )).build()
        client.queryProductDetailsAsync(params) { result, answer ->
            if (closed) { invoke.reject("The billing screen closed. Reopen Account & sync to continue."); return@queryProductDetailsAsync }
            if (result.responseCode != BillingClient.BillingResponseCode.OK) {
                if (unavailable != null) unavailable("Google Play could not load this product (${result.responseCode}). Try again later.")
                else fail(invoke, result)
            }
            else {
                val details = answer.productDetailsList.firstOrNull { it.productId == id }
                if (details == null) {
                    val message = "This product is not available in Google Play yet."
                    if (unavailable != null) unavailable(message) else invoke.reject(message)
                } else done(details)
            }
        }
    }

    // Launch uses only the configured monthly base plan: no implicit introductory or discount offer.
    private fun subscriptionOffer(details: ProductDetails, basePlanId: String) =
        details.subscriptionOfferDetails?.firstOrNull {
            it.basePlanId == basePlanId && it.offerId == null &&
                it.pricingPhases.pricingPhaseList.size == 1 &&
                it.pricingPhases.pricingPhaseList[0].billingPeriod == "P1M" &&
                it.pricingPhases.pricingPhaseList[0].recurrenceMode == ProductDetails.RecurrenceMode.INFINITE_RECURRING
        }

    fun products(invoke: BillingCall) {
        val args = invoke.args
        connected(invoke) {
            fun unavailable(message: String) = invoke.resolve(JSONObject().put("errors", JSONObject().put("sync", message)))
            query(args.getString("syncId"), invoke, { unavailable(it) }) { sync ->
                val monthly = subscriptionOffer(sync, args.getString("basePlanId"))
                if (monthly == null) unavailable("The monthly sync plan is unavailable in Google Play.")
                else invoke.resolve(JSONObject().put("errors", JSONObject())
                    .put("sync", JSONObject().put("id", sync.productId).put("price", monthly.pricingPhases.pricingPhaseList[0].formattedPrice)))
            }
        }
    }

    fun purchase(invoke: BillingCall) {
        val args = invoke.args
        if (!args.getString("accountId").matches(Regex("[a-f0-9]{64}"))) {
            invoke.reject("Sign in to your UrBudget account before subscribing."); return
        }
        connected(invoke) {
            if (buying != null) { invoke.reject("A purchase is already in progress."); return@connected }
            // Fetch again immediately before launch; cached ProductDetails can become stale.
            query(args.getString("productId"), invoke) { details ->
                val product = BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(details)
                val offer = subscriptionOffer(details, args.getString("basePlanId"))
                if (offer == null) { invoke.reject("The monthly sync plan is unavailable."); return@query }
                offer.offerToken?.let { product.setOfferToken(it) }
                activity.runOnUiThread {
                    // The screen may have closed while Google Play was fetching product details.
                    // Its delayed callback must never launch checkout on the disposed Activity.
                    if (closed) { invoke.reject("The billing screen closed. Reopen Account & sync to continue."); return@runOnUiThread }
                    if (buying != null) { invoke.reject("A purchase is already in progress."); return@runOnUiThread }
                    buying = ActivePurchase(invoke, args.getString("productId"), args.getString("accountId"))
                    val result = client.launchBillingFlow(activity, BillingFlowParams.newBuilder()
                        .setObfuscatedAccountId(args.getString("accountId"))
                        .setProductDetailsParamsList(listOf(product.build())).build())
                    if (result.responseCode != BillingClient.BillingResponseCode.OK) {
                        buying = null
                        if (result.responseCode == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) restore(invoke)
                        else fail(invoke, result)
                    }
                }
            }
        }
    }

    private fun purchaseResult(purchases: List<Purchase>): JSONObject {
        val values = JSONArray()
        purchases.forEach { purchase ->
            values.put(JSONObject().put("token", purchase.purchaseToken)
                .put("products", JSONArray(purchase.products))
                .put("state", when (purchase.purchaseState) {
                    Purchase.PurchaseState.PURCHASED -> "purchased"
                    Purchase.PurchaseState.PENDING -> "pending"
                    else -> "unknown"
                }))
        }
        return JSONObject().put("cancelled", false).put("purchases", values)
    }

    fun restore(invoke: BillingCall) {
        val args = invoke.args
        if (!args.getString("accountId").matches(Regex("[a-f0-9]{64}"))) { invoke.reject("Sign in before restoring purchases."); return }
        connected(invoke) {
            client.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build()) { result, subs ->
                if (closed) { invoke.reject("The billing screen closed. Restore purchases after reopening UrBudget."); return@queryPurchasesAsync }
                if (result.responseCode != BillingClient.BillingResponseCode.OK) fail(invoke, result)
                else invoke.resolve(purchaseResult(subs.filter { it.accountIdentifiers?.obfuscatedAccountId == args.getString("accountId") }))
            }
        }
    }

    fun manage(invoke: BillingCall) {
        activity.runOnUiThread {
            if (closed) { invoke.reject("The billing screen closed. Reopen Account & sync to continue."); return@runOnUiThread }
            try {
                activity.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW,
                    android.net.Uri.parse("https://play.google.com/store/account/subscriptions?package=${activity.packageName}")))
                invoke.resolve()
            } catch (_: Exception) { invoke.reject("Open Google Play to manage your subscriptions.") }
        }
    }

    override fun close() {
        if (closed) return
        closed = true
        buying?.invoke?.reject("The purchase screen closed. Restore purchases after reopening UrBudget.")
        buying = null
        waiting.forEach { it.first.reject("The billing connection closed.") }
        waiting.clear()
        client.endConnection()
    }
}
