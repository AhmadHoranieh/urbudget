package app.urbudget.nativeapp.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.urbudget.nativeapp.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.LocalDate

@Composable
internal fun LibraryScreen(budget: JSONObject, vm: BudgetViewModel, importFile: () -> Unit, exportFile: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var entries by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var backups by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var keep by remember { mutableStateOf("0") }
    var token by remember { mutableStateOf("") }
    var restoreToken by remember { mutableStateOf("") }
    var dialog by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf<JSONObject?>(null) }
    var name by remember { mutableStateOf("") }
    var currency by remember { mutableStateOf(budget.text("currency")) }
    val currencies = remember { currencyChoices(budget.text("currency")) }
    var asOf by remember { mutableStateOf(LocalDate.now().toString()) }
    var exportPath by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var revision by remember { mutableIntStateOf(0) }
    val exportBackup = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val path = exportPath
        if (uri != null && path != null) scope.launch {
            runCatching { withContext(Dispatchers.IO) {
                val source = File(path).canonicalFile
                require(source.toPath().startsWith(context.filesDir.canonicalFile.toPath()) && source.isFile)
                context.contentResolver.openOutputStream(uri)?.use { output -> source.inputStream().use { it.copyTo(output) } } ?: error("Could not save the backup.")
            } }.onSuccess { notice = "Portable backup exported." }.onFailure { vm.notifyError(it.message ?: "Could not export the backup.") }
            exportPath = null
        }
    }
    LaunchedEffect(budget, revision) {
        runCatching {
            withContext(Dispatchers.IO) {
                val list = NativeServices.call("list_budgets") as JSONArray
                val backupList = NativeServices.call("list_backups") as JSONArray
                val snapshot = NativeServices.call("load_budget") as JSONObject
                val retention = NativeServices.call("backup_retention")
                listOf(list, backupList, snapshot, retention)
            }
        }.onSuccess { values ->
            entries = (values[0] as JSONArray).objects(); backups = (values[1] as JSONArray).objects()
            token = (values[2] as JSONObject).getString("token"); keep = values[3].toString()
        }.onFailure { vm.notifyError(it.message ?: "Could not load budgets.") }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = Gutter, end = Gutter, top = 4.dp, bottom = DockRoom), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        notice?.let { item { Notice(it, tone = "positive", icon = Icons.Outlined.CheckCircle) } }
        item { SectionTitle("Budgets", "Each has its own history, bank links, assistant chats and backups.") }
        item {
            ListCard {
                entries.forEach { entry -> key(entry.text("id")) {
                    val current = entry.optBoolean("current")
                    val missing = entry.optBoolean("missing")
                    var menu by remember { mutableStateOf(false) }
                    Box {
                        ListRow(entry.text("name"), subtitle = "${entry.text("currency")} · ${if (current) "Open now" else if (missing) "File missing" else "On this device"}",
                            icon = Icons.Outlined.AccountBalanceWallet, iconTint = if (current) ur.accent else ur.text2, iconFill = if (current) ur.accentSoft else ur.zeroSoft,
                            onClick = { if (current) dialog = "settings" else if (!state.busy && !missing) vm.service("open_budget", JSONObject().put("id", entry.text("id"))) },
                            onLongClick = if (current) null else ({ menu = true }), chevron = !current,
                            trailing = if (current) ({ TagChip("Open", fill = ur.accentSoft, color = ur.accent) }) else null, divider = true)
                        DropdownMenu(menu, { menu = false }, shape = RoundedCornerShape(16.dp), containerColor = ur.surface) {
                            DropdownMenuItem(text = { Text("Open") }, leadingIcon = { Icon(Icons.Outlined.FolderOpen, null) }, enabled = !state.busy && !missing,
                                onClick = { menu = false; vm.service("open_budget", JSONObject().put("id", entry.text("id"))) })
                            DropdownMenuItem(text = { Text("Delete local budget", color = ur.negative) }, leadingIcon = { Icon(Icons.Outlined.DeleteOutline, null, tint = ur.negative) },
                                enabled = !state.busy, onClick = { menu = false; selected = entry; dialog = "delete" })
                        }
                    }
                } }
                ListRow("New budget", icon = Icons.Outlined.Add, titleColor = ur.accent, onClick = { if (!state.busy) { name = "My budget"; currency = budget.text("currency"); dialog = "new" } }, chevron = false)
            }
        }
        item { Text("Tap the open budget for its name, currency and formats. Press and hold another to delete it.", Modifier.padding(horizontal = 4.dp), color = ur.muted, style = MaterialTheme.typography.bodySmall) }
        item { SectionTitle("Start a new plan") }
        item {
            ListCard {
                ListRow("Make a fresh start", subtitle = "Carry balances, categories and targets into a new budget; this one stays in the library",
                    icon = Icons.Outlined.AutoAwesome, onClick = { if (!state.busy) { name = "${budget.text("name")} · Fresh start"; asOf = LocalDate.now().toString(); dialog = "fresh" } })
            }
        }
        item { SectionTitle("Backups & recovery", "Automatic backups follow the same retention rules as desktop.") }
        item {
            ListCard {
                ListRow("Create portable backup", subtitle = "A complete copy to save or share", icon = Icons.Outlined.Backup,
                    onClick = { if (!state.busy) vm.service("backup_database") { path -> exportPath = path as? String; revision++; if (exportPath != null) exportBackup.launch("UrBudget-${LocalDate.now()}.json") } }, divider = true)
                ListRow("Export JSON", icon = Icons.Outlined.FileUpload, onClick = exportFile, divider = true)
                ListRow("Import JSON", icon = Icons.Outlined.FileDownload, onClick = importFile)
            }
        }
        item { Choice("Keep automatic backups", keep, listOf("0" to "Keep all", "5" to "Newest 5", "10" to "Newest 10", "30" to "Newest 30"), { value -> keep = value; vm.service("set_backup_retention", JSONObject().put("keep", value.toInt())) }) }
        if (backups.isNotEmpty()) item {
            ListCard {
                backups.forEachIndexed { index, backup ->
                    ListRow(backup.text("name"), subtitle = "${backup.optLong("bytes") / 1024} KiB", icon = Icons.Outlined.History, iconTint = ur.text2, iconFill = ur.zeroSoft, chevron = false,
                        trailing = { TextButton({ selected = backup; restoreToken = token; dialog = "restore" }, enabled = !state.busy && token.isNotBlank()) { Text("Restore", fontWeight = FontWeight.SemiBold) } },
                        divider = index < backups.lastIndex)
                }
            }
        }
        item { Text("Preferences, the theme and flag names are in Settings & data.", Modifier.padding(horizontal = 4.dp), color = ur.muted, style = MaterialTheme.typography.bodySmall) }
    }
    if (dialog == "settings") BudgetSettingsDialog(budget, vm) { dialog = "" }
    if (dialog == "new") FormDialog("Create budget", { dialog = "" }, enabled = !state.busy && name.isNotBlank() && currency.isNotBlank(), onConfirm = {
        vm.createBudget(name, currency); dialog = ""
    }) {
        Field(name, { name = it }, "Budget name")
        Choice("Currency", currency, currencies, { currency = it })
    }
    if (dialog == "fresh") FormDialog("Make a fresh start", { dialog = "" }, "Create fresh budget", enabled = !state.busy && name.isNotBlank(), onConfirm = {
        vm.service("fresh_start", JSONObject().put("name", name).put("asOf", asOf)) { id -> dialog = ""; revision++; vm.service("open_budget", JSONObject().put("id", id)) }
    }) { Field(name, { name = it }, "New budget name"); DateField(asOf, { asOf = it }, "Start date"); Text("The shared engine carries account balances, categories, targets and pending activity into a separate budget. Your original remains in this library.") }
    if (dialog == "delete" || dialog == "restore") AlertDialog(onDismissRequest = { dialog = "" }, title = { Text(if (dialog == "delete") "Delete ${selected?.text("name")}?" else "Restore this backup?") }, text = { Text(if (dialog == "delete") "The local budget and its files will be deleted from this device. Export a backup first if you want to keep them. Cloud copies are managed separately under Account & sync." else "This replaces the open budget with ${selected?.text("name")}. The current budget is backed up before replacement. A newer change will stop this restore for review.") }, confirmButton = { TextButton({
        if (dialog == "delete") vm.service("delete_budget", JSONObject().put("id", selected!!.text("id"))) { dialog = ""; revision++ }
        else vm.service("restore_backup_file", JSONObject().put("path", selected!!.text("path")).put("expectedToken", restoreToken)) { dialog = ""; revision++ }
    }, enabled = !state.busy) { Text(if (dialog == "delete") "Delete local budget" else "Restore") } }, dismissButton = { TextButton({ dialog = "" }) { Text("Cancel") } })
}

private fun JSONArray.objects() = (0 until length()).mapNotNull(::optJSONObject)
