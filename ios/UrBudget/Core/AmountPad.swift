import Foundation

/// The keypad's arithmetic, as desktop/src/AmountPad.tsx does it and YNAB's keypad works: digits
/// come in from the right as cents (1, 2, 3, 4 makes 12.34), an operator starts the next amount
/// (a second one replaces the first), ⌫ takes back the last digit or operator, and = works the sum
/// out. Text is canonical ("12.34 + 5.00"); the screen swaps in the budget's decimal mark.
enum AmountPad {
    static let operators = ["×", "÷", "+", "−"]
    private static func isOperator(_ token: String) -> Bool { operators.contains(token) }

    /// Cents as the keypad shows them: 1234 as "12.34".
    static func show(_ cents: Int64) -> String {
        let whole = cents.magnitude / 100
        let part = cents.magnitude % 100
        return (cents < 0 ? "-" : "") + "\(whole)." + (part < 10 ? "0" : "") + "\(part)"
    }

    /// An amount as typed ("12.50", "1,200", "7") in cents, or nil when it isn't one.
    static func cents(_ text: String) -> Int64? {
        let plain = text.replacingOccurrences(of: ",", with: "")
        guard plain.range(of: #"^-?\d*(\.\d{0,2})?$"#, options: .regularExpression) != nil else { return nil }
        let negative = plain.hasPrefix("-")
        let unsigned = negative ? String(plain.dropFirst()) : plain
        let parts = unsigned.split(separator: ".", omittingEmptySubsequences: false)
        let whole = String(parts.first ?? "")
        let fraction = parts.count > 1 ? String(parts[1]) : ""
        if whole.isEmpty && fraction.isEmpty { return nil }
        guard let units = Int64(whole.isEmpty ? "0" : whole), units < 1_000_000_000_000_000,
              let hundredths = Int64(fraction.padding(toLength: 2, withPad: "0", startingAt: 0)) else { return nil }
        let value = units * 100 + hundredths
        return negative ? -value : value
    }

    static func tokens(_ text: String) -> [String] {
        let pattern = #"-?\d[\d,]*(?:\.\d*)?|\.\d+|[×÷+−]"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: range).compactMap { Range($0.range, in: text).map { String(text[$0]) } }
    }

    /// What the keypad shows, in cents: × and ÷ before + and −. Nil when it ends on an operator or divides by zero.
    static func value(_ text: String) -> Int64? {
        let list = tokens(text)
        guard let last = list.last, !isOperator(last) else { return nil }
        var values: [Int64] = []
        var ops: [String] = []
        for token in list {
            if isOperator(token) { ops.append(token); continue }
            guard let v = cents(token) else { return nil }
            if let op = ops.last, op == "×" || op == "÷" {
                ops.removeLast()
                guard let left = values.popLast() else { return nil }
                if op == "÷" && v == 0 { return nil }
                let result = op == "×"
                    ? rounded(Decimal(left) * Decimal(v) / 100)
                    : rounded(Decimal(left) * 100 / Decimal(v))
                guard let result else { return nil }
                values.append(result)
            } else {
                values.append(v)
            }
        }
        guard var total = values.first else { return nil }
        for index in 1..<max(1, values.count) {
            let (next, overflow) = ops[index - 1] == "−"
                ? total.subtractingReportingOverflow(values[index])
                : total.addingReportingOverflow(values[index])
            if overflow { return nil }
            total = next
        }
        return total
    }

    /// Half away from zero, as BigDecimal's HALF_UP does.
    private static func rounded(_ value: Decimal) -> Int64? {
        var input = value
        var output = Decimal()
        NSDecimalRound(&output, &input, 0, .plain)
        let number = NSDecimalNumber(decimal: output)
        guard number.compare(NSDecimalNumber(value: Int64.max)) != .orderedDescending,
              number.compare(NSDecimalNumber(value: Int64.min)) != .orderedAscending else { return nil }
        return number.int64Value
    }

    /// The keypad's text after a key: a digit, "00", an operator, "⌫" or "=".
    static func press(_ text: String, _ key: String) -> String {
        // Two zeros at once, for whole amounts when digits come in as cents (5 00 00 is 500.00).
        if key == "00" { return press(press(text, "0"), "0") }
        var list = tokens(text)
        let last = list.last
        if key.count == 1, let digit = Int64(key) {
            guard let last, !isOperator(last) else { return (list + [show(digit)]).joined(separator: " ") }
            let current = cents(last) ?? 0
            // Twelve digits is already more than a budget holds; Money.parse rejects the rest.
            if current.magnitude >= 100_000_000_000 { return text }
            let sign: Int64 = current < 0 ? -1 : 1
            list.removeLast()
            return (list + [show(current * 10 + sign * digit)]).joined(separator: " ")
        }
        if isOperator(key) {
            guard let last else { return text }
            if isOperator(last) { list.removeLast() }
            return (list + [key]).joined(separator: " ")
        }
        if key == "⌫" {
            guard let last else { return text }
            list.removeLast()
            if isOperator(last) { return list.joined(separator: " ") }
            let shorter = (cents(last) ?? 0) / 10
            return (shorter != 0 ? list + [show(shorter)] : list).joined(separator: " ")
        }
        if key == "=" { return value(text).map(show) ?? text }
        return text
    }

    /// Whether the text is a sum still to be worked out.
    static func isSum(_ text: String) -> Bool { tokens(text).contains(where: isOperator) }
}
