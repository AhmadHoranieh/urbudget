package app.urbudget.nativeapp.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardReturn
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.urbudget.nativeapp.AccountTypes
import app.urbudget.nativeapp.BudgetViewModel
import app.urbudget.nativeapp.Money
import app.urbudget.nativeapp.NativePreferences
import app.urbudget.nativeapp.ScheduleSummary
import app.urbudget.nativeapp.rateIn
import app.urbudget.nativeapp.rateText
import app.urbudget.nativeapp.scheduleSummary
import app.urbudget.nativeapp.upcomingSchedules
import org.json.JSONObject
import java.time.LocalDate
import java.util.UUID

/** The pages More leads to: cards of rows, as Settings and Payees are on the desktop's phone layout. */
@Composable
internal fun MoreScreen(page: String, navigate: (String) -> Unit, budget: JSONObject, vm: BudgetViewModel,
                        importFile: () -> Unit, exportFile: () -> Unit, restore: (() -> Unit)?, edit: (String, JSONObject?) -> Unit) {
    when (page) {
        "Scheduled" -> SchedulesPage(budget, vm, edit)
        "Loan planner" -> LoanPlannerPage(budget, vm, edit)
        "Payees & rules" -> PayeesPage(budget, vm, edit)
        "Settings & data" -> SettingsPage(navigate, budget, vm, exportFile, importFile, restore, edit)
        else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = Gutter, end = Gutter, top = 4.dp, bottom = DockRoom)) {
            item {
                ListCard {
                    morePages.forEachIndexed { index, item -> ListRow(item.title, subtitle = item.detail, icon = item.icon, onClick = { navigate(item.title) }, divider = index < morePages.lastIndex) }
                }
            }
        }
    }
}

internal val frequencies = listOf("never" to "Once", "daily" to "Daily", "weekly" to "Weekly", "everyOtherWeek" to "Every other week", "every4Weeks" to "Every 4 weeks", "twiceAMonth" to "Twice a month", "monthly" to "Monthly", "everyOtherMonth" to "Every other month", "every3Months" to "Every 3 months", "every4Months" to "Every 4 months", "twiceAYear" to "Twice a year", "yearly" to "Yearly", "everyOtherYear" to "Every other year")

/** A schedule row, prepared away from composition. */
private data class ScheduleItem(val id: String, val schedule: JSONObject, val title: String, val subtitle: String, val amount: String, val positive: Boolean,
                                val due: Boolean, val paused: Boolean, val once: Boolean, val date: String)

private data class SchedulesModel(val lines: List<ScheduleItem>, val summary: ScheduleSummary, val goingOut: String, val comingIn: String)

private fun schedulesModel(budget: JSONObject, today: LocalDate): SchedulesModel {
    val currency = budget.text("currency")
    val accounts = budget.rows("accounts").associate { it.text("id") to it.text("name") }
    val categories = budget.rows("categories").associate { it.text("id") to it.text("name") }
    val upcoming = upcomingSchedules(budget.rows("schedules"))
    val summary = scheduleSummary(upcoming, today)
    val now = today.toString()
    val lines = upcoming.map { schedule ->
        val t = schedule.optJSONObject("transaction") ?: JSONObject()
        val next = schedule.text("nextDate")
        val paused = schedule.optBoolean("paused")
        val due = !paused && next <= now
        val splits = t.rows("splits")
        val category = when {
            t.text("transferAccountId").isNotBlank() -> null
            splits.size > 1 -> "Split"
            splits.firstOrNull()?.optBoolean("unassigned") == true -> "Unassigned"
            else -> splits.firstOrNull()?.text("categoryId")?.let { categories[it] }
        }
        val frequency = schedule.text("frequency")
        ScheduleItem(schedule.text("id"), schedule,
            t.text("payee").ifBlank { accounts[t.text("transferAccountId")]?.let { "Transfer: $it" } ?: "Scheduled transaction" },
            listOfNotNull((if (due) "Due " else "") + Money.date(next), frequencies.firstOrNull { it.first == frequency }?.second ?: frequency,
                accounts[t.text("accountId")], category, if (paused) "Paused" else null).joinToString(" · "),
            money(t.optLong("amount"), currency), t.optLong("amount") > 0, due, paused, frequency == "never" || frequency.isBlank(), Money.date(next))
    }
    return SchedulesModel(lines, summary, money(summary.goingOut, currency), money(summary.comingIn, currency))
}

