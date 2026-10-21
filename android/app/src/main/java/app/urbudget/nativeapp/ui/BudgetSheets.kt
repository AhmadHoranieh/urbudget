package app.urbudget.nativeapp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.urbudget.nativeapp.BudgetViewModel
import app.urbudget.nativeapp.CategoryStatuses
import app.urbudget.nativeapp.Money
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.util.Locale

private val DayMonth = DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH)
private fun shortDay(iso: String?) = iso?.take(10)?.let { runCatching { LocalDate.parse(it).format(DayMonth) }.getOrNull() }

/** One line of a category's moves in a month (desktop/src/moves.ts). */
internal data class MoveLine(val key: String, val at: String?, val what: String, val detail: String?, val amount: Long)

/**
 * A category's moves in a month, oldest first, each named by where the money came from or went.
 * When they don't add up to the month's Assigned, a first line makes up the difference.
 */
internal fun categoryMoves(budget: JSONObject, categoryId: String, month: String, assigned: Long): List<MoveLine> {
    val names = budget.rows("categories").associate { it.text("id") to it.text("name") }
    val lines = ArrayList<MoveLine>()
    budget.rows("moneyMoves").forEachIndexed { i, m ->
        if (m.text("month") != month) return@forEachIndexed
        val changes = m.rows("changes")
        val amount = changes.firstOrNull { it.text("categoryId") == categoryId }?.optLong("amount") ?: 0
        if (amount == 0L) return@forEachIndexed
        val other = changes.firstOrNull { it.text("categoryId") != categoryId }
        val what = when (m.text("kind")) {
            "quickAssign" -> m.text("detail").ifBlank { null }?.let { "Quick assign: $it" } ?: "Quick assign"
            "merge" -> "Merged from ${m.text("detail").ifBlank { "a deleted category" }}"
            "move" -> if (other != null) { val name = names[other.text("categoryId")] ?: "a deleted category"; if (amount > 0) "Moved from $name" else "Moved to $name" }
                else if (amount > 0) "Assigned" else "Returned to Unassigned"
            "assign" -> if (amount > 0) "Assigned" else "Returned to Unassigned"
            else -> m.text("description")
        }
        lines.add(MoveLine("$i", m.text("at"), what, null, amount))
    }
    val recorded = lines.sumOf { it.amount }
    if (lines.isNotEmpty() && recorded != assigned) lines.add(0, MoveLine("earlier", null, "Earlier changes", "Not itemised", assigned - recorded))
    return lines
}

/** A target's kind, as the desktop's inspector names it. */
private fun targetLabel(category: JSONObject): String {
    val goal = category.optJSONObject("goal") ?: return "Set aside"
    return when (goal.text("goal_type")) {
        "NEED" -> if (goal.optBoolean("goal_needs_whole_amount", true)) "Set aside" else "Refill up to"
        "TB", "TBD" -> "Balance target"
        "DEBT" -> "Loan payment target"
        "MF" -> "Monthly funding"
        else -> "Set aside"
    }
}

private fun cadenceLabel(goal: JSONObject?): String? {
    if (goal == null || goal.text("goal_type") != "NEED") return goal?.takeIf { it.text("goal_type") == "TBD" }?.let { "by ${Money.date(it.text("goal_target_date"))}" }
    val every = goal.optInt("goal_cadence_frequency", 1)
    return when (val cadence = goal.optInt("goal_cadence", 1)) {
        0 -> "once, by ${Money.date(goal.text("goal_target_date"))}"
        1 -> if (every > 1) "every $every months" else "each month"
        2 -> if (every > 1) "every $every weeks" else "each week"
        13 -> if (every > 1) "every $every years" else "each year"
        14 -> "every two years"
        else -> "every ${cadence - 1} months"
    }
}

/**
 * A category's details, as a sheet: what's available and why, Assigned edited on the keypad (with
 * YNAB's per-category shortcuts), this month's moves, the note, and the category's other editors
 * a step further in. A card payment category says what's set aside and offers to make a payment.
 */
