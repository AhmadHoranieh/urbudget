import StoreKit
import SwiftUI

/// Account & sync's Sync subscription: whether it's active, and buying, restoring or managing it
/// through the App Store. The account overview (`/me`) says what's active; StoreKit only sells.
struct SyncSubscriptionSection: View {
    /// The account overview, or nil while it loads.
    var overview: JSON?
    /// Loads the overview again after a purchase or restore.
    var reload: () async -> Void

    @Environment(AppStoreSubscription.self) private var appStore
    @Environment(\.purchase) private var purchase
    @State private var busy = false
    @State private var error: String?
    @State private var notice: String?
    @State private var managing = false

    private var plan: JSON { overview?["subscription"] ?? .null }
    private var provider: String { plan.text("provider") }
    private var active: Bool { overview?["sync"]["active"].bool ?? false }
    /// Sync given by UrBudget (the App Review account's) can still be bought, so the purchase can be tried.
    private var offered: Bool { !active || provider == "comp" }

    var body: some View {
        if overview?["sync"].isObject == true {
            Section {
                statusRow
                if let notice { Text(notice).font(.subheadline) }
                if let error { Text(error).font(.subheadline).foregroundStyle(Color.urNegative) }
                if provider == "apple" { Button("Manage subscription") { managing = true }.disabled(busy) }
                if offered { offerRows }
            } header: {
                Text("Sync subscription")
            } footer: {
                if offered { disclosures }
            }
            .task(id: offered) { if offered { await appStore.loadProduct() } }
            .manageSubscriptionsSheet(isPresented: $managing)
            .onChange(of: managing) { _, open in if !open { Task { await reload() } } }
        }
    }

    private var statusRow: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(active ? "Sync subscription active" : "Sync needs an active subscription")
                if !statusDetail.isEmpty { Text(statusDetail).font(.footnote).foregroundStyle(Color.secondary) }
            }
        } icon: {
            Image(systemName: active ? "checkmark.icloud.fill" : "exclamationmark.icloud")
        }
        .foregroundStyle(active ? Color.urPositive : Color.urWarning)
    }

    private var statusDetail: String {
        switch provider {
        case "comp":
            return active ? "Included with this account by UrBudget" : ""
        case "apple":
            if plan.text("status") == "unpaid" { return "The App Store couldn't renew it. Check your payment method in Manage subscription." }
            if let renews = date(plan.text("renewsAt")), active { return "Renews \(renews)" }
            if let ends = date(plan.text("endsAt")) { return active ? "Ends \(ends)" : "Ended \(ends)" }
            return ""
        case "":
            return ""
        default:
            return active ? "Manage it where you subscribed." : ""
        }
    }

    @ViewBuilder private var offerRows: some View {
        if let product = appStore.product {
            VStack(alignment: .leading, spacing: 4) {
                Text(product.displayName).fontWeight(.semibold)
                if !product.description.isEmpty { Text(product.description).font(.subheadline).foregroundStyle(Color.secondary) }
            }
            Button { subscribe(product) } label: {
                HStack {
                    Text("Subscribe for \(product.displayPrice) a \(unit(product))")
                    if busy { Spacer(); ProgressView() }
                }
            }
            .fontWeight(.semibold)
            .disabled(busy)
        } else if appStore.unavailable {
            Text("The App Store isn't available right now. Try again later.").font(.subheadline).foregroundStyle(Color.secondary)
        } else {
            ProgressView()
        }
        Button("Restore purchases", action: restore).disabled(busy)
    }

    /// What App Review guideline 3.1.2 asks for beside the button: the subscription's name, length
    /// and price, that it renews automatically, and links to the terms and the privacy policy.
    @ViewBuilder private var disclosures: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let product = appStore.product {
                Text("\(product.displayName): a \(length(product)) subscription for \(product.displayPrice) a \(unit(product)). Payment is charged to your Apple Account when you confirm the purchase. It renews automatically at the same price unless you turn off auto-renew at least 24 hours before the end of the current period. Manage or cancel it anytime in your Apple Account settings.")
            }
            HStack(spacing: 16) {
                Link("Terms of Use", destination: URL(string: "https://urbudget.app/terms/")!)
                Link("Privacy Policy", destination: URL(string: "https://urbudget.app/privacy/app/")!)
            }
        }
    }

    private func subscribe(_ product: Product) {
        run {
            let token = try await appStore.accountToken()
            notice = try await appStore.complete(try await purchase(product, options: [.appAccountToken(token)]))
        }
    }

    private func restore() {
        run { notice = try await appStore.restore() }
    }

    /// One App Store action at a time, with its error shown in the section; the overview reloads after.
    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        error = nil
        notice = nil
        Task {
            defer { busy = false }
            do { try await action() } catch { self.error = BudgetStore.readable(error) }
            await reload()
        }
    }

    private func unit(_ product: Product) -> String {
        guard let period = product.subscription?.subscriptionPeriod else { return "month" }
        return period.value == 1 ? name(period.unit) : "\(period.value) \(name(period.unit))s"
    }

    private func length(_ product: Product) -> String {
        guard let period = product.subscription?.subscriptionPeriod else { return "1-month" }
        return "\(period.value)-\(name(period.unit))"
    }

    private func name(_ unit: Product.SubscriptionPeriod.Unit) -> String {
        switch unit {
        case .day: return "day"
        case .week: return "week"
        case .month: return "month"
        case .year: return "year"
        @unknown default: return "period"
        }
    }

    private func date(_ iso: String) -> String? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return (parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso))?.formatted(date: .abbreviated, time: .omitted)
    }
}