/**
 * Scheduled: what's due in the next 30 days, then every schedule soonest first with paused ones
 * after (SchedulesModal.tsx). Each opens in the editor; its menu enters, skips, pauses or deletes it.
 */
@Composable
private fun SchedulesPage(budget: JSONObject, vm: BudgetViewModel, edit: (String, JSONObject?) -> Unit) {
    val model = rememberPrepared(budget) { schedulesModel(budget, LocalDate.now()) }
    var deleting by remember { mutableStateOf<ScheduleItem?>(null) }
    fun apply(line: ScheduleItem, skip: Boolean) = withCurrentBudget(budget, vm) {
        vm.runCommand("applySchedules", JSONObject().put("through", LocalDate.now().toString()).put("selected", line.id).put("skip", skip))
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = Gutter, end = Gutter, top = 4.dp, bottom = DockRoom)) {
        item(key = "schedules:actions") {
            Row(Modifier.padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PrimaryButton("Add schedule", { edit("schedule", null) }, Modifier.weight(1f), icon = Icons.Outlined.Add)
                SecondaryButton("Enter all due", { withCurrentBudget(budget, vm) { vm.runCommand("applySchedules", JSONObject().put("through", LocalDate.now().toString())) } },
                    Modifier.weight(1f), enabled = model?.lines?.any { it.due } == true)
            }
        }
        when {
            model == null -> item(key = "schedules:loading") { LinearProgressIndicator(Modifier.fillMaxWidth(), color = ur.accent) }
            model.lines.isEmpty() -> item(key = "schedules:empty") {
                EmptyState("Nothing scheduled", "Add a transaction with a later date, or choose how often it repeats, and it waits here.", "Add schedule") { edit("schedule", null) }
            }
            else -> {
                item(key = "schedules:summary") {
                    ListCard(Modifier.padding(bottom = 8.dp)) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            Row {
                                Figure("Scheduled", "${model.summary.active}${if (model.summary.paused > 0) " · ${model.summary.paused} paused" else ""}", Modifier.weight(1f))
                                Figure("Due in 30 days", "${model.summary.dueSoon}", Modifier.weight(1f))
                            }
                            Row {
                                Figure("Going out", model.goingOut, Modifier.weight(1f))
                                Figure("Coming in", model.comingIn, Modifier.weight(1f), color = if (model.summary.comingIn > 0) ur.positive else ur.text)
                            }
                        }
                    }
                }
                item(key = "schedules:help") {
                    Text("A transaction dated ahead waits here and is entered on its date, uncleared and waiting for approval; a repeating one carries on from there.",
                        Modifier.padding(start = 4.dp, end = 4.dp, bottom = 12.dp), style = MaterialTheme.typography.bodySmall, color = ur.muted)
                }
                itemsIndexed(model.lines, key = { _, line -> "schedule:${line.id}" }, contentType = { _, _ -> "schedule" }) { index, line ->
                    ScheduleRow(line, Modifier.cardSegment(index, model.lines.size, cardFill()), index < model.lines.lastIndex,
                        edit = { edit("schedule", line.schedule) }, enter = { apply(line, false) }, skip = { apply(line, true) },
                        pause = { withCurrentBudget(budget, vm) { vm.upsert("schedules", JSONObject().put("id", line.id).put("paused", !line.paused)) } },
                        delete = { deleting = line })
                }
            }
        }
    }
    deleting?.let { line ->
        AlertDialog(onDismissRequest = { deleting = null }, containerColor = ur.surface, title = { Text("Delete this schedule?") },
            text = { Text("${line.title} won't be entered again. Transactions it already entered stay. You can undo this.") },
            confirmButton = { TextButton({ deleting = null; withCurrentBudget(budget, vm) { vm.remove("schedules", line.id) } }) { Text("Delete", color = ur.negative) } },
            dismissButton = { TextButton({ deleting = null }) { Text("Cancel") } })
    }
}

