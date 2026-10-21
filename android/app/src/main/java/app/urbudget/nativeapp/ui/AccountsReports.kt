package app.urbudget.nativeapp.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ShowChart
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.urbudget.nativeapp.AccountTypes
import app.urbudget.nativeapp.BudgetViewModel
import app.urbudget.nativeapp.accountBadges
import app.urbudget.nativeapp.records
import app.urbudget.nativeapp.upsertRecord
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.util.UUID

/** An account type's icon, as the desktop's accounts list draws them. */
internal fun iconForType(type: String, kind: String): ImageVector = when (type) {
    "checking" -> Icons.Outlined.AccountBalance
    "savings" -> Icons.Outlined.Savings
    "cash" -> Icons.Outlined.Payments
    "creditCard", "lineOfCredit" -> Icons.Outlined.CreditCard
    "mortgage", "property" -> Icons.Outlined.House
    "autoLoan", "vehicle" -> Icons.Outlined.DirectionsCar
    "studentLoan" -> Icons.Outlined.School
    "investment", "retirement" -> Icons.AutoMirrored.Outlined.ShowChart
    "receivable", "personalLoan" -> Icons.Outlined.VolunteerActivism
    "medicalDebt" -> Icons.Outlined.LocalHospital
    "otherDebt" -> Icons.Outlined.Receipt
    else -> when (kind) { "credit" -> Icons.Outlined.CreditCard; "tracking" -> Icons.Outlined.MonetizationOn; else -> Icons.Outlined.AccountBalance }
}

internal fun accountIcon(account: JSONObject): ImageVector = iconForType(AccountTypes.infer(account), account.text("kind"))

private fun typeLabel(type: String) = accountTypes.firstOrNull { it.first == type }?.second ?: type

/** One account as its row shows it, prepared away from composition. */
private data class AccountLine(val id: String, val account: JSONObject, val name: String, val type: String, val kind: String, val subtitle: String,
                               val balance: Long, val balanceText: String, val approvals: Int, val needsCategory: Int, val inNetWorth: Boolean,
                               val loan: Boolean, val archived: Boolean)

private data class AccountSection(val key: String, val name: String, val lines: List<AccountLine>, val total: Long, val totalText: String)

private suspend fun accountSections(budget: JSONObject, summary: JSONObject?, today: String): List<AccountSection> {
    val currency = budget.text("currency")
    val balances = summary?.rows("accounts")?.associate { it.text("id") to it.optLong("balance") }
    val badges = accountBadges(budget, today)
    val loans = budget.rows("loans").map { it.text("accountId") }.toSet()
    val all = budget.rows("accounts")
    fun line(account: JSONObject): AccountLine {
        val id = account.text("id")
        val balance = balances?.get(id) ?: account.optLong("openingBalance")
        val type = AccountTypes.infer(account, balance)
        val worth = AccountTypes.inNetWorth(account)
        return AccountLine(id, account, account.text("name"), type, account.text("kind"),
            typeLabel(type) + if (worth) "" else " · Not in net worth", balance, if (balances == null) "—" else money(balance, currency),
            badges.approvals[id] ?: 0, badges.uncategorized[id] ?: 0, worth, AccountTypes.hasLoan(account, balance, loans), account.optBoolean("archived"))
    }
    return listOf("cash" to "Cash", "credit" to "Credit", "tracking" to "Tracking", "closed" to "Closed").mapNotNull { (key, name) ->
        val lines = all.filter { if (key == "closed") it.optBoolean("archived") else !it.optBoolean("archived") && it.text("kind") == key }.map(::line)
        // Accounts left out of net worth are left out of the total too, as in the sidebar.
        val total = lines.sumOf { if (it.inNetWorth) it.balance else 0L }
        if (lines.isEmpty()) null else AccountSection(key, name, lines, total, money(total, currency))
    }
}

/** Folded sections, remembered for the session per budget, as the desktop remembers them. */
private object AccountSectionMemory {
    private val folded = HashMap<String, Set<String>>()
    fun get(budget: String) = folded[budget] ?: setOf("closed")
    fun set(budget: String, value: Set<String>) { folded[budget] = value }
}