@Composable
internal fun CategorySheet(category: JSONObject, budget: JSONObject, total: JSONObject?, summary: JSONObject?, month: String, vm: BudgetViewModel,
                           startAssigning: Boolean, close: () -> Unit, move: (String) -> Unit, transactions: (RegisterTarget) -> Unit, payCard: (String) -> Unit) {
    val currency = budget.text("currency")
    val id = category.text("id")
    val toast = LocalToast.current
    val state = remember(category, total, month) { CategoryStatuses.of(category, total, month) }
    val words = remember(category, total, state) { CategoryStatuses.targetWords(category, total, state, budget.text("dateFormat") == "mdy") }
    var page by remember { mutableStateOf("main") }
    var editingAssigned by remember { mutableStateOf(startAssigning) }
    var noting by remember { mutableStateOf(false) }
    val assigned = total?.optLong("assigned") ?: 0
    val available = total?.optLong("available") ?: 0
    // Keyed on the category, so a sync arriving while typing doesn't wipe the keypad.
    val pad = rememberPad(assigned, id)
    var error by remember { mutableStateOf<String?>(null) }
    val paymentAccount = category.text("paymentAccountId")
    val payment = paymentAccount.isNotBlank()
    val moves = remember(budget, id, month, assigned) { categoryMoves(budget, id, month, assigned) }
    // What the per-category Quick assign options would set Assigned to, worked out while the keypad is open.
    val suggestions = remember(id, month) { mutableStateMapOf<String, Long>() }
    val jobs = rememberPreviewJobs(id, month, editingAssigned)
    LaunchedEffect(editingAssigned, budget, month) {
        if (!editingAssigned) return@LaunchedEffect
        listOf("assignedLastMonth", "spentLastMonth", "averageAssigned", "averageSpent").forEach { mode ->
            jobs.track(vm.query("workflow", quickAssignParams(budget, month, mode, listOf(id), limit = false).put("previewMonth", month), onError = {}) { result ->
                result.optJSONObject("summary")?.rows("categories")?.firstOrNull { it.text("id") == id }?.optLong("assigned")?.let { suggestions[mode] = it }
            })
        }
    }
    if (page != "main") {
        CategoryEditor(page, category, budget, total, month, vm, back = { page = "main"; error = null }, close = close)
        return
    }
    UrSheet(close) {
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(bottom = if (editingAssigned) 0.dp else 20.dp)) {
            Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(category.text("name"), style = MaterialTheme.typography.headlineSmall, color = ur.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(if (category.optBoolean("hidden")) "${category.text("group")} · Hidden" else category.text("group"), style = MaterialTheme.typography.bodyMedium, color = ur.muted)
                }
                CategoryMenu(payment, category.optBoolean("hidden"), { action ->
                    if (action == "hide" || action == "show") withCurrentBudget(budget, vm) {
                        vm.upsert("categories", category.copyJson().put("hidden", action == "hide"))
                        toast(if (action == "hide") "Hid ${category.text("name")}. Find it under Hidden categories." else "${category.text("name")} is shown again.", true)
                        close()
                    } else page = action
                })
                IconButton(close) { Icon(Icons.Outlined.Close, "Close", tint = ur.muted) }
            }
            val colors = statusColors(state.status)
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(money(available, currency), color = if (state.status == "zero") ur.text else colors.ink, fontSize = 36.sp, fontWeight = FontWeight.ExtraBold, style = Tabular)
                Text(when {
                    state.status == "negative" -> "Overspent"
                    state.status == "credit" -> "Overspent on a card"
                    payment -> "Set aside for the card"
                    else -> "Available"
                }, color = ur.muted, style = MaterialTheme.typography.bodyMedium)
                if (words != null) Text(if (words.amount == null) words.words else "${money(words.amount, currency)} ${words.words}",
                    Modifier.padding(top = 6.dp), fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium,
                    color = when { state.status == "underfunded" -> ur.warning; state.eventually > 0 -> ur.muted; else -> ur.positive })
                if (state.progress != null && !state.snoozed) TargetBar(state.progress, state.status, Modifier.padding(top = 10.dp).fillMaxWidth(.7f))
            }
            ListCard(Modifier.padding(horizontal = Gutter)) {
                ListRow("Carried from last month", value = money(total?.optLong("carried") ?: 0, currency), divider = true)
                Column(Modifier.fillMaxWidth().background(if (editingAssigned) ur.accentSoft else Color.Transparent)) {
                    ListRow("Assigned in ${shortMonthLabel(month)}", onClick = { editingAssigned = true; pad.set(assigned) }, chevron = false,
                        trailing = {
                            if (editingAssigned) Text(if (pad.isSum) pad.display() else money(pad.cents ?: 0, currency), color = ur.accent, fontSize = 20.sp, fontWeight = FontWeight.ExtraBold, style = Tabular)
                            else Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(money(assigned, currency), style = MaterialTheme.typography.bodyLarge.merge(Tabular), fontWeight = FontWeight.SemiBold, color = ur.accent)
                                Icon(Icons.Outlined.Edit, null, Modifier.padding(start = 6.dp).size(16.dp), tint = ur.accent)
                            }
                        }, divider = true)
                }
                // A card payment's activity is the card's own register for the month.
                val (from, through) = monthBounds(month)
                ListRow("Activity", value = money(total?.optLong("activity") ?: 0, currency),
                    onClick = { transactions(if (payment) RegisterTarget(account = paymentAccount, from = from, through = through) else RegisterTarget(category = id, from = from, through = through)) },
                    divider = (total?.optLong("upcoming") ?: 0) > 0 || category.optLong("target") > 0)
                if ((total?.optLong("upcoming") ?: 0) > 0) ListRow("Upcoming", subtitle = "Scheduled this month", value = money(total!!.optLong("upcoming"), currency), divider = category.optLong("target") > 0)
                if (category.optLong("target") > 0) ListRow("Target", subtitle = listOfNotNull(targetLabel(category), cadenceLabel(category.optJSONObject("goal"))).joinToString(" "),
                    value = money(category.optLong("target"), currency), onClick = { page = "target" })
            }
            error?.let { Box(Modifier.padding(horizontal = Gutter, vertical = 8.dp)) { FormError(it) } }
            if (!editingAssigned) {
                if (payment) PrimaryButton("Make a payment", { payCard(paymentAccount) }, Modifier.fillMaxWidth().padding(horizontal = Gutter).padding(top = 14.dp), icon = Icons.Outlined.CreditCard)
                Row(Modifier.fillMaxWidth().padding(horizontal = Gutter, vertical = 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    SecondaryButton(if (available < 0) "Cover" else "Move money", { move(if (available < 0) "from" else "to") }, Modifier.weight(1f), icon = Icons.Outlined.SwapHoriz)
                    SecondaryButton(if (category.optLong("target") > 0 || category.optJSONObject("goal") != null) "Edit target" else "Create target", { page = "target" },
                        Modifier.weight(1f), icon = Icons.Outlined.TrackChanges)
                }
                ListCard(Modifier.padding(horizontal = Gutter)) {
                    ListRow(if (category.text("note").isBlank()) "Add a note" else "Note", subtitle = category.text("note").ifBlank { null },
                        icon = Icons.AutoMirrored.Outlined.Notes, iconTint = ur.text2, iconFill = ur.zeroSoft,
                        titleColor = if (category.text("note").isBlank()) ur.accent else ur.text, onClick = { noting = true })
                }
                if (moves.isNotEmpty()) {
                    Text("Moves this month", Modifier.padding(start = Gutter + 4.dp, top = 16.dp, bottom = 6.dp), style = MaterialTheme.typography.titleSmall, color = ur.text)
                    ListCard(Modifier.padding(horizontal = Gutter)) {
                        val shownMoves = moves.takeLast(5)
                        shownMoves.forEachIndexed { index, line ->
                            ListRow(line.what, subtitle = line.detail ?: shortDay(line.at), value = (if (line.amount > 0) "+" else "") + money(line.amount, currency),
                                valueColor = if (line.amount < 0) ur.negative else ur.text, divider = index < shownMoves.lastIndex || moves.size > 5)
                        }
                        if (moves.size > 5) ListRow("Show all ${moves.size}", titleColor = ur.accent, onClick = { page = "history" })
                    }
                }
            } else {
                Row(Modifier.fillMaxWidth().horizontalScrollRow().padding(horizontal = Gutter, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    if (state.needed > 0 && !payment) FilterPill("Needed +${money(state.needed, currency)}", false, { pad.set(assigned + state.needed) })
                    if (available < 0) FilterPill("Cover +${money(-available, currency)}", false, { pad.set(assigned - available) })
                    listOf("assignedLastMonth" to "Last month", "spentLastMonth" to "Spent last month", "averageAssigned" to "Avg assigned", "averageSpent" to "Avg spent").forEach { (mode, label) ->
                        suggestions[mode]?.takeIf { it != assigned }?.let { value -> FilterPill("$label ${money(value, currency)}", false, { pad.set(value) }) }
                    }
                    TextButton({ editingAssigned = false; error = null }) { Text("Cancel", color = ur.muted) }
                }
            }
        }
        if (editingAssigned) AmountKeypad(pad, onDone = {
            val cents = pad.cents
            if (cents == null) { error = "Finish the sum before saving."; return@AmountKeypad }
            // The sheet stays open on the new figures, as the desktop's inspector does.
            withCurrentBudget(budget, vm) {
                vm.runCommand("workflow", JSONObject().put("action", JSONObject().put("type", "assignAmount").put("month", month).put("categoryId", id).put("amount", cents)))
                editingAssigned = false
                error = null
            }
        }, doneLabel = "Assign")
    }
    if (noting) NoteDialog(category, budget, vm) { noting = false }
}

/** A row that scrolls sideways when its chips don't fit. */
@Composable
private fun Modifier.horizontalScrollRow() = this.then(Modifier.horizontalScroll(rememberScrollState()))

/** The first and last day of a month, for limiting the register to it. */
internal fun monthBounds(month: String): Pair<String, String> = runCatching {
    val ym = YearMonth.parse(month); ym.atDay(1).toString() to ym.atEndOfMonth().toString()
}.getOrDefault("" to "")

@Composable
private fun CategoryMenu(payment: Boolean, hidden: Boolean, open: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        IconButton({ expanded = true }) { Icon(Icons.Outlined.MoreHoriz, "Category actions", tint = ur.text2) }
        DropdownMenu(expanded, { expanded = false }, shape = RoundedCornerShape(16.dp), containerColor = ur.surface) {
            val items = buildList {
                if (!payment) add(Triple("details", "Name, group & note", Icons.Outlined.Edit))
                add(Triple("organize", "Move or reorder", Icons.Outlined.SwapVert))
                if (!payment) add(Triple("renameGroup", "Rename or merge group", Icons.Outlined.DriveFileRenameOutline))
                add(Triple("history", "Money moves this month", Icons.Outlined.History))
                add(if (hidden) Triple("show", "Show category", Icons.Outlined.Visibility) else Triple("hide", "Hide category", Icons.Outlined.VisibilityOff))
            }
            items.forEach { (id, label, icon) -> DropdownMenuItem(text = { Text(label) }, leadingIcon = { Icon(icon, null) }, onClick = { open(id); expanded = false }) }
            if (!payment) {
                HorizontalDivider(color = ur.border)
                DropdownMenuItem(text = { Text("Delete category", color = ur.negative) }, leadingIcon = { Icon(Icons.Outlined.DeleteOutline, null, tint = ur.negative) },
                    onClick = { open("delete"); expanded = false })
            }
        }
    }
}

