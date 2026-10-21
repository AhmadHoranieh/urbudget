package app.urbudget.nativeapp.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.*
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.urbudget.nativeapp.BudgetViewModel
import app.urbudget.nativeapp.Money
import app.urbudget.nativeapp.PayeeInfo
import app.urbudget.nativeapp.payeeIndex
import app.urbudget.nativeapp.RegisterIndex
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.UUID
import kotlin.math.abs

/** A day's band, or a transaction under it, ready to draw. */
private sealed interface RegisterLine
@Immutable private data class DayLine(val date: String, val label: String) : RegisterLine
@Immutable private data class TxChip(val text: String, val kind: Int)
/** One transaction as the register draws it: everything formatted once, off the main thread. */
@Immutable private data class TxLine(
    val id: String, val date: String, val payee: String, val transfer: Boolean, val card: Boolean, val otherAccount: String,
    val amount: Long, val amountText: String, val chips: List<TxChip>, val accountName: String, val memo: String,
    val cleared: String, val future: Boolean, val flag: String, val approved: Boolean,
) : RegisterLine

private const val ChipNormal = 0
private const val ChipNeeds = 1
private const val ChipMore = 2

private val DayMonthFirst = DateTimeFormatter.ofPattern("EEEE, MMMM d, yyyy", Locale.ENGLISH)
private val DayFirst = DateTimeFormatter.ofPattern("EEEE, d MMMM yyyy", Locale.ENGLISH)
private fun dayLabel(iso: String, monthFirst: Boolean) = runCatching {
    LocalDate.parse(iso).format(if (monthFirst) DayMonthFirst else DayFirst)
}.getOrDefault(iso)

/** Turns the matching entries into lines: day bands when sorted by date, and each transaction formatted. */
private fun registerLines(entries: List<RegisterIndex.Entry>, order: String, accountFilter: String, budget: JSONObject, today: String): List<RegisterLine> {
    val currency = budget.text("currency")
    val monthFirst = budget.text("dateFormat") == "mdy"
    val accounts = budget.rows("accounts").associateBy { it.text("id") }
    val categories = budget.rows("categories").associate { it.text("id") to it.text("name") }
    val lines = ArrayList<RegisterLine>(entries.size + 64)
    val byDay = order == "newest" || order == "oldest"
    var day = ""
    entries.forEach { entry ->
        if (byDay && entry.date != day) { day = entry.date; lines.add(DayLine(day, dayLabel(day, monthFirst))) }
        val t = entry.transaction
        val amount = entry.amountFor(accountFilter)
        val transferId = t.text("transferAccountId")
        // Seen from the receiving account, a transfer shows its own side's memo and flag.
        val reverse = accountFilter.isNotBlank() && transferId == accountFilter
        val source = if (reverse) t.optJSONObject("transferSource") else null
        val other = if (reverse) t.text("accountId") else transferId
        val otherAccount = accounts[other]
        val splits = t.rows("splits")
        val chips = when {
            splits.size > 1 -> splits.take(2).mapIndexed { i, part ->
                TxChip("${if (i in entry.needsCategory) "Needs a category" else splitName(part, categories)} ${money(part.optLong("amount"), currency)}", if (i in entry.needsCategory) ChipNeeds else ChipNormal)
            } + if (splits.size > 2) listOf(TxChip("+${splits.size - 2}", ChipMore)) else emptyList()
            0 in entry.needsCategory -> listOf(TxChip("Needs a category", ChipNeeds))
            splits.isEmpty() -> emptyList()
            splits.first().optBoolean("unassigned") -> listOf(TxChip("Unassigned", ChipNormal))
            splits.first().text("categoryId").isBlank() -> emptyList()
            else -> listOf(TxChip(categories[splits.first().text("categoryId")] ?: "Category", ChipNormal))
        }
        lines.add(TxLine(
            id = entry.id, date = entry.date,
            payee = if (transferId.isNotBlank()) "${if (amount < 0) "To" else "From"}: ${otherAccount?.text("name") ?: "Account"}" else t.text("payee").ifBlank { "No payee" },
            transfer = transferId.isNotBlank(), card = transferId.isNotBlank() && otherAccount?.text("kind") == "credit", otherAccount = other,
            amount = amount, amountText = (if (amount > 0) "+" else "") + money(amount, currency), chips = chips,
            accountName = if (accountFilter.isBlank()) accounts[t.text("accountId")]?.text("name").orEmpty() else "",
            memo = source?.text("memo")?.ifBlank { null } ?: t.text("memo"),
            cleared = if (accountFilter.isBlank()) entry.status else entry.accountStatuses[accountFilter]?.firstOrNull() ?: entry.status,
            future = entry.date > today,
            flag = if (reverse) source?.text("flag_color").orEmpty() else entry.flag,
            approved = entry.approved,
        ))
    }
    return lines
}

/** Date range presets, as the desktop's register offers them. */
private fun datePreset(id: String, earliest: String?): Pair<String, String> {
    val now = YearMonth.now()
    fun months(back: Long) = now.minusMonths(back).atDay(1).toString() to now.atEndOfMonth().toString()
    return when (id) {
        "thisMonth" -> months(0)
        "lastMonth" -> now.minusMonths(1).let { it.atDay(1).toString() to it.atEndOfMonth().toString() }
        "last3" -> months(2)
        "last6" -> months(5)
        "last12" -> months(11)
        "ytd" -> now.withMonth(1).atDay(1).toString() to now.atEndOfMonth().toString()
        "lastYear" -> YearMonth.of(now.year - 1, 1).atDay(1).toString() to YearMonth.of(now.year - 1, 12).atEndOfMonth().toString()
        else -> (earliest ?: "") to ""
    }
}
private val datePresets = listOf("thisMonth" to "This month", "lastMonth" to "Last month", "last3" to "Last 3 months", "last6" to "Last 6 months",
    "last12" to "Last 12 months", "ytd" to "Year to date", "lastYear" to "Last year")

/**
 * Transactions on a phone: the days as bands with the date written out, each transaction its payee
 * and amount over its categories as chips, the account and the memo. Search and filters fold away
 * behind the search button. An account's transactions lead with its balances. A long press selects;
 * the selection's actions take the tab bar's place. The list keeps showing while a change or a
 * search recomputes it, and every line is formatted on a worker.
 */
