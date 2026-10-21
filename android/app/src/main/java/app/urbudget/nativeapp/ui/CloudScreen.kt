package app.urbudget.nativeapp.ui

import android.app.Activity
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.ui.Alignment
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.urbudget.nativeapp.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle

@Composable
internal fun CloudScreen(vm: BudgetViewModel) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val preferences = remember { NativePreferences(context) }
    val billing = remember { BillingGateway(context as Activity) }
    DisposableEffect(billing) { onDispose { billing.close() } }
    var status by remember { mutableStateOf<JSONObject?>(null) }
    var overview by remember { mutableStateOf<JSONObject?>(null) }
    var catalog by remember { mutableStateOf<JSONObject?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var email by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var sent by remember { mutableStateOf(false) }
    var dialog by remember { mutableStateOf("") }
    var phrase by remember { mutableStateOf("") }
    var repeated by remember { mutableStateOf("") }
    var confirmation by remember { mutableStateOf("") }
    var pendingBudget by remember { mutableStateOf<JSONObject?>(null) }
    var automatic by remember { mutableStateOf(preferences.automaticSync) }
    var overviewRevision by remember { mutableIntStateOf(0) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    suspend fun reloadStatus() {
        val previous = status
        val next = NativeServices.read("cloud_status") as JSONObject
        val changed = withContext(Dispatchers.Default) { !sameJson(previous, next) }
        if (changed) status = next
    }
    fun work(operation: suspend () -> Unit) {
        if (busy) return
        busy = true; error = null; notice = null
        scope.launch {
            try { operation(); reloadStatus(); overviewRevision++ }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { error = failure.message ?: "Try again." }
            finally { busy = false }
        }
    }
    fun call(method: String, params: JSONObject = JSONObject(), done: (Any?) -> Unit = {}) = work {
        var invoked = false
        try {
            val result = withContext(Dispatchers.IO) {
                invoked = true
                NativeServices.call(method, params)
            }
            done(result)
        } finally {
            // JNI can complete a sync commit after this screen is disposed. Queue the
            // revision probe even when cancellation prevents delivering the result.
            if (invoked && NativeServicePolicy.budgetResult(method)) vm.refresh()
        }
    }
    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                try { reloadStatus() }
                catch (cancel: CancellationException) { throw cancel }
                catch (failure: Exception) { error = failure.message }
                delay(5_000)
            }
        }
    }
    val signedIn = status?.text("email").orEmpty()
    LaunchedEffect(signedIn, overviewRevision, lifecycle) {
        if (signedIn.isBlank()) { overview = null; catalog = null }
        else lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            // Fetch optional subscription details independently: a slow /me request must not
            // disable local sync controls or delay status polling after every successful action.
            try { overview = NativeServices.read("account_overview") as JSONObject }
            catch (cancel: CancellationException) { throw cancel }
            catch (_: Exception) { /* Existing status remains usable when offline. */ }
        }
    }
    val sync = status?.optJSONObject("sync")
    val report = sync?.optJSONObject("last")
    val reportedBudgets = remember(report) { report?.rows("budgets").orEmpty() }
    fun purchaseMessage(result: JSONObject) {
        notice = when {
            result.optBoolean("cancelled") -> "Purchase cancelled."
            result.optBoolean("pending") -> "Payment is pending. Google Play will finish it; restore purchases when it completes."
            result.optInt("restored") > 0 -> "Purchase verified and restored to your account."
            else -> "No purchases were found for this UrBudget account."
        }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = Gutter, end = Gutter, top = 4.dp, bottom = DockRoom), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Text("Your budgets stay on this device. Sync is optional.", Modifier.padding(horizontal = 4.dp), color = ur.muted, style = MaterialTheme.typography.bodyMedium) }
        if (busy) item { LinearProgressIndicator(Modifier.fillMaxWidth(), color = ur.accent) }
        error?.let { item { FormError(it) } }
        notice?.let { item { Notice(it, tone = "info") } }
        item { SectionTitle("Account") }
        item {
            if (signedIn.isBlank()) CloudCard {
                Text("Sign in with your email to use sync. No password needed.", color = ur.text2, style = MaterialTheme.typography.bodyMedium)
                Field(email, { email = it; sent = false; code = "" }, "Email address")
                if (sent) Field(code, { code = it }, "Code from the email")
                val sendCode = { call("account_start", JSONObject().put("email", email.trim())) { sent = true; notice = "Check your email for a sign-in code." } }
                if (sent) Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    PrimaryButton("Sign in", { call("account_verify", JSONObject().put("email", email.trim()).put("code", code.trim())) { code = "" } }, Modifier.weight(1f), enabled = !busy && code.isNotBlank())
                    SecondaryButton("New code", sendCode, Modifier.weight(1f), enabled = !busy && email.contains('@'))
                } else PrimaryButton("Send sign-in code", sendCode, Modifier.fillMaxWidth(), enabled = !busy && email.contains('@'))
            } else ListCard {
                ListRow(signedIn, subtitle = status?.text("credentialStore").orEmpty().ifBlank { "Session stored securely on this device" }, icon = Icons.Outlined.Person, chevron = false, divider = true)
                ListRow("Sign out on this device", titleColor = ur.negative, onClick = { if (!busy) call("account_sign_out") }, chevron = false)
            }
        }
        item { SectionTitle("Sync subscription") }
        item {
            CloudCard {
                Text("UrBudget is free. Sync is an optional monthly subscription. Google Play shows its price and handles payment.", color = ur.text2, style = MaterialTheme.typography.bodyMedium)
                if (signedIn.isBlank()) Text("Sign in above to subscribe or restore purchases.", color = ur.muted, style = MaterialTheme.typography.bodySmall) else {
                    val product = catalog?.optJSONObject("sync")
                    if (catalog == null) PrimaryButton("Show price", { work { catalog = billing.products() } }, Modifier.fillMaxWidth(), enabled = !busy)
                    if (product != null) PrimaryButton("Subscribe to sync · ${product.text("price")} a month", { work { purchaseMessage(billing.subscribe()) } }, Modifier.fillMaxWidth(), enabled = !busy)
                    catalog?.optJSONObject("errors")?.text("sync")?.takeIf(String::isNotBlank)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = ur.negative) }
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        TextButton({ work { purchaseMessage(billing.restore()) } }, enabled = !busy) { Text("Restore purchases") }
                        TextButton({ work { billing.manage() } }, enabled = !busy) { Text("Manage subscription") }
                    }
                }
            }
        }
        item { SectionTitle("Encrypted sync", "Budgets are encrypted before uploading. Only your sync passphrase opens them.") }
        if (signedIn.isNotBlank()) {
            item {
                ListCard {
                    overview?.optJSONObject("sync")?.let { ListRow(if (it.optBoolean("active")) "Sync subscription active" else "Sync needs an active subscription",
                        icon = Icons.Outlined.CloudSync, iconTint = if (it.optBoolean("active")) ur.positive else ur.warning, iconFill = if (it.optBoolean("active")) ur.positiveSoft else ur.warningSoft, chevron = false, divider = true) }
                    SwitchRow("Sync automatically", automatic, { automatic = it; preferences.automaticSync = it }, subtitle = "While the app is open", divider = true)
                    if (sync?.optBoolean("unlocked") == true) {
                        ListRow("Sync now", icon = Icons.Outlined.Sync, onClick = { if (!busy) call("sync_now") }, chevron = false, divider = true)
                        ListRow("Lock sync on this device", icon = Icons.Outlined.Lock, iconTint = ur.text2, iconFill = ur.zeroSoft, onClick = { if (!busy) call("sync_lock") }, chevron = false)
                    } else ListRow("Set up or unlock sync", icon = Icons.Outlined.Key, onClick = { if (!busy) call("sync_has_key") { exists -> phrase = ""; repeated = ""; dialog = if (exists == true) "unlock" else "setup" } })
                }
            }
            if (report != null && (report.text("message").isNotBlank() || report.text("at").isNotBlank())) item {
                Text(listOfNotNull(report.text("message").ifBlank { null }, report.text("at").ifBlank { null }?.let { "Last attempt: $it" }).joinToString(" · "),
                    Modifier.padding(horizontal = 4.dp), color = ur.muted, style = MaterialTheme.typography.bodySmall)
            }
            if (reportedBudgets.isNotEmpty()) item {
                ListCard {
                    reportedBudgets.forEachIndexed { index, entry ->
                        val state = entry.text("state")
                        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(entry.text("name"), Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = ur.text)
                                TagChip(syncStateLabel(state), fill = if (state == "conflict") ur.warningSoft else ur.zeroSoft, color = if (state == "conflict") ur.warning else ur.text2)
                            }
                            entry.text("message").takeIf(String::isNotBlank)?.let { Text(it, color = ur.text2, style = MaterialTheme.typography.bodyMedium) }
                            entry.optJSONArray("notes")?.let { notes -> for (i in 0 until notes.length()) Text(notes.optString(i), style = MaterialTheme.typography.bodySmall, color = ur.muted) }
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                when (state) {
                                    "cloud_only" -> SecondaryButton("Download and open", { call("sync_download", JSONObject().put("id", entry.text("id"))) { id -> vm.service("open_budget", JSONObject().put("id", id)) } }, enabled = !busy)
                                    "local_only" -> SecondaryButton("Start syncing", { call("sync_track", JSONObject().put("ids", JSONArray().put(entry.text("id")))) { vm.service("sync_now") } }, enabled = !busy)
                                    "conflict" -> PrimaryButton("Review differences", { pendingBudget = entry; dialog = "conflict" }, enabled = !busy, color = ur.warning)
                                }
                                if (state != "local_only") TextButton({ pendingBudget = entry; dialog = "removeCloud" }, enabled = !busy) { Text("Remove cloud copy", color = ur.negative) }
                            }
                        }
                        if (index < reportedBudgets.lastIndex) Hairline(start = 16.dp)
                    }
                }
            }
            item {
                ListCard {
                    ListRow("Reset forgotten sync passphrase", onClick = { if (!busy) { phrase = ""; repeated = ""; dialog = "reset" } }, divider = true)
                    ListRow("Delete account and cloud data", titleColor = ur.negative, onClick = { if (!busy) { confirmation = ""; dialog = "deleteAccount" } })
                }
            }
        } else item { Text("Sign in above to use sync.", Modifier.padding(horizontal = 4.dp), color = ur.muted, style = MaterialTheme.typography.bodyMedium) }
        item { TextButton({ call("account_open", JSONObject().put("next", "/privacy/app/")) }, enabled = !busy) { Text("Privacy & your choices") } }
    }
    if (dialog in setOf("setup", "unlock", "reset")) FormDialog(if (dialog == "reset") "Reset sync passphrase?" else if (dialog == "setup") "Create sync passphrase" else "Unlock encrypted sync", { dialog = ""; phrase = ""; repeated = "" }, confirm = if (dialog == "reset") "Reset cloud copies" else "Continue", enabled = !busy && phrase.length >= 8 && (dialog == "unlock" || phrase == repeated), onConfirm = {
        val method = if (dialog == "reset") "sync_reset" else "sync_setup"
        call(method, JSONObject().put("passphrase", phrase)) { dialog = ""; phrase = ""; repeated = ""; vm.service("sync_now") }
    }) {
        if (dialog == "reset") Text("This deletes cloud copies encrypted with the old passphrase. Local budgets stay on your devices and this device uploads its copies again.")
        else Text("Keep this passphrase somewhere safe. UrBudget cannot recover it for you.")
        FilledField(phrase, { phrase = it }, label = { Text("Sync passphrase · at least 8 characters") }, visualTransformation = PasswordVisualTransformation(), singleLine = true)
        if (dialog != "unlock") FilledField(repeated, { repeated = it }, label = { Text("Repeat passphrase") }, visualTransformation = PasswordVisualTransformation(), singleLine = true)
    }
    if (dialog == "deleteAccount") FormDialog("Delete your account?", { dialog = "" }, "Delete account", enabled = !busy && confirmation.trim().equals(signedIn, ignoreCase = true), onConfirm = {
        call("account_delete", JSONObject().put("confirm", confirmation)) { dialog = "" }
    }) { Text("This deletes your account and cloud budgets and stops subscription renewals. Budgets on your devices stay. Purchase records may be retained as described in the privacy policy."); Field(confirmation, { confirmation = it }, "Type $signedIn to confirm") }
    if (dialog == "removeCloud") AlertDialog(onDismissRequest = { dialog = "" }, title = { Text("Remove cloud copy?") }, text = { Text("This stops syncing ${pendingBudget?.text("name")} and deletes its cloud copy. Local copies remain on your devices.") }, confirmButton = { TextButton({
        call("sync_remove", JSONObject().put("id", pendingBudget!!.text("id"))) { dialog = ""; vm.service("sync_now") }
    }, enabled = !busy) { Text("Remove") } }, dismissButton = { TextButton({ dialog = "" }) { Text("Cancel") } })
    if (dialog == "conflict" && pendingBudget != null) SyncConflictDialog(pendingBudget!!, busy, { dialog = "" }) { keep, choices ->
        call("sync_resolve", JSONObject().put("id", pendingBudget!!.text("id")).put("keep", keep).put("choices", choices)) { dialog = "" }
    }
}

