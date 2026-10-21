package app.urbudget.nativeapp.ui

import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.urbudget.nativeapp.BudgetViewModel
import app.urbudget.nativeapp.ScopedResult
import app.urbudget.nativeapp.encodeFileBytes
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

@Composable
internal fun YnabImportDialog(budget: JSONObject, vm: BudgetViewModel, close: () -> Unit) {
    var token by remember { mutableStateOf("") }
    var saved by remember { mutableStateOf("") }
    var tokens by remember { mutableStateOf(emptyList<JSONObject>()) }
    var plans by remember { mutableStateOf(emptyList<JSONObject>()) }
    var plan by remember { mutableStateOf("") }
    var rememberToken by remember { mutableStateOf(false) }
    var replace by remember { mutableStateOf(false) }
    var mode by remember { mutableStateOf("api") }
    var result by remember { mutableStateOf<JSONObject?>(null) }
    val choices = remember { mutableStateMapOf<String, String>() }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    var filePreview by remember { mutableStateOf<ScopedResult<JSONObject>?>(null) }
    var dateOrder by remember { mutableStateOf("") }
    var selectedFiles by remember { mutableStateOf<JSONArray?>(null) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val requests = rememberPreviewJobs()
    val apiContext = remember(mode, token, saved) { Any() }
    val currentApiContext by rememberUpdatedState(apiContext)
    val apiRequests = rememberPreviewJobs(apiContext)
    val fileContext = remember(budget, selectedFiles, dateOrder, mode) { Any() }
    val currentFileContext by rememberUpdatedState(fileContext)
    val fileRequests = rememberPreviewJobs(fileContext)
    LaunchedEffect(apiContext, fileContext) { loading = false }
    fun loadTokens() { requests.track(vm.service("ynab_tokens") { value -> val rows = value as? JSONArray; tokens = if (rows == null) emptyList() else (0 until rows.length()).mapNotNull(rows::optJSONObject) }) }
    fun authentication() = JSONObject().put("token", token).also { if (saved.isNotBlank()) it.put("savedToken", saved) }
    fun call(method: String, params: JSONObject) {
        loading = true; error = null
        apiRequests.track(vm.service(method, params, onError = { if (currentApiContext === apiContext) { error = it; loading = false } }) { value ->
            if (currentApiContext !== apiContext) return@service
            loading = false; result = value as? JSONObject; choices.clear()
            if (result?.text("reviewId").isNullOrBlank()) { token = ""; loadTokens() }
        })
    }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) scope.launch {
            loading = true; error = null
            runCatching {
                withContext(Dispatchers.IO) {
                    require(uris.size <= 8) { "Select at most eight YNAB export files." }
                    var total = 0
                    JSONArray(uris.map { uri ->
                        val name = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else "export.zip" } ?: "export.zip"
                        val bytes = context.contentResolver.openInputStream(uri)?.use { stream -> val out = java.io.ByteArrayOutputStream(); val block = ByteArray(8192); while (out.size() <= 8 * 1024 * 1024) { val count = stream.read(block); if (count < 0) break; out.write(block, 0, count) }; out.toByteArray() } ?: error("Could not read the selected file.")
                        require(bytes.size <= 8 * 1024 * 1024) { "Each YNAB file must be smaller than 8 MiB." }; total += bytes.size; require(total <= 16 * 1024 * 1024) { "Select at most 16 MiB of exports." }
                        JSONObject().put("name", name).put("bytes", encodeFileBytes(bytes))
                    })
                }
            }.onSuccess { selectedFiles = it; filePreview = null }.onFailure { if (it is CancellationException) throw it; error = it.message }
            loading = false
        }
    }
    LaunchedEffect(Unit) { loadTokens() }
    val conflicts = remember(result) { result?.rows("conflicts").orEmpty() }
    val differences = remember(result) { result?.rows("differences").orEmpty() }
    val tokenChoices = remember(tokens) { listOf("" to "Paste one-time token") + tokens.map { it.text("id") to "${it.text("label")} · ${it.text("hint")}" } }
    val planChoices = remember(plans) { plans.map { it.text("id") to it.text("name") } }
    val fileNames = remember(selectedFiles) { selectedFiles?.let { files -> (0 until files.length()).joinToString("\n") { files.getJSONObject(it).text("name") } } }
    val candidate = filePreview?.forScope(fileContext)
    val fileDifferences = remember(candidate) { candidate?.optJSONObject("importAudit")?.rows("categoryDifferences").orEmpty() }
    val allConflictsChosen by remember(conflicts) { derivedStateOf { conflicts.all { choices[it.text("path")] in listOf("local", "remote") } } }
    val reviewId = result?.text("reviewId").orEmpty()
    LazyFormDialog("Import from YNAB", close, onConfirm = null) {
        item { Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Choice("Import method", mode, listOf("api" to "YNAB account", "files" to "YNAB export files"), { mode = it; error = null })
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        FormError(error)
        } }
        if (mode == "api") {
            item { Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Choice("Credential", saved, tokenChoices, { saved = it; plans = emptyList(); plan = "" })
            if (saved.isBlank()) {
                FilledField(token, { token = it }, Modifier.fillMaxWidth(), label = { Text("Personal access token") }, visualTransformation = PasswordVisualTransformation(), singleLine = true)
                Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(rememberToken, { rememberToken = it }); Text("Remember in device credential store") }
            } else TextButton({ requests.track(vm.service("forget_ynab_token", JSONObject().put("id", saved)) { saved = ""; loadTokens() }) }) { Text("Forget saved token") }
            OutlinedButton({ loading = true; error = null; apiRequests.track(vm.service("ynab_plans", authentication(), onError = { if (currentApiContext === apiContext) { loading = false; error = it } }) { value -> if (currentApiContext === apiContext) { val list = value as? JSONArray; plans = if (list == null) emptyList() else (0 until list.length()).mapNotNull(list::optJSONObject); plan = plans.firstOrNull()?.text("id").orEmpty(); loading = false } }) }, enabled = !loading && (token.isNotBlank() || saved.isNotBlank())) { Text("Load YNAB plans") }
            if (plans.isNotEmpty()) {
                Choice("Plan", plan, planChoices, { plan = it })
                Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(replace, { replace = it }); Text("Replace budget instead of merging changes") }
                Text("Imports keep a local backup. Repeated imports request only changes; competing edits wait for your choice.", style = MaterialTheme.typography.bodySmall)
                Button({ call("sync_ynab", authentication().put("planId", plan).put("replace", replace).put("rememberToken", rememberToken).put("tokenLabel", plans.firstOrNull { it.text("id") == plan }?.text("name"))) }, enabled = !loading && plan.isNotBlank()) { Text(if (replace) "Import and replace" else "Import changes") }
            }
            } }
            if (reviewId.isNotBlank() && differences.isNotEmpty()) {
                item { Text("Review differences from YNAB", style = MaterialTheme.typography.titleMedium) }
                items(differences) { DifferenceRow(it, budget.text("currency")) }
                item { Column(verticalArrangement = Arrangement.spacedBy(14.dp)) { Text("These source totals differ from the shared engine's calculation. Accept only after reviewing them.")
                Button({ call("accept_ynab_import", JSONObject().put("reviewId", reviewId)) }, enabled = !loading) { Text("Accept differences and continue") }
                } }
            }
            if (reviewId.isNotBlank() && conflicts.isNotEmpty()) {
                item { Text("Choose each competing change", style = MaterialTheme.typography.titleMedium) }
                items(conflicts) { conflict ->
                    OutlinedCard { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(conflict.text("about").ifBlank { conflict.text("path") }); Text(conflict.text("field"), style = MaterialTheme.typography.labelMedium)
                        Text("Local: ${conflict.text("localText").ifBlank { conflict.opt("local")?.toString() ?: "Deleted" }}")
                        Text("YNAB: ${conflict.text("remoteText").ifBlank { conflict.opt("remote")?.toString() ?: "Deleted" }}")
                        Choice("Keep", choices[conflict.text("path")] ?: "", listOf("" to "Choose a version", "local" to "Local", "remote" to "YNAB"), { choices[conflict.text("path")] = it })
                    } }
                }
                item { Button({ call("resolve_ynab", JSONObject().put("reviewId", reviewId).put("choices", JSONObject(choices.toMap()))) }, enabled = !loading && allConflictsChosen) { Text("Apply chosen versions") } }
            }
            if (result != null && reviewId.isBlank()) item { Text(if (result?.optBoolean("unchanged") == true) "Your budget is already up to date." else "YNAB import saved. A backup is available in your budget's history.", color = MaterialTheme.colorScheme.primary) }
        } else {
            item { Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("Choose YNAB's ZIP export, or its Register and Plan CSV files together. Source IDs, targets and notes are absent from these exports; use account import when available.")
            OutlinedButton({ picker.launch(arrayOf("*/*")) }, enabled = !loading) { Text("Choose YNAB export files") }
            fileNames?.let { Text(it) }
            Choice("Date order", dateOrder, listOf("" to "Detect automatically", "mdy" to "Month / day / year", "dmy" to "Day / month / year", "ymd" to "Year / month / day"), { dateOrder = it; filePreview = null })
            Button({ loading = true; error = null; fileRequests.track(vm.query("importYnabFiles", JSONObject().put("files", selectedFiles).put("dateOrder", dateOrder.ifBlank { null } ?: JSONObject.NULL).put("currency", budget.text("currency")), onError = { if (currentFileContext === fileContext) { loading = false; error = it } }) { if (currentFileContext === fileContext) { filePreview = ScopedResult(fileContext, it); loading = false } }) }, enabled = !loading && selectedFiles != null) { Text("Preview file import") }
            } }
            candidate?.let { candidate ->
                item { Text("${candidate.text("name")} · ${candidate.text("currency")}\n${candidate.optJSONArray("accounts")?.length() ?: 0} accounts · ${candidate.optJSONArray("transactions")?.length() ?: 0} transactions", style = MaterialTheme.typography.titleMedium) }
                items(fileDifferences) { DifferenceRow(it, candidate.text("currency")) }
                item { Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Text("Replacing this budget keeps the previous budget for recovery.")
                    Button({
                        loading = true; error = null
                        fileRequests.track(scope.launch {
                            try {
                                val encoded = withContext(Dispatchers.Default) { candidate.toString() }
                                require(currentFileContext === fileContext && vm.state.value.budget === budget) { "Your budget changed. Preview these files again." }
                                vm.importBudget(encoded); close()
                            } catch (cancel: CancellationException) { throw cancel } catch (failure: Exception) { error = failure.message; loading = false }
                        })
                    }, enabled = !loading) { Text("Accept preview and replace") }
                } }
            }
        }
    }
}

@Composable
private fun DifferenceRow(difference: JSONObject, currency: String) {
    OutlinedCard { Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(listOf(difference.text("month"), difference.text("category"), difference.text("account"), difference.text("field")).filter { it.isNotBlank() }.joinToString(" · "))
        if (difference.has("expected") && difference.has("actual")) Text("YNAB ${money(difference.optLong("expected"), currency)} · Calculated ${money(difference.optLong("actual"), currency)}")
        else Text(remember(difference) { difference.toString(2) })
    } }
}
