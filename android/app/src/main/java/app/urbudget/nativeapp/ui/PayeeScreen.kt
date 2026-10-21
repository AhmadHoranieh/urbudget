package app.urbudget.nativeapp.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.urbudget.nativeapp.BudgetViewModel
import app.urbudget.nativeapp.Money
import app.urbudget.nativeapp.PayeeInfo
import app.urbudget.nativeapp.PayeeRules
import app.urbudget.nativeapp.payeeDetail
import app.urbudget.nativeapp.payeeIndex
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import org.json.JSONArray
import org.json.JSONObject
import java.time.YearMonth
import java.util.UUID

private fun plural(n: Int, word: String) = "%,d %s%s".format(n, word, if (n == 1) "" else "s")

/** A payee row, prepared away from composition. */
private data class PayeeLine(val name: String, val record: JSONObject, val subtitle: String)

/** An import rule row. */
private data class RuleLine(val rule: JSONObject, val title: String, val subtitle: String)

private suspend fun payeeLines(budget: JSONObject): List<PayeeLine> {
    val categories = budget.rows("categories").associate { it.text("id") to it.text("name") }
    val context = currentCoroutineContext()
    return payeeIndex(budget).mapIndexed { index, info ->
        if (index % 256 == 0) context.ensureActive()
        PayeeLine(info.name, info.record, listOfNotNull(
            if (info.count > 0) "${plural(info.count, "transaction")} · ${Money.date(info.last)}" else "Not used in transactions yet",
            info.default?.let { "Default: ${if (it == Unassigned) "Unassigned" else categories[it] ?: "Deleted category"}" }).joinToString(" · "))
    }
}

private fun ruleLines(budget: JSONObject): List<RuleLine> {
    val categories = budget.rows("categories").associate { it.text("id") to it.text("name") }
    return budget.rows("payeeRules").map { rule ->
        RuleLine(rule, "Contains “${rule.text("match")}”", listOfNotNull(rule.text("payee").ifBlank { null }?.let { "Rename to $it" },
            rule.text("categoryId").ifBlank { null }?.let { if (it == Unassigned) "Unassigned" else categories[it] ?: "Deleted category" })
            .joinToString(" · ").ifBlank { "Keep payee name" })
    }
}

/** Payees & rules: search the payees, open one for its details; then the import rules. */
@Composable
internal fun PayeesPage(budget: JSONObject, vm: BudgetViewModel, edit: (String, JSONObject?) -> Unit) {
    var search by rememberSaveable { mutableStateOf("") }
    val all = rememberPrepared(budget) { payeeLines(budget) }
    val shown = rememberPrepared(all, search) {
        val query = search.trim()
        if (query.isEmpty()) all else all?.filter { it.name.contains(query, ignoreCase = true) }
    }
    val rules = rememberPrepared(budget) { ruleLines(budget) }
    val pending = rememberPrepared(budget) { PayeeRules.changes(budget, budget.rows("payeeRules")) }
    val reapply = { withCurrentBudget(budget, vm) { vm.runCommand("workflow", JSONObject().put("action", JSONObject().put("type", "reapplyPayeeRules"))) } }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = Gutter, end = Gutter, top = 4.dp, bottom = DockRoom)) {
        item(key = "payees:title") {
            SectionTitle("Payees", "Tidy names, and a default category for new transactions") { IconButton({ edit("payee", null) }) { Icon(Icons.Outlined.Add, "Add payee", tint = ur.accent) } }
        }
        item(key = "payees:search") { SearchField(search, { search = it }, "Search payees", Modifier.padding(top = 4.dp, bottom = 10.dp)) }
        when {
            shown == null -> item(key = "payees:loading") { LinearProgressIndicator(Modifier.fillMaxWidth().padding(vertical = 12.dp), color = ur.accent) }
            shown.isEmpty() -> item(key = "payees:empty") {
                Text(if (search.isBlank()) "Payees appear here as you enter transactions." else "No payees match.", Modifier.padding(4.dp), color = ur.muted)
            }
            else -> itemsIndexed(shown, key = { _, line -> "payee:${line.name}" }, contentType = { _, _ -> "payee" }) { index, line ->
                ListRow(line.name, Modifier.cardSegment(index, shown.size, cardFill()), subtitle = line.subtitle, onClick = { edit("payee", line.record) }, divider = index < shown.lastIndex)
            }
        }
        item(key = "rules:title") {
            Box(Modifier.padding(top = 16.dp)) {
                SectionTitle("Import rules", "The longest matching pattern wins") { IconButton({ edit("rule", null) }) { Icon(Icons.Outlined.Add, "Add import rule", tint = ur.accent) } }
            }
        }
        if ((pending ?: 0) > 0) item(key = "rules:pending") {
            Notice("The rules would rename or categorize ${plural(pending ?: 0, "transaction")} you already have.", Modifier.padding(bottom = 10.dp),
                tone = "info", action = "Apply", onAction = reapply, icon = Icons.Outlined.AutoFixHigh)
        }
        val ruleList = rules.orEmpty()
        if (ruleList.isEmpty()) item(key = "rules:empty") {
            Text("Rules rename and categorize transactions as they come in from bank files and bank sync.", Modifier.padding(4.dp), color = ur.muted, style = MaterialTheme.typography.bodyMedium)
        } else itemsIndexed(ruleList, key = { _, line -> "rule:${line.rule.text("id")}" }, contentType = { _, _ -> "rule" }) { index, line ->
            ListRow(line.title, Modifier.cardSegment(index, ruleList.size, cardFill()), subtitle = line.subtitle, onClick = { edit("rule", line.rule) }, divider = index < ruleList.lastIndex)
        }
        if (ruleList.isNotEmpty()) item(key = "rules:apply") {
            TextButton(reapply, Modifier.padding(top = 4.dp)) { Text("Apply rules to existing transactions", color = ur.accent) }
        }
    }
}

