package app.urbudget.nativeapp.ui

import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.urbudget.nativeapp.BankReviewRow
import app.urbudget.nativeapp.BankReviewSummary
import app.urbudget.nativeapp.BudgetViewModel
import app.urbudget.nativeapp.R
import app.urbudget.nativeapp.Words
import app.urbudget.nativeapp.bankReviewChoices
import app.urbudget.nativeapp.bankReviewCounts
import app.urbudget.nativeapp.prepareBankReview
import app.urbudget.nativeapp.summarizeBankReview
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream

private val bankFormats = listOf("csv" to "CSV", "ofx" to "OFX", "qfx" to "QFX", "qif" to "QIF")
@Composable
private fun dateOrders() = listOf("ymd" to stringResource(R.string.bank_dates_ymd), "dmy" to stringResource(R.string.bank_dates_dmy), "mdy" to stringResource(R.string.bank_dates_mdy))

/**
 * Imports a file a bank exported (BankImport.tsx): choose the file, preview it, decide what each
 * row does (add it, match an existing transaction, or skip it), then one atomic budget change.
 */
@Composable
internal fun BankImportDialog(budget: JSONObject, vm: BudgetViewModel, initialImport: JSONObject? = null, onImported: () -> Unit = {}, close: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val budgetState by vm.state.collectAsStateWithLifecycle()
    var account by remember { mutableStateOf(initialImport?.text("account") ?: budget.rows("accounts").firstOrNull { !it.optBoolean("archived") }?.text("id").orEmpty()) }
    var format by remember { mutableStateOf("csv") }
    var dateOrder by remember { mutableStateOf("ymd") }
    var flipSigns by remember { mutableStateOf(false) }
    var fileName by remember { mutableStateOf(initialImport?.text("name").orEmpty()) }
    var content by remember { mutableStateOf<String?>(initialImport?.text("csv")) }
    var rows by remember { mutableStateOf<List<BankReviewRow>?>(null) }
    var summary by remember { mutableStateOf<BankReviewSummary?>(null) }
    val decisions = remember { mutableStateMapOf<Int, String>() }
    var error by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var epoch by remember { mutableIntStateOf(0) }
    var previewBudget by remember { mutableStateOf<JSONObject?>(null) }
    val previews = rememberPreviewJobs(budget, account, format, dateOrder, flipSigns, content)
    val accountChoices = remember(budget) { budget.rows("accounts").filterNot { it.optBoolean("archived") }.map { it.text("id") to it.text("name") } }
    val accountName = accountChoices.firstOrNull { it.first == account }?.second.orEmpty()
    val counts by remember { derivedStateOf { bankReviewCounts(rows.orEmpty(), decisions) } }
    val (importing, undecided) = counts
    // Only a CSV can write purchases as positive numbers; only CSV and QIF write dates in an order of their own.
    val signs = format == "csv"
    val datesInFile = format == "csv" || format == "qif"

    LaunchedEffect(budgetState.error) {
        if (saving && budgetState.error != null) { error = budgetState.error; loading = false; saving = false }
    }

    LaunchedEffect(budget, account, format, dateOrder, flipSigns, content) {
        epoch++
        rows = null
        summary = null
        decisions.clear()
        previewBudget = null
        loading = false
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) scope.launch {
            loading = true
            error = null
            runCatching {
                withContext(Dispatchers.IO) {
                    val name = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                        if (it.moveToFirst()) it.getString(0) else context.getString(R.string.bank_statement_file)
                    } ?: context.getString(R.string.bank_statement_file)
                    val text = context.contentResolver.openInputStream(uri)?.use { input ->
                        val output = ByteArrayOutputStream()
                        val buffer = ByteArray(8192)
                        while (true) {
                            val size = input.read(buffer)
                            if (size < 0) break
                            require(output.size() + size <= 8 * 1024 * 1024) { context.getString(R.string.bank_statement_too_large) }
                            output.write(buffer, 0, size)
                        }
                        output.toString(Charsets.UTF_8.name()).removePrefix(Char(0xFEFF).toString())
                    } ?: error(context.getString(R.string.bank_statement_unopened))
                    name to text
                }
            }.onSuccess { (name, text) ->
                fileName = name
                content = text
                val extension = name.substringAfterLast('.', "").lowercase()
                if (extension in listOf("csv", "ofx", "qfx", "qif")) format = extension
            }.onFailure { error = it.message }
            loading = false
        }
    }

    fun preview() {
        val statement = content ?: return
        loading = true
        error = null
        val generation = ++epoch
        val source = budget
        previews.track(vm.query("bankPreview", JSONObject().put("accountId", account).put("content", statement)
            .put("format", format).put("dateFormat", dateOrder).put("flipSigns", signs && flipSigns),
            onError = { message -> if (generation == epoch) { loading = false; error = message } }) { result ->
            if (generation == epoch) {
                if (vm.state.value.budget !== source) {
                    loading = false
                    error = Words[R.string.bank_budget_changed_preview]
                } else {
                    previews.track(scope.launch {
                        try {
                            val imported = withContext(Dispatchers.Default) {
                                prepareBankReview(result.rows("items"), source, true, result.optJSONArray("candidateSets")).let { it to summarizeBankReview(it) }
                            }
                            if (generation == epoch) {
                                require(vm.state.value.budget === source) { Words[R.string.bank_budget_changed_preview] }
                                rows = imported.first; summary = imported.second; previewBudget = source; decisions.clear(); loading = false
                                if (imported.first.isEmpty()) error = Words[R.string.bank_file_empty]
                            }
                        } catch (cancel: CancellationException) { throw cancel } catch (failure: Exception) {
                            if (generation == epoch) { error = failure.message; loading = false }
                        }
                    })
                }
            }
        })
    }

    fun importRows() {
        if (previewBudget !== vm.state.value.budget) {
            error = Words[R.string.bank_budget_changed_preview]
            rows = null
            return
        }
        loading = true
        saving = true
        val source = previewBudget; val imported = rows.orEmpty(); val selected = decisions.toMap(); val accountId = account
        scope.launch {
            try {
                val choices = withContext(Dispatchers.Default) { bankReviewChoices(imported, selected, true) }
                require(source === vm.state.value.budget) { Words[R.string.bank_budget_changed_preview] }
                vm.runCommand("bankApply", JSONObject().put("accountId", accountId).put("choices", choices)) { onImported(); close() }
            } catch (cancel: CancellationException) { throw cancel } catch (failure: Exception) { error = failure.message; loading = false; saving = false }
        }
    }

    val reviewing = rows
    LazyFormDialog(stringResource(R.string.import_bank_file), close,
        confirm = if (reviewing == null) stringResource(R.string.bank_preview) else if (saving) stringResource(R.string.bank_importing) else stringResource(R.string.bank_import_count, "$importing"),
        onConfirm = if (reviewing == null) ::preview else ::importRows,
        enabled = !loading && if (reviewing == null) content != null && account.isNotBlank() else undecided == 0 && importing > 0) {
        if (loading) item(key = "import:loading") { LinearProgressIndicator(Modifier.fillMaxWidth(), color = ur.accent) }
        error?.let { item(key = "import:error") { FormError(it) } }
        if (reviewing == null) {
            item(key = "import:lead") {
                Text(stringResource(R.string.bank_import_lead),
                    style = MaterialTheme.typography.bodyMedium, color = ur.text2)
            }
            item(key = "import:account") { Choice(stringResource(R.string.bank_into_account), account, accountChoices) { if (!loading) account = it } }
            item(key = "import:file") {
                ListCard {
                    ListRow(fileName.ifEmpty { stringResource(R.string.bank_choose_file) }, subtitle = if (content == null) stringResource(R.string.bank_file_formats) else stringResource(R.string.bank_choose_another, bankFormats.first { it.first == format }.second),
                        icon = if (content == null) Icons.Outlined.FileOpen else Icons.Outlined.Description, onClick = { if (!loading) picker.launch(arrayOf("*/*")) })
                }
            }
            if (content != null) {
                item(key = "import:format") { Choice(stringResource(R.string.bank_read_as), format, bankFormats) { if (!loading) format = it } }
                if (datesInFile) item(key = "import:dates") { Choice(stringResource(R.string.bank_dates_in_file), dateOrder, dateOrders()) { if (!loading) dateOrder = it } }
                if (signs) item(key = "import:signs") { CheckRow(stringResource(R.string.bank_purchases_positive), flipSigns, { if (!loading) flipSigns = it }) }
            }
            item(key = "import:help") {
                Text(stringResource(R.string.bank_csv_help),
                    style = MaterialTheme.typography.bodySmall, color = ur.muted)
            }
        } else {
            item(key = "import:summary") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(stringResource(R.string.bank_source_into, fileName.ifEmpty { stringResource(R.string.bank_statement_label) }, accountName), style = MaterialTheme.typography.titleSmall, color = ur.text)
                        summary?.let { Text(reviewCounts(it), style = MaterialTheme.typography.bodySmall, color = ur.muted) }
                    }
                    TextButton({ rows = null; summary = null; decisions.clear(); error = null }, enabled = !loading) { Text(stringResource(R.string.bank_change_file), color = ur.accent, fontWeight = FontWeight.SemiBold) }
                }
            }
            if (summary?.allIn == true && signs && !flipSigns) item(key = "import:all-in") {
                Notice(stringResource(R.string.bank_all_in_note), action = stringResource(R.string.bank_reverse_signs_action),
                    onAction = { flipSigns = true }, icon = Icons.Outlined.SwapVert)
            }
            summary?.let { bankReviewNotes(it, undecided) }
            bankReviewRows(reviewing, decisions, !loading) { index, value -> decisions[index] = value }
        }
    }
}