@Composable
internal fun TransactionsScreen(budget: JSONObject, summary: JSONObject?, accountFilter: String, categoryFilter: String, onBack: (() -> Unit)?,
                                setCategory: (String) -> Unit, edit: (JSONObject) -> Unit, add: () -> Unit, editAccount: (JSONObject) -> Unit,
                                reconcile: (JSONObject) -> Unit, editSchedule: (JSONObject?) -> Unit, vm: BudgetViewModel,
                                bar: @Composable RowScope.() -> Unit, setDockHidden: (Boolean) -> Unit,
                                initialFrom: String = "", initialThrough: String = "", initialSearch: String = "", payCard: (String) -> Unit = {}, openAccount: (String) -> Unit = {}) {
    val currency = budget.text("currency")
    val monthFirst = budget.text("dateFormat") == "mdy"
    var searching by rememberSaveable { mutableStateOf(initialSearch.isNotEmpty()) }
    var search by rememberSaveable { mutableStateOf(initialSearch) }
    var status by rememberSaveable { mutableStateOf("") }
    var flagFilter by rememberSaveable { mutableStateOf("") }
    var from by rememberSaveable { mutableStateOf(initialFrom) }
    var through by rememberSaveable { mutableStateOf(initialThrough) }
    var minimum by rememberSaveable { mutableStateOf("") }
    var maximum by rememberSaveable { mutableStateOf("") }
    var order by rememberSaveable { mutableStateOf("newest") }
    var filtersOpen by remember { mutableStateOf(false) }
    var datesOpen by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf(setOf<String>()) }
    var bulk by remember { mutableStateOf<String?>(null) }
    var bulkCategory by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var showAllScheduled by remember { mutableStateOf(false) }
    // Schedules start folded or open as Settings says; the band switches them.
    val upcomingOpen = LocalPreferences.current.showUpcoming
    var scheduledOpen by rememberSaveable { mutableStateOf(upcomingOpen) }
    var csv by remember { mutableStateOf("") }
    val selecting = selected.isNotEmpty()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    val exporter = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/csv")) { uri ->
        val content = csv
        if (uri != null) scope.launch {
            runCatching { withContext(Dispatchers.IO) { context.contentResolver.openOutputStream(uri)?.bufferedWriter()?.use { it.write(content) } ?: error("Could not open export destination.") } }
                .onFailure { vm.notifyError(it.message ?: "Could not export the register.") }
        }
    }
    DisposableEffect(selecting) { setDockHidden(selecting); onDispose { setDockHidden(false) } }
    BackHandler(selecting) { selected = emptySet() }
    BackHandler(searching && !selecting) { searching = false; search = "" }
    // Typing settles for a moment before the list recomputes.
    var query by remember { mutableStateOf(search) }
    LaunchedEffect(search) { if (search.isNotEmpty()) delay(150); query = search }
    val account = remember(budget, accountFilter) { if (accountFilter.isBlank()) null else budget.row("accounts", accountFilter) }
    val categories = remember(budget) { budget.rows("categories").associate { it.text("id") to it.text("name") } }
    val flags = remember(budget) { flagChoices(budget) }
    // The index for this snapshot, kept in the view model so revisiting the tab doesn't rebuild it.
    val cachedIndex = remember { (vm.screenCache["registerIndex"] as? Pair<*, *>)?.takeIf { it.first === budget }?.second as? RegisterIndex }
    val index by produceState(cachedIndex, budget) {
        val hit = (vm.screenCache["registerIndex"] as? Pair<*, *>)?.takeIf { it.first === budget }?.second as? RegisterIndex
        value = hit ?: withContext(Dispatchers.Default) { RegisterIndex.build(budget) }.also { vm.screenCache["registerIndex"] = budget to it }
    }
    val minimumAmount = remember(budget, minimum) { if (minimum.isBlank()) null else runCatching { amountValue(minimum) }.getOrNull() }
    val maximumAmount = remember(budget, maximum) { if (maximum.isBlank()) null else runCatching { amountValue(maximum) }.getOrNull() }
    val filter = remember(accountFilter, status, categoryFilter, flagFilter, from, through, minimum, maximum, minimumAmount, maximumAmount, query, order) {
        RegisterIndex.Filter(accountFilter, status, categoryFilter, flagFilter, from, through, minimumAmount, maximumAmount,
            minimum.isNotBlank() && minimumAmount == null || maximum.isNotBlank() && maximumAmount == null, query, order)
    }
    val today = LocalDate.now().toString()
    // The last result stays on screen while a newer one is worked out, unless it was another account's.
    var computing by remember { mutableStateOf(false) }
    val produced by produceState<Pair<String, List<RegisterLine>>?>(null, index, filter) {
        val prepared = index ?: return@produceState
        // Only a slow recompute shows the bar, so typing doesn't make it flicker.
        val busy = launch { delay(150); computing = true }
        value = accountFilter to withContext(Dispatchers.Default) { registerLines(prepared.matching(filter), filter.order, accountFilter, budget, today) }
        busy.cancel()
        computing = false
    }
    val lines = produced?.takeIf { it.first == accountFilter }?.second
    val visibleIds = remember(lines) { lines.orEmpty().mapNotNull { (it as? TxLine)?.id } }
    val allSelected = selecting && selected.size >= visibleIds.size && selected.containsAll(visibleIds)
    val selectedTotal = remember(selected, lines) { lines.orEmpty().sumOf { if (it is TxLine && it.id in selected) it.amount else 0L } }
    val anyUnapproved = remember(selected, lines) { lines.orEmpty().any { it is TxLine && it.id in selected && !it.approved } }
    val toApprove = remember(index, accountFilter) { index?.awaitingApproval(accountFilter) ?: 0 }
    val schedules = remember(budget, accountFilter, categoryFilter) {
        if (categoryFilter.isNotBlank()) emptyList() else budget.rows("schedules").filter { schedule ->
            // A schedule with no next date has finished.
            val t = schedule.optJSONObject("transaction") ?: return@filter false
            schedule.text("nextDate").isNotBlank() && (accountFilter.isBlank() || t.text("accountId") == accountFilter || t.text("transferAccountId") == accountFilter)
        }.sortedWith(compareBy<JSONObject> { it.optBoolean("paused") }.thenBy { it.text("nextDate") })
    }
    val scheduledSoon = remember(schedules, accountFilter) {
        val horizon = LocalDate.now().plusDays(30).toString()
        val soon = schedules.filter { !it.optBoolean("paused") && it.text("nextDate") <= horizon }.map { s ->
            val t = s.optJSONObject("transaction") ?: JSONObject()
            if (accountFilter.isNotBlank() && t.text("transferAccountId") == accountFilter) -t.optLong("amount") else t.optLong("amount")
        }
        soon.filter { it > 0 }.sum() to soon.filter { it < 0 }.sum()
    }
    // The Filters pill counts what its sheet sets; dates have their own pill.
    val sheetFilters = listOf(status, flagFilter, minimum, maximum).count { it.isNotBlank() } + if (order != "newest") 1 else 0
    val activeFilters = sheetFilters + if (from.isNotBlank() || through.isNotBlank()) 1 else 0
    val title = when {
        account != null -> account.text("name")
        categoryFilter == "__none" -> "Uncategorized"
        categoryFilter == Unassigned -> "Unassigned"
        categoryFilter.isNotBlank() -> categories[categoryFilter] ?: "Category"
        else -> "Transactions"
    }
    val earliest = remember(budget) { budget.rows("transactions").minOfOrNull { it.text("date") } }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            if (selecting) Row(Modifier.fillMaxWidth().background(ur.bg).statusBarsPadding().height(64.dp).padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                RoundIconButton(Icons.Outlined.Close, "End selection", { selected = emptySet() })
                Column(Modifier.weight(1f).padding(start = 12.dp)) {
                    Text("${selected.size} selected", style = MaterialTheme.typography.headlineSmall, color = ur.text)
                    Text(money(selectedTotal, currency), style = MaterialTheme.typography.bodySmall.merge(Tabular), color = ur.muted)
                }
                TextButton({ selected = if (allSelected) emptySet() else visibleIds.toSet() }) {
                    Text(if (allSelected) "Select none" else "Select all", color = ur.accent, fontWeight = FontWeight.Bold)
                }
            } else PhoneTopBar(title, subtitle = account?.let { accountTypeLabel(it) } ?: if (from.isNotBlank() || through.isNotBlank()) dateRangeLabel(from, through) else null,
                onBack = onBack, actions = {
                RoundIconButton(Icons.Outlined.Search, "Search", { searching = !searching; if (!searching) search = "" }, tint = if (searching) ur.accent else ur.text, dot = activeFilters > 0 && !searching)
                bar()
            })
            AnimatedVisibility(searching && !selecting) {
                Column(Modifier.fillMaxWidth().background(ur.bg).padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    SearchField(search, { search = it }, "Payee, category, memo, amount", Modifier.padding(horizontal = Gutter))
                    Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = Gutter), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterPill(if (sheetFilters > 0) "Filters · $sheetFilters" else "Filters", sheetFilters > 0, { filtersOpen = true }, Icons.Outlined.Tune)
                        FilterPill(if (from.isNotBlank() || through.isNotBlank()) dateRangeLabel(from, through) else "Dates", from.isNotBlank() || through.isNotBlank(), { datesOpen = true }, Icons.Outlined.DateRange)
                        FilterPill("Needs approval", status == "approval", { status = if (status == "approval") "" else "approval" })
                        FilterPill("Uncleared", status == "uncleared", { status = if (status == "uncleared") "" else "uncleared" })
                        if (accountFilter.isBlank()) FilterPill("Needs a category", categoryFilter == "__none", { setCategory(if (categoryFilter == "__none") "" else "__none") })
                        FilterPill("Flagged", flagFilter == "__any", { flagFilter = if (flagFilter == "__any") "" else "__any" }, Icons.Outlined.Flag)
                        FilterPill("Export", false, { vm.query("exportRegister") { csv = it.text("items"); exporter.launch("urbudget-register.csv") } }, Icons.Outlined.FileUpload)
                    }
                }
            }
            Box(Modifier.fillMaxWidth().height(2.dp)) { if (computing && lines != null) LinearProgressIndicator(Modifier.matchParentSize(), color = ur.accent, trackColor = ur.bg) }
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = DockRoom)) {
                if (account != null && summary != null) item(key = "summary", contentType = "summary") {
                    AccountSummaryCard(account, summary.rows("accounts").firstOrNull { it.text("id") == accountFilter }, currency,
                        { reconcile(account) }, { editAccount(account) }, if (account.text("kind") == "credit") ({ payCard(account.text("id")) }) else null,
                        Modifier.padding(horizontal = Gutter).padding(bottom = 14.dp))
                }
                if (toApprove > 0 && status != "approval" && !selecting) item(key = "approve", contentType = "notice") {
                    Notice(if (toApprove == 1) "1 transaction to approve" else "$toApprove transactions to approve", Modifier.padding(horizontal = Gutter).padding(bottom = 12.dp),
                        tone = "info", action = "Review", onAction = { status = "approval"; searching = true }, icon = Icons.Outlined.NewReleases)
                }
                if (schedules.isNotEmpty() && !searching && !selecting) {
                    item(key = "scheduled", contentType = "band") {
                        val (incoming, outgoing) = scheduledSoon
                        val soon = listOfNotNull(if (incoming != 0L) "+${money(incoming, currency)}" else null, if (outgoing != 0L) money(outgoing, currency) else null)
                        Band("Scheduled · ${schedules.size}", trailing = if (soon.isEmpty()) null else "30 days: ${soon.joinToString("  ")}",
                            open = scheduledOpen, onClick = { scheduledOpen = !scheduledOpen })
                    }
                    val shown = if (!scheduledOpen) emptyList() else if (showAllScheduled) schedules else schedules.take(3)
                    items(shown, key = { "s:${it.text("id")}" }, contentType = { "schedule" }) { schedule ->
                        ScheduleLine(schedule, budget, categories, currency, accountFilter, edit = { editSchedule(schedule) }, vm = vm,
                            last = schedule === shown.last() && schedules.size <= 3)
                    }
                    if (scheduledOpen && schedules.size > 3) item(key = "scheduled-more", contentType = "more") {
                        Column(Modifier.background(ur.surface)) {
                            Hairline(start = Gutter)
                            TextButton({ showAllScheduled = !showAllScheduled }, Modifier.padding(horizontal = 6.dp)) {
                                Text(if (showAllScheduled) "Show fewer" else "Show ${schedules.size - 3} more", color = ur.accent, fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }
                }
                val list = lines
                if (list == null) item(key = "loading", contentType = "loading") { LinearProgressIndicator(Modifier.fillMaxWidth().padding(Gutter), color = ur.accent) }
                else if (list.isEmpty()) item(key = "empty", contentType = "empty") {
                    if (search.isNotBlank() || activeFilters > 0) EmptyState("No matches", "Nothing matches this search and these filters.", "Clear filters") {
                        search = ""; status = ""; flagFilter = ""; from = ""; through = ""; minimum = ""; maximum = ""; order = "newest"
                    } else EmptyState("No transactions here", "Add a purchase, income, or a transfer to see your money in motion.", "Add transaction", add)
                }
                items(list.orEmpty(), key = { line -> when (line) { is DayLine -> "d:${line.date}"; is TxLine -> line.id } },
                    contentType = { if (it is DayLine) 0 else 1 }) { line ->
                    when (line) {
                        is DayLine -> Band(line.label)
                        is TxLine -> TransactionLine(line, selecting, line.id in selected,
                            open = {
                                if (selecting) selected = if (line.id in selected) selected - line.id else selected + line.id
                                else budget.row("transactions", line.id)?.let(edit)
                            },
                            select = {
                                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                selected = if (line.id in selected) selected - line.id else selected + line.id
                            },
                            toggleCleared = {
                                if (line.cleared != "reconciled") withCurrentBudget(budget, vm) {
                                    vm.runCommand("workflow", bulkAction(setOf(line.id), "status", if (line.cleared == "cleared") "uncleared" else "cleared", accountFilter))
                                }
                            },
                            approve = { withCurrentBudget(budget, vm) { vm.runCommand("workflow", bulkAction(setOf(line.id), "approve", "", accountFilter)) } },
                            jump = { if (line.otherAccount.isNotBlank()) openAccount(line.otherAccount) })
                    }
                }
            }
        }
        AnimatedVisibility(selecting, Modifier.align(Alignment.BottomCenter), enter = slideInVertically { it } + fadeIn(), exit = slideOutVertically { it } + fadeOut()) {
            SelectionDock(
                approve = if (anyUnapproved) ({ withCurrentBudget(budget, vm) { vm.runCommand("workflow", bulkAction(selected, "approve", "", accountFilter)); selected = emptySet() } }) else null,
                category = { bulkCategory = true },
                cleared = { withCurrentBudget(budget, vm) { vm.runCommand("workflow", bulkAction(selected, "status", "cleared", accountFilter)); selected = emptySet() } },
                flag = { value -> withCurrentBudget(budget, vm) { vm.runCommand("workflow", bulkAction(selected, "flag", value, accountFilter)); selected = emptySet() } },
                delete = { confirmDelete = true },
                more = { bulk = "payee" }, flags = flags)
        }
    }
    if (filtersOpen) FiltersSheet(budget, status, { status = it }, flagFilter, { flagFilter = it }, minimum, { minimum = it }, maximum, { maximum = it },
        order, { order = it }, categoryFilter, setCategory, accountFilter.isBlank()) { filtersOpen = false }
    if (datesOpen) DatesSheet(from, through, { f, t -> from = f; through = t }, earliest) { datesOpen = false }
    bulk?.let { operation -> BulkTransactionDialog(selected, accountFilter, budget, vm, operation, { bulk = null }) { bulk = null; selected = emptySet() } }
    if (bulkCategory) CategoryPickerSheet(budget, summary, LocalDate.now().toString().take(7), "", "Categorize ${selected.size}", includeUnassigned = true, includePayment = false,
        onPick = { id -> withCurrentBudget(budget, vm) { vm.runCommand("workflow", bulkAction(selected, "category", id, accountFilter)); selected = emptySet() }; bulkCategory = false }) { bulkCategory = false }
    if (confirmDelete) AlertDialog(onDismissRequest = { confirmDelete = false }, title = { Text("Delete ${selected.size} transactions?") },
        text = { Text("Both sides of transfers are removed too. You can undo this.") }, containerColor = ur.surface,
        confirmButton = { TextButton({ withCurrentBudget(budget, vm) { vm.runCommand("workflow", bulkAction(selected, "delete", "", accountFilter)); selected = emptySet() }; confirmDelete = false }) { Text("Delete", color = ur.negative) } },
        dismissButton = { TextButton({ confirmDelete = false }) { Text("Cancel") } })
}

