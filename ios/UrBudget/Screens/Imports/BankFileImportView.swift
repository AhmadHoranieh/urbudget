import SwiftUI
import UniformTypeIdentifiers

private let bankFormats: [(id: String, label: String)] = [("csv", "CSV"), ("ofx", "OFX"), ("qfx", "QFX"), ("qif", "QIF")]
private let bankDateOrders: [(id: String, label: String)] = [
    ("ymd", "Year-month-day (2026-10-31)"), ("dmy", "Day/month/year (31/10/2026)"), ("mdy", "Month/day/year (10/31/2026)"),
]
private let changedAgain = "Your budget changed, so these rows were checked again. Look them over, then import."

private enum BankFileRoute: Hashable { case account }

/// A statement's preview: its review rows and the budget revision they were checked against.
private struct BankFilePreview {
    var rows: [BankReviewRow]
    var summary: BankReviewSummary
    var revision: String
}

/// Imports a file a bank exported (BankImport.tsx, Android's BankImportDialog): choose the file,
/// preview it, decide what each row does (add it, match an existing transaction, or skip it),
/// then one budget change that Undo takes back.
struct BankFileImportView: View {
    @Environment(BudgetStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var account = ""
    @State private var format = "csv"
    @State private var dateOrder = "ymd"
    @State private var flipSigns = false
    @State private var fileName = ""
    @State private var content: String?
    @State private var preview: BankFilePreview?
    @State private var decisions: [Int: String] = [:]
    @State private var error: String?
    @State private var notice: String?
    @State private var loading = false
    @State private var saving = false
    @State private var picking = false
    @State private var confirmDiscard = false
    @State private var generation = 0
    @State private var route: [BankFileRoute] = []
    @State private var started = false
    /// A statement opened from another app, and the account it goes into (from an account's register).
    private let opened: URL?
    private let presetAccount: String

    init(file: URL? = nil, account: String = "") {
        opened = file
        presetAccount = account
    }

    private static let types: [UTType] = [.commaSeparatedText, .text]
        + ["ofx", "qfx", "qif"].compactMap { UTType(filenameExtension: $0) } + [.data]

    private var budget: JSON { store.budget ?? [:] }
    private var accounts: [JSON] { budget.rows("accounts").filter { !$0.flag("archived") } }
    private var accountName: String { budget.row("accounts", id: account)?.text("name") ?? "" }
    /// Only a CSV can write purchases as positive numbers; only CSV and QIF write dates in an order of their own.
    private var signs: Bool { format == "csv" }
    private var datesInFile: Bool { format == "csv" || format == "qif" }

    var body: some View {
        NavigationStack(path: $route) {
            Group {
                if let preview { review(preview) } else { setup }
            }
            .navigationTitle(preview == nil ? "Import bank file" : "Review import")
            .inlineTitle()
            .toolbar { toolbar }
            .navigationDestination(for: BankFileRoute.self) { _ in
                AccountPicker(selected: account) { id in
                    account = id
                    route.removeAll()
                }
            }
        }
        .fileImporter(isPresented: $picking, allowedContentTypes: Self.types) { read($0) }
        .interactiveDismissDisabled(preview != nil || saving)
        .confirmationDialog("Discard this review?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { dismiss() }
        } message: {
            Text("Nothing has been imported yet. The choices you made are lost.")
        }
        .onAppear(perform: begin)
        .onChange(of: store.revision) { _, now in
            // Sync, Undo or another screen changed the budget: check the rows again against it.
            guard let preview, !saving, !loading, now != preview.revision else { return }
            runPreview(notice: changedAgain)
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") {
                if preview != nil && !decisions.isEmpty { confirmDiscard = true } else { dismiss() }
            }
            .disabled(saving)
        }
        ToolbarItem(placement: .confirmationAction) {
            if saving || (loading && preview != nil) {
                ProgressView()
            } else if let preview {
                let counts = BankReview.counts(preview.rows, decisions)
                Button(counts.importing == 1 ? "Import 1" : "Import \(counts.importing)") { importRows() }
                    .fontWeight(.semibold)
                    .disabled(counts.undecided > 0 || counts.importing == 0)
            } else {
                Button("Preview") { runPreview() }
                    .fontWeight(.semibold)
                    .disabled(content == nil || account.isEmpty || loading)
            }
        }
    }