/**
 * Accounts on a phone: cash, credit, tracking and closed accounts, each kind a card with its total.
 * A tap opens the account's transactions; a long press, its actions.
 */
@Composable
internal fun AccountsScreen(budget: JSONObject, summary: JSONObject?, open: (JSONObject) -> Unit, edit: (JSONObject) -> Unit, reconcile: (JSONObject) -> Unit,
                            add: () -> Unit, vm: BudgetViewModel, bar: @Composable RowScope.() -> Unit) {
    val currency = budget.text("currency")
    val identity = remember { vm.state.value.budgetIdentity.orEmpty() }
    var folded by remember(identity) { mutableStateOf(AccountSectionMemory.get(identity)) }
    val sections = rememberPrepared(budget, summary) { accountSections(budget, summary, LocalDate.now().toString()) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var loanFor by remember { mutableStateOf<JSONObject?>(null) }
    fun move(line: AccountLine, section: AccountSection, delta: Int) {
        val index = section.lines.indexOfFirst { it.id == line.id }
        val neighbour = section.lines.getOrNull(index + delta) ?: return
        withCurrentBudget(budget, vm) {
            vm.editBudget { draft -> draft.put("accounts", AccountTypes.moveAccount(draft.optJSONArray("accounts") ?: JSONArray(), line.id, neighbour.id, delta > 0)) }
        }
    }
    fun setClosed(line: AccountLine, archived: Boolean) = withCurrentBudget(budget, vm) {
        vm.upsert("accounts", JSONObject().put("id", line.id).put("archived", archived))
        val message = if (archived) "Closed ${line.name}${if (line.balance != 0L) ". It still has a balance of ${line.balanceText}" else ""}." else "Reopened ${line.name}."
        scope.launch {
            snackbar.currentSnackbarData?.dismiss()
            if (snackbar.showSnackbar(message, actionLabel = "Undo", withDismissAction = true, duration = SnackbarDuration.Long) == SnackbarResult.ActionPerformed)
                vm.upsert("accounts", JSONObject().put("id", line.id).put("archived", !archived))
        }
    }
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            PhoneTopBar("Accounts", actions = { RoundIconButton(Icons.Outlined.Add, "Add account", add); bar() })
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = Gutter, end = Gutter, bottom = DockRoom)) {
                if (summary != null) item(key = "networth", contentType = "networth") {
                    val worth = summary.optLong("netWorth")
                    Row(Modifier.fillMaxWidth().padding(bottom = 4.dp).clip(RoundedCornerShape(18.dp)).background(ur.surface).padding(horizontal = 18.dp, vertical = 14.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("Net worth", color = ur.muted, style = MaterialTheme.typography.bodyMedium)
                            Text(money(worth, currency), fontSize = 26.sp, fontWeight = FontWeight.ExtraBold, style = Tabular, color = if (worth < 0) ur.negative else ur.text)
                        }
                        Icon(Icons.Outlined.AccountBalanceWallet, null, Modifier.size(28.dp), tint = ur.accent)
                    }
                }
                when {
                    sections == null -> item(key = "loading") { LinearProgressIndicator(Modifier.fillMaxWidth().padding(vertical = 16.dp), color = ur.accent) }
                    sections.isEmpty() -> item(key = "empty") { EmptyState("Add your first account", "Start with your checking or spending account and its current balance.", "Add account", add) }
                }
                sections.orEmpty().forEach { section ->
                    val isOpen = section.key !in folded
                    item(key = "section:${section.key}", contentType = "section") {
                        Box(Modifier.padding(top = 6.dp, bottom = 6.dp)) {
                            FoldingHeader(section.name, isOpen, {
                                folded = if (isOpen) folded + section.key else folded - section.key
                                AccountSectionMemory.set(identity, folded)
                            }, section.totalText, if (section.key != "closed" && section.total < 0) ur.negative else ur.text)
                        }
                    }
                    if (isOpen) itemsIndexed(section.lines, key = { _, line -> "account:${line.id}" }, contentType = { _, _ -> "account" }) { index, line ->
                        AccountRow(line, Modifier.cardSegment(index, section.lines.size, cardFill()), divider = index < section.lines.lastIndex,
                            open = { open(line.account) }, edit = { edit(line.account) }, reconcile = { reconcile(line.account) },
                            loan = if (line.loan) ({ loanFor = budget.rows("loans").firstOrNull { it.text("accountId") == line.id } ?: JSONObject().put("accountId", line.id) }) else null,
                            moveUp = if (index > 0) ({ move(line, section, -1) }) else null,
                            moveDown = if (index < section.lines.lastIndex) ({ move(line, section, 1) }) else null,
                            toggleClosed = { setClosed(line, !line.archived) })
                    }
                }
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 96.dp))
    }
    loanFor?.let { LoanDialog(it, budget, summary, vm) { loanFor = null } }
}