private val ShortDate = DateTimeFormatter.ofPattern("d MMM yyyy", Locale.ENGLISH)
private fun dateRangeLabel(from: String, through: String): String {
    fun d(iso: String) = runCatching { LocalDate.parse(iso).format(ShortDate) }.getOrDefault(iso)
    return when {
        from.isNotBlank() && through.isNotBlank() -> "${d(from)} – ${d(through)}"
        from.isNotBlank() -> "From ${d(from)}"
        through.isNotBlank() -> "Through ${d(through)}"
        else -> "Any date"
    }
}

private fun bulkAction(ids: Set<String>, operation: String, value: String, account: String) =
    JSONObject().put("action", JSONObject().put("type", "bulk").put("ids", JSONArray(ids.toList())).put("operation", operation).put("value", value).put("accountId", account.ifBlank { "all" }))

internal fun accountTypeLabel(account: JSONObject) = accountTypes.firstOrNull { it.first == account.text("accountType") }?.second
    ?: when (account.text("kind")) { "credit" -> "Credit card"; "tracking" -> "Tracking"; else -> "Cash" }

/** A band across the screen: a day's date, or a section's name. */
@Composable
internal fun Band(text: String, trailing: String? = null, open: Boolean? = null, onClick: (() -> Unit)? = null) {
    Column(Modifier.background(ur.surface2)) {
        Hairline()
        Row(Modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable(onClickLabel = if (open == true) "Fold $text" else "Show $text", onClick = onClick) else Modifier)
            .heightIn(min = 44.dp).padding(horizontal = Gutter), verticalAlignment = Alignment.CenterVertically) {
            if (open != null) Icon(if (open) Icons.Outlined.ExpandMore else Icons.Outlined.ChevronRight, null, Modifier.padding(end = 6.dp).size(20.dp), tint = ur.muted)
            Text(text, Modifier.weight(1f), fontSize = 16.sp, fontWeight = FontWeight.Bold, color = ur.text)
            trailing?.let { Text(it, color = ur.muted, fontWeight = FontWeight.SemiBold, style = Tabular) }
        }
        Hairline()
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TransactionLine(line: TxLine, selecting: Boolean, selected: Boolean, open: () -> Unit, select: () -> Unit, toggleCleared: () -> Unit,
                            approve: () -> Unit, jump: () -> Unit) {
    Column(Modifier.background(if (selected) ur.accentSoft else ur.surface).then(if (line.future) Modifier.alpha(.6f) else Modifier)) {
        Row(Modifier.fillMaxWidth().combinedClickable(onClick = open, onLongClick = select, onClickLabel = if (selecting) "Select" else "Edit transaction")
            .padding(start = if (selecting) 8.dp else Gutter, end = 10.dp, top = 11.dp, bottom = 11.dp), verticalAlignment = Alignment.CenterVertically) {
            if (selecting) Box(Modifier.padding(end = 10.dp).size(24.dp).clip(CircleShape).background(if (selected) ur.accent else Color.Transparent)
                .border(1.5.dp, if (selected) ur.accent else ur.borderStrong, CircleShape), contentAlignment = Alignment.Center) {
                if (selected) Icon(Icons.Outlined.Check, null, Modifier.size(15.dp), tint = ur.surface)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (line.transfer) Box(Modifier.padding(end = 8.dp).size(26.dp).clip(RoundedCornerShape(7.dp)).background(ur.accentSoft)
                        .clickable(enabled = !selecting, onClickLabel = "Open the other account", onClick = jump), contentAlignment = Alignment.Center) {
                        Icon(if (line.card) Icons.Outlined.CreditCard else Icons.Outlined.SwapHoriz, null, Modifier.size(16.dp), tint = ur.accent)
                    }
                    if (line.flag.isNotBlank()) FlagDot(line.flag, Modifier.padding(end = 6.dp), 10.dp)
                    Text(line.payee, Modifier.weight(1f), fontSize = 16.5.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        color = if (!line.approved) ur.accent else ur.text)
                    Text(line.amountText, Modifier.padding(start = 8.dp), fontSize = 16.5.sp, fontWeight = FontWeight.SemiBold,
                        color = if (line.amount > 0) ur.positive else ur.text, style = Tabular, maxLines = 1)
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        line.chips.forEach { chip ->
                            if (chip.kind == ChipNeeds) TagChip(chip.text, Modifier.weight(1f, fill = false), fill = ur.attention.copy(alpha = if (ur.dark) .25f else 1f), color = if (ur.dark) ur.attention else ur.onAttention)
                            else TagChip(chip.text, if (chip.kind == ChipMore) Modifier else Modifier.weight(1f, fill = false))
                        }
                    }
                    if (line.accountName.isNotBlank()) Text(line.accountName, Modifier.padding(start = 8.dp), color = ur.muted, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    // Approving sits on this line so amounts stay in one column.
                    if (!line.approved && !selecting) Box(Modifier.padding(start = 8.dp).size(28.dp).clip(CircleShape).background(ur.accentSoft)
                        .clickable(role = Role.Button, onClickLabel = "Approve", onClick = approve), contentAlignment = Alignment.Center) {
                        Icon(Icons.Outlined.Check, "Approve", Modifier.size(16.dp), tint = ur.accent)
                    }
                }
                if (line.memo.isNotBlank()) Text(line.memo, color = ur.muted, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            ClearedMark(line.cleared, Modifier.padding(start = 6.dp), onClick = if (selecting || line.cleared == "reconciled") null else toggleCleared)
        }
        Hairline(start = Gutter)
    }
}

private fun splitName(part: JSONObject, categories: Map<String, String>) = when {
    part.optBoolean("unassigned") -> "Unassigned"
    part.text("transferAccountId").isNotBlank() -> "Transfer"
    else -> categories[part.text("categoryId")] ?: "Uncategorized"
}

/** A scheduled transaction atop the list: payee and amount, category and next date, Enter and Skip. */
@Composable
private fun ScheduleLine(schedule: JSONObject, budget: JSONObject, categories: Map<String, String>, currency: String, accountFilter: String,
                         edit: () -> Unit, vm: BudgetViewModel, last: Boolean) {
    val t = schedule.optJSONObject("transaction") ?: JSONObject()
    val amount = if (accountFilter.isNotBlank() && t.text("transferAccountId") == accountFilter) -t.optLong("amount") else t.optLong("amount")
    val paused = schedule.optBoolean("paused")
    var menu by remember { mutableStateOf(false) }
    val today = LocalDate.now().toString()
    val split = t.rows("splits")
    val category = when {
        split.size > 1 -> "Split"
        split.firstOrNull()?.optBoolean("unassigned") == true -> "To Unassigned"
        else -> split.firstOrNull()?.text("categoryId")?.let { categories[it] }
    }
    val transferName = remember(budget, t) { budget.row("accounts", t.text("transferAccountId"))?.text("name") }
    Column(Modifier.background(ur.surface).then(if (paused) Modifier.alpha(.55f) else Modifier)) {
        Row(Modifier.fillMaxWidth().clickable(onClick = edit).padding(start = Gutter, end = 6.dp, top = 10.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Outlined.Repeat, null, Modifier.size(18.dp), tint = ur.muted)
            Text(t.text("payee").ifBlank { transferName?.let { "Transfer: $it" } ?: "Scheduled" },
                Modifier.weight(1f).padding(start = 8.dp), fontSize = 16.5.sp, fontWeight = FontWeight.SemiBold, color = ur.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text((if (amount > 0) "+" else "") + money(amount, currency), Modifier.padding(end = 10.dp), fontSize = 16.5.sp, fontWeight = FontWeight.SemiBold,
                color = if (amount > 0) ur.positive else ur.text2, style = Tabular)
        }
        Row(Modifier.fillMaxWidth().padding(start = Gutter, end = 4.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (category != null) TagChip(category, Modifier.padding(end = 2.dp))
            Text(if (paused) "Paused" else (if (schedule.text("nextDate") <= today) "Due " else "") + Money.date(schedule.text("nextDate")),
                Modifier.weight(1f), color = if (!paused && schedule.text("nextDate") <= today) ur.warning else ur.muted, fontSize = 14.sp, maxLines = 1)
            if (!paused) {
                SmallAction("Enter", { vm.runCommand("applySchedules", JSONObject().put("through", today).put("selected", schedule.text("id"))) }, primary = true)
                SmallAction("Skip", { vm.runCommand("applySchedules", JSONObject().put("through", today).put("selected", schedule.text("id")).put("skip", true)) })
            }
            Box {
                IconButton({ menu = true }, Modifier.size(36.dp)) { Icon(Icons.Outlined.MoreHoriz, "Schedule actions", Modifier.size(18.dp), tint = ur.muted) }
                DropdownMenu(menu, { menu = false }, shape = RoundedCornerShape(16.dp), containerColor = ur.surface) {
                    DropdownMenuItem(text = { Text("Edit") }, leadingIcon = { Icon(Icons.Outlined.Edit, null) }, onClick = { edit(); menu = false })
                    DropdownMenuItem(text = { Text(if (paused) "Resume" else "Pause") }, leadingIcon = { Icon(if (paused) Icons.Outlined.PlayArrow else Icons.Outlined.Pause, null) },
                        onClick = { withCurrentBudget(budget, vm) { vm.upsert("schedules", schedule.copyJson().put("paused", !paused)) }; menu = false })
                    DropdownMenuItem(text = { Text("Delete", color = ur.negative) }, leadingIcon = { Icon(Icons.Outlined.DeleteOutline, null, tint = ur.negative) },
                        onClick = { withCurrentBudget(budget, vm) { vm.remove("schedules", schedule.text("id")) }; menu = false })
                }
            }
        }
        if (!last) Hairline(start = Gutter)
    }
}

/** An account's balances above its transactions: working balance, cleared and uncleared, and its actions. */
@Composable
private fun AccountSummaryCard(account: JSONObject, total: JSONObject?, currency: String, reconcile: () -> Unit, edit: () -> Unit, pay: (() -> Unit)?,
                               modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(ur.surface).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Working balance", color = ur.muted, style = MaterialTheme.typography.bodyMedium)
        Text(money(total?.optLong("balance") ?: 0, currency), fontSize = 28.sp, fontWeight = FontWeight.ExtraBold, style = Tabular,
            color = if ((total?.optLong("balance") ?: 0) < 0) ur.negative else ur.text)
        Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
            Figure("Cleared", money(total?.optLong("cleared") ?: 0, currency))
            Figure("Uncleared", money(total?.optLong("uncleared") ?: 0, currency))
        }
        if (pay != null && !account.optBoolean("archived")) PrimaryButton("Make a payment", pay, Modifier.fillMaxWidth(), icon = Icons.Outlined.CreditCard)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SecondaryButton("Reconcile", reconcile, Modifier.weight(1f), enabled = total != null && !account.optBoolean("archived"), icon = Icons.Outlined.Lock)
            SecondaryButton("Edit account", edit, Modifier.weight(1f), icon = Icons.Outlined.Edit)
        }
    }
}

/** The selection's actions, on the same glass as the tab bar whose place they take. */
@Composable
private fun SelectionDock(approve: (() -> Unit)?, category: () -> Unit, cleared: () -> Unit, flag: (String) -> Unit, delete: () -> Unit, more: () -> Unit,
                          flags: List<Pair<String, String>>) {
    val shape = RoundedCornerShape(32.dp)
    var flagMenu by remember { mutableStateOf(false) }
    Row(Modifier.navigationBarsPadding().padding(start = 12.dp, end = 12.dp, bottom = 10.dp).fillMaxWidth().height(66.dp)
        .floating(shape, ur.dark, ur.border).clip(shape).background(ur.glass).border(0.5.dp, ur.border, shape).padding(5.dp)) {
        @Composable
        fun RowScope.Action(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, tint: Color = ur.text, onClick: () -> Unit) {
            Column(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(28.dp)).clickable(role = Role.Button, onClickLabel = label, onClick = onClick),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                Icon(icon, null, Modifier.size(22.dp), tint = tint)
                Text(label, fontSize = 11.5.sp, fontWeight = FontWeight.SemiBold, color = tint, maxLines = 1)
            }
        }
        // Approve only appears when something selected is waiting for it.
        if (approve != null) Action("Approve", Icons.Outlined.ThumbUp, onClick = approve)
        Action("Category", Icons.Outlined.Category, onClick = category)
        Action("Cleared", Icons.Outlined.CheckCircle, onClick = cleared)
        Box(Modifier.weight(1f)) {
            Row { Action("Flag", Icons.Outlined.Flag) { flagMenu = true } }
            DropdownMenu(flagMenu, { flagMenu = false }, shape = RoundedCornerShape(16.dp), containerColor = ur.surface) {
                DropdownMenuItem(text = { Text("No flag") }, leadingIcon = { Icon(Icons.Outlined.OutlinedFlag, null) }, onClick = { flag(""); flagMenu = false })
                flags.forEach { (id, name) -> DropdownMenuItem(text = { Text(name) }, leadingIcon = { FlagDot(id, size = 14.dp) }, onClick = { flag(id); flagMenu = false }) }
            }
        }
        Action("Delete", Icons.Outlined.DeleteOutline, ur.negative, delete)
        Action("More", Icons.Outlined.MoreHoriz, onClick = more)
    }
}