private data class RecentLine(val key: String, val title: String, val detail: String, val amount: String, val positive: Boolean)

/** A payee's page, prepared away from composition. */
private data class PayeeSheet(val info: PayeeInfo?, val count: Int, val total: Long, val totalText: String, val recent: List<RecentLine>,
                              val names: Set<String>, val merge: List<Pair<String, String>>)

private suspend fun payeeSheet(budget: JSONObject, name: String?): PayeeSheet {
    val currency = budget.text("currency")
    val index = payeeIndex(budget)
    val accounts = budget.rows("accounts").associate { it.text("id") to it.text("name") }
    val categories = budget.rows("categories").associate { it.text("id") to it.text("name") }
    val detail = name?.let { payeeDetail(budget, it) }
    val recent = detail?.recent.orEmpty().map { t ->
        val category = if (t.splits > 1) "Split (${t.splits})" else categories[t.categoryId] ?: "Unassigned"
        RecentLine(t.id.ifBlank { "${t.date}:${t.amount}" }, Money.date(t.date), listOfNotNull(accounts[t.accountId], category).joinToString(" · "), money(t.amount, currency), t.amount > 0)
    }
    return PayeeSheet(index.firstOrNull { it.name == name }, detail?.count ?: 0, detail?.total ?: 0L, money(detail?.total ?: 0L, currency), recent,
        index.map { it.name }.toSet(), listOf("" to "Choose a payee") + index.filter { it.name != name }.map { it.name to it.name })
}

/**
 * A payee: how often it's used, its latest transactions, its default category (or the one used
 * last), and renaming or merging it into another payee (PayeesPage.tsx).
 */
@Composable
internal fun PayeeDialog(original: JSONObject?, budget: JSONObject, vm: BudgetViewModel, close: () -> Unit) {
    val openedBudget = remember { budget }
    val originalName = original?.text("name")?.ifBlank { null }
    var name by remember { mutableStateOf(originalName ?: "") }
    var category by remember { mutableStateOf(original?.text("categoryId") ?: "") }
    var picking by remember { mutableStateOf(false) }
    // The categories' available amounts as the picker opens.
    var pickerSummary by remember { mutableStateOf<JSONObject?>(null) }
    val sheet = rememberPrepared(openedBudget, originalName) { payeeSheet(openedBudget, originalName) }
    val categories = remember(budget) { budget.rows("categories").associate { it.text("id") to it.text("name") } }
    fun categoryName(id: String) = when (id) { "" -> null; Unassigned -> "Unassigned"; else -> categories[id] ?: "Deleted category" }
    val lastUsed = sheet?.info?.lastUsed
    val placeholder = if (lastUsed != null) "Last used: ${if (lastUsed.isBlank()) "no category" else categoryName(lastUsed)}" else "No default"
    val merging = name.trim().let { it.isNotEmpty() && it != originalName && sheet?.names?.contains(it) == true }
    FormDialog(if (original == null) "Add payee" else "Payee", close, onConfirm = {
        withCurrentBudget(openedBudget, vm) {
            vm.runCommand("workflow", JSONObject().put("action", JSONObject().put("type", "savePayee").put("from", originalName ?: JSONObject.NULL)
                .put("record", (original?.copyJson() ?: JSONObject().put("id", UUID.randomUUID().toString())).put("name", name.trim()).put("categoryId", category.ifBlank { null } ?: JSONObject.NULL))))
            close()
        }
    }, enabled = name.isNotBlank()) {
        if (originalName != null) Column {
            Text(originalName, style = MaterialTheme.typography.titleLarge, color = ur.text)
            Text(if (sheet == null) "…" else if (sheet.count == 0) "No transactions yet" else "${plural(sheet.count, "transaction")} · total ${sheet.totalText}",
                style = MaterialTheme.typography.bodyMedium, color = ur.muted)
        }
        PickerField("Default category", categoryName(category), placeholder, { pickerSummary = vm.state.value.summary; picking = true }, onClear = { category = "" })
        Text("Filled in when you enter a transaction for this payee. Without one, the category you used last time is suggested.",
            style = MaterialTheme.typography.bodySmall, color = ur.muted)
        Field(name, { name = it }, if (original == null) "Payee name" else "Name")
        if (originalName != null) {
            Choice("Merge into another payee", "", sheet?.merge ?: listOf("" to "Choose a payee")) { if (it.isNotBlank()) name = it }
            Text(if (merging) "${name.trim()} already exists, so saving merges the two." else
                "Renaming or merging updates saved transactions, split payees, schedules and import rules.",
                style = MaterialTheme.typography.bodySmall, color = if (merging) ur.warning else ur.muted)
        }
        if (sheet != null && sheet.recent.isNotEmpty()) {
            Text("Recent transactions", style = MaterialTheme.typography.titleSmall, color = ur.text)
            ListCard {
                sheet.recent.forEachIndexed { index, line ->
                    ListRow(line.title, subtitle = line.detail, value = line.amount, valueColor = if (line.positive) ur.positive else ur.text, divider = index < sheet.recent.lastIndex)
                }
            }
        }
    }
    if (picking) CategoryPickerSheet(budget, pickerSummary, YearMonth.now().toString(), category, "Default category", includeUnassigned = true, includePayment = false,
        onPick = { category = it; picking = false }) { picking = false }
}