@Composable
private fun AccountRow(line: AccountLine, modifier: Modifier, divider: Boolean, open: () -> Unit, edit: () -> Unit, reconcile: () -> Unit, loan: (() -> Unit)?,
                       moveUp: (() -> Unit)?, moveDown: (() -> Unit)?, toggleClosed: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    val outside = !line.inNetWorth
    Box(modifier) {
        ListRow(line.name, subtitle = line.subtitle, icon = iconForType(line.type, line.kind),
            iconTint = when { outside -> ur.muted; line.kind == "cash" -> ur.positive; line.kind == "credit" -> ur.accent; else -> ur.text2 },
            iconFill = when { outside -> ur.zeroSoft; line.kind == "cash" -> ur.positiveSoft; line.kind == "credit" -> ur.accentSoft; else -> ur.zeroSoft },
            titleColor = if (outside) ur.text2 else ur.text, onClick = open, onLongClick = { menu = true }, divider = divider, trailing = {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (line.needsCategory > 0) AttentionDot()
                    if (line.approvals > 0) CountBadge(line.approvals)
                    Text(line.balanceText, style = MaterialTheme.typography.bodyLarge.merge(Tabular), fontWeight = FontWeight.SemiBold, maxLines = 1,
                        color = when { outside -> ur.muted; line.balance < 0 -> ur.negative; else -> ur.text })
                }
            })
        DropdownMenu(menu, { menu = false }, shape = RoundedCornerShape(16.dp), containerColor = ur.surface) {
            DropdownMenuItem(text = { Text("Edit account") }, leadingIcon = { Icon(Icons.Outlined.Edit, null) }, onClick = { menu = false; edit() })
            DropdownMenuItem(text = { Text("Reconcile") }, leadingIcon = { Icon(Icons.Outlined.Lock, null) }, enabled = !line.archived, onClick = { menu = false; reconcile() })
            if (loan != null) DropdownMenuItem(text = { Text("Loan details & payoff") }, leadingIcon = { Icon(Icons.Outlined.Calculate, null) }, onClick = { menu = false; loan() })
            HorizontalDivider(color = ur.border)
            DropdownMenuItem(text = { Text("Move up") }, leadingIcon = { Icon(Icons.Outlined.ArrowUpward, null) }, enabled = moveUp != null, onClick = { menu = false; moveUp?.invoke() })
            DropdownMenuItem(text = { Text("Move down") }, leadingIcon = { Icon(Icons.Outlined.ArrowDownward, null) }, enabled = moveDown != null, onClick = { menu = false; moveDown?.invoke() })
            HorizontalDivider(color = ur.border)
            DropdownMenuItem(text = { Text(if (line.archived) "Reopen account" else "Close account") },
                leadingIcon = { Icon(if (line.archived) Icons.Outlined.Unarchive else Icons.Outlined.Archive, null) }, onClick = { menu = false; toggleClosed() })
        }
    }
}

/** Adds an account as the view model's saveAccount does, with the note and net-worth choice the form also takes. */
private fun createAccount(budget: JSONObject, record: JSONObject) {
    val id = record.getString("id")
    require(budget.records("accounts").none { it.optString("id") == id }) { "This account already exists." }
    budget.upsertRecord("accounts", record)
    if (record.optString("kind") == "credit" && budget.records("categories").none { it.optString("paymentAccountId") == id }) {
        budget.upsertRecord("categories", JSONObject().put("id", UUID.randomUUID().toString()).put("name", record.getString("name"))
            .put("group", "Credit Card Payments").put("target", 0).put("paymentAccountId", id))
    }
}