@Composable
private fun FiltersSheet(budget: JSONObject, status: String, setStatus: (String) -> Unit, flag: String, setFlag: (String) -> Unit,
                         minimum: String, setMinimum: (String) -> Unit, maximum: String, setMaximum: (String) -> Unit,
                         order: String, setOrder: (String) -> Unit, category: String, setCategory: (String) -> Unit, allowCategory: Boolean, close: () -> Unit) {
    val categories = remember(budget) { listOf("" to "All categories", "__none" to "Needs a category", Unassigned to "Unassigned") + budget.rows("categories").map { it.text("id") to it.text("name") } }
    FormDialog("Filters", close, confirm = "Done", onConfirm = close) {
        Choice("Status", status, listOf("" to "Any status", "uncleared" to "Uncleared", "cleared" to "Cleared", "reconciled" to "Reconciled", "notReconciled" to "Not reconciled", "approval" to "Needs approval"), setStatus)
        if (allowCategory) Choice("Category", category, categories, setCategory)
        Choice("Flag", flag, listOf("" to "Any or no flag", "__any" to "Flagged", "__none" to "Not flagged") + flagChoices(budget), setFlag)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Box(Modifier.weight(1f)) { Field(minimum, setMinimum, "At least", true) }
            Box(Modifier.weight(1f)) { Field(maximum, setMaximum, "At most", true) }
        }
        Text("Amounts match outflows and inflows alike.", color = ur.muted, style = MaterialTheme.typography.bodySmall)
        Choice("Sort", order, listOf("newest" to "Newest first", "oldest" to "Oldest first", "amount" to "Amount", "payee" to "Payee"), setOrder)
        TextButton({ setStatus(""); setFlag(""); setMinimum(""); setMaximum(""); setOrder("newest"); if (allowCategory) setCategory("") }) {
            Text("Clear filters", color = ur.negative)
        }
    }
}