@Composable
private fun NoteDialog(category: JSONObject, budget: JSONObject, vm: BudgetViewModel, close: () -> Unit) {
    var note by remember { mutableStateOf(category.text("note")) }
    FormDialog("Note", close, onConfirm = { withCurrentBudget(budget, vm) { vm.upsert("categories", category.copyJson().put("note", note)) }; close() }) {
        Field(note, { note = it }, category.text("name"), lines = 6)
    }
}

/** The target kinds the desktop offers, in its words. Imported kinds stay available only to targets that already use them. */
private val targetBehaviours = listOf(
    Triple("set", "Set aside each period", "Assign the whole amount every period, whatever is left over."),
    Triple("refill", "Refill up to each period", "Top up to the amount; money carried forward counts."),
    Triple("TB", "Maintain a category balance", "Keep at least this much available."),
    Triple("TBD", "Reach a balance by a date", "Save up to the amount by a chosen date."),
)

/** The category's editors a step in from its details: target, name and note, order, group, history, delete. */
@Composable
private fun CategoryEditor(section: String, category: JSONObject, budget: JSONObject, total: JSONObject?, month: String, vm: BudgetViewModel,
                           back: () -> Unit, close: () -> Unit) {
    if (section == "target") { TargetEditor(category, budget, month, vm, back, close); return }
    val openedBudget = remember { budget }
    val toast = LocalToast.current
    val currency = budget.text("currency")
    val categories = remember(budget, category) { budget.rows("categories").filter { it.text("id") != category.text("id") } }
    val replacements = remember(categories) { listOf(Unassigned to "Unassigned") + categories.filter { it.text("paymentAccountId").isBlank() }.map { it.text("id") to it.text("name") } }
    val groups = remember(budget) { groupNames(budget) }
    var note by remember { mutableStateOf(category.text("note")) }
    var name by remember { mutableStateOf(category.text("name")) }
    var group by remember { mutableStateOf(category.text("group")) }
    var hidden by remember { mutableStateOf(category.optBoolean("hidden")) }
    var before by remember { mutableStateOf("") }
    var groupBefore by remember { mutableStateOf("__keep") }
    var renameGroup by remember { mutableStateOf(category.text("group")) }
    var replacement by remember { mutableStateOf(Unassigned) }
    var deleteConfirmed by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Whether anything refers to the category: an unused one is deleted without choosing where its history goes.
    val used = remember(budget, category) {
        val id = category.text("id")
        budget.rows("assignments").any { it.text("categoryId") == id && it.optLong("amount") != 0L } ||
            budget.rows("transactions").any { t -> t.rows("splits").any { it.text("categoryId") == id } }
    }
    val moves = remember(budget, category, month, total) { categoryMoves(budget, category.text("id"), month, total?.optLong("assigned") ?: 0) }
    val save: (() -> Unit)? = if (section == "history") null else ({
        runCatching {
            requireCurrentBudget(openedBudget, vm)
            when (section) {
                "organize" -> vm.runCommand("workflow", JSONObject().put("action", JSONObject().put("type", "organizeCategory").put("id", category.text("id")).put("group", group).put("beforeId", before.ifBlank { null } ?: JSONObject.NULL).also { if (groupBefore != "__keep") it.put("groupBefore", groupBefore.ifBlank { null } ?: JSONObject.NULL) }))
                "renameGroup" -> {
                    require(renameGroup.isNotBlank()) { "Enter a group name." }
                    vm.runCommand("workflow", JSONObject().put("action", JSONObject().put("type", "renameGroup").put("from", category.text("group")).put("to", renameGroup.trim())))
                    if (renameGroup.trim() in groups && renameGroup.trim() != category.text("group")) toast("Merged ${category.text("group")} into ${renameGroup.trim()}.", true)
                }
                "delete" -> {
                    require(!used || deleteConfirmed) { "Confirm the category deletion." }
                    vm.runCommand("workflow", JSONObject().put("action", JSONObject().put("type", "deleteCategory").put("id", category.text("id")).put("replacement", if (used) replacement else Unassigned)))
                    toast("Deleted ${category.text("name")}.", true)
                }
                "details" -> { require(name.isNotBlank() && group.isNotBlank()) { "Enter a name and group." }; vm.upsert("categories", category.copyJson().put("name", name.trim()).put("group", group.trim()).put("note", note).put("hidden", hidden)) }
            }
        }.onSuccess { close() }.onFailure { error = it.message }
    })
    val title = when (section) { "details" -> "Name, group & note"; "organize" -> "Move or reorder"; "renameGroup" -> "Rename group"; "history" -> "Money moves"; else -> "Delete category" }
    UrSheet(close) {
        SheetHeader(title, close, if (section == "delete") "Delete" else "Save", save, enabled = section != "delete" || !used || deleteConfirmed, onBack = back)
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = screenHeight() * .8f),
            contentPadding = PaddingValues(start = 18.dp, end = 18.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (section == "history") {
                if (moves.isEmpty()) item { Text("No money moved for this category this month.", color = ur.muted) }
                else item {
                    ListCard {
                        moves.forEachIndexed { index, line ->
                            ListRow(line.what, subtitle = line.detail ?: shortDay(line.at), value = (if (line.amount > 0) "+" else "") + money(line.amount, currency),
                                valueColor = if (line.amount < 0) ur.negative else ur.text, divider = index < moves.lastIndex)
                        }
                    }
                }
                item { Text("Moves add up to what's assigned in ${monthLabel(month)}.", color = ur.muted, style = MaterialTheme.typography.bodySmall) }
            } else item {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    when (section) {
                        "details" -> {
                            Field(name, { name = it }, "Name")
                            Choice("Group", group, groups.map { it to it } + if (group !in groups) listOf(group to group) else emptyList(), { group = it })
                            Field(note, { note = it }, "Note", lines = 4)
                            ListCard { SwitchRow("Hidden", hidden, { hidden = it }, subtitle = "Hidden categories keep their money and history") }
                        }
                        "organize" -> {
                            Choice("Group", group, groups.map { it to it }, { group = it; before = "" })
                            Choice("Place before", before, remember(categories, group) { listOf("" to "End of group") + categories.filter { it.text("group") == group }.map { it.text("id") to it.text("name") } }, { before = it })
                            Choice("Place group before", groupBefore, remember(budget, group) { listOf("__keep" to "Keep group position", "" to "End of groups") + groups.filter { it != group }.map { it to it } }, { groupBefore = it })
                        }
                        "renameGroup" -> { Field(renameGroup, { renameGroup = it }, "Group name"); Text("All categories in this group move together. An existing group name merges the groups.", color = ur.muted, style = MaterialTheme.typography.bodySmall) }
                        "delete" -> if (!used) {
                            Text("It has no transactions or assigned money.", color = ur.text2, style = MaterialTheme.typography.bodyMedium)
                        } else {
                            Choice("Move its history into", replacement, replacements, { replacement = it })
                            Text("Transactions, schedules, defaults and loan categories move to the destination. Monthly assignments combine with its assignments; Unassigned takes them back.", color = ur.text2, style = MaterialTheme.typography.bodyMedium)
                            CheckRow("Delete this category and move its history", deleteConfirmed, { deleteConfirmed = it })
                        }
                    }
                    FormError(error)
                }
            }
        }
    }
}