@Composable
private fun ScheduleRow(line: ScheduleItem, modifier: Modifier, divider: Boolean, edit: () -> Unit, enter: () -> Unit, skip: () -> Unit, pause: () -> Unit, delete: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Box(modifier) {
        ListRow(line.title, Modifier.alpha(if (line.paused) .6f else 1f), subtitle = line.subtitle, value = line.amount, valueColor = if (line.positive) ur.positive else ur.text,
            icon = if (line.paused) Icons.Outlined.Pause else Icons.Outlined.Repeat, iconTint = if (line.due) ur.warning else if (line.paused) ur.muted else ur.accent,
            iconFill = if (line.due) ur.warningSoft else if (line.paused) ur.zeroSoft else ur.accentSoft,
            onClick = edit, onLongClick = { menu = true }, chevron = false, divider = divider, trailing = {
                Box {
                    IconButton({ menu = true }, Modifier.size(36.dp)) { Icon(Icons.Outlined.MoreHoriz, "Actions for ${line.title}", Modifier.size(20.dp), tint = ur.muted) }
                    DropdownMenu(menu, { menu = false }, shape = RoundedCornerShape(16.dp), containerColor = ur.surface) {
                        DropdownMenuItem(text = { Text("Enter now") }, leadingIcon = { Icon(Icons.AutoMirrored.Outlined.KeyboardReturn, null) }, onClick = { menu = false; enter() })
                        DropdownMenuItem(text = { Text(if (line.once) "Skip it" else "Skip ${line.date}") }, leadingIcon = { Icon(Icons.Outlined.SkipNext, null) }, onClick = { menu = false; skip() })
                        DropdownMenuItem(text = { Text(if (line.paused) "Resume" else "Pause") }, leadingIcon = { Icon(if (line.paused) Icons.Outlined.PlayArrow else Icons.Outlined.Pause, null) },
                            onClick = { menu = false; pause() })
                        DropdownMenuItem(text = { Text("Edit") }, leadingIcon = { Icon(Icons.Outlined.Edit, null) }, onClick = { menu = false; edit() })
                        HorizontalDivider(color = ur.border)
                        DropdownMenuItem(text = { Text("Delete", color = ur.negative) }, leadingIcon = { Icon(Icons.Outlined.DeleteOutline, null, tint = ur.negative) },
                            onClick = { menu = false; delete() })
                    }
                }
            })
    }
}

/** A loan row: a debt with its details, or one still waiting for them. */
private data class LoanLine(val accountId: String, val record: JSONObject, val name: String, val subtitle: String, val owed: String, val type: String)

private fun loanLines(budget: JSONObject, summary: JSONObject?): List<LoanLine> {
    val currency = budget.text("currency")
    val balances = summary?.rows("accounts")?.associate { it.text("id") to it.optLong("balance") }.orEmpty()
    val loans = budget.rows("loans").associateBy { it.text("accountId") }
    val month = LocalDate.now().toString().take(7)
    return budget.rows("accounts").mapNotNull { account ->
        val id = account.text("id")
        val balance = balances[id] ?: account.optLong("openingBalance")
        val saved = loans[id]
        if (account.optBoolean("archived") && saved == null || !AccountTypes.hasLoan(account, balance, loans.keys)) return@mapNotNull null
        LoanLine(id, saved ?: JSONObject().put("accountId", id), account.text("name"),
            saved?.let { "Payment ${money(it.optLong("monthlyPayment"), currency)} · ${rateText(rateIn(it, month))}%" } ?: "Add loan details to see the payoff date",
            money(maxOf(0L, -balance), currency), AccountTypes.infer(account, balance))
    }
}

/** Loan planner: each debt with its payment and what's owed; a tap opens its details and planner. */
@Composable
private fun LoanPlannerPage(budget: JSONObject, vm: BudgetViewModel, edit: (String, JSONObject?) -> Unit) {
    val summary = vm.state.collectAsStateWithLifecycle().value.summary
    val lines = rememberPrepared(budget, summary) { loanLines(budget, summary) }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = Gutter, end = Gutter, top = 4.dp, bottom = DockRoom)) {
        item(key = "loans:new") { PrimaryButton("New payoff plan", { edit("loan", null) }, Modifier.fillMaxWidth().padding(bottom = 12.dp), icon = Icons.Outlined.Add) }
        when {
            lines == null -> item(key = "loans:loading") { LinearProgressIndicator(Modifier.fillMaxWidth(), color = ur.accent) }
            lines.isEmpty() -> item(key = "loans:empty") {
                EmptyState("Make a payoff plan", "Add a tracking account of a loan type, such as Mortgage or Auto loan, with what you owe as a negative balance. Then add its rate and payment here.",
                    "Create plan") { edit("loan", null) }
            }
            else -> itemsIndexed(lines, key = { _, line -> "loan:${line.accountId}" }, contentType = { _, _ -> "loan" }) { index, line ->
                ListRow(line.name, Modifier.cardSegment(index, lines.size, cardFill()), subtitle = line.subtitle, value = line.owed, icon = iconForType(line.type, "tracking"),
                    iconTint = ur.text2, iconFill = ur.zeroSoft, onClick = { edit("loan", line.record) }, divider = index < lines.lastIndex)
            }
        }
        item(key = "loans:help") {
            Text("Owed is what's left on each loan. The planner tries extra payments without changing anything; Record payment adds the transfer and the month's interest.",
                Modifier.padding(start = 4.dp, end = 4.dp, top = 12.dp), style = MaterialTheme.typography.bodySmall, color = ur.muted)
        }
    }
}

