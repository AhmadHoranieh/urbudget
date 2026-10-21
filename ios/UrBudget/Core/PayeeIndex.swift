import Foundation

/// A payee as the payee picker lists it (desktop payees.ts): how often and when it was last used,
/// its saved default category, and the category its latest single-category transaction used.
/// A category is "__rta" for Unassigned and empty for spending left without one.
struct PayeeInfo: Identifiable, Equatable {
    var name: String
    var count: Int
    var last: String
    var lastUsed: String?
    var defaultCategory: String?
    var id: String { name }
    /// The default, else the category used last (payees.ts's categoryId).
    var category: String? { defaultCategory ?? lastUsed }
}

/// Every payee with usage counts, most used first; payees only in schedules, splits or rules come last.
func payeeIndex(_ budget: JSON) -> [PayeeInfo] {
    struct Usage { var count = 0; var last = ""; var category: String? }
    var usage: [String: Usage] = [:]
    var order: [String] = []
    var others: [String] = []
    var seenOthers: Set<String> = []
    func other(_ name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty && seenOthers.insert(trimmed).inserted { others.append(trimmed) }
    }
    for t in budget.rows("transactions") {
        for s in t.rows("splits") { other(s.text("payee")) }
        let name = t.text("payee").trimmingCharacters(in: .whitespaces)
        if name.isEmpty || !t.text("transferAccountId").isEmpty { continue }
        if usage[name] == nil { order.append(name) }
        var info = usage[name] ?? Usage()
        info.count += 1
        let date = t.text("date")
        if date >= info.last {
            info.last = date
            let splits = t.rows("splits")
            if splits.count == 1, let only = splits.first, only.text("transferAccountId").isEmpty {
                let category = only.text("categoryId")
                info.category = !category.isEmpty ? category : (only.flag("unassigned") || t.long("amount") > 0 ? "__rta" : "")
            }
        }
        usage[name] = info
    }
    for s in budget.rows("schedules") { other(s["transaction"].text("payee")) }
    for r in budget.rows("payeeRules") { other(r.text("payee")) }
    let categories = Set(budget.rows("categories").map { $0.text("id") })
    var fixed: [String: String] = [:]
    for p in budget.rows("payees") {
        let name = p.text("name")
        // YNAB's own transfer payees ("Transfer : Savings") are offered as real transfers instead.
        if name.isEmpty || !p.text("transfer_account_id").isEmpty || p.flag("deleted") || name.hasPrefix("Transfer : ") { continue }
        if usage[name] == nil { usage[name] = Usage(); order.append(name) }
        let category = p.text("categoryId")
        if !category.isEmpty && (category == "__rta" || categories.contains(category)) && fixed[name] == nil { fixed[name] = category }
    }
    let listed = order.map { name -> PayeeInfo in
        let info = usage[name]!
        return PayeeInfo(name: name, count: info.count, last: info.last, lastUsed: info.category, defaultCategory: fixed[name])
    }.sorted { a, b in
        if a.count != b.count { return a.count > b.count }
        let (x, y) = (a.name.lowercased(), b.name.lowercased())
        return x != y ? x < y : a.name < b.name
    }
    let extra = others.filter { usage[$0] == nil }.sorted { $0.lowercased() < $1.lowercased() }
        .map { PayeeInfo(name: $0, count: 0, last: "", lastUsed: nil, defaultCategory: nil) }
    return listed + extra
}
