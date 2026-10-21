import Foundation

let HiddenGroup = "Hidden categories"

/// How a category's line under its name reads.
enum Tone: Sendable { case muted, warning, negative, positive }

/// One category as the budget list draws it: plain values, formatted once off the main thread.
struct CategoryRowModel: Identifiable, Equatable, Sendable {
    var id: String
    var name: String
    var group: String
    var hidden: Bool
    var payment: Bool
    var detail: String?
    var tone: Tone
    var snoozed: Bool
    var progress: Int?
    var status: String
    var assigned: Int64
    var assignedText: String
    var available: Int64
    var availableText: String
    var underfunded: Bool
    var overfunded: Bool
    var moved: Bool
    var note = ""

    func inView(_ view: String) -> Bool {
        switch view {
        case "underfunded": return underfunded
        case "overfunded": return overfunded
        case "available": return available > 0
        case "overspent": return available < 0
        case "snoozed": return snoozed
        default: return true
        }
    }
}

struct GroupModel: Identifiable, Equatable, Sendable {
    var name: String
    var rows: [CategoryRowModel]
    var id: String { name }
}

struct BudgetModel: Equatable, Sendable {
    var readyToAssign: Int64
    var groups: [GroupModel]
    var uncategorized: Int64
    var uncategorizedCredit: Int64
    var needsCategory: Uncategorized.Counts
    var shortfalls: [(month: String, amount: Int64)]
    var futureAssigned: Int64
    var futureReadyToAssign: Int64
    var monthNote: String?
    /// The longest figures each column must fit, for sizing the columns once.
    var widestAssigned: String
    var widestAvailable: String

    static func == (a: BudgetModel, b: BudgetModel) -> Bool {
        a.readyToAssign == b.readyToAssign && a.groups == b.groups && a.uncategorized == b.uncategorized
            && a.needsCategory == b.needsCategory && a.monthNote == b.monthNote && a.futureAssigned == b.futureAssigned
            && a.shortfalls.map(\.month) == b.shortfalls.map(\.month) && a.shortfalls.map(\.amount) == b.shortfalls.map(\.amount)
    }
}

/// The views the budget's filter menu offers.
let budgetViews: [(id: String, label: String)] = [
    ("all", "All"), ("underfunded", "Underfunded"), ("overfunded", "Overfunded"),
    ("available", "Money available"), ("overspent", "Overspent"), ("snoozed", "Snoozed"),
]

/// The budget's groups in budget order, empty ones included (desktop's groupNames with empty).
func groupNames(_ budget: JSON) -> [String] {
    var names: [String] = []
    var seen: Set<String> = []
    for name in budget["groupOrder"].array.map(\.string) where !name.isEmpty && seen.insert(name).inserted { names.append(name) }
    for category in budget.rows("categories") where !category.flag("hidden") {
        let name = category.text("group", "Everyday")
        if seen.insert(name).inserted { names.append(name) }
    }
    return names
}

/// The budget's groups in their saved order, each with its categories in order. Hidden ones come last.
func orderedGroups(_ budget: JSON, include: (JSON) -> Bool = { _ in true }) -> [(name: String, categories: [JSON])] {
    var ranks: [String: Int] = [:]
    for (index, id) in budget["categoryOrder"].array.enumerated() { ranks[id.string] = index }
    var groupRanks: [String: Int] = [:]
    for (index, name) in budget["groupOrder"].array.enumerated() { groupRanks[name.string] = index }
    let sorted = budget.rows("categories").filter(include).enumerated()
        .sorted { (ranks[$0.element.text("id")] ?? Int.max, $0.offset) < (ranks[$1.element.text("id")] ?? Int.max, $1.offset) }
        .map(\.element)
    var order: [String] = []
    var groups: [String: [JSON]] = [:]
    for category in sorted {
        let name = category.flag("hidden") ? HiddenGroup : category.text("group", "Everyday")
        if groups[name] == nil { order.append(name) }
        groups[name, default: []].append(category)
    }
    let rank = { (name: String) -> Int in name == HiddenGroup ? Int.max : groupRanks[name] ?? Int.max - 1 }
    return order.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }
        .map { ($0.element, groups[$0.element] ?? []) }
}

