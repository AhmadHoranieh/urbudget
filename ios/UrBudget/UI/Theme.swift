import SwiftUI

/// UrBudget's colours (desktop/src/styles.css, as Android shows them) on iOS's own grouped
/// backgrounds. The words and status colours stay UrBudget's; surfaces and type follow iOS.
extension Color {
    static let urAccent = Color(light: 0x0068DA, dark: 0x5B93FF)
    static let urPositive = Color(light: 0x197A35, dark: 0x56C67F)
    static let urNegative = Color(light: 0xCC2229, dark: 0xFF8077)
    static let urWarning = Color(light: 0xAD4F00, dark: 0xE2B44A)
    /// Yellow for spending that still needs a category.
    static let urAttention = Color(light: 0xFFCC00, dark: 0xE2B44A)
    static let urOnAttention = Color(light: 0x1D1D1F, dark: 0x14161A)
    /// The grey of zero amounts and inactive chips.
    static let urZero = Color(light: 0xE9E9EE, dark: 0x2E2E33)
    /// Text on a solid status fill.
    static let urOnSolid = Color(light: 0xFFFFFF, dark: 0x0C0E18)
    static let urBrand = Color(light: 0x6D4AE8, dark: 0x6D4AE8)
    /// Chevrons and other faint marks (the system's tertiary label). Fixed colours, unlike
    /// `.primary`/`.secondary`/`.tertiary`, which iOS 26 tints inside buttons.
    static let urTertiary = Color(light: 0xB4B4B9, dark: 0x5A5A5F)

    static func flag(_ name: String) -> Color {
        switch name {
        case "red": return Color(light: 0xFF3B30, dark: 0xE5484D)
        case "orange": return Color(light: 0xFF9500, dark: 0xF76B15)
        case "yellow": return Color(light: 0xFFCC00, dark: 0xE2A336)
        case "green": return Color(light: 0x34C759, dark: 0x30A46C)
        case "blue": return Color(light: 0x007AFF, dark: 0x3E63DD)
        case "purple": return Color(light: 0xAF52DE, dark: 0x8E4EC6)
        default: return .secondary
        }
    }
}

/// What a category's state looks like: the pill's fill and text, and the colour for words about it.
struct StatusColors {
    var fill: Color
    var content: Color
    var ink: Color

    init(_ status: String) {
        switch status {
        case "positive": (fill, content, ink) = (.urPositive, .urOnSolid, .urPositive)
        case "underfunded", "credit": (fill, content, ink) = (.urWarning, .urOnSolid, .urWarning)
        case "negative": (fill, content, ink) = (.urNegative, .urOnSolid, .urNegative)
        default: (fill, content, ink) = (.urZero, .secondary, .secondary)
        }
    }
}

extension Tone {
    var color: Color {
        switch self {
        case .negative: return .urNegative
        case .warning: return .urWarning
        case .positive: return .urPositive
        case .muted: return .secondary
        }
    }
}

/// Money in lists: tabular figures, so amounts line up, at the text style the size stands for,
/// so they grow with Dynamic Type.
extension Text {
    func figure(_ size: CGFloat = 17, weight: Font.Weight = .regular) -> Text {
        font(.system(Font.TextStyle.forSize(size), design: .default, weight: weight)).monospacedDigit()
    }
}

extension Font.TextStyle {
    /// The text style whose default size is nearest `size` points.
    static func forSize(_ size: CGFloat) -> Font.TextStyle {
        switch size {
        case ..<12.5: return .caption
        case ..<14: return .footnote
        case ..<16: return .subheadline
        case ..<18.5: return .body
        case ..<21: return .title3
        case ..<25: return .title2
        case ..<31: return .title
        default: return .largeTitle
        }
    }
}
