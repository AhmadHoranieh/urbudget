import Foundation
import Observation

/// Encrypted sync while the app is open, as Android's MainActivity runs it: shortly after each
/// change, when the app comes to the foreground, and every minute. One attempt at a time; only
/// when signed in with sync unlocked; and the open budget reloads when sync replaced it.
@MainActor @Observable
final class SyncCoordinator {
    /// The latest account and sync status (`cloud_status`), for badges and the sync screen.
    private(set) var status: JSON?
    private(set) var syncing = false

    @ObservationIgnored private weak var store: BudgetStore?
    @ObservationIgnored private var soon: Task<Void, Never>?
    @ObservationIgnored private var periodic: Task<Void, Never>?

    static let automaticKey = "automaticSync"
    static var automatic: Bool { UserDefaults.standard.object(forKey: automaticKey) as? Bool ?? true }

    func attach(_ store: BudgetStore) {
        self.store = store
        store.onChange = { [weak self] in self?.syncSoon() }
    }

    var signedIn: Bool { !(status?.text("email").isEmpty ?? true) }
    var unlocked: Bool { status?["sync"]["unlocked"].bool ?? false }
    /// The last sync attempt's report, if any.
    var lastReport: JSON? { status?["sync"]["last"].isObject == true ? status?["sync"]["last"] : nil }
    var conflicts: Int { lastReport?.rows("budgets").count { $0.text("state") == "conflict" } ?? 0 }

    func refreshStatus() async {
        if let next = try? await store?.service("cloud_status") { status = next }
    }

    /// The app is in the foreground: sync now and then every minute until it leaves.
    func start() {
        guard periodic == nil else { return }
        periodic = Task { [weak self] in
            while !Task.isCancelled {
                await self?.syncAutomatically()
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }

    func stop() {
        periodic?.cancel()
        periodic = nil
        soon?.cancel()
        soon = nil
    }

    /// A change was saved: sync a few seconds later, once edits settle.
    func syncSoon() {
        soon?.cancel()
        soon = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            if !Task.isCancelled { await self?.syncAutomatically() }
        }
    }

    func syncAutomatically() async {
        guard Self.automatic else { await refreshStatus(); return }
        await refreshStatus()
        guard signedIn, unlocked else { return }
        _ = try? await syncNow()
    }

    /// One sync of every tracked budget. Returns the report; the open budget reloads if it changed.
    @discardableResult
    func syncNow() async throws -> JSON {
        guard let store, !syncing else { return lastReport ?? [:] }
        syncing = true
        defer { syncing = false }
        let report = try await store.service("sync_now")
        // A downloaded or merged version may have replaced the open budget.
        store.reload()
        await refreshStatus()
        return report
    }
}