/**
 * Creating or changing a target, as the desktop's editor does: the four behaviours, the amount on
 * the keypad, how often it repeats and from when, and snoozing for this month.
 */
@Composable
private fun TargetEditor(category: JSONObject, budget: JSONObject, month: String, vm: BudgetViewModel, back: () -> Unit, close: () -> Unit) {
    val openedBudget = remember { budget }
    val toast = LocalToast.current
    val currency = budget.text("currency")
    val existing = category.optJSONObject("goal")
    val existingType = existing?.text("goal_type")
    var behaviour by remember { mutableStateOf(when { existing == null -> "set"; existingType == "NEED" -> if (existing.optBoolean("goal_needs_whole_amount", true)) "set" else "refill"; else -> existingType ?: "set" }) }
    val pad = rememberPad(category.optLong("target").takeIf { it > 0 }, category.text("id"))
    var keypad by remember { mutableStateOf(category.optLong("target") <= 0) }
    var due by remember { mutableStateOf(existing?.text("goal_target_date")?.ifBlank { null } ?: "$month-28") }
    var cadence by remember { mutableStateOf((existing?.optInt("goal_cadence", 1) ?: 1).toString()) }
    var interval by remember { mutableStateOf((existing?.optInt("goal_cadence_frequency", 1) ?: 1).toString()) }
    var weekday by remember { mutableStateOf((existing?.optInt("goal_day", 0) ?: 0).coerceIn(0, 6).toString()) }
    var start by remember { mutableStateOf(existing?.text("goal_creation_month")?.take(7)?.ifBlank { null } ?: month) }
    var snoozed by remember { mutableStateOf(existing?.text("goal_snoozed_at")?.startsWith(month) ?: false) }
    var error by remember { mutableStateOf<String?>(null) }
    val need = behaviour == "set" || behaviour == "refill"
    val payment = category.text("paymentAccountId").isNotBlank()
    val options = targetBehaviours + listOfNotNull(
        if (existingType == "MF") Triple("MF", "Monthly funding", "An imported target: fund this amount each month.") else null,
        if (existingType == "DEBT") Triple("DEBT", "Monthly debt payment", "An imported target for a loan payment.") else null,
    )
    val save = {
        runCatching {
            requireCurrentBudget(openedBudget, vm)
            val amount = pad.cents ?: error("Finish the sum first.")
            require(amount > 0) { "Enter a target amount, or remove the target." }
            val type = if (need) "NEED" else behaviour
            val sameGoal = existingType == type
            val goal = (if (sameGoal) existing!!.copyJson() else JSONObject().put("goal_creation_month", "${YearMonth.now()}-01")).put("goal_type", type)
            goal.put("goal_target", Math.multiplyExact(amount, 10L))
            if (type != "TB") goal.put("goal_creation_month", "${YearMonth.parse(start)}-01")
            if (month == YearMonth.now().toString() && !payment) goal.put("goal_snoozed_at", if (snoozed) "$month-01" else JSONObject.NULL)
            if (type == "NEED") {
                val every = interval.toIntOrNull() ?: 1
                require(every in 1..100) { "Choose an interval from 1 to 100." }
                goal.put("goal_cadence", cadence.toInt()).put("goal_cadence_frequency", every).put("goal_needs_whole_amount", behaviour == "set")
                if (cadence == "2") { goal.put("goal_day", weekday.toInt()); goal.remove("goal_target_date"); goal.remove("goal_target_month") }
                else if (cadence != "1" || every > 1) { LocalDate.parse(due); goal.put("goal_target_date", due); goal.remove("goal_target_month"); goal.remove("goal_day") }
                else { goal.remove("goal_target_date"); goal.remove("goal_target_month"); goal.remove("goal_day") }
            } else if (type == "TBD") { LocalDate.parse(due); goal.put("goal_target_date", due) }
            vm.upsert("categories", category.copyJson().put("target", amount).put("goal", goal))
            toast("Set the ${category.text("name")} target to ${money(amount, currency)}.", true)
        }.onSuccess { close() }.onFailure { error = it.message }
    }
    UrSheet(close) {
        SheetHeader(if (existing != null || category.optLong("target") > 0) "Edit target" else "Create target", close, "Save", { save() }, onBack = back)
        LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false), contentPadding = PaddingValues(start = 18.dp, end = 18.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item(key = "amount") {
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(if (keypad) ur.accentSoft else ur.surface2).clickable { keypad = true; pad.fresh = true }.padding(vertical = 14.dp),
                    horizontalAlignment = Alignment.CenterHorizontally) {
                    PadAmount(pad, currency, color = if (keypad) ur.accent else ur.text)
                    Text(if (behaviour == "TB" || behaviour == "TBD") "Balance to reach" else "Amount each period", color = ur.muted, style = MaterialTheme.typography.bodySmall)
                }
            }
            item(key = "behaviours") {
                ListCard {
                    options.forEachIndexed { index, (id, label, hint) ->
                        Row(Modifier.fillMaxWidth().clickable(role = Role.RadioButton) { behaviour = id }.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(behaviour == id, { behaviour = id }, colors = RadioButtonDefaults.colors(selectedColor = ur.accent))
                            Column(Modifier.weight(1f).padding(start = 4.dp)) {
                                Text(label, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = ur.text)
                                Text(hint, style = MaterialTheme.typography.bodySmall, color = ur.muted)
                            }
                        }
                        if (index < options.lastIndex) Hairline(start = 52.dp)
                    }
                }
            }
            item(key = "cadence") {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (need) {
                        Choice("Repeats", cadence, listOf("0" to "Once by a date", "1" to "Monthly", "2" to "Weekly", "13" to "Yearly") + (3..12).map { it.toString() to "Every ${it - 1} months" } + listOf("14" to "Every two years"),
                            { cadence = it; interval = "1" })
                        if (cadence in listOf("1", "2", "13")) Field(interval, { interval = it }, "Every how many ${when (cadence) { "2" -> "weeks"; "13" -> "years"; else -> "months" }}", true)
                        if (cadence == "2") Choice("Day of week", weekday, listOf("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday").mapIndexed { i, label -> i.toString() to label }, { weekday = it })
                        else if (cadence != "1" || interval != "1") DateField(due, { due = it }, if (cadence == "0") "Needed by" else "First due date")
                    }
                    if (behaviour == "TBD") DateField(due, { due = it }, "Reach it by")
                    if (behaviour != "TB") MonthField(start, { start = it }, "Starts")
                    if (month == YearMonth.now().toString() && !payment && (existing != null || category.optLong("target") > 0)) ListCard { SwitchRow("Snooze this month", snoozed, { snoozed = it }, subtitle = "It asks for nothing until next month") }
                    FormError(error)
                    if (existing != null || category.optLong("target") > 0) TextButton({
                        withCurrentBudget(openedBudget, vm) { vm.saveTarget(category.text("id"), null); toast("Removed the ${category.text("name")} target.", true); close() }
                    }) { Text("Remove target", color = ur.negative) }
                }
            }
        }
        if (keypad) AmountKeypad(pad, { keypad = false })
    }
}