    // MARK: Choosing the file

    private var setup: some View {
        Form {
            Section {
                Text("Bring in the transactions your bank exported. You check every row, and how it matches what you already entered, before anything is saved.")
                    .font(.subheadline).foregroundStyle(Color.secondary)
                    .listRowBackground(Color.clear)
            }
            if accounts.isEmpty {
                EmptyState(title: "Add an account first", detail: "Imported transactions go into one of your accounts. Add it in Accounts, then import its statement.",
                           symbol: "building.columns")
            } else {
                fileSection
                if content != nil { readingSection }
            }
            if loading {
                HStack(spacing: 10) {
                    ProgressView()
                    Text(content == nil ? "Reading the file…" : "Checking the rows…").foregroundStyle(Color.secondary)
                }
            }
            if let error { FormErrorView(message: error) }
        }
    }

    private var fileSection: some View {
        Section {
            NavigationLink(value: BankFileRoute.account) {
                LabeledContent("Into account", value: accountName.isEmpty ? "Choose" : accountName)
            }
            .disabled(loading)
            Button { picking = true } label: {
                HStack(spacing: 12) {
                    Image(systemName: content == nil ? "doc.badge.plus" : "doc.text")
                        .font(.title3).foregroundStyle(Color.urAccent).frame(width: 30)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(fileName.isEmpty ? "Choose a file" : fileName).foregroundStyle(Color.primary).lineLimit(1)
                        Text(content == nil ? "CSV, OFX, QFX or QIF" : "\(bankFormats.first { $0.id == format }?.label ?? format) · tap to choose another")
                            .font(.footnote).foregroundStyle(Color.secondary)
                    }
                }
            }
            .disabled(loading)
            .accessibilityHint("Opens your files")
        } footer: {
            Text("CSV files need a header row with Date, Payee (or Description), and either Amount (negative for money out) or Outflow and Inflow. Memo is optional.")
        }
    }

    private var readingSection: some View {
        Section {
            Picker("Read as", selection: $format) {
                ForEach(bankFormats, id: \.id) { Text($0.label).tag($0.id) }
            }
            if datesInFile {
                Picker("Dates in the file", selection: $dateOrder) {
                    ForEach(bankDateOrders, id: \.id) { Text($0.label).tag($0.id) }
                }
            }
            if signs {
                Toggle("Purchases are positive (reverse amount signs)", isOn: $flipSigns)
            }
        }
        .disabled(loading)
    }

    // MARK: Reviewing the rows

    private func review(_ preview: BankFilePreview) -> some View {
        let counts = BankReview.counts(preview.rows, decisions)
        return List {
            Section {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(fileName.isEmpty ? "Statement" : fileName) into \(accountName)").font(.headline)
                    Text(BankReview.countsText(preview.summary)).font(.footnote).foregroundStyle(Color.secondary)
                }
                Button("Change file") { leaveReview() }.disabled(saving || loading)
            }
            if let notice {
                Notice(text: notice, tone: "info").listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
            }
            if let error { FormErrorView(message: error) }
            if preview.summary.allIn && signs && !flipSigns {
                Notice(text: "Every row came out as money in. If these are purchases, the file writes them as positive numbers.",
                       icon: "arrow.up.arrow.down", action: "Reverse signs") {
                    flipSigns = true
                    runPreview()
                }
                .listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
            }
            BankReviewNotes(summary: preview.summary, undecided: counts.undecided)
            Section {
                BankReviewRows(rows: preview.rows, decisions: $decisions, enabled: !saving && !loading)
            } header: {
                BankReviewHeader(rows: preview.rows, decisions: $decisions, undecided: counts.undecided, enabled: !saving && !loading)
            } footer: {
                Text(BankReview.matchingNote)
            }
        }
        .groupedList()
    }

    // MARK: Actions

    private func begin() {
        guard !started else { return }
        started = true
        account = accounts.contains { $0.text("id") == presetAccount } ? presetAccount : accounts.first?.text("id") ?? ""
        if let opened { read(.success(opened)) }
        // ISO dates always read; a file written another way most likely follows the budget's format.
        switch budget.text("dateFormat") {
        case "mdy": dateOrder = "mdy"
        case "dmy", "dmmmy": dateOrder = "dmy"
        default: dateOrder = "ymd"
        }
    }

    private func leaveReview() {
        generation += 1
        preview = nil
        decisions = [:]
        error = nil
        notice = nil
        loading = false
    }

    private func read(_ result: Result<URL, Error>) {
        let url: URL
        switch result {
        case .success(let picked): url = picked
        case .failure(let failure): error = BudgetStore.readable(failure); return
        }
        loading = true
        error = nil
        Task {
            do {
                let file = try await Task.detached(priority: .userInitiated) {
                    try ImportFiles.read(url, limit: 8 * 1024 * 1024, tooLarge: "Choose a statement smaller than 8 MB.")
                }.value
                let text = await Task.detached(priority: .userInitiated) { ImportFiles.text(file.data) }.value
                fileName = file.name
                content = text
                let ext = (file.name as NSString).pathExtension.lowercased()
                if bankFormats.contains(where: { $0.id == ext }) { format = ext }
            } catch {
                self.error = BudgetStore.readable(error)
            }
            loading = false
        }
    }

    /// Previews the statement through the engine's `bankPreview`, against the published budget.
    private func runPreview(notice next: String? = nil) {
        guard let content, !account.isEmpty else { return }
        generation += 1
        let current = generation
        let params: JSON = ["accountId": .string(account), "content": .string(content), "format": .string(format),
                            "dateFormat": .string(datesInFile ? dateOrder : "ymd"), "flipSigns": .bool(signs && flipSigns)]
        loading = true
        error = nil
        notice = nil
        Task {
            let revision = store.revision
            let budget = store.budget ?? [:]
            do {
                let result = try await store.query("bankPreview", params)
                let rows = try await Task.detached(priority: .userInitiated) {
                    try BankReview.prepare(rows: result.rows("items"), budget: budget, allowIdlessDuplicate: true,
                                           candidateSets: result["candidateSets"].array)
                }.value
                guard current == generation else { return }
                guard store.revision == revision else { throw AppError("Your budget changed. Preview this statement again.") }
                guard !rows.isEmpty else { throw AppError("The file has no transactions to import.") }
                preview = BankFilePreview(rows: rows, summary: BankReview.summarize(rows), revision: revision)
                decisions = [:]
                notice = next
            } catch {
                guard current == generation else { return }
                // A review checked against an older budget can't be imported.
                if let shown = preview, shown.revision != store.revision { preview = nil; decisions = [:] }
                self.error = BudgetStore.readable(error)
            }
            loading = false
        }
    }

    private func importRows() {
        guard let preview else { return }
        let selected = decisions
        let accountId = account
        let importing = BankReview.counts(preview.rows, selected).importing
        saving = true
        error = nil
        Task {
            do {
                let rows = preview.rows
                let choices = await Task.detached(priority: .userInitiated) {
                    BankReview.choices(rows, selected, allowIdlessDuplicate: true)
                }.value
                try await store.importsCommand("bankApply", ["accountId": .string(accountId), "choices": choices],
                                               since: preview.revision, stale: "Your budget changed. Preview this statement again.")
                store.showToast("Imported \(importing) \(importing == 1 ? "transaction" : "transactions"). They're waiting for your approval.", undo: true)
                dismiss()
            } catch {
                saving = false
                if store.revision != preview.revision {
                    runPreview(notice: changedAgain)
                } else {
                    self.error = BudgetStore.readable(error)
                }
            }
        }
    }
}