@Composable
internal fun AccountDialog(original: JSONObject?, budget: JSONObject, vm: BudgetViewModel, close: () -> Unit) {
    val openedBudget = remember { budget }
    // An untyped account is read as the accounts list reads it: an imported debt stays a debt.
    val balanceNow = remember { original?.let { account -> vm.state.value.summary?.rows("accounts")?.firstOrNull { it.text("id") == account.text("id") }?.optLong("balance") ?: account.optLong("openingBalance") } ?: 0L }
    var name by remember { mutableStateOf(original?.text("name") ?: "") }
    val existingKind = original?.text("kind")?.ifBlank { null }
    var type by remember { mutableStateOf(if (original == null) "checking" else AccountTypes.forEditing(original, balanceNow)) }
    val kind = AccountTypes.kindFor(type)
    var balance by remember { mutableStateOf(amountText(original?.optLong("openingBalance") ?: 0)) }
    var note by remember { mutableStateOf(original?.text("note") ?: "") }
    var archived by remember { mutableStateOf(original?.optBoolean("archived") ?: false) }
    var netWorth by remember { mutableStateOf(original?.let(AccountTypes::inNetWorth) ?: true) }
    var error by remember { mutableStateOf<String?>(null) }
    val typeChoices = remember(existingKind) { accountTypes.filter { existingKind == null || AccountTypes.kindFor(it.first) == existingKind } }
    FormDialog(if (original == null) "Add account" else "Edit account", close, confirm = if (original == null) "Add" else "Save", onConfirm = {
        runCatching {
            requireCurrentBudget(openedBudget, vm)
            require(name.isNotBlank()) { "Enter an account name." }
            val opening = amountValue(balance)
            // Only tracking accounts can stay out of net worth.
            val counted = kind != "tracking" || netWorth
            if (original == null) {
                if (note.isBlank() && counted) vm.saveAccount(name = name, kind = kind, openingBalance = opening, accountType = type)
                else {
                    val record = JSONObject().put("id", UUID.randomUUID().toString()).put("name", name.trim()).put("kind", kind).put("openingBalance", opening)
                        .put("archived", false).put("accountType", type).put("note", note).put("netWorth", counted)
                    vm.editBudget { draft -> createAccount(draft, record) }
                }
            } else vm.upsert("accounts", original.copyJson().put("name", name.trim()).put("accountType", type).put("note", note).put("openingBalance", opening)
                .put("archived", archived).put("netWorth", counted))
        }.onSuccess { close() }.onFailure { error = it.message }
    }) {
        Field(name, { name = it }, "Account name")
        Choice("Account type", type, typeChoices, { type = it })
        Notice(when (kind) { "cash" -> "Its money is in your budget, ready to assign."; "credit" -> "A credit card payment category is created for it."; else -> "Tracked outside the budget, in net worth." },
            tone = "info", icon = iconForType(type, kind))
        Field(balance, { balance = it }, if (original == null) "Current balance (${budget.text("currency")})" else "Opening balance (${budget.text("currency")})", true)
        Text(listOfNotNull(if (AccountTypes.isLiability(type)) "Enter what you owe as a negative amount." else if (original == null) "For debt, enter a negative balance." else null,
            if (original == null) null else "Changing an opening balance changes the account’s entire history.").joinToString(" "),
            style = MaterialTheme.typography.bodySmall, color = ur.muted)
        if (original != null) Text("To switch between cash, credit and tracking, create a new account so past transactions keep their budget treatment.",
            style = MaterialTheme.typography.bodySmall, color = ur.muted)
        Field(note, { note = it }, "Note", lines = 3)
        if (kind == "tracking" || original != null) ListCard {
            if (kind == "tracking") SwitchRow("Count in net worth", netWorth, { netWorth = it }, divider = original != null,
                subtitle = if (netWorth) null else "Its balance still shows and appears in reports, but isn't added to net worth.")
            if (original != null) SwitchRow("Account closed", archived, { archived = it }, subtitle = "History and balance stay in the budget.")
        }
        FormError(error)
    }
}