/** A month field: the month, tapping opens the month sheet. */
@Composable
internal fun MonthField(month: String, onChange: (String) -> Unit, label: String) {
    var picking by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(fieldFill()).clickable { picking = true }
        .padding(start = 16.dp, end = 12.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodySmall, color = ur.muted)
            Text(monthLabel(month), style = MaterialTheme.typography.bodyLarge, color = ur.text)
        }
        Icon(Icons.Outlined.CalendarMonth, null, tint = ur.muted)
    }
    if (picking) MonthPickerSheet(month, { onChange(it); picking = false }) { picking = false }
}

/**
 * Moving money, as a sheet: from one category (or Unassigned) to another, the amount on the keypad.
 * Covering overspending opens with the overspent amount, taken from Unassigned when it has money.
 */
@Composable
internal fun MoveMoneySheet(request: MoveRequest, budget: JSONObject, summary: JSONObject?, month: String, vm: BudgetViewModel, close: () -> Unit) {
    val openedBudget = remember { budget }
    val toast = LocalToast.current
    val currency = budget.text("currency")
    val totals = remember(summary) { summary?.rows("categories")?.associateBy { it.text("id") }.orEmpty() }
    val names = remember(budget) { budget.rows("categories").associate { it.text("id") to it.text("name") } }
    fun available(id: String) = if (id == Unassigned) summary?.optLong("readyToAssign") ?: 0 else totals[id]?.optLong("available") ?: 0
    fun name(id: String) = if (id == Unassigned) "Unassigned" else names[id] ?: "Choose a category"
    val start = available(request.category)
    val rta = summary?.optLong("readyToAssign") ?: 0
    var from by remember { mutableStateOf(when { request.direction == "to" -> request.category; start < 0 && rta > 0 && request.category != Unassigned -> Unassigned; else -> "" }) }
    var to by remember { mutableStateOf(if (request.direction == "from") request.category else "") }
    val pad = rememberPad(if (start < 0) -start else maxOf(0, start))
    var keypad by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val title = when {
        request.category == Unassigned && start >= 0 -> "Assign money"
        start < 0 && request.category != Unassigned -> "Cover overspending"
        else -> "Move money"
    }
    UrSheet(close) {
        SheetHeader(title, close, null, null, cancelFirst = true)
        Column(Modifier.padding(horizontal = Gutter).padding(bottom = if (keypad) 8.dp else 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(if (keypad) ur.accentSoft else ur.surface2).clickable { keypad = true; pad.fresh = true }.padding(vertical = 18.dp),
                contentAlignment = Alignment.Center) {
                PadAmount(pad, currency, color = if (keypad) ur.accent else ur.text)
            }
            ListCard(Modifier.border(1.dp, ur.border, RoundedCornerShape(18.dp))) {
                MoveEnd("From", from, ::name, ::available, currency) { picking = "from" }
                Box(Modifier.fillMaxWidth()) {
                    Hairline(Modifier.align(Alignment.Center))
                    Box(Modifier.align(Alignment.Center).size(34.dp).clip(CircleShape).background(ur.surface).border(1.dp, ur.border, CircleShape)
                        .clickable(onClickLabel = "Swap") { val f = from; from = to; to = f }, contentAlignment = Alignment.Center) {
                        Icon(Icons.Outlined.SwapVert, "Swap", Modifier.size(18.dp), tint = ur.accent)
                    }
                }
                MoveEnd("To", to, ::name, ::available, currency) { picking = "to" }
            }
            FormError(error)
            if (!keypad) PrimaryButton(if (from == Unassigned) "Assign" else "Move", {
                runCatching {
                    requireCurrentBudget(openedBudget, vm)
                    require(from.isNotBlank() && to.isNotBlank()) { "Choose where the money comes from and where it goes." }
                    require(from != to) { "Choose two different places." }
                    val amount = pad.cents ?: error("Finish the sum first.")
                    require(amount > 0) { "Enter an amount to move." }
                    vm.runCommand("workflow", JSONObject().put("action", JSONObject().put("type", "moveMoney").put("month", month).put("from", from).put("to", to).put("amount", amount)))
                    toast("Moved ${money(amount, currency)} from ${name(from)} to ${name(to)}.", true)
                }.onSuccess { close() }.onFailure { error = it.message }
            }, Modifier.fillMaxWidth(), icon = Icons.Outlined.SwapHoriz)
        }
        if (keypad) AmountKeypad(pad, { keypad = false })
    }
    picking?.let { end ->
        CategoryPickerSheet(budget, summary, month, if (end == "from") from else to, if (end == "from") "Move from" else "Move to",
            includeUnassigned = true, includePayment = false, onPick = { if (end == "from") from = it else to = it; picking = null }) { picking = null }
    }
}

@Composable
private fun MoveEnd(label: String, id: String, name: (String) -> String, available: (String) -> Long, currency: String, pick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClickLabel = "Choose $label", onClick = pick).heightIn(min = 64.dp).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodySmall, color = ur.muted)
            Text(if (id.isBlank()) "Choose a category" else name(id), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold,
                color = if (id.isBlank()) ur.accent else ur.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (id.isNotBlank()) {
            val amount = available(id)
            AvailablePill(amount, currency, if (amount < 0) "negative" else if (amount > 0) "positive" else "zero")
        }
        Icon(Icons.Outlined.ChevronRight, null, Modifier.padding(start = 6.dp), tint = ur.muted)
    }
}

/** One entry of the category picker, prepared once per budget so typing a search does no JSON work. */
@Immutable
private data class PickerEntry(val id: String, val name: String, val group: String, val available: Long?, val status: String, val search: String)

/**
 * Choosing a category: search, then the groups with each category's available pill, as YNAB's
 * picker shows them. Unassigned and Uncategorized come first when offered. Hidden categories are
 * listed last, as the desktop's picker keeps them.
 */
@Composable
internal fun CategoryPickerSheet(budget: JSONObject, summary: JSONObject?, month: String, selected: String, title: String,
                                 includeUnassigned: Boolean = false, includeUncategorized: Boolean = false, includePayment: Boolean = true,
                                 top: (@Composable () -> Unit)? = null, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    val currency = budget.text("currency")
    var search by remember { mutableStateOf("") }
    val entries by produceState(emptyList<Pair<String, List<PickerEntry>>>(), budget, summary, month, includePayment) {
        value = withContext(Dispatchers.Default) {
            val totals = summary?.rows("categories")?.associateBy { it.text("id") }.orEmpty()
            orderedGroups(budget) { includePayment || it.text("paymentAccountId").isBlank() }.map { (group, categories) ->
                group to categories.map { c ->
                    val id = c.text("id")
                    PickerEntry(id, c.text("name"), group, totals[id]?.optLong("available"), CategoryStatuses.of(c, totals[id], month).status, "${c.text("name")} $group".lowercase())
                }
            }
        }
    }
    val shown = remember(entries, search) {
        val q = search.trim().lowercase()
        if (q.isEmpty()) entries else entries.map { (g, list) -> g to list.filter { q in it.search } }.filter { it.second.isNotEmpty() }
    }
    UrSheet(onDismiss) {
        SheetHeader(title, onDismiss, null, null)
        SearchField(search, { search = it }, "Search categories", Modifier.padding(horizontal = Gutter))
        LazyColumn(Modifier.fillMaxWidth().height(screenHeight() * .66f), contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp)) {
            if (top != null && search.isBlank()) item(key = "top") { top() }
            if (includeUnassigned && search.isBlank()) item(key = "unassigned") {
                PickerRow("Unassigned", "Available to assign", summary?.optLong("readyToAssign"), currency, selected == Unassigned) { onPick(Unassigned) }
            }
            if (includeUncategorized && search.isBlank()) item(key = "uncategorized") { PickerRow("Uncategorized", null, null, currency, selected == "") { onPick("") } }
            shown.forEach { (group, categories) ->
                item(key = "g:$group", contentType = "group") {
                    Text(group.uppercase(), Modifier.fillMaxWidth().background(ur.surface2).padding(horizontal = 20.dp, vertical = 8.dp),
                        style = MaterialTheme.typography.labelSmall, color = ur.muted, letterSpacing = .6.sp)
                }
                items(categories, key = { "c:${it.id}" }, contentType = { "category" }) { entry ->
                    PickerRow(entry.name, null, entry.available, currency, selected == entry.id, status = entry.status) { onPick(entry.id) }
                }
            }
            if (shown.isEmpty() && search.isNotBlank()) item(key = "none") { Text("No categories match “$search”.", Modifier.padding(24.dp), color = ur.muted) }
        }
    }
}

