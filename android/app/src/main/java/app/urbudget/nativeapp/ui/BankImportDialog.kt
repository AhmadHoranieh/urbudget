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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.urbudget.nativeapp.BankReviewRow
import app.urbudget.nativeapp.BankReviewSummary
import android.net.Uri
import app.urbudget.nativeapp.BudgetViewModel
import app.urbudget.nativeapp.bankReviewChoices
import app.urbudget.nativeapp.bankReviewCounts
import app.urbudget.nativeapp.decodeStatement
import app.urbudget.nativeapp.prepareBankReview
import app.urbudget.nativeapp.statementFormat
import app.urbudget.nativeapp.summarizeBankReview
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream

private val bankFormats = listOf("csv" to "CSV or Excel", "ofx" to "OFX", "qfx" to "QFX", "qif" to "QIF", "camt053" to "CAMT.053", "mt940" to "MT940")
private val dateOrders = listOf("ymd" to "Year-month-day (2026-10-31)", "dmy" to "Day/month/year (31/10/2026)", "mdy" to "Month/day/year (10/31/2026)")

/**
 * Imports a file a bank exported (BankImport.tsx): choose the file, preview it, decide what each
 * row does (add it, match an existing transaction, or skip it), then one atomic budget change.
 */
@Composable
internal fun BankImportDialog(budget: JSONObject, vm: BudgetViewModel, initialImport: JSONObject? = null, onImported: () -> Unit = {},
                               askAssistant: ((Uri) -> Unit)? = null, close: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val budgetState by vm.state.collectAsStateWithLifecycle()
    var account by remember { mutableStateOf(initialImport?.text("account") ?: budget.rows("accounts").firstOrNull { !it.optBoolean("archived") }?.text("id").orEmpty()) }
    var format by remember { mutableStateOf("csv") }
    var dateOrder by remember { mutableStateOf("ymd") }
    var flipSigns by remember { mutableStateOf(false) }
    var fileName by remember { mutableStateOf(initialImport?.text("name").orEmpty()) }
    var content by remember { mutableStateOf<String?>(initialImport?.text("csv")) }
    // A PDF chosen, which the assistant reads.
    var pdf by remember { mutableStateOf<Uri?>(null) }
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

    // How the account's last bank file read: its date order and signs, kept by the import. A file
    // the assistant prepared is written the standard way.
    LaunchedEffect(account) {
        val kept = budget.rows("accounts").firstOrNull { it.text("id") == account }?.optJSONObject("fileImport")
        if (initialImport == null && kept != null) {
            if (kept.has("dateFormat")) dateOrder = kept.text("dateFormat")
            if (kept.has("flipSigns")) flipSigns = kept.optBoolean("flipSigns")
        }
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
                        if (it.moveToFirst()) it.getString(0) else "Bank statement"
                    } ?: "Bank statement"
                    val read = context.contentResolver.openInputStream(uri)?.use { input ->
                        val output = ByteArrayOutputStream()
                        val buffer = ByteArray(8192)
                        while (true) {
                            val size = input.read(buffer)
                            if (size < 0) break
                            require(output.size() + size <= 8 * 1024 * 1024) { "Choose a statement smaller than 8 MiB." }
                            output.write(buffer, 0, size)
                        }
                        val bytes = output.toByteArray()
                        // A PDF is the assistant's to read: no text.
                        val isPdf = name.endsWith(".pdf", ignoreCase = true) || bytes.take(4) == "%PDF".toByteArray().toList()
                        isPdf to (if (isPdf) "" else decodeStatement(bytes))
                    } ?: error("The selected statement could not be opened.")
                    Triple(name, read.second, read.first)
                }
            }.onSuccess { (name, text, isPdf) ->
                fileName = name
                pdf = if (isPdf) uri else null
                content = if (isPdf) null else text
                if (!isPdf) statementFormat(name, text)?.let { format = it }
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
                    error = "Your budget changed. Preview this statement again."
                } else {
                    previews.track(scope.launch {
                        try {
                            val imported = withContext(Dispatchers.Default) {
                                prepareBankReview(result.rows("items"), source, true, result.optJSONArray("candidateSets")).let { it to summarizeBankReview(it) }
                            }
                            if (generation == epoch) {
                                require(vm.state.value.budget === source) { "Your budget changed. Preview this statement again." }
                                rows = imported.first; summary = imported.second; previewBudget = source; decisions.clear(); loading = false
                                if (imported.first.isEmpty()) error = "The file has no transactions to import."
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
            error = "Your budget changed. Preview this statement again."
            rows = null
            return
        }
        loading = true
        saving = true
        val source = previewBudget; val imported = rows.orEmpty(); val selected = decisions.toMap(); val accountId = account
        // The account keeps how this file read for its next one; a CSV's columns stay as chosen on the desktop.
        val remember = if (datesInFile && initialImport == null) JSONObject().put("dateFormat", dateOrder).apply { if (signs) put("flipSigns", flipSigns) } else null
        scope.launch {
            try {
                val choices = withContext(Dispatchers.Default) { bankReviewChoices(imported, selected, true) }
                require(source === vm.state.value.budget) { "Your budget changed. Preview this statement again." }
                vm.runCommand("bankApply", JSONObject().put("accountId", accountId).put("choices", choices).put("remember", remember ?: JSONObject.NULL)) { onImported(); close() }
            } catch (cancel: CancellationException) { throw cancel } catch (failure: Exception) { error = failure.message; loading = false; saving = false }
        }
    }

    val reviewing = rows
    LazyFormDialog("Import bank file", close,
        confirm = if (reviewing == null) "Preview" else if (saving) "Importing…" else "Import $importing",
        onConfirm = if (reviewing == null) ::preview else ::importRows,
        enabled = !loading && if (reviewing == null) content != null && account.isNotBlank() else undecided == 0 && importing > 0) {
        if (loading) item(key = "import:loading") { LinearProgressIndicator(Modifier.fillMaxWidth(), color = ur.accent) }
        error?.let { item(key = "import:error") { FormError(it) } }
        if (reviewing == null) {
            item(key = "import:lead") {
                Text("Bring in the transactions your bank exported. You check every row, and how it matches what you already entered, before anything is saved.",
                    style = MaterialTheme.typography.bodyMedium, color = ur.text2)
            }
            item(key = "import:account") { Choice("Into account", account, accountChoices) { if (!loading) account = it } }
            item(key = "import:file") {
                ListCard {
                    ListRow(fileName.ifEmpty { "Choose a file" }, subtitle = if (pdf != null) "PDF · tap to choose another" else if (content == null) "CSV, Excel, OFX, QIF, CAMT.053 or MT940; PDF through the assistant" else "${bankFormats.first { it.first == format }.second} · tap to choose another",
                        icon = if (content == null) Icons.Outlined.FileOpen else Icons.Outlined.Description, onClick = { if (!loading) picker.launch(arrayOf("*/*")) })
                }
            }
            pdf?.let { file ->
                item(key = "import:pdf") {
                    if (askAssistant != null) Notice("PDF statements need the assistant. It reads the PDF, finds the transactions, checks them against the statement's totals and brings them to a review like this one, where you decide on each row.", tone = "info",
                        action = "Read it with the assistant", onAction = { askAssistant(file) }, icon = Icons.Outlined.AutoAwesome)
                    else Notice("PDF statements need the assistant. Open the assistant, attach this PDF and ask it to import the statement.", tone = "info")
                }
            }
            if (content != null) {
                item(key = "import:format") { Choice("Read as", format, bankFormats) { if (!loading) format = it } }
                if (datesInFile) item(key = "import:dates") { Choice("Dates in the file", dateOrder, dateOrders) { if (!loading) dateOrder = it } }
                if (signs) item(key = "import:signs") { CheckRow("Purchases are positive (reverse amount signs)", flipSigns, { if (!loading) flipSigns = it }) }
            }
            item(key = "import:help") {
                Text("In a CSV or Excel file, the date, payee and amount (or money out and money in) columns are found by the names banks give them, in most languages, or by what's in them, or by the columns chosen for the account on the desktop.",
                    style = MaterialTheme.typography.bodySmall, color = ur.muted)
            }
        } else {
            item(key = "import:summary") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("${fileName.ifEmpty { "Statement" }} into $accountName", style = MaterialTheme.typography.titleSmall, color = ur.text)
                        summary?.let { Text(reviewCounts(it), style = MaterialTheme.typography.bodySmall, color = ur.muted) }
                    }
                    TextButton({ rows = null; summary = null; decisions.clear(); error = null }, enabled = !loading) { Text("Change file", color = ur.accent, fontWeight = FontWeight.SemiBold) }
                }
            }
            if (summary?.allIn == true && signs && !flipSigns) item(key = "import:all-in") {
                Notice("Every row came out as money in. If these are purchases, the file writes them as positive numbers.", action = "Reverse signs",
                    onAction = { flipSigns = true }, icon = Icons.Outlined.SwapVert)
            }
            summary?.let { bankReviewNotes(it, undecided) }
            suggestedTransfers(reviewing, decisions, !loading)
            bankReviewRows(reviewing, decisions, !loading) { index, value -> decisions[index] = value }
        }
    }
}