/**
 * Settings as the desktop arranges them for a phone: the budget's name and formats, appearance and
 * the preferences that mean something here, then backups, imports and the rest.
 */
@Composable
private fun SettingsPage(navigate: (String) -> Unit, budget: JSONObject, vm: BudgetViewModel, exportFile: () -> Unit, importFile: () -> Unit, restore: (() -> Unit)?,
                         edit: (String, JSONObject?) -> Unit) {
    val context = LocalContext.current
    val preferences = remember { NativePreferences(context) }
    val prefs = LocalPreferences.current
    var theme by remember { mutableStateOf(preferences.theme) }
    var dialog by remember { mutableStateOf("") }
    val flagNames = remember(budget) { budget.optJSONObject("flagNames")?.let { names -> flagColors.mapNotNull { names.text(it).ifBlank { null } } }.orEmpty() }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = Gutter, end = Gutter, top = 4.dp, bottom = DockRoom), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { SectionTitle("Budget") }
        item {
            ListCard {
                ListRow("Name, currency & formats", subtitle = "${budget.text("name")} · ${formatSummary(budget)}", icon = Icons.Outlined.Tune, onClick = { dialog = "budget" }, divider = true)
                ListRow("Flag names", subtitle = flagNames.joinToString(" · ").ifBlank { "Name colours such as Reimburse or Tax" }, icon = Icons.Outlined.Flag, onClick = { dialog = "flags" })
            }
        }
        item { SectionTitle("Appearance") }
        item { Segmented(listOf("system" to "Device", "light" to "Light", "dark" to "Dark"), theme, { theme = it; preferences.theme = it }) }
        item { SectionTitle("Preferences", "These apply on this phone, to every budget.") }
        item {
            ListCard {
                SwitchRow("Show what targets still need", prefs.showNeeded, prefs::setShowNeeded, subtitle = "The amount under each category's name, such as “120.00 needed”", divider = true)
                SwitchRow("New transactions start cleared", prefs.newCleared, prefs::setNewCleared, subtitle = "Useful if you enter transactions once they've reached your bank", divider = true)
                SwitchRow("Open scheduled transactions", prefs.showUpcoming, prefs::setShowUpcoming, subtitle = "Whether the schedules atop each register start unfolded", divider = true)
                SwitchRow("Enter due schedules on opening", prefs.automaticSchedules, prefs::setAutomaticSchedules, subtitle = "Scheduled transactions that are due are added when the app opens")
            }
        }
        item {
            Choice("Open on", prefs.startPage, listOf("budget" to "Budget", "transactions" to "All transactions"), prefs::setStartPage)
            Text("The page you see when the app starts or you switch budgets.", Modifier.padding(top = 6.dp, start = 4.dp), style = MaterialTheme.typography.bodySmall, color = ur.muted)
        }
        item { SectionTitle("Backups") }
        item {
            ListCard {
                ListRow("Export full backup", subtitle = "A portable JSON file with every desktop field", icon = Icons.Outlined.FileUpload, onClick = exportFile, divider = true)
                ListRow("Import full backup", subtitle = "A UrBudget JSON budget from desktop or Android", icon = Icons.Outlined.FileDownload, onClick = importFile, divider = restore != null)
                if (restore != null) ListRow("Restore previous budget", subtitle = "The budget saved before your last import", icon = Icons.Outlined.Restore, onClick = restore)
            }
        }
        item { SectionTitle("Imports") }
        item {
            ListCard {
                ListRow("Import bank file", subtitle = "CSV, OFX, QFX or QIF, reviewed first", icon = Icons.Outlined.FileOpen, onClick = { edit("bankImport", null) }, divider = true)
                ListRow("Import from YNAB", subtitle = "From YNAB's API or its export files", icon = Icons.Outlined.FileDownload, onClick = { edit("ynabImport", null) })
            }
        }
        item { SectionTitle("More") }
        item {
            ListCard {
                ListRow("Budget library", subtitle = "Budgets, backups and fresh starts", icon = Icons.Outlined.FolderOpen, onClick = { navigate("Budget library") }, divider = true)
                ListRow("Account & sync", subtitle = "Encrypted sync and your account", icon = Icons.Outlined.CloudSync, onClick = { navigate("Account & sync") }, divider = true)
                ListRow("Privacy & your data", subtitle = "What stays on this phone and what sync, bank links and the assistant share", icon = Icons.Outlined.Shield,
                    onClick = { vm.service("account_open", JSONObject().put("next", "/privacy/app/")) })
            }
        }
        item {
            Text("${budget.text("name")} · Stored on this device. Envelope math, targets, reports and imports use the same engine as the desktop app.",
                Modifier.padding(top = 8.dp, start = 4.dp, end = 4.dp), style = MaterialTheme.typography.bodySmall, color = ur.muted)
        }
    }
    if (dialog == "budget") BudgetSettingsDialog(budget, vm) { dialog = "" }
    if (dialog == "flags") FlagNamesDialog(budget, vm) { dialog = "" }
}

