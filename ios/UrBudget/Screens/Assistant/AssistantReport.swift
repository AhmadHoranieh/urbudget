import SwiftUI
import UIKit

/// A report the assistant wrote: read it here, share its text, save it, or print it (the print
/// options also save a PDF).
struct AssistantReportView: View {
    var report: JSON
    @Environment(\.dismiss) private var dismiss
    @State private var blocks: [AssistantMarkdownBlock]?
    @State private var share: AssistantSheetItem<URL>?
    @State private var error: String?

    private var meta: String {
        [report.text("budget"), report.text("period"), String(report.text("created").prefix(10))]
            .filter { !$0.isEmpty }.joined(separator: " · ")
    }

    var body: some View {
        NavigationStack {
            Group {
                if let blocks {
                    AssistantMarkdownDocument(blocks: blocks) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(report.text("title")).font(.title2.bold()).accessibilityAddTraits(.isHeader)
                            if !meta.isEmpty { Text(meta).font(.footnote).foregroundStyle(Color.secondary) }
                        }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(Color.groupedBackground)
            .navigationTitle(report.text("title"))
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                ToolbarItemGroup(placement: .bottomBarItems) {
                    ShareLink(item: report.text("body"), subject: Text(report.text("title"))) {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                    Spacer()
                    Button("Print / PDF", systemImage: "printer") { AssistantReportPrinter.print(report, meta: meta) }
                    Spacer()
                    Button("Save text", systemImage: "square.and.arrow.down") { saveText() }
                }
            }
            .sheet(item: $share) { AssistantShareSheet(items: [$0.value]) { share = nil }.presentationDetents([.medium, .large]) }
            .alert("Couldn’t complete that", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(error ?? "")
            }
            .task {
                let body = report.text("body")
                blocks = await Task.detached(priority: .userInitiated) { AssistantMarkdown.documentBlocks(body) }.value
            }
        }
    }

    private func saveText() {
        let name = AssistantExport.fileName(report.text("title"), extension: "md", fallback: "Report")
        let body = report.text("body")
        Task {
            do {
                share = AssistantSheetItem(value: try await Task.detached { try AssistantExport.temporaryFile(named: name, data: Data(body.utf8)) }.value)
            } catch {
                self.error = BudgetStore.readable(error)
            }
        }
    }
}

/// iOS's print system supplies the printer and Save as PDF, as Android's print framework does.
/// The report is laid out from escaped HTML with real tables, A4-friendly margins and page numbers.
@MainActor
enum AssistantReportPrinter {
    static func print(_ report: JSON, meta: String) {
        let title = report.text("title")
        let body = report.text("body")
        Task { @MainActor in
            let html = await Task.detached(priority: .userInitiated) { AssistantMarkdown.html(title: title, meta: meta, body: body) }.value
            let info = UIPrintInfo(dictionary: nil)
            info.jobName = String(title.prefix(80))
            info.outputType = .grayscale
            let formatter = UIMarkupTextPrintFormatter(markupText: html)
            formatter.perPageContentInsets = UIEdgeInsets(top: 36, left: 36, bottom: 36, right: 36)
            let renderer = AssistantPrintRenderer()
            renderer.headerHeight = 12
            renderer.footerHeight = 28
            renderer.addPrintFormatter(formatter, startingAtPageAt: 0)
            let controller = UIPrintInteractionController.shared
            controller.printInfo = info
            controller.printPageRenderer = renderer
            controller.present(animated: true)
        }
    }
}

/// Draws "2 / 5" under each printed page.
private final class AssistantPrintRenderer: UIPrintPageRenderer {
    override func drawFooterForPage(at pageIndex: Int, in footerRect: CGRect) {
        let text = "\(pageIndex + 1) / \(numberOfPages)" as NSString
        let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 9), .foregroundColor: UIColor.darkGray]
        let size = text.size(withAttributes: attributes)
        text.draw(at: CGPoint(x: footerRect.midX - size.width / 2, y: footerRect.minY + (footerRect.height - size.height) / 2),
                  withAttributes: attributes)
    }
}

/// The system share sheet for a file: Save to Files, AirDrop, Mail, Numbers and the rest.
struct AssistantShareSheet: UIViewControllerRepresentable {
    var items: [Any]
    /// Called when the person shares or cancels, so the sheet presenting it closes.
    var finished: () -> Void = {}

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        let finished = finished
        controller.completionWithItemsHandler = { _, _, _, _ in finished() }
        return controller
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Reports a reply to UrBudget. Only the excerpt and explanation in this form are sent.
struct AssistantReplyReportForm: View {
    var excerpt: String
    @Environment(\.dismiss) private var dismiss
    private let controller = AssistantController.shared
    @State private var text = ""
    @State private var reason = ""
    @State private var started = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Only the excerpt and explanation below will be sent to UrBudget. Edit out anything private before sending.")
                        .font(.subheadline)
                }
                Section {
                    TextField("Selected excerpt", text: $text, axis: .vertical)
                        .lineLimit(6...14)
                        .onChange(of: text) { _, value in text = assistantLimited(value, utf16: 4000) }
                } header: {
                    Text("Selected excerpt")
                } footer: {
                    Text("\(text.utf16.count) / 4,000")
                }
                Section("What went wrong?") {
                    TextField("What went wrong?", text: $reason, axis: .vertical)
                        .lineLimit(3...8)
                        .onChange(of: reason) { _, value in reason = assistantLimited(value, utf16: 1000) }
                }
                if let error = controller.error, controller.busy.isEmpty { FormErrorView(message: error) }
            }
            .navigationTitle("Report a reply")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        controller.dismissError()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if controller.busy.contains("reportReply") {
                        ProgressView()
                    } else {
                        Button("Send report") {
                            controller.reportReply(text: text, reason: reason) { dismiss() }
                        }
                        .fontWeight(.semibold)
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
            .onAppear {
                guard !started else { return }
                started = true
                text = assistantLimited(excerpt, utf16: 4000)
                controller.dismissError()
            }
        }
    }
}