/** Dates: the desktop's presets, or a range of your own. */
@Composable
private fun DatesSheet(from: String, through: String, set: (String, String) -> Unit, earliest: String?, close: () -> Unit) {
    var custom by remember { mutableStateOf(false) }
    var start by remember { mutableStateOf(from.ifBlank { LocalDate.now().minusMonths(1).toString() }) }
    var end by remember { mutableStateOf(through.ifBlank { LocalDate.now().toString() }) }
    UrSheet(close) {
        SheetHeader("Dates", close, if (custom) "Apply" else null, if (custom) ({ val (a, b) = if (start <= end) start to end else end to start; set(a, b); close() }) else null)
        Column(Modifier.padding(horizontal = Gutter).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            ListCard {
                ListRow("Any date", onClick = { set("", ""); close() }, chevron = false, divider = true,
                    trailing = if (from.isBlank() && through.isBlank()) ({ Icon(Icons.Outlined.Check, null, tint = ur.accent) }) else null)
                datePresets.forEach { (id, label) ->
                    val (a, b) = datePreset(id, earliest)
                    ListRow(label, onClick = { set(a, b); close() }, chevron = false, divider = true,
                        trailing = if (from == a && through == b) ({ Icon(Icons.Outlined.Check, null, tint = ur.accent) }) else null)
                }
                ListRow("Custom range", titleColor = ur.accent, onClick = { custom = true }, chevron = false)
            }
            if (custom) {
                DateField(start, { start = it }, "From")
                DateField(end, { end = it }, "Through")
            }
        }
    }
}

private data class SplitDraft(val original: JSONObject, val category: String, val amount: String, val memo: String, val transfer: String = "", val payee: String = "", val transferStatus: String = "uncleared", val key: String = UUID.randomUUID().toString())

/**
 * Adding or editing a transaction takes the whole screen, as YNAB's app does: Outflow or Inflow, the
 * amount large on the keypad (digits fill in as cents and it does sums), then the payee, category,
 * account and date as rows of a card, and the rest in a second card.
 */