/** Reconciling, as YNAB asks it: is the cleared balance what the bank says? If not, enter the bank's. */
@Composable
internal fun ReconcileDialog(account: JSONObject, budget: JSONObject, summary: JSONObject?, vm: BudgetViewModel, close: () -> Unit) {
    val openedBudget = remember { budget }
    val currency = budget.text("currency")
    val total = remember(summary, account) { summary?.rows("accounts")?.firstOrNull { it.text("id") == account.text("id") } }
    var differs by remember { mutableStateOf(false) }
    var balance by remember { mutableStateOf(amountText(total?.optLong("cleared") ?: 0)) }
    var date by remember { mutableStateOf(LocalDate.now().toString()) }
    var preview by remember { mutableStateOf<Long?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val adjustmentId = remember { UUID.randomUUID().toString() }
    val contextKey = remember(budget, balance, date) { Any() }
    val currentContext by rememberUpdatedState(contextKey)
    val previews = rememberPreviewJobs(contextKey)
    LaunchedEffect(budget) { preview = null; loading = false }
    fun review() = runCatching {
        requireCurrentBudget(openedBudget, vm)
        val params = JSONObject().put("accountId", account.text("id")).put("balance", amountValue(balance)).put("date", date).put("adjustmentId", adjustmentId)
        loading = true
        previews.track(vm.query("reconcile", params, onError = { if (currentContext == contextKey) loading = false }) { candidate ->
            if (currentContext == contextKey) { preview = candidate.row("transactions", adjustmentId)?.optLong("amount") ?: 0; loading = false }
        })
    }.onFailure { error = it.message }
    FormDialog("Reconcile ${account.text("name")}", close, confirm = if (preview == null) "Review" else if (preview == 0L) "Reconcile" else "Adjust & finish", onConfirm = {
        runCatching {
            requireCurrentBudget(openedBudget, vm)
            if (preview == null) review()
            else { vm.runCommand("reconcile", JSONObject().put("accountId", account.text("id")).put("balance", amountValue(balance)).put("date", date).put("adjustmentId", adjustmentId)); close() }
        }.onFailure { error = it.message }
    }, enabled = total != null && !loading && (differs || preview != null)) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            Text("Is your cleared balance", color = ur.text2, style = MaterialTheme.typography.bodyLarge)
            Text(money(total?.optLong("cleared") ?: 0, currency), fontSize = 34.sp, fontWeight = FontWeight.ExtraBold, style = Tabular, color = ur.text)
            Text("what your bank shows?", color = ur.text2, style = MaterialTheme.typography.bodyLarge)
        }
        if (!differs && preview == null) Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SecondaryButton("No", { differs = true }, Modifier.weight(1f))
            PrimaryButton("Yes", { balance = amountText(total?.optLong("cleared") ?: 0); review() }, Modifier.weight(1f), enabled = total != null && !loading, color = ur.positive)
        }
        if (differs) {
            Field(balance, { balance = it; preview = null; loading = false }, "Bank's balance", true)
            DateField(date, { date = it; preview = null; loading = false }, "Statement date")
            Text("Mark the transactions on your statement as cleared first; any difference left becomes an adjustment.", color = ur.muted, style = MaterialTheme.typography.bodySmall)
        }
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth(), color = ur.accent)
        preview?.let {
            if (it == 0L) Notice("Balances match. Cleared transactions will be locked as reconciled.", tone = "positive", icon = Icons.Outlined.Lock)
            else Notice("An adjustment of ${money(it, currency)} will be recorded. Look for missing or incorrect transactions first.", tone = "attention", icon = Icons.Outlined.WarningAmber)
        }
        FormError(error)
    }
}

internal val accountTypes = listOf("checking" to "Checking", "savings" to "Savings", "cash" to "Cash", "creditCard" to "Credit card", "lineOfCredit" to "Line of credit", "investment" to "Investment", "retirement" to "Retirement", "mortgage" to "Mortgage", "autoLoan" to "Auto loan", "studentLoan" to "Student loan", "personalLoan" to "Personal loan", "medicalDebt" to "Medical debt", "property" to "Property", "vehicle" to "Vehicle", "receivable" to "Receivable", "otherAsset" to "Other asset", "otherDebt" to "Other debt")
