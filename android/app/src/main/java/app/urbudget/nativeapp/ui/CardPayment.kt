package app.urbudget.nativeapp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CreditCard
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.urbudget.nativeapp.BudgetViewModel
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.util.UUID

/**
 * Paying a credit card, as the desktop's payment form does: what's set aside in its payment
 * category, the whole balance, or another amount, from the cash account that paid it last.
 */
@Composable
internal fun CardPaymentSheet(cardId: String, budget: JSONObject, summary: JSONObject?, vm: BudgetViewModel, close: () -> Unit) {
    val openedBudget = remember { budget }
    val toast = LocalToast.current
    val currency = budget.text("currency")
    val card = remember(budget, cardId) { budget.row("accounts", cardId) }
    val balances = remember(summary) { summary?.rows("accounts")?.associate { it.text("id") to it.optLong("balance") }.orEmpty() }
    val category = remember(budget, cardId) { budget.rows("categories").firstOrNull { it.text("paymentAccountId") == cardId } }
    // The amounts are fixed when the sheet opens, so a retry pays exactly once.
    val owed = remember { maxOf(0L, -(balances[cardId] ?: 0)) }
    val aside = remember { maxOf(0L, category?.let { c -> summary?.rows("categories")?.firstOrNull { it.text("id") == c.text("id") }?.optLong("available") } ?: 0) }
    val paymentId = remember { UUID.randomUUID().toString() }
    val sources = remember(budget) { budget.rows("accounts").filter { it.text("kind") == "cash" && !it.optBoolean("archived") } }
    var from by remember {
        mutableStateOf(budget.rows("transactions").filter { t -> t.text("transferAccountId") == cardId && t.optLong("amount") < 0 && sources.any { it.text("id") == t.text("accountId") } }
            .maxByOrNull { it.text("date") }?.text("accountId")
            ?: sources.sortedWith(compareBy<JSONObject> { if (it.text("accountType") == "checking") 0 else if (it.text("accountType") == "savings" || it.text("name").contains("saving", true)) 2 else 1 }
                .thenByDescending { balances[it.text("id")] ?: 0 }).firstOrNull()?.text("id").orEmpty())
    }
    var choice by remember { mutableStateOf(if (aside > 0) "aside" else if (owed > 0) "balance" else "other") }
    val pad = rememberPad(null, cardId)
    var keypad by remember { mutableStateOf(choice == "other") }
    var date by remember { mutableStateOf(LocalDate.now().toString()) }
    var memo by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var dating by remember { mutableStateOf(false) }
    var picking by remember { mutableStateOf(false) }
    val amount = when (choice) { "aside" -> aside; "balance" -> owed; else -> pad.cents ?: 0 }
    if (card == null) { close(); return }
    val pay = {
        runCatching {
            requireCurrentBudget(openedBudget, vm)
            require(from.isNotBlank()) { "Choose the account the payment comes from." }
            require(amount > 0) { "Enter an amount to pay." }
            vm.saveTransaction(JSONObject().put("id", paymentId).put("accountId", from).put("date", date).put("payee", "").put("memo", memo)
                .put("amount", -amount).put("status", "uncleared").put("approved", true).put("flag", JSONObject.NULL)
                .put("transferAccountId", cardId).put("transferStatus", "uncleared")
                .put("splits", JSONArray().put(JSONObject().put("categoryId", JSONObject.NULL).put("unassigned", false).put("amount", -amount))))
            toast("Paid ${money(amount, currency)} to ${card.text("name")}.", true)
        }.onSuccess { close() }.onFailure { error = it.message }
    }
    UrSheet(close) {
        SheetHeader("Pay ${card.text("name")}", close, null, null, cancelFirst = true)
        Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(horizontal = Gutter).padding(bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            ListCard {
                @Composable
                fun Option(id: String, title: String, detail: String, figure: Long?) {
                    Row(Modifier.fillMaxWidth().clickable(role = Role.RadioButton) { choice = id; keypad = id == "other" }.padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(choice == id, { choice = id; keypad = id == "other" }, colors = RadioButtonDefaults.colors(selectedColor = ur.accent))
                        Column(Modifier.weight(1f).padding(start = 4.dp)) {
                            Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, color = ur.text)
                            Text(detail, style = MaterialTheme.typography.bodySmall, color = ur.muted)
                        }
                        figure?.let { Text(money(it, currency), style = MaterialTheme.typography.bodyLarge.merge(Tabular), fontWeight = FontWeight.SemiBold, color = ur.text) }
                    }
                }
                if (category != null) { Option("aside", "What's set aside", "In the ${category.text("name")} payment category", aside); Hairline(start = 52.dp) }
                Option("balance", "The whole balance", "Pays the card off", owed)
                Hairline(start = 52.dp)
                Option("other", "Another amount", if (choice == "other") (if (pad.isSum) pad.display() else money(pad.cents ?: 0, currency)) else "Type it on the keypad", null)
            }
            ListCard {
                ListRow("From", subtitle = sources.firstOrNull { it.text("id") == from }?.text("name") ?: "Choose account", onClick = { picking = true; keypad = false }, divider = true)
                ListRow("Date", subtitle = app.urbudget.nativeapp.Money.date(date), onClick = { dating = true; keypad = false })
            }
            Field(memo, { memo = it }, "Memo (optional)")
            Text("The payment is a transfer from the cash account to the card: it uses money already set aside, so it doesn't change any category.",
                color = ur.muted, style = MaterialTheme.typography.bodySmall)
            FormError(error)
            if (!keypad) PrimaryButton("Pay ${money(amount, currency)}", { pay() }, Modifier.fillMaxWidth(), enabled = amount > 0, icon = Icons.Outlined.CreditCard)
        }
        if (keypad) AmountKeypad(pad, { keypad = false })
    }
    if (dating) DatePickerSheet(date, { date = it; dating = false }) { dating = false }
    if (picking) UrSheet({ picking = false }) {
        SheetHeader("Pay from", { picking = false }, null, null)
        Column(Modifier.padding(horizontal = Gutter).padding(bottom = 24.dp)) {
            ListCard {
                sources.forEachIndexed { index, account ->
                    val id = account.text("id")
                    ListRow(account.text("name"), value = money(balances[id] ?: 0, currency), icon = accountIcon(account), iconTint = ur.positive, iconFill = ur.positiveSoft,
                        onClick = { from = id; picking = false }, chevron = false, divider = index < sources.lastIndex)
                }
            }
        }
    }
}