@Composable
internal fun TransactionDialog(original: JSONObject?, budget: JSONObject, initialAccount: String, vm: BudgetViewModel, close: () -> Unit, saveOverride: ((JSONObject) -> Unit)? = null, dialogTitle: String? = null, extraFields: (@Composable () -> Unit)? = null,
                               summary: JSONObject? = null) {
    val openedBudget = remember { budget }
    // Read once: the form doesn't follow every state emission while it's open.
    val summary = summary ?: remember { vm.state.value.summary }
    val accounts = remember(budget, original) { val used = original?.rows("splits")?.map { it.text("transferAccountId") }.orEmpty().toSet(); budget.rows("accounts").filter { !it.optBoolean("archived") || it.text("id") == original?.text("accountId") || it.text("id") == original?.text("transferAccountId") || it.text("id") in used } }
    val currency = budget.text("currency")
    val flags = remember(budget) { flagChoices(budget) }
    // Payees most used first, each with its usual category, worked out once off the main thread.
    val payees by produceState(emptyList<PayeeInfo>(), budget) { value = withContext(Dispatchers.Default) { payeeIndex(budget) } }
    val toast = LocalToast.current
    var account by remember { mutableStateOf(original?.text("accountId") ?: initialAccount.ifBlank { accounts.firstOrNull { it.text("kind") != "tracking" }?.text("id") ?: accounts.firstOrNull()?.text("id") ?: "" }) }
    var payee by remember { mutableStateOf(original?.text("payee") ?: "") }
    var date by remember { mutableStateOf(original?.text("date") ?: LocalDate.now().toString()) }
    var memo by remember { mutableStateOf(original?.text("memo") ?: "") }
    val pad = rememberPad(original?.optLong("amount")?.let { abs(it) })
    var keypad by remember { mutableStateOf(original == null) }
    var direction by remember { mutableStateOf(if ((original?.optLong("amount") ?: -1) >= 0) "in" else "out") }
    val startCleared = LocalPreferences.current.newCleared
    var status by remember { mutableStateOf(original?.text("status") ?: if (startCleared) "cleared" else "uncleared") }
    // Nothing dated ahead has cleared yet: a new one moved ahead goes uncleared, until the switch is set by hand.
    var statusSet by remember { mutableStateOf(false) }
    var transfer by remember { mutableStateOf(original?.text("transferAccountId") ?: "") }
    var peerStatus by remember { mutableStateOf(original?.text("transferStatus", "uncleared") ?: "uncleared") }
    var flag by remember { mutableStateOf(original?.text("flag") ?: "") }
    var approved by remember { mutableStateOf(original?.optBoolean("approved", true) ?: true) }
    var splitMode by remember { mutableStateOf((original?.rows("splits")?.size ?: 0) > 1) }
    var category by remember { mutableStateOf(original?.rows("splits")?.firstOrNull()?.let { if (it.optBoolean("unassigned")) Unassigned else it.text("categoryId") } ?: "") }
    // Split lines are each one's share of the total, entered without a sign, as on the desktop.
    val splitSign = if ((original?.optLong("amount") ?: 0) < 0) -1 else 1
    var splitRows by remember { mutableStateOf(original?.rows("splits")?.map { SplitDraft(it, if (it.optBoolean("unassigned")) Unassigned else it.text("categoryId"), amountText(it.optLong("amount") * splitSign), it.text("memo"), it.text("transferAccountId"), it.text("payee"), it.text("transferStatus", "uncleared")) }.orEmpty()) }
    var repeat by remember { mutableStateOf("never") }
    var repeatMenu by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    var picker by remember { mutableStateOf<String?>(null) }
    var splitPicker by remember { mutableStateOf<Int?>(null) }
    var flagMenu by remember { mutableStateOf(false) }
    val accountName = { id: String -> budget.row("accounts", id)?.text("name") }
    fun categoryName(id: String) = when (id) { "" -> null; Unassigned -> "Unassigned"; else -> budget.row("categories", id)?.text("name") }
    val today = LocalDate.now().toString()
    val schedule = saveOverride == null && date > today && status == "uncleared" && (transfer.isBlank() || peerStatus == "uncleared")
    // Repeat makes a new transaction a schedule too; it's offered while adding one.
    val repeatable = original == null && saveOverride == null
    // A transfer between two budget accounts (or two tracking ones) moves money without a category.
    val needsCategory = remember(budget, account, transfer) {
        transfer.isBlank() || (budget.row("accounts", account)?.text("kind") == "tracking") != (budget.row("accounts", transfer)?.text("kind") == "tracking")
    }
    val save: () -> Unit = {
        runCatching {
            requireCurrentBudget(openedBudget, vm)
            require(account.isNotBlank()) { "Choose an account." }; LocalDate.parse(date)
            val parsed = pad.cents ?: error("Finish the sum first."); require(parsed >= 0) { "Use Outflow or Inflow to choose the direction." }
            val sign = if (direction == "out") -1L else 1L
            val cents = parsed * sign
            require(transfer != account) { "Choose a different transfer account." }
            val record = (original?.copyJson() ?: JSONObject().put("id", UUID.randomUUID().toString()))
                .put("date", date).put("accountId", account).put("payee", payee).put("memo", memo).put("amount", cents).put("status", status)
                .put("approved", approved).put("flag", flag.ifBlank { null } ?: JSONObject.NULL)
                .put("transferAccountId", transfer.ifBlank { null } ?: JSONObject.NULL).put("transferStatus", if (transfer.isNotEmpty()) peerStatus else JSONObject.NULL)
            val parts = if (!needsCategory) {
                listOf((original?.rows("splits")?.singleOrNull()?.copyJson() ?: JSONObject()).put("categoryId", JSONObject.NULL).put("unassigned", false).put("amount", cents))
            } else if (splitMode) {
                require(splitRows.size >= 2) { "Add at least two split lines." }
                splitRows.map { part ->
                    part.original.copyJson().put("categoryId", if (part.category.isBlank() || part.category == Unassigned) JSONObject.NULL else part.category)
                        .put("unassigned", part.category == Unassigned).put("amount", amountValue(part.amount) * sign).put("memo", part.memo).put("payee", part.payee.ifBlank { null } ?: JSONObject.NULL)
                        .put("transferAccountId", part.transfer.ifBlank { null } ?: JSONObject.NULL).put("transferStatus", if (part.transfer.isNotEmpty()) part.transferStatus else JSONObject.NULL)
                }.also { require(it.sumOf { row -> row.optLong("amount") } == cents) { "The split amounts must equal the transaction total." } }
            } else listOf((original?.rows("splits")?.singleOrNull()?.copyJson() ?: JSONObject()).put("categoryId", if (category.isBlank() || category == Unassigned) JSONObject.NULL else category).put("unassigned", category == Unassigned).put("amount", cents))
            record.put("splits", jsonArray(parts))
            val often = frequencies.firstOrNull { it.first == repeat }?.second?.lowercase(Locale.ROOT)
            when {
                saveOverride != null -> saveOverride(record)
                repeatable && repeat != "never" -> {
                    // One schedule from this date: entered now when it's due, and repeating from there.
                    val id = record.text("id")
                    vm.saveRepeating(JSONObject().put("id", id).put("transaction", record).put("nextDate", date).put("anchorDate", date)
                        .put("frequency", repeat).put("paused", false), entered = record.takeIf { date <= today })
                    toast(if (date <= today) "Saved. It repeats $often." else "Scheduled $often from ${Money.date(date)}.", false)
                }
                else -> {
                    vm.saveTransaction(record)
                    if (schedule) toast("Scheduled for ${Money.date(date)}. It's entered on that day.", false)
                }
            }
        }.onSuccess { close() }.onFailure { error = it.message }
    }
    FullScreenDialog(close) {
        Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().imePadding()) {
            Box(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 6.dp)) {
                IconButton(close, Modifier.align(Alignment.CenterStart)) { Icon(Icons.Outlined.Close, "Cancel", tint = ur.text) }
                Text(dialogTitle ?: if (original == null) "New transaction" else "Edit transaction", Modifier.align(Alignment.Center), style = MaterialTheme.typography.titleMedium, color = ur.text)
                TextButton(save, Modifier.align(Alignment.CenterEnd), enabled = accounts.isNotEmpty()) {
                    Text(if (schedule || repeatable && repeat != "never" && date > today) "Schedule" else "Save", color = if (accounts.isNotEmpty()) ur.accent else ur.muted, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                }
            }
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = Gutter), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Segmented(listOf("out" to "Outflow", "in" to "Inflow"), direction, { direction = it })
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(if (keypad) ur.accentSoft else ur.surface)
                    .clickable(onClickLabel = "Edit amount") { keypad = true; pad.fresh = true }.padding(vertical = 16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    PadAmount(pad, currency, color = if (direction == "in") ur.positive else ur.text, sign = if (direction == "in") "+" else "−")
                    Text(if (keypad) "Type the amount" else "Tap to change", color = ur.muted, style = MaterialTheme.typography.bodySmall)
                }
                if (accounts.isEmpty()) Notice("Create an account in Accounts before adding your first transaction.", tone = "info")
                if (original?.text("status") == "reconciled" || original?.text("transferStatus") == "reconciled")
                    Notice("This transaction is reconciled. Changing its amount, date, or account changes previously reconciled history.", icon = Icons.Outlined.Lock)
                ListCard {
                    FormRow(Icons.Outlined.Storefront, "Payee", when {
                        transfer.isNotBlank() -> "${if (direction == "out") "Transfer to" else "Transfer from"} ${accountName(transfer) ?: "account"}"
                        else -> payee.ifBlank { null }
                    }, "Choose payee", divider = true) { keypad = false; picker = "payee" }
                    if (!splitMode && needsCategory) FormRow(Icons.Outlined.Category, "Category", categoryName(category), "Choose category",
                        divider = true, attention = category.isBlank()) { keypad = false; picker = "category" }
                    FormRow(budget.row("accounts", account)?.let(::accountIcon) ?: Icons.Outlined.AccountBalance, "Account", accountName(account), "Choose account", divider = true) {
                        keypad = false; picker = "account"
                    }
                    var dating by remember { mutableStateOf(false) }
                    FormRow(Icons.Outlined.CalendarToday, "Date", Money.date(date) + if (date == today) " · Today" else if (schedule) " · Scheduled" else "", "",
                        divider = repeatable) { keypad = false; dating = true }
                    if (dating) DatePickerSheet(date, { picked ->
                        date = picked; dating = false
                        if (original == null && !statusSet) { status = if (picked > today || !startCleared) "uncleared" else "cleared"; peerStatus = "uncleared" }
                    }) { dating = false }
                    if (repeatable) Box {
                        FormRow(Icons.Outlined.Repeat, "Repeat", if (repeat == "never") (if (date > today) "Once" else "Never") else frequencies.firstOrNull { it.first == repeat }?.second, "") {
                            keypad = false; repeatMenu = true
                        }
                        DropdownMenu(repeatMenu, { repeatMenu = false }, shape = RoundedCornerShape(16.dp), containerColor = ur.surface) {
                            frequencies.forEach { (id, name) ->
                                DropdownMenuItem(text = { Text(if (id == "never") (if (date > today) "Once" else "Never") else name) },
                                    trailingIcon = if (id == repeat) ({ Icon(Icons.Outlined.Check, null, tint = ur.accent) }) else null,
                                    onClick = { repeat = id; repeatMenu = false })
                            }
                        }
                    }
                }
                extraFields?.invoke()
                if (splitMode && needsCategory) SplitCard(splitRows, { splitRows = it }, pad.cents ?: 0L, currency, ::categoryName,
                    pickCategory = { splitPicker = it }, unsplit = { splitMode = false; category = splitRows.firstOrNull()?.category ?: "" })
                ListCard {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.Top) {
                        Icon(Icons.AutoMirrored.Outlined.Notes, null, Modifier.size(22.dp), tint = ur.muted)
                        Box(Modifier.weight(1f).padding(start = 14.dp)) {
                            if (memo.isEmpty()) Text("Memo", color = ur.muted, style = MaterialTheme.typography.bodyLarge)
                            BasicTextField(memo, { memo = it }, Modifier.fillMaxWidth(), textStyle = MaterialTheme.typography.bodyLarge.copy(color = ur.text), cursorBrush = SolidColor(ur.accent))
                        }
                    }
                    Hairline(start = 52.dp)
                    ClearedRow(if (transfer.isNotBlank()) "Cleared in ${accountName(account) ?: "this account"}" else "Cleared", status) { status = it; statusSet = true }
                    Hairline(start = 52.dp)
                    if (transfer.isNotBlank()) {
                        ClearedRow("Cleared in ${accountName(transfer) ?: "the other account"}", peerStatus) { peerStatus = it; statusSet = true }
                        Hairline(start = 52.dp)
                    }
                    Box {
                        FormRow(Icons.Outlined.Flag, "Flag", flags.firstOrNull { it.first == flag }?.second, "No flag",
                            leading = if (flag.isNotBlank()) ({ FlagDot(flag, size = 16.dp) }) else null) { flagMenu = true }
                        DropdownMenu(flagMenu, { flagMenu = false }, shape = RoundedCornerShape(16.dp), containerColor = ur.surface) {
                            DropdownMenuItem(text = { Text("No flag") }, leadingIcon = { Icon(Icons.Outlined.OutlinedFlag, null) }, onClick = { flag = ""; flagMenu = false })
                            flags.forEach { (id, name) -> DropdownMenuItem(text = { Text(name) }, leadingIcon = { FlagDot(id, size = 14.dp) }, onClick = { flag = id; flagMenu = false }) }
                        }
                    }
                    if (!approved) Hairline(start = 52.dp)
                    if (!approved) Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.NewReleases, null, Modifier.size(22.dp), tint = ur.accent)
                        Text("Imported, not yet approved", Modifier.weight(1f).padding(start = 14.dp), color = ur.text, style = MaterialTheme.typography.bodyLarge)
                        TextButton({ approved = true }) { Text("Approve", color = ur.accent, fontWeight = FontWeight.Bold) }
                    }
                    if (!splitMode && needsCategory) {
                        Hairline(start = 52.dp)
                        FormRow(Icons.AutoMirrored.Outlined.CallSplit, "Split", null, "Split between categories", onClick = {
                            splitMode = true
                            if (splitRows.size < 2) {
                                val total = pad.cents ?: 0L
                                splitRows = listOf(SplitDraft(JSONObject(), category, amountText(total), ""), SplitDraft(JSONObject(), "", amountText(0), ""))
                            }
                        })
                    }
                }
                FormError(error)
                if (original != null && saveOverride == null) TextButton({ confirmDelete = true }, Modifier.align(Alignment.CenterHorizontally)) {
                    Icon(Icons.Outlined.DeleteOutline, null, tint = ur.negative); Spacer(Modifier.width(6.dp)); Text("Delete transaction", color = ur.negative, fontWeight = FontWeight.SemiBold)
                }
                Spacer(Modifier.height(24.dp))
            }
            AnimatedVisibility(keypad, enter = slideInVertically { it } + fadeIn(), exit = slideOutVertically { it } + fadeOut()) {
                AmountKeypad(pad, { keypad = false; if (original == null && payee.isBlank() && transfer.isBlank()) picker = "payee" })
            }
        }
    }
    when (picker) {
        "payee" -> PayeePickerSheet(budget, payees, account, payee, transfer, onPayee = { name ->
            payee = name; transfer = ""
            // The payee's usual category fills in when none is chosen yet; its usual "none" is Unassigned only for income.
            val usual = payees.firstOrNull { it.name == name }?.category
            when {
                usual == null || splitMode || category.isNotBlank() -> Unit
                usual == "__rta" || usual.isEmpty() -> if (direction == "in") category = Unassigned
                else -> category = usual
            }
            picker = if (category.isBlank() && !splitMode) "category" else null
        }, onTransfer = { id -> transfer = id; picker = null }) { picker = null }
        "category" -> CategoryPickerSheet(budget, summary, date.take(7), category, "Category", includeUnassigned = true, includeUncategorized = true, includePayment = false,
            top = {
                Row(Modifier.fillMaxWidth().clickable { picker = null; splitMode = true
                    if (splitRows.size < 2) { val total = pad.cents ?: 0L; splitRows = listOf(SplitDraft(JSONObject(), category, amountText(total), ""), SplitDraft(JSONObject(), "", amountText(0), "")) }
                }.padding(horizontal = 20.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.AutoMirrored.Outlined.CallSplit, null, tint = ur.accent); Text("Split between categories", Modifier.padding(start = 12.dp), color = ur.accent, fontWeight = FontWeight.SemiBold)
                }
            }, onPick = { category = it; picker = null }) { picker = null }
        "account" -> AccountPickerSheet(budget, summary, account, { account = it; if (transfer == it) transfer = ""; picker = null }) { picker = null }
    }
    splitPicker?.let { index ->
        CategoryPickerSheet(budget, summary, date.take(7), splitRows.getOrNull(index)?.category.orEmpty(), "Split category", includeUnassigned = true, includeUncategorized = true, includePayment = false,
            onPick = { value -> splitRows = splitRows.mapIndexed { i, row -> if (i == index) row.copy(category = value) else row }; splitPicker = null }) { splitPicker = null }
    }
    if (confirmDelete) AlertDialog(onDismissRequest = { confirmDelete = false }, title = { Text("Delete transaction?") }, text = { Text("Both sides of a transfer will be removed. You can undo the change.") },
        containerColor = ur.surface,
        confirmButton = { TextButton({ withCurrentBudget(openedBudget, vm) { vm.deleteTransaction(original!!.text("id")); close() } }) { Text("Delete", color = ur.negative) } }, dismissButton = { TextButton({ confirmDelete = false }) { Text("Cancel") } })
}