@Composable
private fun PickerRow(name: String, detail: String?, available: Long?, currency: String, chosen: Boolean, status: String? = null, pick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = pick).heightIn(min = 54.dp).padding(horizontal = 20.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(name, style = MaterialTheme.typography.bodyLarge, fontWeight = if (chosen) FontWeight.Bold else FontWeight.Medium, color = ur.text)
            detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = ur.muted) }
        }
        if (chosen) Icon(Icons.Outlined.Check, null, Modifier.padding(end = 8.dp), tint = ur.accent)
        if (available != null) AvailablePill(available, currency, status ?: if (available < 0) "negative" else if (available > 0) "positive" else "zero")
    }
}

/** Quick assign's options, grouped as the desktop groups them. */
internal data class QuickMode(val id: String, val label: String, val group: String, val hint: String)
internal val quickAssignModes = listOf(
    QuickMode("underfunded", "Underfunded", "Fund targets", "Assign what targets still need and cover overspending."),
    QuickMode("assignedLastMonth", "Assigned last month", "Repeat past months", "Assign what each category got last month."),
    QuickMode("spentLastMonth", "Spent last month", "Repeat past months", "Assign what each category spent last month."),
    QuickMode("averageAssigned", "Average assigned", "Repeat past months", "Assign each category's 12-month average assignment."),
    QuickMode("averageSpent", "Average spent", "Repeat past months", "Assign each category's 12-month average spending."),
    QuickMode("reduceOverfunding", "Reduce overfunding", "Clean up", "Return what's beyond each target to Unassigned."),
    QuickMode("resetAvailable", "Reset available amounts", "Clean up", "Bring every Available to 0.00."),
    QuickMode("resetAssigned", "Reset assigned amounts", "Clean up", "Set this month's assignments to 0.00."),
)
private val resets = setOf("resetAvailable", "resetAssigned")

/** The engine request for a Quick assign option over the given (default: every visible) categories. */
internal fun quickAssignParams(budget: JSONObject, month: String, mode: String, categories: List<String>? = null, limit: Boolean = true): JSONObject {
    val reference = YearMonth.now().toString()
    val ids = categories ?: budget.rows("categories").filterNot { it.optBoolean("hidden") }.map { it.text("id") }
    return JSONObject().put("action", JSONObject().put("type", "autoAssign").put("month", month).put("mode", mode).put("categories", JSONArray(ids))
        .put("limitToAvailable", limit).put("expectedAsOfMonth", reference)).put("asOfMonth", reference)
}

/** What an option does, in words, for this month (desktop QuickAssign.tsx explain). */
private fun explain(mode: String, month: String): String {
    val now = runCatching { YearMonth.parse(month).month.getDisplayName(java.time.format.TextStyle.FULL, Locale.ENGLISH) }.getOrDefault(month)
    val last = runCatching { YearMonth.parse(month).minusMonths(1).month.getDisplayName(java.time.format.TextStyle.FULL, Locale.ENGLISH) }.getOrDefault("last month")
    return when (mode) {
        "underfunded" -> "Assigns what each category still needs for its $now target, and covers overspending. It never assigns more than Unassigned holds: overspent categories go first, then the targets due soonest, then credit card payments."
        "assignedLastMonth" -> "Replaces each category's $now assignment with what you assigned to it in $last."
        "spentLastMonth" -> "Replaces each category's $now assignment with what it spent in $last. Categories that spent nothing get 0.00, and credit card payments stay as they are."
        "averageAssigned" -> "Replaces each category's $now assignment with its average monthly assignment over the last 12 months."
        "averageSpent" -> "Replaces each category's $now assignment with its average monthly spending over the last 12 months. Credit card payments stay as they are."
        "reduceOverfunding" -> "Lowers the $now assignment of categories holding more than their target needs, and returns the extra to Unassigned."
        "resetAvailable" -> "Changes each category's $now assignment so its Available becomes 0.00. Money set aside, including what carried over from $last, returns to Unassigned."
        "resetAssigned" -> "Sets each category's $now assignment to 0.00. Carried-over money and spending stay, so each Available drops by what was assigned."
        else -> ""
    }
}

/**
 * Unassigned's sheet: the month in figures, how far this month's targets are funded, targets against
 * expected income, ways to give the money jobs (Quick assign with what each option would do, or one
 * category), and the month's recent changes.
 */