@Composable
internal fun RuleDialog(original: JSONObject?, budget: JSONObject, vm: BudgetViewModel, close: () -> Unit) {
    val openedBudget = remember { budget }
    val id = remember { original?.text("id")?.ifBlank { null } ?: UUID.randomUUID().toString() }
    var match by remember { mutableStateOf(original?.text("match") ?: "") }
    var payee by remember { mutableStateOf(original?.text("payee") ?: "") }
    var category by remember { mutableStateOf(original?.text("categoryId") ?: "") }
    val categories = remember(budget) { listOf("" to "Keep category", Unassigned to "Unassigned") + budget.rows("categories").filter { it.text("paymentAccountId").isBlank() }.map { it.text("id") to it.text("name") } }
    val ready = match.isNotBlank() && (payee.isNotBlank() || category.isNotBlank())
    // What this rule, as typed, would change in the transactions you already have.
    val changes = rememberPrepared(openedBudget, match, payee, category) {
        if (match.isBlank()) 0 else {
            val draft = (original?.copyJson() ?: JSONObject().put("id", id)).put("match", match.trim()).put("payee", payee.trim()).put("categoryId", category.ifBlank { null } ?: JSONObject.NULL)
            val rules = openedBudget.rows("payeeRules").map { if (it.text("id") == id) draft else it }.let { if (it.any { rule -> rule === draft }) it else it + draft }
            PayeeRules.changes(openedBudget, rules, setOf(id))
        }
    }
    FormDialog(if (original == null) "Add import rule" else "Import rule", close, onConfirm = {
        withCurrentBudget(openedBudget, vm) {
            vm.upsert("payeeRules", (original?.copyJson() ?: JSONObject().put("id", id)).put("match", match.trim()).put("payee", payee.trim())
                .put("categoryId", category.ifBlank { null } ?: JSONObject.NULL)); close()
        }
    }, enabled = ready) {
        Field(match, { match = it }, "Bank payee contains")
        Field(payee, { payee = it }, "Rename to")
        Choice("Category", category, categories, { category = it })
        when {
            match.isBlank() -> Text("Enter the text to look for in the bank's payee, e.g. CARREFOUR.", style = MaterialTheme.typography.bodySmall, color = ur.muted)
            !ready -> Text("Choose a new name, a category, or both.", style = MaterialTheme.typography.bodySmall, color = ur.warning)
            (changes ?: 0) > 0 -> Text("Applied to existing transactions, it would rename or categorize ${plural(changes ?: 0, "transaction")}.",
                style = MaterialTheme.typography.bodySmall, color = ur.muted)
        }
        Text("A rule matches when the bank's payee contains its text, ignoring case and punctuation; the longest match wins. It renames the payee and fills in the category if there's none.",
            style = MaterialTheme.typography.bodySmall, color = ur.muted)
        if (original != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                listOf("up" to "Move earlier", "down" to "Move later").forEach { (direction, label) ->
                    SecondaryButton(label, { withCurrentBudget(openedBudget, vm) { vm.runCommand("workflow", JSONObject().put("action", JSONObject().put("type", "reorderPayeeRule").put("id", id).put("direction", direction))); close() } }, Modifier.weight(1f))
                }
            }
            Text("The longest pattern wins; list order breaks ties.", style = MaterialTheme.typography.bodySmall, color = ur.muted)
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton({ withCurrentBudget(openedBudget, vm) { vm.runCommand("workflow", JSONObject().put("action", JSONObject().put("type", "reapplyPayeeRules").put("ruleIds", JSONArray().put(id)))); close() } }) {
                    Text("Apply to existing transactions", color = ur.accent, fontWeight = FontWeight.SemiBold)
                }
            }
            TextButton({ withCurrentBudget(openedBudget, vm) { vm.remove("payeeRules", id); close() } }) { Text("Delete rule", color = ur.negative) }
        }
    }
}
