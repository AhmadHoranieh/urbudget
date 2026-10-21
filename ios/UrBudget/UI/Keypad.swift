import SwiftUI

/// What the keypad holds. A seeded amount (an existing assignment, a balance to move) is replaced by
/// the first digit, as YNAB's keypad does, while an operator first keeps it: "+ 25" adds 25.
@Observable
final class PadState {
    var text: String
    var fresh: Bool

    init(_ cents: Int64?) {
        text = cents.map(AmountPad.show) ?? ""
        fresh = cents != nil
    }

    func press(_ key: String) {
        let digit = !key.isEmpty && key.allSatisfy(\.isNumber)
        text = fresh && digit ? AmountPad.press("", key) : AmountPad.press(text, key)
        fresh = false
    }

    func set(_ cents: Int64) {
        text = AmountPad.show(cents)
        fresh = true
    }

    /// The amount in cents, or nil while it's a sum that doesn't work out (ends on an operator).
    var cents: Int64? { text.isEmpty ? 0 : AmountPad.value(text) }
    var isSum: Bool { AmountPad.isSum(text) }
    /// The text with the budget's decimal mark.
    var display: String { text.replacingOccurrences(of: ".", with: Money.decimalMark()) }
}

/// The amount, large, as the keypad has it: the sum while it's being typed, else the money.
struct PadAmount: View {
    var pad: PadState
    var currency: String
    var color: Color = .primary
    var sign = ""

    var body: some View {
        let text = pad.text.isEmpty ? money(0, currency) : pad.isSum ? pad.display : money(pad.cents ?? 0, currency)
        let signed = !sign.isEmpty && !pad.isSum && (pad.cents ?? 0) != 0 ? sign + text : text
        Text(signed)
            .font(.system(size: pad.isSum ? 30 : 42, weight: .heavy, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(color)
            .lineLimit(1)
            .minimumScaleFactor(0.5)
            .contentTransition(.numericText())
            .animation(.snappy(duration: 0.15), value: pad.text)
    }
}

/// The keypad for amounts, styled like the system keyboard: digits, the four operators, =, ⌫ and Done.
struct AmountKeypad: View {
    var pad: PadState
    var doneLabel = "Done"
    var onDone: () -> Void

    var body: some View {
        // Five equal columns; = and Done each take two.
        Grid(horizontalSpacing: 6, verticalSpacing: 6) {
            GridRow { key("7"); key("8"); key("9"); key("×", kind: .op); key("÷", kind: .op) }
            GridRow { key("4"); key("5"); key("6"); key("+", kind: .op); key("−", kind: .op) }
            GridRow { key("1"); key("2"); key("3"); key("=", kind: .op).gridCellColumns(2) }
            GridRow {
                key("00")
                key("0")
                key("⌫", kind: .op)
                Button {
                    if pad.isSum { pad.press("=") }
                    onDone()
                } label: {
                    Text(doneLabel).font(.headline).frame(maxWidth: .infinity).frame(height: 48)
                }
                .buttonStyle(KeyStyle(kind: .done))
                .keyboardShortcut(.return, modifiers: [])
                .gridCellColumns(2)
            }
        }
        .padding(8)
        .fixedSize(horizontal: false, vertical: true)
        .background(Color(light: 0xD1D3D9, dark: 0x2B2B2E))
        .sensoryFeedback(.selection, trigger: pad.text)
    }

    /// The hardware key that types each keypad key, as on a calculator.
    private static let typed: [String: KeyEquivalent] = [
        "+": "+", "−": "-", "×": "*", "÷": "/", "=": "=", "⌫": .delete,
    ]

    private func shortcut(_ key: String) -> KeyboardShortcut? {
        if let typed = Self.typed[key] { return KeyboardShortcut(typed, modifiers: []) }
        return key.count == 1 ? KeyboardShortcut(KeyEquivalent(key.first!), modifiers: []) : nil
    }

    private func key(_ key: String, kind: KeyStyle.Kind = .digit) -> some View {
        Button { pad.press(key) } label: {
            Group {
                if key == "⌫" { Image(systemName: "delete.left").font(.title3) }
                else { Text(key).font(.system(size: 25, weight: kind == .digit ? .regular : .medium)) }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 48)
        }
        .buttonStyle(KeyStyle(kind: kind))
        .keyboardShortcut(shortcut(key))
        .accessibilityLabel(["⌫": "Delete", "−": "Minus", "×": "Times", "÷": "Divided by", "00": "Double zero"][key] ?? key)
    }
}

struct KeyStyle: ButtonStyle {
    enum Kind { case digit, op, done }
    var kind: Kind

    func makeBody(configuration: Configuration) -> some View {
        let fill: Color
        let ink: Color
        switch kind {
        case .digit: fill = Color(light: 0xFFFFFF, dark: 0x6B6B70); ink = .primary
        case .op: fill = Color(light: 0xABB0BA, dark: 0x464649); ink = .primary
        case .done: fill = .urAccent; ink = .white
        }
        return configuration.label
            .foregroundStyle(ink)
            .background(fill.opacity(configuration.isPressed ? 0.6 : 1), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .shadow(color: .black.opacity(0.25), radius: 0, y: 1)
    }
}