@Composable
internal fun UnassignedSheet(budget: JSONObject, summary: JSONObject, month: String, vm: BudgetViewModel, close: () -> Unit, assignTo: () -> Unit, editIncome: () -> Unit) {
    val currency = budget.text("currency")
    var strategy by remember { mutableStateOf<String?>(null) }
    var allChanges by remember { mutableStateOf(false) }
    val rta = summary.optLong("readyToAssign")
    // What each option would change in total, worked out while the sheet is open.
    val outcomes = remember(budget, month) { mutableStateMapOf<String, Long>() }
    val jobs = rememberPreviewJobs(budget, month)
    LaunchedEffect(budget, summary, month) {
        val before = summary.optLong("assigned")
        quickAssignModes.forEach { mode ->
            jobs.track(vm.query("workflow", quickAssignParams(budget, month, mode.id).put("previewMonth", month), onError = {}) { result ->
                result.optJSONObject("summary")?.let { outcomes[mode.id] = it.optLong("assigned") - before }
            })
        }
    }
    val figures = remember(budget, summary, month) {
        val totals = summary.rows("categories").associateBy { it.text("id") }
        val visible = budget.rows("categories").filterNot { it.optBoolean("hidden") }
        val needed = visible.sumOf { c -> CategoryStatuses.of(c, totals[c.text("id")], month).needed }
        val targets = visible.sumOf { c -> totals[c.text("id")]?.optLong("monthTarget") ?: 0 }
        val carried = visible.sumOf { c -> totals[c.text("id")]?.optLong("carried") ?: 0 }
        Triple(needed, targets, carried)
    }
    val (needed, targets, carried) = figures
    val income = if (budget.isNull("expectedIncome") || !budget.has("expectedIncome")) null else budget.optLong("expectedIncome")
    val changes = remember(budget, month) { budget.rows("moneyMoves").filter { it.text("month") == month }.reversed() }
    strategy?.let { mode -> QuickAssignDialog(budget, summary, month, vm, mode) { strategy = null; close() }; return }
    UrSheet(close) {
        SheetHeader(monthLabel(month), close, null, null)
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(horizontal = Gutter).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(money(rta, currency), fontSize = 36.sp, fontWeight = FontWeight.ExtraBold, style = Tabular,
                    color = when { rta > 0 -> ur.positive; rta < 0 -> ur.negative; else -> ur.text })
                Text(when { rta > 0 -> "Unassigned: ready for a job"; rta < 0 -> "More is assigned than you have"; else -> "All of it is assigned" }, color = ur.muted)
            }
            if (needed > 0) Notice("${money(needed, currency)} still needed this month", tone = "attention", icon = Icons.Outlined.TrackChanges)
            else Notice("This month's funding is complete", tone = "positive", icon = Icons.Outlined.CheckCircle)
            PrimaryButton(if (rta < 0) "Take money back" else "Assign to a category", assignTo, Modifier.fillMaxWidth(), icon = Icons.Outlined.SwapHoriz)
            ListCard {
                ListRow("Carried over", value = money(carried, currency), divider = true)
                ListRow("Income this month", value = money(summary.optLong("income"), currency), divider = true)
                ListRow("Assigned", value = money(summary.optLong("assigned"), currency), divider = true)
                // The month's activity and available include spending that still needs a category.
                ListRow("Activity", value = money(summary.optLong("activity") + summary.optLong("uncategorized"), currency), divider = true)
                val available = summary.optLong("available") + summary.optLong("uncategorized")
                ListRow("Available", value = money(available, currency), valueColor = if (available < 0) ur.negative else ur.text)
            }
            SectionTitle("Targets & income")
            ListCard {
                ListRow("${shortMonthLabel(month)} targets", value = money(targets, currency), divider = true)
                ListRow("Expected income", value = income?.let { money(it, currency) } ?: "Add", valueColor = if (income == null) ur.accent else ur.text, onClick = editIncome,
                    subtitle = when {
                        income == null -> "Compare your targets with what you expect to earn"
                        targets > income -> "Targets are ${money(targets - income, currency)} more than expected income"
                        else -> "${money(income - targets, currency)} left after targets"
                    })
            }
            SectionTitle("Quick assign")
            quickAssignModes.groupBy { it.group }.forEach { (group, modes) ->
                Text(group.uppercase(), Modifier.padding(start = 4.dp), style = MaterialTheme.typography.labelSmall, color = ur.muted, letterSpacing = .6.sp)
                ListCard {
                    modes.forEachIndexed { index, mode ->
                        val outcome = outcomes[mode.id]
                        val changes0 = outcome != null && outcome != 0L
                        ListRow(mode.label, subtitle = mode.hint, onClick = if (outcome == null || changes0) ({ strategy = mode.id }) else null, chevron = false,
                            titleColor = if (outcome == 0L) ur.muted else ur.text,
                            value = when { outcome == null -> "…"; outcome == 0L -> "No change"; else -> (if (outcome > 0) "+" else "") + money(outcome, currency) },
                            valueColor = when { outcome == null || outcome == 0L -> ur.muted; outcome > 0 -> ur.positive; else -> ur.negative },
                            divider = index < modes.lastIndex)
                    }
                }
            }
            if (changes.isNotEmpty()) {
                SectionTitle("Recent changes")
                ListCard {
                    val shownChanges = if (allChanges) changes else changes.take(4)
                    shownChanges.forEachIndexed { index, m ->
                        ListRow(m.text("description").ifBlank { "Change" }, subtitle = shortDay(m.text("at")), divider = index < shownChanges.lastIndex || changes.size > 4 && !allChanges)
                    }
                    if (changes.size > 4 && !allChanges) ListRow("Show all ${changes.size}", titleColor = ur.accent, onClick = { allChanges = true })
                }
            }
        }
    }
}

/** One category's change in a Quick assign preview. */
private data class QuickRow(val id: String, val name: String, val before: Long, val after: Long, val availableBefore: Long, val availableAfter: Long, val card: Boolean)

/**
 * A Quick assign option explained with the budget's own numbers before applying it: what it assigns
 * and returns, Unassigned before and after, each category's change, and warnings when it would
 * over-assign or leave categories overspent.
 */
@Composable
internal fun QuickAssignDialog(budget: JSONObject, summary: JSONObject, month: String, vm: BudgetViewModel, mode: String, close: () -> Unit) {
    val currency = budget.text("currency")
    val toast = LocalToast.current
    val option = quickAssignModes.first { it.id == mode }
    val params = remember(budget, month, mode) { quickAssignParams(budget, month, mode) }
    var preview by remember(budget, month, mode) { mutableStateOf<JSONObject?>(null) }
    var failed by remember(budget, month, mode) { mutableStateOf<String?>(null) }
    val jobs = rememberPreviewJobs(budget, month, mode)
    LaunchedEffect(params) { jobs.track(vm.query("workflow", params.copyJson().put("previewMonth", month), onError = { failed = it }) { preview = it }) }
    val rows by produceState<List<QuickRow>?>(null, preview) {
        val result = preview ?: return@produceState
        value = withContext(Dispatchers.Default) {
            val before = summary.rows("categories").associateBy { it.text("id") }
            val after = result.optJSONObject("summary")?.rows("categories")?.associateBy { it.text("id") }.orEmpty()
            val ranks = orderedGroups(budget).flatMap { it.second }.mapIndexed { i, c -> c.text("id") to i }.toMap()
            budget.rows("categories").mapNotNull { c ->
                val id = c.text("id")
                val b = before[id]?.optLong("assigned") ?: 0
                val a = after[id]?.optLong("assigned") ?: b
                if (a == b) null else QuickRow(id, c.text("name"), b, a, before[id]?.optLong("available") ?: 0, after[id]?.optLong("available") ?: 0, c.text("paymentAccountId").isNotBlank())
            }.sortedBy { ranks[it.id] ?: Int.MAX_VALUE }
        }
    }
    val after = preview?.optJSONObject("summary")
    val visible = remember(budget) { budget.rows("categories").count { !it.optBoolean("hidden") } }
    val list = rows
    val assigns = list?.filter { it.after > it.before }?.sumOf { it.after - it.before } ?: 0
    val returns = list?.filter { it.after < it.before }?.sumOf { it.before - it.after } ?: 0
    val apply = {
        withCurrentBudget(budget, vm) {
            vm.runCommand("workflow", params)
            val change = assigns - returns
            toast("${option.label}: ${if (change >= 0) "assigned" else "removed"} ${money(kotlin.math.abs(change), currency)}.", true)
            close()
        }
    }
    UrSheet(close) {
        SheetHeader(option.label, close, null, null, cancelFirst = true)
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = screenHeight() * .78f), contentPadding = PaddingValues(start = 18.dp, end = 18.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item(key = "explain") {
                Text(explain(mode, month), color = ur.text2, style = MaterialTheme.typography.bodyMedium)
                Text("All $visible visible categories in ${monthLabel(month)}.", Modifier.padding(top = 4.dp), color = ur.muted, style = MaterialTheme.typography.bodySmall)
            }
            failed?.let { item(key = "error") { FormError(it) } }
            if (list == null && failed == null) item(key = "loading") { LinearProgressIndicator(Modifier.fillMaxWidth(), color = ur.accent) }
            if (list != null && after != null) {
                item(key = "figures") {
                    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(ur.surface2).padding(14.dp)) {
                        Figure(if (returns > assigns) "Returns" else "Assigns", money(if (returns > assigns) returns - assigns else assigns - returns, currency), Modifier.weight(1f),
                            color = if (returns > assigns) ur.negative else ur.positive)
                        Figure("Unassigned", "${money(summary.optLong("readyToAssign"), currency)} → ${money(after.optLong("readyToAssign"), currency)}", Modifier.weight(1.6f),
                            color = if (after.optLong("readyToAssign") < 0) ur.negative else ur.text)
                    }
                    Text("${list.size} of $visible categories change.", Modifier.padding(top = 6.dp), color = ur.muted, style = MaterialTheme.typography.bodySmall)
                }
                if (after.optLong("readyToAssign") < 0) item(key = "over") {
                    Notice("This assigns more than you have: Unassigned would be ${money(after.optLong("readyToAssign"), currency)}.", tone = "negative", icon = Icons.Outlined.WarningAmber)
                }
                val overspentAfter = after.rows("categories").count { it.optLong("available") < 0 }
                if (overspentAfter > 0) item(key = "overspent") {
                    Notice("${if (overspentAfter == 1) "1 category stays" else "$overspentAfter categories stay"} overspent.", tone = "attention", icon = Icons.Outlined.Info)
                }
                if (list.isEmpty()) item(key = "nothing") { Notice("Nothing to change for ${monthLabel(month)}.", tone = "info") }
                else item(key = "rows") {
                    ListCard {
                        list.forEachIndexed { index, row ->
                            val change = row.after - row.before
                            ListRow(row.name, subtitle = "${money(row.before, currency)} → ${money(row.after, currency)} · Available ${money(row.availableAfter, currency)}",
                                value = (if (change > 0) "+" else "") + money(change, currency), valueColor = if (change > 0) ur.positive else ur.negative,
                                divider = index < list.lastIndex)
                        }
                    }
                }
            }
        }
        val count = list?.size ?: 0
        PrimaryButton(if (count == 0) "Nothing to apply" else "Apply to $count ${if (count == 1) "category" else "categories"}", apply,
            Modifier.fillMaxWidth().padding(horizontal = Gutter).padding(bottom = 16.dp), enabled = count > 0, color = if (mode in resets) ur.negative else ur.accent)
    }
}

