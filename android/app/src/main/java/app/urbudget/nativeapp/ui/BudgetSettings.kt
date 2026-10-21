package app.urbudget.nativeapp.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.urbudget.nativeapp.BudgetViewModel
import org.json.JSONObject
import java.util.Currency
import java.util.Locale

/** The desktop's number formats (newBudget.ts numberPresets): decimal and thousands separators together. */
private val numberPresets = listOf(
    "1,234.56" to ("." to ","), "1.234,56" to ("," to "."), "1 234,56" to ("," to " "), "1'234.56" to ("." to "'"), "1234.56" to ("." to ""),
)
internal val dateFormatChoices = listOf("iso" to "2026-10-15", "dmy" to "15/10/2026", "mdy" to "10/15/2026", "dmmmy" to "15 Oct 2026")

private fun symbolOf(code: String) = runCatching { Currency.getInstance(code).getSymbol(Locale.ENGLISH) }.getOrDefault(code)
/** Where a currency's symbol goes unless the budget says otherwise: before a sign ($1.00), after a code (1.00 SAR). */
private fun defaultSymbol(code: String) = if (symbolOf(code) == code) "after" else "before"

/** Every ISO currency the phone knows, "SAR · Saudi Riyal", with `current` kept even if it isn't one of them. */
internal fun currencyChoices(current: String): List<Pair<String, String>> {
    val known = Currency.getAvailableCurrencies().sortedBy { it.currencyCode }.map { it.currencyCode to "${it.currencyCode} · ${it.getDisplayName(Locale.ENGLISH)}" }
    return if (current.isBlank() || known.any { it.first == current }) known else listOf(current to current) + known
}

/**
 * The open budget's name, currency, number and date formats, as the desktop's Settings › Budget
 * edits them. The currency only relabels amounts.
 */
@Composable
internal fun BudgetSettingsDialog(budget: JSONObject, vm: BudgetViewModel, close: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    val opened = remember { budget }
    val identity = remember { vm.state.value.budgetIdentity }
    val toast = LocalToast.current
    val saved = budget.optJSONObject("numberFormat")
    var name by remember { mutableStateOf(budget.text("name")) }
    var currency by remember { mutableStateOf(budget.text("currency", "SAR")) }
    var decimal by remember { mutableStateOf(saved?.text("decimal", ".") ?: ".") }
    var group by remember { mutableStateOf(saved?.text("group", ",") ?: ",") }
    var symbol by remember { mutableStateOf(saved?.text("symbol")?.ifBlank { null } ?: defaultSymbol(budget.text("currency", "SAR"))) }
    var dateFormat by remember { mutableStateOf(budget.text("dateFormat", "iso")) }
    val currencies = remember { currencyChoices(budget.text("currency")) }
    val preset = numberPresets.indexOfFirst { it.second == decimal to group }.coerceAtLeast(0)
    fun example(place: String): String {
        val number = numberPresets[preset].first
        val mark = symbolOf(currency)
        return when (place) { "before" -> if (mark.length == 1) "$mark$number" else "$mark $number"; "after" -> "$number $mark"; else -> number }
    }
    FormDialog("Budget settings", close, enabled = !state.busy && name.isNotBlank(), onConfirm = {
        if (identity != state.budgetIdentity) vm.notifyError("The open budget changed. Close settings and reopen them.")
        else withCurrentBudget(opened, vm) {
            vm.editBudget {
                it.put("name", name.trim()).put("currency", currency).put("numberFormat", JSONObject().put("decimal", decimal).put("group", group).put("symbol", symbol))
                    .put("dateFormat", dateFormat)
            }
            toast("Budget settings saved.", true)
            close()
        }
    }) {
        Field(name, { name = it.take(200) }, "Budget name")
        Choice("Currency", currency, currencies, { next ->
            // A symbol left where the old currency puts it moves to where the new one does.
            if (symbol == defaultSymbol(currency)) symbol = defaultSymbol(next)
            currency = next
        })
        Text("The currency only changes how amounts are labelled. Amounts are never converted.", style = MaterialTheme.typography.bodySmall, color = ur.muted)
        Choice("Number format", preset.toString(), numberPresets.mapIndexed { i, p -> i.toString() to p.first }, { i ->
            numberPresets.getOrNull(i.toInt())?.second?.let { (d, g) -> decimal = d; group = g }
        })
        Choice("Currency placement", symbol, listOf("before" to "Before amount · ${example("before")}", "after" to "After amount · ${example("after")}",
            "none" to "Don't show · ${example("none")}"), { symbol = it })
        Choice("Date format", dateFormat, dateFormatChoices, { dateFormat = it })
    }
}

/** Names for the flag colours, such as Reimburse or Tax. */
@Composable
internal fun FlagNamesDialog(budget: JSONObject, vm: BudgetViewModel, close: () -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()
    val opened = remember { budget }
    val identity = remember { vm.state.value.budgetIdentity }
    var names by remember { mutableStateOf(flagColors.associateWith { budget.optJSONObject("flagNames")?.text(it).orEmpty() }) }
    FormDialog("Flag names", close, enabled = !state.busy, onConfirm = {
        if (identity != state.budgetIdentity) vm.notifyError("The open budget changed. Close this editor and reopen it.")
        else withCurrentBudget(opened, vm) {
            val saved = JSONObject().apply { names.forEach { (color, value) -> value.trim().takeIf(String::isNotEmpty)?.let { put(color, it) } } }
            vm.editBudget { if (saved.length() == 0) it.remove("flagNames") else it.put("flagNames", saved) }
            close()
        }
    }) {
        Text("Use names such as Reimburse or Tax. Leave a name empty to use its colour.", style = MaterialTheme.typography.bodySmall, color = ur.muted)
        flagColors.forEach { color -> Field(names[color].orEmpty(), { names = names + (color to it.take(40)) }, "${color.replaceFirstChar(Char::uppercase)} flag") }
    }
}

/** How the open budget writes amounts and dates, for a settings row. */
internal fun formatSummary(budget: JSONObject): String {
    val saved = budget.optJSONObject("numberFormat")
    val number = numberPresets.firstOrNull { it.second == (saved?.text("decimal", ".") ?: ".") to (saved?.text("group", ",") ?: ",") }?.first ?: "1,234.56"
    val date = dateFormatChoices.firstOrNull { it.first == budget.text("dateFormat", "iso") }?.second ?: "2026-10-15"
    return "${budget.text("currency")} · $number · $date"
}