/**
 * A schedule in the transaction editor, with how often it repeats. One that's due (dated today or
 * earlier) is entered as soon as it's saved, as the desktop does (Register.tsx's saveSchedule).
 */
@Composable
internal fun ScheduleDialog(original: JSONObject?, budget: JSONObject, vm: BudgetViewModel, close: () -> Unit) {
    val openedBudget = remember { budget }
    val id = remember { original?.text("id") ?: UUID.randomUUID().toString() }
    var frequency by remember { mutableStateOf(original?.text("frequency") ?: "monthly") }
    var paused by remember { mutableStateOf(original?.optBoolean("paused") ?: false) }
    val transaction = remember { (original?.optJSONObject("transaction")?.copyJson() ?: JSONObject().put("id", "schedule:$id").put("status", "uncleared").put("amount", 0)).put("date", original?.text("nextDate") ?: LocalDate.now().plusDays(1).toString()) }
    // The saved schedule's next date, while waiting to enter it once the save is published.
    var entering by remember { mutableStateOf<String?>(null) }
    val state by vm.state.collectAsStateWithLifecycle()
    LaunchedEffect(entering, state.budget, state.error) {
        val due = entering ?: return@LaunchedEffect
        if (state.error != null) { close(); return@LaunchedEffect }
        val current = state.budget ?: return@LaunchedEffect
        if (current === openedBudget) return@LaunchedEffect
        val saved = current.rows("schedules").firstOrNull { it.text("id") == id }
        // Enter only the schedule as it was just saved, never one changed meanwhile.
        if (saved != null && !saved.optBoolean("paused") && saved.text("nextDate") == due)
            vm.runCommand("applySchedules", JSONObject().put("through", LocalDate.now().toString()).put("selected", id))
        close()
    }
    TransactionDialog(transaction, budget, "", vm, close = { if (entering == null) close() }, saveOverride = { record ->
        val date = record.text("date")
        vm.upsert("schedules", (original?.copyJson() ?: JSONObject()).put("id", id).put("transaction", record).put("nextDate", date)
            .put("anchorDate", if (date == original?.text("nextDate")) original.text("anchorDate") else date).put("frequency", frequency).put("paused", paused))
        if (!paused && date <= LocalDate.now().toString()) entering = date
    }, dialogTitle = if (original == null) "New schedule" else "Edit schedule", extraFields = {
        Choice("Repeat", frequency, frequencies, { frequency = it })
        ListCard { SwitchRow("Paused", paused, { paused = it }) }
        if (!paused) Text("If it's dated today or earlier, it's entered as soon as you save it.", style = MaterialTheme.typography.bodySmall, color = ur.muted)
        if (original != null) TextButton({ withCurrentBudget(openedBudget, vm) { vm.remove("schedules", id); close() } }) { Text("Delete schedule", color = ur.negative) }
    })
}
