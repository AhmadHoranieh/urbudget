import Charts
import SwiftUI

// MARK: Loan list

/// A loan row: a debt with its details, or one still waiting for them.
private struct LoanLine: Identifiable {
    var id: String
    var account: JSON
    var name: String
    var subtitle: String
    var owed: Int64
    var terms: JSON?
}

private func loanLines(budget: JSON, balances: [String: Int64], month: String) -> [LoanLine] {
    let currency = budget.text("currency")
    var loans: [String: JSON] = [:]
    for loan in budget.rows("loans") { loans[loan.text("accountId")] = loan }
    let saved = Set(loans.keys)
    return budget.rows("accounts").compactMap { account in
        let id = account.text("id")
        let balance = balances[id] ?? account.long("openingBalance")
        let terms = loans[id]
        if account.flag("archived") && terms == nil || !LoanMath.hasLoan(account, balance: balance, saved: saved) { return nil }
        let subtitle = terms.map { "Payment \(money($0.long("monthlyPayment"), currency)) · \(LoanMath.rateText(LoanMath.rateIn($0, month: month), decimal: Money.decimalMark()))%" }
            ?? "Add loan details to see the payoff date"
        return LoanLine(id: id, account: account, name: account.text("name"), subtitle: subtitle, owed: max(0, -balance), terms: terms)
    }
}

/// An account to open in the loan editor.
private struct LoanEditorRequest: Identifiable { var id: String }

/// Loan planner: each debt with its payment, payoff date and what's owed; a tap opens its details
/// and payoff planner (MoreScreen.kt's LoanPlannerPage).
struct LoanPlannerView: View {
    @Environment(BudgetStore.self) private var store
    @State private var editing: LoanEditorRequest?
    @State private var payoffs: [String: String] = [:]

    init() {}

    var body: some View {
        let currency = store.currency
        let month = String(Dates.today.prefix(7))
        let lines = store.budget.map { loanLines(budget: $0, balances: store.planningBalances, month: month) } ?? []
        List {
            if lines.isEmpty {
                EmptyState(title: "Make a payoff plan",
                           detail: "Add a tracking account of a loan type, such as Mortgage or Auto loan, with what you owe as a negative balance. Then add its rate and payment here.",
                           symbol: "chart.line.downtrend.xyaxis")
                    .listRowBackground(Color.clear)
            } else {
                Section {
                    Figure(label: "Owed on \(lines.count == 1 ? "1 loan" : "\(lines.count) loans")", value: money(lines.reduce(0) { $0 + $1.owed }, currency))
                        .padding(.vertical, 4)
                }
                Section {
                    ForEach(lines) { line in
                        Button { editing = LoanEditorRequest(id: line.id) } label: { row(line, currency) }
                            .accessibilityHint("Opens the loan's details and payoff planner")
                    }
                } footer: {
                    Text("Owed is what's left on each loan. The planner tries extra payments without changing anything; Record payment adds the transfer and the month's interest.")
                }
            }
        }
        .groupedList()
        .navigationTitle("Loan planner")
        .sheet(item: $editing) { LoanEditor(accountId: $0.id) }
        .task(id: store.version) { await loadPayoffs(lines) }
    }