@Composable
internal fun NewCategoryDialog(budget: JSONObject, vm: BudgetViewModel, presetGroup: String? = null, close: () -> Unit) {
    val existing = remember(budget) { groupNames(budget) }
    var name by remember { mutableStateOf("") }
    var group by remember { mutableStateOf(presetGroup ?: existing.firstOrNull() ?: "Everyday") }
    var newGroup by remember { mutableStateOf(existing.isEmpty()) }
    FormDialog("New category", close, confirm = "Add", onConfirm = { vm.saveCategory(name = name.trim(), group = group.trim()); close() }, enabled = name.isNotBlank() && group.isNotBlank()) {
        Field(name, { name = it }, "Category name")
        if (!newGroup) Choice("Group", group, existing.map { it to it } + ("__new" to "New group…"), { if (it == "__new") { newGroup = true; group = "" } else group = it })
        else Field(group, { group = it }, "New group name")
    }
}

/** A new, empty group: it waits in the group order with an "Add a category" row. */
@Composable
internal fun NewGroupDialog(budget: JSONObject, vm: BudgetViewModel, close: () -> Unit) {
    val existing = remember(budget) { groupNames(budget) }
    var name by remember { mutableStateOf("") }
    val taken = name.trim() in existing
    FormDialog("New group", close, confirm = "Add", onConfirm = {
        withCurrentBudget(budget, vm) {
            vm.editBudget { b -> b.put("groupOrder", (b.optJSONArray("groupOrder") ?: JSONArray(existing)).put(name.trim())) }
        }
        close()
    }, enabled = name.isNotBlank() && !taken) {
        Field(name, { name = it }, "Group name")
        if (taken) FormError("There is already a group called ${name.trim()}.")
    }
}

@Composable
internal fun RenameGroupDialog(group: String, budget: JSONObject, vm: BudgetViewModel, close: () -> Unit) {
    val toast = LocalToast.current
    val existing = remember(budget) { groupNames(budget) }
    var name by remember { mutableStateOf(group) }
    FormDialog("Rename group", close, onConfirm = {
        withCurrentBudget(budget, vm) {
            vm.runCommand("workflow", JSONObject().put("action", JSONObject().put("type", "renameGroup").put("from", group).put("to", name.trim())))
            if (name.trim() in existing) toast("Merged $group into ${name.trim()}.", true)
        }
        close()
    }, enabled = name.isNotBlank() && name != group) {
        Field(name, { name = it }, "Group name")
        Text("An existing group's name merges the two groups.", color = ur.muted, style = MaterialTheme.typography.bodySmall)
    }
}

/** Deleting a group moves its categories to another group (a merge), or drops an empty group from the order. */
@Composable
internal fun DeleteGroupDialog(group: String, budget: JSONObject, vm: BudgetViewModel, close: () -> Unit) {
    val toast = LocalToast.current
    val others = remember(budget) { groupNames(budget).filter { it != group } }
    val count = remember(budget) { budget.rows("categories").count { !it.optBoolean("hidden") && it.text("group") == group } }
    var target by remember { mutableStateOf(others.firstOrNull().orEmpty()) }
    FormDialog("Delete $group", close, confirm = "Delete", onConfirm = {
        withCurrentBudget(budget, vm) {
            if (count == 0) vm.editBudget { b ->
                val order = b.optJSONArray("groupOrder") ?: JSONArray()
                b.put("groupOrder", JSONArray((0 until order.length()).map { order.optString(it) }.filter { it != group }))
            } else vm.runCommand("workflow", JSONObject().put("action", JSONObject().put("type", "renameGroup").put("from", group).put("to", target)))
            toast(if (count == 0) "Deleted $group." else "Deleted $group; its categories moved to $target.", true)
        }
        close()
    }, enabled = count == 0 || target.isNotBlank()) {
        if (count == 0) Text("The group is empty.", color = ur.text2)
        else {
            Text("Move its $count ${if (count == 1) "category" else "categories"} to", color = ur.text2)
            Choice("Group", target, others.map { it to it }, { target = it })
        }
    }
}

@Composable
internal fun BudgetPlanningDialog(budget: JSONObject, month: String, vm: BudgetViewModel, close: () -> Unit) {
    val openedBudget = remember { budget }
    var note by remember { mutableStateOf(budget.rows("ynabMonths").firstOrNull { it.text("month").startsWith(month) }?.text("note").orEmpty()) }
    var income by remember { mutableStateOf(if (budget.isNull("expectedIncome") || !budget.has("expectedIncome")) "" else amountText(budget.optLong("expectedIncome"))) }
    var error by remember { mutableStateOf<String?>(null) }
    FormDialog(monthLabel(month), close, onConfirm = {
        runCatching { requireCurrentBudget(openedBudget, vm); val expected = if (income.isBlank()) null else amountValue(income).also { require(it >= 0) { "Expected income must be zero or positive." } }; vm.runCommand("workflow", JSONObject().put("action", JSONObject().put("type", "setBudgetPlanning").put("month", month).put("note", note).put("expectedIncome", expected ?: JSONObject.NULL))); close() }.onFailure { error = it.message }
    }) {
        Field(note, { note = it }, "Month note", lines = 5)
        Field(income, { income = it }, "Expected monthly income (${budget.text("currency")})", true)
        Text("Expected income helps compare your targets with your plan. It doesn’t add money to Unassigned.", style = MaterialTheme.typography.bodySmall, color = ur.muted)
        FormError(error)
    }
}