/** Cleared as a switch, or locked once reconciled. */
@Composable
private fun ClearedRow(label: String, status: String, set: (String) -> Unit) {
    if (status == "reconciled") FormRow(Icons.Outlined.Lock, label.replaceFirst("Cleared", "Reconciled"), "Locked by reconciliation", "", onClick = null)
    else Row(Modifier.fillMaxWidth().clickable(role = Role.Switch) { set(if (status == "cleared") "uncleared" else "cleared") }.padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically) {
        ClearedMark(status, Modifier.size(22.dp))
        Text(label, Modifier.weight(1f).padding(start = 14.dp), style = MaterialTheme.typography.bodyLarge, color = ur.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Switch(status == "cleared", { set(if (it) "cleared" else "uncleared") }, colors = SwitchDefaults.colors(checkedTrackColor = ur.positive, uncheckedTrackColor = ur.zeroSoft, uncheckedBorderColor = ur.zeroSoft, uncheckedThumbColor = Color.White))
    }
}

/** A row of the transaction form: an icon, the field's value (or what to choose), a chevron. */
@Composable
private fun FormRow(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, value: String?, placeholder: String, divider: Boolean = false,
                    attention: Boolean = false, leading: (@Composable () -> Unit)? = null, onClick: (() -> Unit)?) {
    Column {
        Row(Modifier.fillMaxWidth().then(if (onClick != null) Modifier.clickable(onClickLabel = "Choose $label", onClick = onClick) else Modifier)
            .heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, Modifier.size(22.dp), tint = if (attention) ur.warning else ur.muted)
            Column(Modifier.weight(1f).padding(start = 14.dp)) {
                if (value != null) Text(label, style = MaterialTheme.typography.bodySmall, color = ur.muted)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    leading?.let { it(); Spacer(Modifier.width(8.dp)) }
                    Text(value ?: placeholder, style = MaterialTheme.typography.bodyLarge, fontWeight = if (value != null) FontWeight.Medium else FontWeight.Normal,
                        color = if (value != null) ur.text else if (attention) ur.warning else ur.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            if (onClick != null) Icon(Icons.Outlined.ChevronRight, null, Modifier.size(20.dp), tint = ur.muted)
        }
        if (divider) Hairline(start = 52.dp)
    }
}

@Composable
private fun SplitCard(rows: List<SplitDraft>, update: (List<SplitDraft>) -> Unit, total: Long, currency: String, categoryName: (String) -> String?,
                      pickCategory: (Int) -> Unit, unsplit: () -> Unit) {
    val assigned = rows.sumOf { runCatching { amountValue(it.amount) }.getOrDefault(0L) }
    val left = total - assigned
    ListCard {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 6.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Split", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, color = ur.text)
            Text(when { left == 0L -> "Fully split"; (total < 0) == (left < 0) -> "${money(abs(left), currency)} left to split"; else -> "${money(abs(left), currency)} over the total" },
                color = if (left == 0L) ur.positive else ur.warning, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium)
            if (rows.size <= 1) TextButton(unsplit) { Text("Undo split") }
        }
        Text("Each line is its share of the total.", Modifier.padding(horizontal = 16.dp), color = ur.muted, style = MaterialTheme.typography.bodySmall)
        rows.forEachIndexed { index, part ->
            CompositionLocalProvider(LocalFieldFill provides ur.surface) {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp).clip(RoundedCornerShape(14.dp)).background(ur.surface2).padding(10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Row(Modifier.weight(1f).clip(RoundedCornerShape(10.dp)).clickable { pickCategory(index) }.padding(vertical = 6.dp, horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(if (part.transfer.isNotBlank()) "Transfer" else categoryName(part.category) ?: "Choose category", Modifier.weight(1f),
                            color = if (part.category.isBlank() && part.transfer.isBlank()) ur.warning else ur.text, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp), tint = ur.muted)
                    }
                    IconButton({ update(rows.filterIndexed { i, _ -> i != index }) }, Modifier.size(36.dp)) { Icon(Icons.Outlined.Close, "Remove split line ${index + 1}", Modifier.size(18.dp), tint = ur.muted) }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.weight(1f)) { Field(part.amount, { value -> update(rows.mapIndexed { i, row -> if (i == index) row.copy(amount = value) else row }) }, "Amount", true) }
                    Box(Modifier.weight(1.3f)) { Field(part.memo, { value -> update(rows.mapIndexed { i, row -> if (i == index) row.copy(memo = value) else row }) }, "Memo") }
                }
                if (left != 0L && runCatching { amountValue(part.amount) }.getOrDefault(0L) == 0L) TextButton({ update(rows.mapIndexed { i, row -> if (i == index) row.copy(amount = amountText(left)) else row }) }) {
                    Text("Use the ${money(abs(left), currency)} left", color = ur.accent)
                }
            }
            }
        }
        TextButton({ update(rows + SplitDraft(JSONObject(), "", amountText(0), "")) }, Modifier.padding(horizontal = 6.dp, vertical = 2.dp)) {
            Icon(Icons.Outlined.Add, null, tint = ur.accent); Spacer(Modifier.width(6.dp)); Text("Add line", color = ur.accent, fontWeight = FontWeight.SemiBold)
        }
    }
}

