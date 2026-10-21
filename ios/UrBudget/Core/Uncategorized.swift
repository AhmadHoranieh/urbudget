import Foundation

/// Spending with no category yet, as YNAB's "This needs a category" (desktop/src/uncategorized.ts).
/// Only money leaving the budget needs one: money coming in with none is income for Unassigned, and
/// a transfer between budget accounts needs none. Categories named "Uncategorized" (YNAB's) count
/// as none. Scheduled transactions aren't counted until they're entered.
struct Uncategorized {
    private var onBudget: [String: Bool] = [:]
    private var tracking: Set<String> = []
    private var placeholders: Set<String> = ["local-uncategorized"]
    private let today: String

    /// How many entered transactions need a category, how much they spend, and how many per budget account.
    struct Counts: Equatable { var total = 0; var amount: Int64 = 0; var byAccount: [String: Int] = [:] }

    init(budget: JSON, today: String = Dates.today) {
        self.today = today
        for account in budget.rows("accounts") {
            let budgetSide = account.text("kind") != "tracking" && account.flag("onBudget", true)
            onBudget[account.text("id")] = budgetSide
            if !budgetSide { tracking.insert(account.text("id")) }
        }
        for category in budget.rows("categories") {
            let name = category.text("name")
            if name == "Uncategorized" || name == "Uncategorized Transactions" { placeholders.insert(category.text("id")) }
        }
    }

    private func optionalText(_ value: JSON, _ key: String) -> String? {
        let text = value.text(key)
        return text.isEmpty ? nil : text
    }

    /// Whether the line was left for Unassigned on purpose (income), as desktop's leftUnassigned.
    private func leftUnassigned(_ t: JSON, _ s: JSON, single: Bool) -> Bool {
        if !s["unassigned"].isNull { return s["unassigned"].bool }
        let source = s["source"].isObject ? s["source"] : (single ? t["source"] : .null)
        let name = source.text("category_name")
        return name == "Inflow: Ready to Assign" || name == "Inflow: To be Budgeted" || t.text("payee") == "Reconciliation adjustment"
    }

    /// How much a line spends with no category: its money out, seen from the budget, or 0.
    func missing(_ t: JSON, _ s: JSON) -> Int64 {
        if t.text("date") > today { return 0 }
        let selfSide = onBudget[t.text("accountId")] ?? false
        let peer = optionalText(s, "transferAccountId") ?? optionalText(t, "transferAccountId")
        let other = peer.map { onBudget[$0] ?? false }
        let line = s.long("amount")
        let amount: Int64
        if let other {
            amount = selfSide == other ? 0 : (selfSide ? line : -line)
        } else {
            amount = selfSide ? line : 0
        }
        if amount >= 0 { return 0 }
        let none: Bool
        if let category = optionalText(s, "categoryId") {
            none = placeholders.contains(category)
        } else {
            none = !leftUnassigned(t, s, single: t["splits"].array.count == 1)
        }
        return none ? -amount : 0
    }

    func needs(_ t: JSON, _ s: JSON) -> Bool { missing(t, s) > 0 }

    func needs(_ t: JSON) -> Bool { t.rows("splits").contains { missing(t, $0) > 0 } }

    func counts(_ budget: JSON) -> Counts {
        var counts = Counts()
        for t in budget.rows("transactions") {
            var spent: Int64 = 0
            var affected: Set<String> = []
            for s in t.rows("splits") {
                let m = missing(t, s)
                guard m > 0 else { continue }
                spent += m
                // A tracking-side split spends the budget account on the other side.
                let account = tracking.contains(t.text("accountId"))
                    ? (optionalText(s, "transferAccountId") ?? optionalText(t, "transferAccountId"))
                    : t.text("accountId")
                if let account { affected.insert(account) }
            }
            guard spent != 0 else { continue }
            counts.total += 1
            counts.amount += spent
            for account in affected { counts.byAccount[account, default: 0] += 1 }
        }
        return counts
    }
}