/// Builds the list's model off the main thread, once per budget snapshot and month.
func buildBudgetModel(budget: JSON, summary: JSON, month: String) -> BudgetModel {
    let currency = budget.text("currency")
    let monthFirst = budget.text("dateFormat") == "mdy"
    var totals: [String: JSON] = [:]
    for row in summary.rows("categories") { totals[row.text("id")] = row }
    // Categories with money moved to or from another one this month get a marker by Assigned.
    var moved: Set<String> = []
    for move in budget.rows("moneyMoves") where move.text("month") == month {
        let changes = move.rows("changes")
        if move.text("kind") == "merge" || move.text("kind") == "move" && changes.count > 1 {
            for change in changes where change.long("amount") != 0 { moved.insert(change.text("categoryId")) }
        }
    }
    var ranks: [String: Int] = [:]
    for (index, id) in budget["categoryOrder"].array.enumerated() { ranks[id.string] = index }
    let categories = budget.rows("categories").enumerated()
        .sorted { (ranks[$0.element.text("id")] ?? Int.max, $0.offset) < (ranks[$1.element.text("id")] ?? Int.max, $1.offset) }
        .map(\.element)
    let rows: [CategoryRowModel] = categories.map { category in
        let id = category.text("id")
        let total = totals[id]
        let state = CategoryStatus(category: category, summary: total, month: month)
        let available = total?.long("available") ?? 0
        let assigned = total?.long("assigned") ?? 0
        let words = state.status == "underfunded" || state.eventually > 0
            ? state.targetWords(category: category, summary: total, monthFirst: monthFirst) : nil
        let detail: String?
        if state.status == "credit" { detail = "Overspent on a card" }
        else if state.status == "negative" { detail = "Overspent" }
        else if let words { detail = words.amount.map { "\(money($0, currency)) \(words.words)" } ?? words.words }
        else if state.snoozed { detail = "Snoozed" }
        else { detail = nil }
        let tone: Tone = ["negative", "credit"].contains(state.status) ? .negative : state.status == "underfunded" ? .warning : .muted
        return CategoryRowModel(
            id: id, name: category.text("name"), group: category.text("group", "Everyday"), hidden: category.flag("hidden"),
            payment: !category.text("paymentAccountId").isEmpty, detail: detail, tone: tone, snoozed: state.snoozed,
            progress: state.progress, status: state.status, assigned: assigned, assignedText: money(assigned, currency),
            available: available, availableText: money(available, currency), underfunded: state.status == "underfunded",
            overfunded: category.long("target") > 0 && available > category.long("target"), moved: moved.contains(id),
            note: category.text("note").trimmingCharacters(in: .whitespacesAndNewlines))
    }
    var byGroup: [String: [CategoryRowModel]] = [:]
    for row in rows where !row.hidden { byGroup[row.group, default: []].append(row) }
    var groups = groupNames(budget).map { GroupModel(name: $0, rows: byGroup[$0] ?? []) }
    let hidden = rows.filter(\.hidden)
    if !hidden.isEmpty { groups.append(GroupModel(name: HiddenGroup, rows: hidden)) }
    var assignedTexts = rows.map(\.assignedText) + [money(0, currency)]
    var availableTexts = rows.map(\.availableText) + [money(summary.long("uncategorized"), currency)]
    for group in groups {
        assignedTexts.append(money(group.rows.reduce(0) { $0 + $1.assigned }, currency))
        availableTexts.append(money(group.rows.reduce(0) { $0 + $1.available }, currency))
    }
    let note = budget.rows("ynabMonths").first { $0.text("month").hasPrefix(month) }?.text("note")
    return BudgetModel(
        readyToAssign: summary.long("readyToAssign"), groups: groups,
        uncategorized: summary.long("uncategorized"), uncategorizedCredit: summary.long("uncategorizedCredit"),
        needsCategory: Uncategorized(budget: budget).counts(budget),
        shortfalls: summary.rows("futureShortfalls").map { ($0.text("month"), $0.long("amount")) },
        futureAssigned: summary.long("futureAssigned"), futureReadyToAssign: summary.long("futureReadyToAssign"),
        monthNote: note?.isEmpty == false ? note : nil,
        widestAssigned: assignedTexts.max { $0.count < $1.count } ?? "",
        widestAvailable: availableTexts.max { $0.count < $1.count } ?? "")
}

/// A category's moves in a month, oldest first, named by where the money came from or went
/// (desktop/src/moves.ts). When they don't add up to Assigned, a first line makes up the difference.
struct MoveLine: Identifiable {
    var id: String
    var at: String?
    var what: String
    var detail: String?
    var amount: Int64
}

func categoryMoves(_ budget: JSON, category: String, month: String, assigned: Int64) -> [MoveLine] {
    var names: [String: String] = [:]
    for c in budget.rows("categories") { names[c.text("id")] = c.text("name") }
    var lines: [MoveLine] = []
    for (index, move) in budget.rows("moneyMoves").enumerated() where move.text("month") == month {
        let changes = move.rows("changes")
        let amount = changes.first { $0.text("categoryId") == category }?.long("amount") ?? 0
        guard amount != 0 else { continue }
        let other = changes.first { $0.text("categoryId") != category }
        let what: String
        switch move.text("kind") {
        case "quickAssign": what = move.text("detail").isEmpty ? "Quick assign" : "Quick assign: \(move.text("detail"))"
        case "merge": what = "Merged from \(move.text("detail").isEmpty ? "a deleted category" : move.text("detail"))"
        case "move":
            if let other {
                let name = names[other.text("categoryId")] ?? "a deleted category"
                what = amount > 0 ? "Moved from \(name)" : "Moved to \(name)"
            } else {
                what = amount > 0 ? "Assigned" : "Returned to Unassigned"
            }
        case "assign": what = amount > 0 ? "Assigned" : "Returned to Unassigned"
        default: what = move.text("description")
        }
        lines.append(MoveLine(id: "\(index)", at: move.text("at"), what: what, detail: nil, amount: amount))
    }
    let recorded = lines.reduce(0) { $0 + $1.amount }
    if !lines.isEmpty && recorded != assigned {
        lines.insert(MoveLine(id: "earlier", at: nil, what: "Earlier changes", detail: "Not itemised", amount: assigned - recorded), at: 0)
    }
    return lines
}

/// The flag colours, with the budget's names for them.
let flagColors = ["red", "orange", "yellow", "green", "blue", "purple"]

func flagChoices(_ budget: JSON) -> [(id: String, name: String)] {
    flagColors.map { color in
        let named = budget["flagNames"].text(color)
        return (color, named.isEmpty ? color.prefix(1).uppercased() + color.dropFirst() : named)
    }
}