/** Payees: type to search or name a new one; transfers to the other accounts come first, as YNAB lists them. */
@Composable
private fun PayeePickerSheet(budget: JSONObject, payees: List<PayeeInfo>, account: String, payee: String, transfer: String, onPayee: (String) -> Unit, onTransfer: (String) -> Unit, onDismiss: () -> Unit) {
    var search by remember { mutableStateOf(payee) }
    // Most used first, as the desktop suggests them.
    val names = remember(payees) { payees.map { it.name } }
    val matches = remember(names, search) { if (search.isBlank()) names else names.filter { it.contains(search.trim(), true) } }
    val transfers = remember(budget, account, search) { budget.rows("accounts").filter { !it.optBoolean("archived") && it.text("id") != account && (search.isBlank() || it.text("name").contains(search, true)) } }
    val height = screenHeight()
    UrSheet(onDismiss) {
        SheetHeader("Payee", onDismiss, null, null)
        SearchField(search, { search = it }, "Search or add a payee", Modifier.padding(horizontal = Gutter))
        LazyColumn(Modifier.fillMaxWidth().height(height * .62f), contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp)) {
            if (search.isNotBlank() && matches.none { it.equals(search.trim(), true) }) item {
                Row(Modifier.fillMaxWidth().clickable { onPayee(search.trim()) }.padding(horizontal = 20.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.Add, null, tint = ur.accent)
                    Text("Add “${search.trim()}”", Modifier.padding(start = 12.dp), color = ur.accent, fontWeight = FontWeight.SemiBold)
                }
            }
            if (transfers.isNotEmpty()) {
                item { Text("TRANSFER TO OR FROM", Modifier.fillMaxWidth().background(ur.surface2).padding(horizontal = 20.dp, vertical = 8.dp), style = MaterialTheme.typography.labelSmall, color = ur.muted, letterSpacing = .6.sp) }
                items(transfers, key = { "t:${it.text("id")}" }) { other ->
                    Row(Modifier.fillMaxWidth().clickable { onTransfer(other.text("id")) }.padding(horizontal = 20.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.SwapHoriz, null, tint = ur.accent)
                        Text(other.text("name"), Modifier.weight(1f).padding(start = 12.dp), color = ur.text, fontWeight = if (transfer == other.text("id")) FontWeight.Bold else FontWeight.Normal)
                        if (transfer == other.text("id")) Icon(Icons.Outlined.Check, null, tint = ur.accent)
                    }
                }
            }
            if (matches.isNotEmpty()) item { Text("PAYEES", Modifier.fillMaxWidth().background(ur.surface2).padding(horizontal = 20.dp, vertical = 8.dp), style = MaterialTheme.typography.labelSmall, color = ur.muted, letterSpacing = .6.sp) }
            items(matches, key = { "p:$it" }) { name ->
                Row(Modifier.fillMaxWidth().clickable { onPayee(name) }.padding(horizontal = 20.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(name, Modifier.weight(1f), color = ur.text, fontWeight = if (name == payee && transfer.isBlank()) FontWeight.Bold else FontWeight.Normal)
                    if (name == payee && transfer.isBlank()) Icon(Icons.Outlined.Check, null, tint = ur.accent)
                }
            }
        }
    }
}

@Composable
private fun AccountPickerSheet(budget: JSONObject, summary: JSONObject?, selected: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    val currency = budget.text("currency")
    val balances = remember(summary) { summary?.rows("accounts")?.associate { it.text("id") to it.optLong("balance") }.orEmpty() }
    UrSheet(onDismiss) {
        SheetHeader("Account", onDismiss, null, null)
        Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = Gutter).padding(bottom = 24.dp)) {
            ListCard {
                val accounts = budget.rows("accounts").filter { !it.optBoolean("archived") || it.text("id") == selected }
                accounts.forEachIndexed { index, account ->
                    val id = account.text("id")
                    ListRow(account.text("name"), subtitle = accountTypeLabel(account), value = money(balances[id] ?: 0, currency),
                        valueColor = if ((balances[id] ?: 0) < 0) ur.negative else ur.text, icon = accountIcon(account), onClick = { onPick(id) }, chevron = false,
                        trailing = if (id == selected) ({ Icon(Icons.Outlined.Check, null, tint = ur.accent) }) else null, divider = index < accounts.lastIndex)
                }
            }
        }
    }
}

internal val statuses = listOf("uncleared" to "Uncleared", "cleared" to "Cleared", "reconciled" to "Reconciled")

@Composable
private fun BulkTransactionDialog(ids: Set<String>, account: String, budget: JSONObject, vm: BudgetViewModel, initial: String, close: () -> Unit, done: () -> Unit) {
    val openedBudget = remember { budget }
    var operation by remember { mutableStateOf(initial) }
    var value by remember { mutableStateOf("") }
    var confirmDelete by remember { mutableStateOf(false) }
    FormDialog("Edit ${ids.size} transactions", close, confirm = if (operation == "delete") "Delete" else "Apply", enabled = operation != "delete" || confirmDelete, onConfirm = {
        withCurrentBudget(openedBudget, vm) { vm.runCommand("workflow", bulkAction(ids, operation, value, account)); done() }
    }) {
        Choice("Change", operation, listOf("payee" to "Payee", "memo" to "Memo", "status" to "Cleared status", "duplicate" to "Duplicate", "approve" to "Approve", "delete" to "Delete"),
            { operation = it; value = if (it == "status") "uncleared" else "" })
        when (operation) {
            "status" -> Choice("Status", value, statuses.filter { it.first != "reconciled" }, { value = it })
            "payee", "memo" -> Field(value, { value = it }, if (operation == "payee") "Payee" else "Memo")
            "duplicate" -> Text("Makes a copy of each selected transaction.", color = ur.muted, style = MaterialTheme.typography.bodySmall)
            "delete" -> CheckRow("Delete the selected transactions and both transfer sides", confirmDelete, { confirmDelete = it })
        }
    }
}