    private func row(_ line: LoanLine, _ currency: String) -> some View {
        HStack(spacing: 12) {
            AccountIcon(account: line.account, balance: -line.owed)
            VStack(alignment: .leading, spacing: 2) {
                Text(line.name).foregroundStyle(Color.primary)
                Text(line.subtitle).font(.footnote).foregroundStyle(Color.secondary)
                if let payoff = payoffs[line.id] {
                    Text(payoff).font(.footnote).foregroundStyle(line.owed == 0 ? Color.urPositive : .secondary)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                Text(money(line.owed, currency)).monospacedDigit().fontWeight(.semibold).foregroundStyle(Color.primary)
                Text("Owed").font(.caption).foregroundStyle(Color.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// When each loan with details is paid off at its current payment, from the shared engine.
    private func loadPayoffs(_ lines: [LoanLine]) async {
        guard let budget = store.budget else { return }
        let today = Dates.today
        var found: [String: String] = [:]
        for line in lines {
            guard let terms = line.terms else { continue }
            if line.owed == 0 { found[line.id] = "Paid off"; continue }
            let start = await Task.detached(priority: .utility) { LoanMath.nextPayment(budget, accountId: line.id, today: today) }.value
            guard !Task.isCancelled else { return }
            if let projection = try? await store.planningPure("loanProjection", ["balance": .int(line.owed), "terms": terms, "start": .string(start)]) {
                found[line.id] = "Paid off \(Dates.shortMonthLabel(String(projection.text("payoffDate").prefix(7))))"
            }
        }
        if !Task.isCancelled { payoffs = found }
    }
}

// MARK: Loan editor

private enum LoanRoute: Hashable { case category, schedule }

/// An engine reply, or the sentence it failed with.
private enum LoanOutcome {
    case value(JSON)
    case failure(String)

    var value: JSON? { if case .value(let value) = self { return value } else { return nil } }
    var failure: String? { if case .failure(let message) = self { return message } else { return nil } }
}

/// What the payoff planner works out, so a result is only shown for the inputs it was worked out from.
private struct LoanPlanKey: Hashable {
    var terms: String
    var start: String
    var owed: Int64
    var left: Int64
    var extra: Int64
    var lump: Int64
    var changed: Bool
}

private struct LoanNeededKey: Hashable {
    var terms: String
    var start: String
    var due: String
    var left: Int64
    var lump: Int64
}

/// One point of the payoff chart.
private struct LoanChartPoint: Identifiable {
    var id: String
    var series: String
    var date: Date
    var owed: Double
}

/// A loan: where it stands, its details (rate, payment, fees or escrow, payment category and dated
/// rate changes), and a payoff planner that only tries things out (LoanDialog.kt, LoanPlanner.tsx).
/// Recording a payment uses the saved details, never unsaved ones; the maths is the shared engine's.
struct LoanEditor: View {
    @Environment(BudgetStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    private let accountId: String

    init(accountId: String) { self.accountId = accountId }

    @State private var loaded = false
    @State private var baseline = LoanDraft()
    @State private var draft = LoanDraft()
    @State private var extraText = ""
    @State private var oneOffText = ""
    @State private var by = ""
    @State private var start: String?
    @State private var plan: (key: LoanPlanKey, base: LoanOutcome?, scenario: LoanOutcome?)?
    @State private var needed: (key: LoanNeededKey, outcome: LoanOutcome)?
    @State private var imported: JSON?
    @State private var error: String?
    @State private var saving = false
    @State private var paying = false
    @State private var confirmRemove = false
    @State private var confirmDiscard = false
    @State private var route: [LoanRoute] = []

    private var today: String { Dates.today }
    private var account: JSON? { store.budget?.row("accounts", id: accountId) }
    private var saved: JSON? { store.budget?.rows("loans").first { $0.text("accountId") == accountId } }
    private var balance: Int64 { store.planningBalances[accountId] ?? account?.long("openingBalance") ?? 0 }
    private var owed: Int64 { max(0, -balance) }
    private var feeLabel: String { account.map { AccountTypes.infer($0, balance: balance) } == "mortgage" ? "Escrow" : "Fees" }
    private var dirty: Bool { draft != baseline }
    private var terms: Result<JSON, Error> { Result { try draft.terms(accountId: accountId, saved: saved, requireCategory: false) } }
    private var extra: Int64? { LoanMath.plannerAmount(extraText) }
    private var oneOff: Int64? { LoanMath.plannerAmount(oneOffText) }
    /// Recording a payment adds the month's interest and fees with its first payment. While this
    /// month's is still to come, a one-off now goes in with it, after them; once it's in, they're
    /// charged and the one-off comes off what's owed.
    private var firstThisMonth: Bool { start?.prefix(7) == today.prefix(7) }
    private var lump: Int64 { firstThisMonth ? oneOff ?? 0 : 0 }
    private var left: Int64 { firstThisMonth ? owed : max(0, owed - (oneOff ?? 0)) }
    private var changed: Bool { (extra ?? 0) > 0 || (oneOff ?? 0) > 0 }

    private var planKey: LoanPlanKey? {
        guard let value = try? terms.get(), let start else { return nil }
        return LoanPlanKey(terms: value.serialized(), start: start, owed: owed, left: left, extra: extra ?? 0, lump: lump, changed: changed)
    }

    private var neededKey: LoanNeededKey? {
        guard let value = try? terms.get(), let start, !by.isEmpty else { return nil }
        return LoanNeededKey(terms: value.serialized(), start: start, due: by, left: left, lump: lump)
    }

    var body: some View {
        NavigationStack(path: $route) {
            Group {
                if let account { form(account) } else { ContentUnavailableView("This account was deleted", systemImage: "trash") }
            }
            .navigationDestination(for: LoanRoute.self) { destination($0) }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(saving || dirty)
        .onAppear(perform: load)
        .onChange(of: store.version) {
            // Without unsaved edits the form follows the budget (a payment just recorded, a sync).
            let fresh = LoanDraft(saved: saved)
            if draft == baseline { baseline = fresh; draft = fresh }
        }
        .task(id: store.version) {
            guard let budget = store.budget else { return }
            let accountId = accountId
            let today = today
            let next = await Task.detached(priority: .userInitiated) { LoanMath.nextPayment(budget, accountId: accountId, today: today) }.value
            if !Task.isCancelled { start = next }
        }
        .task(id: planKey) { await project() }
        .task(id: neededKey) { await solve() }
        .task {
            // A loan imported from YNAB may carry its terms; offer them while nothing is saved.
            guard saved == nil, account?["source"].isObject == true else { return }
            imported = try? await store.query("loanTerms", ["accountId": .string(accountId)])
        }
        .sheet(isPresented: $paying) {
            if let account, let saved { LoanPaymentSheet(account: account, terms: saved) }
        }
        .confirmationDialog("Remove loan details?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive, action: remove)
        } message: {
            Text("The payoff date and interest are no longer worked out for \(account?.text("name") ?? "this account"). Its transactions stay. You can undo this.")
        }
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        let fresh = LoanDraft(saved: saved)
        baseline = fresh
        draft = fresh
    }

    // MARK: Engine

    private func project() async {
        guard let key = planKey, let value = try? terms.get(), owed > 0 else { return }
        try? await Task.sleep(for: .milliseconds(200))
        if Task.isCancelled { return }
        let base: LoanOutcome
        do {
            base = .value(try await store.planningPure("loanProjection", ["balance": .int(key.owed), "terms": value, "start": .string(key.start)]))
        } catch {
            base = .failure(BudgetStore.readable(error))
        }
        var scenario: LoanOutcome?
        if key.changed && key.left > 0 {
            do {
                scenario = .value(try await store.planningPure("loanProjection", ["balance": .int(key.left), "terms": value, "start": .string(key.start),
                                                                                  "extra": .int(key.extra), "lump": .int(key.lump)]))
            } catch {
                scenario = .failure(BudgetStore.readable(error))
            }
        }
        if !Task.isCancelled { plan = (key, base, scenario) }
    }

    /// The payment that clears what's left by the chosen date; the difference becomes the extra.
    private func solve() async {
        guard let key = neededKey, let value = try? terms.get(), key.left > 0 else { return }
        try? await Task.sleep(for: .milliseconds(200))
        if Task.isCancelled { return }
        do {
            let reply = try await store.planningPure("loanPaymentByDate", ["balance": .int(key.left), "terms": value, "start": .string(key.start),
                                                                          "due": .string(key.due), "lump": .int(key.lump)])
            if Task.isCancelled { return }
            needed = (key, .value(reply))
            let amount = reply.isObject ? reply.long("items") : reply.int
            let more = amount - value.long("monthlyPayment")
            extraText = more > 0 ? Money.editable(more) : ""
        } catch {
            if !Task.isCancelled { needed = (key, .failure(BudgetStore.readable(error))) }
        }
    }

    // MARK: Form

    private func form(_ account: JSON) -> some View {
        let currency = store.currency
        let saved = saved
        let termsValue = try? terms.get()
        // The last plan stays on screen while the next one is worked out, so typing doesn't flicker.
        let current = planKey != nil && owed > 0 ? plan : nil
        let fresh = current != nil && current?.key == planKey
        let base = current?.base?.value
        let then = changed && left > 0 ? current?.scenario?.value : nil
        let paidNow = changed && (then.map { $0.long("months") == 1 && (oneOff ?? 0) >= ($0.rows("schedule").first?.long("payment") ?? .max) } ?? (left == 0))
        let fees = termsValue?.long("monthlyFees") ?? 0
        return Form {
            facts(account, saved: saved, terms: termsValue, base: base, currency: currency)
            if let saved, !dirty { interestNotice(saved, currency: currency) }
            if saved == nil, let imported {
                Section {
                    Notice(text: "Your import has this loan's rate and payment.", tone: "info", icon: "square.and.arrow.down", action: "Use them") {
                        var fresh = LoanDraft(saved: imported)
                        if fresh.category.isEmpty { fresh.category = draft.category }
                        draft = fresh
                    }
                }
                .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                .listRowBackground(Color.clear)
            }
            detailsSection(currency)
            ratesSection
            if case .failure(let problem) = terms, !draft.isEmpty { FormErrorView(message: BudgetStore.readable(problem)) }
            if dirty && saved != nil {
                Notice(text: "Unsaved changes. The planner below already tries them; Save keeps them.", tone: "info")
                    .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                    .listRowBackground(Color.clear)
            }
            plannerSection(currency, terms: termsValue)
            if fresh, let message = current?.base?.failure { FormErrorView(message: message) }
            if fresh, changed && left > 0, let message = current?.scenario?.failure { FormErrorView(message: message) }
            if let base {
                results(base: base, then: then, paidNow: paidNow, fees: fees, updating: !fresh, currency: currency)
            } else if termsValue != nil && owed > 0 && !fresh {
                Section { ProgressView().frame(maxWidth: .infinity) }
            }
            Section {
                if saved != nil {
                    Button("Remove loan details", role: .destructive) { confirmRemove = true }.frame(maxWidth: .infinity)
                }
            } footer: {
                Text("Interest compounds monthly and each charge is rounded to the cent, so a lender's own figures may differ a little. Recording a payment adds local transactions; it doesn't pay your bank.")
            }
            if let error { FormErrorView(message: error) }
        }
        .navigationTitle("Loan · \(account.text("name"))")
        .inlineTitle()
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { if dirty { confirmDiscard = true } else { dismiss() } }
                    .confirmationDialog("Discard your changes to the loan details?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                        Button("Discard changes", role: .destructive) { dismiss() }
                        Button("Keep editing", role: .cancel) {}
                    }
            }
            ToolbarItem(placement: .confirmationAction) {
                if saving {
                    ProgressView()
                } else {
                    Button("Save", action: save).fontWeight(.semibold).disabled(termsValue == nil || saved != nil && !dirty)
                }
            }
        }
    }

    /// Where the loan stands: owed, rate and payment, when it's paid off and the interest still to pay (LoanHeader.tsx).
    private func facts(_ account: JSON, saved: JSON?, terms: JSON?, base: JSON?, currency: String) -> some View {
        let month = String(today.prefix(7))
        let rate = terms.map { "\(LoanMath.rateText(LoanMath.rateIn($0, month: month), decimal: Money.decimalMark()))%" } ?? "—"
        let payoff = owed == 0 ? "Paid off" : base.map { Dates.shortMonthLabel(String($0.text("payoffDate").prefix(7))) } ?? "—"
        let interest = owed == 0 ? money(0, currency) : base.map { money($0.long("totalInterest"), currency) } ?? "—"
        return Section {
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 12) {
                GridRow {
                    Figure(label: "Owed", value: money(owed, currency))
                    Figure(label: "Rate", value: rate)
                    Figure(label: "Payment", value: terms.map { money($0.long("monthlyPayment"), currency) } ?? "—")
                }
                GridRow {
                    Figure(label: "Paid off", value: payoff)
                    Figure(label: "Interest to pay", value: interest).gridCellColumns(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)
            if owed > 0 && !account.flag("archived") {
                Button { paying = true } label: { Label("Record payment", systemImage: "banknote") }
                    .disabled(saved == nil || dirty)
            }
        } footer: {
            if owed > 0 && !account.flag("archived") {
                Text(saved == nil ? "Save the loan details first to record a payment with them."
                     : dirty ? "Save your changes first: a payment uses the saved details."
                     : "\((terms?.long("monthlyFees") ?? 0) > 0 ? "Interest and \(feeLabel.lowercased()) are" : "Interest is") added to the loan with the first payment each month.")
            }
        }
    }

    /// This month's payment is in, but not its interest: a transfer entered before the loan had details.
    @ViewBuilder private func interestNotice(_ saved: JSON, currency: String) -> some View {
        let month = String(today.prefix(7))
        let charges = LoanMath.rateIn(saved, month: month) > 0 || saved.long("monthlyFees") > 0
        let payments = charges ? (store.budget.map { LoanMath.paymentsWithoutInterest($0, accountId: accountId, today: today) } ?? []) : []
        if !payments.isEmpty {
            Section {
                Notice(text: "This month's payment is in, but its interest\(saved.long("monthlyFees") > 0 ? " and \(feeLabel.lowercased())" : "") isn't on the loan yet.",
                       tone: "attention", icon: "percent", action: "Add") {
                    addInterest(payments.map { $0.text("id") })
                }
            }
            .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
            .listRowBackground(Color.clear)
        }
    }

    private func detailsSection(_ currency: String) -> some View {
        Section {
            LabeledContent("Interest rate (%)") {
                TextField("0", text: $draft.rate).decimalKeyboard().multilineTextAlignment(.trailing).monospacedDigit()
            }
            LabeledContent("Monthly payment") {
                TextField(money(0, currency), text: $draft.payment).decimalKeyboard().multilineTextAlignment(.trailing).monospacedDigit()
            }
            LabeledContent("Monthly \(feeLabel.lowercased())") {
                TextField(money(0, currency), text: $draft.fees).decimalKeyboard().multilineTextAlignment(.trailing).monospacedDigit()
            }
            NavigationLink(value: LoanRoute.category) {
                PlanningPickerRow(icon: "tag", label: "Payment category", value: planningCategoryName(store.budget, draft.category),
                                  placeholder: "Where the payment comes from")
            }
        } header: {
            Text("Loan details")
        } footer: {
            Text("What the payoff date and the interest are worked out from. Amounts in \(currency).")
        }
    }

    private var ratesSection: some View {
        Section {
            ForEach($draft.rates) { $row in
                VStack(alignment: .leading, spacing: 8) {
                    MonthRow(title: "From", month: $row.month)
                    LabeledContent("New annual rate (%)") {
                        TextField("0", text: $row.rate).decimalKeyboard().multilineTextAlignment(.trailing).monospacedDigit()
                    }
                }
                .swipeActions {
                    Button(role: .destructive) { draft.rates.removeAll { $0.id == row.id } } label: { Label("Remove", systemImage: "trash") }
                }
                .contextMenu {
                    Button(role: .destructive) { draft.rates.removeAll { $0.id == row.id } } label: { Label("Remove rate change", systemImage: "trash") }
                }
            }
            Button {
                let month = Dates.currentMonth
                let taken = draft.rates.contains { $0.month == month }
                draft.rates.append(LoanRateDraft(month: taken ? Dates.addMonths(month, 1) : month, rate: draft.rate))
            } label: {
                Label("Add rate change", systemImage: "plus")
            }
        } header: {
            Text("Rate changes")
        } footer: {
            Text("For a variable rate: each one replaces the rate above from its month. Swipe to remove one.")
        }
    }

    private func plannerSection(_ currency: String, terms: JSON?) -> some View {
        Section {
            if owed == 0 {
                Notice(text: "Nothing is owed on this account.", tone: "positive", icon: "checkmark.circle.fill")
                    .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
            }
            LabeledContent("Extra each month") {
                TextField(money(0, currency), text: $extraText).decimalKeyboard().multilineTextAlignment(.trailing).monospacedDigit()
            }
            LabeledContent("One-off payment now") {
                TextField(money(0, currency), text: $oneOffText).decimalKeyboard().multilineTextAlignment(.trailing).monospacedDigit()
            }
            if by.isEmpty {
                Button { by = Dates.addDays(today, 365 * 5) } label: { Label("Pay off by a date…", systemImage: "calendar.badge.clock") }
            } else {
                HStack {
                    DayPicker(title: "Pay off by", iso: $by)
                    Button {
                        by = ""
                        needed = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(Color.secondary)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Clear the payoff date")
                }
            }
            if extra == nil || oneOff == nil { FormErrorView(message: "Enter amounts like 50 or 25.50.") }
            if let terms, let key = neededKey, let needed, needed.key == key {
                neededNotice(needed.outcome, terms: terms, currency: currency)
            }
        } header: {
            Text("Payoff planner")
        } footer: {
            Text("Only a sandbox: nothing here changes your budget or the loan's details.")
        }
    }

    @ViewBuilder private func neededNotice(_ outcome: LoanOutcome, terms: JSON, currency: String) -> some View {
        let month = Dates.monthLabel(String(by.prefix(7)))
        let payment = terms.long("monthlyPayment")
        switch outcome {
        case .failure(let message):
            Notice(text: message, tone: "attention", icon: "calendar")
                .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
        case .value(let reply):
            let amount = reply.isObject ? reply.long("items") : reply.int
            Notice(text: amount > payment
                   ? "To pay it off by \(month), pay \(money(amount, currency)) a month: \(money(amount - payment, currency)) more than now, tried below as the extra."
                   : "Your current payment already pays it off by \(month).",
                   tone: "info", icon: "calendar")
                .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
        }
    }

    @ViewBuilder private func results(base: JSON, then: JSON?, paidNow: Bool, fees: Int64, updating: Bool, currency: String) -> some View {
        let showChanges = changed && (then != nil || paidNow)
        if showChanges {
            Section {
                HStack(alignment: .top) {
                    Figure(label: "Interest saved", value: money(base.long("totalInterest") - (then?.long("totalInterest") ?? 0), currency), color: .urPositive)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Figure(label: "Time saved", value: LoanMath.span(Int(base.long("months") - (then?.long("months") ?? 0))), color: .urPositive)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Figure(label: "Paid off", value: paidNow || then == nil ? "Now" : Dates.shortMonthLabel(String(then!.text("payoffDate").prefix(7))), color: .urPositive)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, 4)
                .accessibilityElement(children: .combine)
            }
            .listRowBackground(Color.urPositive.opacity(0.12))
        }
        Section {
            comparison(base: base, then: then, paidNow: paidNow, fees: fees, currency: currency)
            chart(base: base, then: then)
            let shown = (then ?? base).rows("schedule")
            if !shown.isEmpty {
                NavigationLink(value: LoanRoute.schedule) {
                    Label("Payment schedule\(then != nil ? " with changes" : "") · \(shown.count) payments", systemImage: "list.bullet.rectangle")
                }
            }
        } header: {
            HStack {
                Text("Current plan\(changed ? " and with changes" : "")")
                Spacer()
                if updating { ProgressView().controlSize(.small) }
            }
        }
    }

    private func comparison(base: JSON, then: JSON?, paidNow: Bool, fees: Int64, currency: String) -> some View {
        func payoff(_ p: JSON) -> String { Dates.shortMonthLabel(String(p.text("payoffDate").prefix(7))) }
        var rows: [(String, (JSON) -> String)] = [
            ("Paid off", payoff),
            ("Time left", { LoanMath.span(Int($0.long("months"))) }),
            ("Interest", { money($0.long("totalInterest"), currency) }),
        ]
        if fees > 0 { rows.append((feeLabel, { money($0.long("totalFees"), currency) })) }
        rows.append(("Total cost", { money(owed + $0.long("totalInterest") + $0.long("totalFees"), currency) }))
        return Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 8) {
            GridRow {
                Color.clear.frame(height: 1)
                Text("Current plan").font(.caption.weight(.semibold)).foregroundStyle(Color.secondary)
                if changed { Text("With changes").font(.caption.weight(.semibold)).foregroundStyle(Color.urAccent) }
            }
            ForEach(rows.indices, id: \.self) { index in
                let (label, value) = rows[index]
                GridRow {
                    Text(label).font(.subheadline).foregroundStyle(Color.secondary)
                    Text(value(base)).font(.subheadline.weight(.semibold)).monospacedDigit()
                    if changed {
                        Text(then.map(value) ?? (paidNow ? "—" : "")).font(.subheadline.weight(.semibold)).monospacedDigit().foregroundStyle(Color.urAccent)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    /// The balance after each payment, the current plan against the changes, from today's balance (LoanPlanner.tsx's PayoffChart).
    @ViewBuilder private func chart(base: JSON, then: JSON?) -> some View {
        let now = Dates.pickerDate(today)
        let points = chartPoints(base, series: "Current plan", from: owed, now: now) + (then.map { chartPoints($0, series: "With changes", from: left, now: now) } ?? [])
        if points.count > 2 {
            Chart(points) { point in
                LineMark(x: .value("Date", point.date), y: .value("Owed", point.owed), series: .value("Plan", point.series))
                    .foregroundStyle(by: .value("Plan", point.series))
                    .lineStyle(StrokeStyle(lineWidth: 2, dash: point.series == "Current plan" && then != nil ? [5, 4] : []))
                    .interpolationMethod(.monotone)
            }
            .chartForegroundStyleScale(["Current plan": Color.secondary, "With changes": Color.urAccent])
            .chartLegend(then != nil ? .visible : .hidden)
            .chartYAxis {
                AxisMarks { value in
                    AxisGridLine()
                    AxisValueLabel { if let owed = value.as(Double.self) { Text(owed.formatted(.number.notation(.compactName))) } }
                }
            }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 5)) { _ in
                    AxisGridLine()
                    AxisValueLabel(format: .dateTime.year())
                }
            }
            .frame(height: 200)
            .padding(.vertical, 6)
            .accessibilityLabel("Balance owed after each payment")
        }
    }

    private func chartPoints(_ projection: JSON, series: String, from: Int64, now: Date) -> [LoanChartPoint] {
        [LoanChartPoint(id: "\(series):now", series: series, date: now, owed: Double(from) / 100)]
            + projection.rows("schedule").enumerated().map { index, row in
                LoanChartPoint(id: "\(series):\(index)", series: series, date: Dates.pickerDate(row.text("date")), owed: Double(row.long("balance")) / 100)
            }
    }

    @ViewBuilder private func destination(_ route: LoanRoute) -> some View {
        switch route {
        case .category:
            CategoryPicker(title: "Payment category", month: Dates.currentMonth, selected: draft.category, includePayment: false) { picked in
                draft.category = picked
                self.route = []
            }
        case .schedule:
            let current = planKey != nil ? plan : nil
            let shown = (changed && left > 0 ? current?.scenario?.value : nil) ?? current?.base?.value
            LoanScheduleList(rows: shown?.rows("schedule") ?? [], feeLabel: feeLabel, currency: store.currency)
        }
    }

    // MARK: Changes

    private func save() {
        let record: JSON
        do {
            record = try draft.terms(accountId: accountId, saved: saved, requireCategory: true)
        } catch {
            self.error = BudgetStore.readable(error)
            return
        }
        let guarded = saved.map { (collection: "loans", record: $0) }
        let name = account?.text("name") ?? "the loan"
        saving = true
        error = nil
        Task {
            defer { saving = false }
            do {
                try await store.planningEdit(original: guarded) { try $0.upsertRecord("loans", record) }
                store.showToast("Saved the loan details for \(name).", undo: true)
                baseline = draft
                dismiss()
            } catch {
                self.error = BudgetStore.readable(error)
            }
        }
    }

    private func remove() {
        guard let saved else { return }
        let accountId = accountId
        saving = true
        Task {
            defer { saving = false }
            do {
                try await store.planningEdit(original: (collection: "loans", record: saved)) { try $0.removeRecord("loans", id: accountId) }
                store.showToast("Removed the loan details.", undo: true)
                dismiss()
            } catch {
                self.error = BudgetStore.readable(error)
            }
        }
    }

    /// Adds the month's interest (and fees) for payments already in, as recording them would have (loans.rs's apply_new_payments).
    private func addInterest(_ ids: [String]) {
        saving = true
        error = nil
        Task {
            defer { saving = false }
            do {
                try await store.planningCommand("applyLoanPayments", ["ids": JSON(ids)], original: saved.map { (collection: "loans", record: $0) })
                store.showToast("Added this month's interest to the loan.", undo: true)
            } catch {
                self.error = BudgetStore.readable(error)
            }
        }
    }
}

/// Every payment until the loan is paid off, a section a year.
private struct LoanScheduleList: View {
    var rows: [JSON]
    var feeLabel: String
    var currency: String

    var body: some View {
        let years = Dictionary(grouping: rows.enumerated(), by: { String($0.element.text("date").prefix(4)) })
        let order = years.keys.sorted()
        List {
            if rows.isEmpty {
                EmptyState(title: "No payments", detail: "Nothing is owed, or the plan is still being worked out.", symbol: "list.bullet.rectangle")
            }
            ForEach(order, id: \.self) { year in
                let lines = years[year] ?? []
                Section {
                    ForEach(lines, id: \.offset) { _, row in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Text(Money.date(row.text("date"))).fontWeight(.semibold)
                                Spacer()
                                Text(money(row.long("payment"), currency)).monospacedDigit().fontWeight(.semibold)
                            }
                            Text("Interest \(money(row.long("interest"), currency)) · \(feeLabel) \(money(row.long("fees"), currency)) · Principal \(money(row.long("principal"), currency))")
                                .font(.footnote).foregroundStyle(Color.secondary)
                            Text("Still owed \(money(row.long("balance"), currency))").font(.footnote).monospacedDigit().foregroundStyle(Color.secondary)
                        }
                        .padding(.vertical, 2)
                        .accessibilityElement(children: .combine)
                    }
                } header: {
                    HStack {
                        Text(year)
                        Spacer()
                        Text("Interest \(money(lines.reduce(0) { $0 + $1.element.long("interest") }, currency))").textCase(nil)
                    }
                }
            }
        }
        .groupedList()
        .navigationTitle("Payment schedule")
        .inlineTitle()
    }
}

// MARK: Recording a payment

private enum LoanPaymentRoute: Hashable { case from, category }

/// Recording a loan payment (LoanPayment.tsx): a transfer from a budget account to the loan,
/// spending its payment category, with the saved loan details. The month's interest and fees go
/// onto the loan with its first payment that month (loans.rs's record).
private struct LoanPaymentSheet: View {
    @Environment(BudgetStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    var account: JSON
    var terms: JSON

    // Stable across a retry, so a save that failed late records one payment, not two.
    @State private var paymentId = UUID().uuidString.lowercased()
    @State private var pad: PadState
    @State private var keypad = false
    @State private var from = ""
    @State private var date = Dates.today
    @State private var category: String
    @State private var error: String?
    @State private var saving = false
    @State private var route: [LoanPaymentRoute] = []

    init(account: JSON, terms: JSON) {
        self.account = account
        self.terms = terms
        _pad = State(initialValue: PadState(terms.long("monthlyPayment")))
        _category = State(initialValue: terms.text("categoryId"))
    }

    private var loanId: String { account.text("id") }
    private var sources: [JSON] {
        (store.budget?.rows("accounts") ?? []).filter { $0.text("kind") == "cash" && !$0.flag("archived") && AccountTypes.onBudget($0) }
    }

    var body: some View {
        let currency = store.currency
        let balances = store.planningBalances
        let balance = balances[loanId] ?? account.long("openingBalance")
        let mortgage = AccountTypes.infer(account, balance: balance) == "mortgage"
        let charges = terms.long("monthlyFees") > 0 ? "interest and \(mortgage ? "escrow" : "fees") are" : "interest is"
        let source = sources.first { $0.text("id") == from }
        NavigationStack(path: $route) {
            Form {
                Section {
                    HStack(alignment: .top) {
                        Figure(label: "Owed on the loan", value: money(max(0, -balance), currency))
                        Spacer()
                        Figure(label: "Monthly payment", value: money(terms.long("monthlyPayment"), currency), alignment: .trailing)
                    }
                    .accessibilityElement(children: .combine)
                }
                Section {
                    Button {
                        keypad = true
                        pad.fresh = true
                    } label: {
                        VStack(spacing: 4) {
                            PadAmount(pad: pad, currency: currency)
                            Text(keypad ? "Type the amount" : "Tap to change").font(.footnote).foregroundStyle(Color.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                    }
                    .listRowBackground(keypad ? Color.urAccent.opacity(0.12) : nil)
                    .accessibilityLabel("Amount, \(money(pad.cents ?? 0, currency)). Edit amount")
                }
                Section {
                    if sources.isEmpty {
                        Notice(text: "Add a cash account in your budget to pay the loan from.", tone: "info")
                    } else {
                        NavigationLink(value: LoanPaymentRoute.from) {
                            PlanningPickerRow(icon: "building.columns", label: "From", value: source?.text("name"), placeholder: "Choose account")
                        }
                    }
                    DatePicker(selection: Binding(get: { Dates.pickerDate(date) }, set: { date = Dates.fromPicker($0) }), displayedComponents: .date) {
                        Label("Date", systemImage: "calendar")
                    }
                    NavigationLink(value: LoanPaymentRoute.category) {
                        PlanningPickerRow(icon: "tag", label: "Category", value: store.budget?.row("categories", id: category)?.text("name"),
                                          placeholder: "Where the payment comes from", attention: category.isEmpty)
                    }
                } footer: {
                    Text("Recorded as a transfer from \(source?.text("name") ?? "the account you choose") to \(account.text("name")), spending the category. The month's \(charges) added to the loan with its first payment that month.")
                }
                if let error { FormErrorView(message: error) }
            }
            .navigationTitle("Pay \(account.text("name"))")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Pay", action: save).fontWeight(.semibold).disabled(sources.isEmpty || (pad.cents ?? 0) <= 0)
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if keypad { AmountKeypad(pad: pad) { keypad = false } }
            }
            .navigationDestination(for: LoanPaymentRoute.self) { destination($0) }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(saving)
        .task {
            guard from.isEmpty, let budget = store.budget else { return }
            let sources = sources
            let loanId = loanId
            from = await Task.detached(priority: .userInitiated) { LoanMath.defaultSource(budget, loanId: loanId, sources: sources, balances: balances) }.value
        }
    }

    @ViewBuilder private func destination(_ route: LoanPaymentRoute) -> some View {
        switch route {
        case .from:
            let currency = store.currency
            let balances = store.planningBalances
            List(sources, id: \.idText) { source in
                let id = source.text("id")
                Button {
                    from = id
                    self.route = []
                } label: {
                    HStack(spacing: 12) {
                        AccountIcon(account: source, balance: balances[id] ?? 0)
                        Text(source.text("name")).foregroundStyle(Color.primary)
                        Spacer()
                        Text(money(balances[id] ?? 0, currency)).monospacedDigit()
                        if id == from { Image(systemName: "checkmark").foregroundStyle(Color.urAccent).fontWeight(.semibold) }
                    }
                }
            }
            .groupedList()
            .navigationTitle("Pay from")
            .inlineTitle()
        case .category:
            CategoryPicker(title: "Payment category", month: String(date.prefix(7)), selected: category, includePayment: false) { picked in
                category = picked
                self.route = []
            }
        }
    }

    private func save() {
        attempt($error) {
            guard let amount = pad.cents else { throw AppError("Finish the sum first.") }
            guard !from.isEmpty else { throw AppError("Choose the account the payment comes from.") }
            guard amount > 0 else { throw AppError("Enter an amount to pay.") }
            guard !category.isEmpty else { throw AppError("Choose the category the payment comes from.") }
            guard Dates.day(date) != nil else { throw AppError("Choose a valid date.") }
            var chosen = terms
            chosen["categoryId"] = .string(category)
            let params: JSON = ["terms": chosen, "from": .string(from), "amount": .int(amount), "date": .string(date), "id": .string(paymentId)]
            let name = account.text("name")
            let currency = store.currency
            let original = (collection: "loans", record: terms)
            saving = true
            Task {
                defer { saving = false }
                do {
                    try await store.planningCommand("loanRecord", params, original: original)
                    store.showToast("Recorded a payment of \(money(amount, currency)) to \(name).", undo: true)
                    dismiss()
                } catch {
                    self.error = BudgetStore.readable(error)
                }
            }
        }
    }
}