/** A white card with its contents padded, for a section of controls. */
@Composable
private fun CloudCard(content: @Composable ColumnScope.() -> Unit) {
    ListCard { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp), content = content) }
}

private fun syncStateLabel(state: String) = when (state) {
    "cloud_only" -> "In the cloud"; "local_only" -> "This device only"; "conflict" -> "Needs review"; "synced" -> "Synced"; "" -> "Unknown"
    else -> state.replace('_', ' ').replaceFirstChar(Char::uppercase)
}

@Composable
private fun SyncConflictDialog(entry: JSONObject, busy: Boolean, close: () -> Unit, resolve: (String, JSONObject) -> Unit) {
    val conflicts = remember(entry) { entry.rows("conflicts") }
    var choices by remember(entry) { mutableStateOf(mapOf<String, String>()) }
    var whole by remember { mutableStateOf("") }
    FormDialog("Resolve ${entry.text("name")}", close, "Apply choices", enabled = !busy && (if (conflicts.isEmpty()) whole.isNotBlank() else conflicts.all { choices.containsKey(it.text("key")) }), onConfirm = {
        resolve(if (conflicts.isEmpty()) whole else "merge", JSONObject(choices))
    }) {
        Text("Review both versions. Nothing changes until you apply your choices.")
        if (conflicts.isEmpty()) Choice("Keep this complete budget", whole, listOf("local" to "This device replaces the cloud copy", "cloud" to "Cloud copy replaces this device"), { whole = it })
        if (conflicts.isNotEmpty()) LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            items(conflicts, key = { it.text("key") }) { difference ->
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("${difference.text("label")} · ${difference.text("field")}", fontWeight = FontWeight.Bold)
            Text("This device: ${difference.opt("local") ?: "Deleted"}")
            Text("Cloud: ${difference.opt("remote") ?: "Deleted"}")
            Choice("Keep", choices[difference.text("key")].orEmpty(), listOf("local" to "This device", "cloud" to "Cloud"), { choices = choices + (difference.text("key") to it) })
            }
            }
        }
    }
}
