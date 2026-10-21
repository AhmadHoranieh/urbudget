package app.urbudget.nativeapp

import java.math.BigDecimal
import java.math.RoundingMode

/**
 * The phone keypad's arithmetic, as desktop/src/AmountPad.tsx does it and YNAB's keypad works:
 * digits come in from the right as cents (1, 2, 3, 4 makes 12.34), an operator starts the next
 * amount (a second one replaces the first), ⌫ takes back the last digit or operator, and = works
 * the sum out. Text is canonical ("12.34 + 5.00"); the screen swaps in the budget's decimal mark.
 */
object AmountPad {
    val operators = listOf("×", "÷", "+", "−")
    private fun isOp(token: String) = token in operators
    private val tokenPattern = Regex("-?\\d[\\d,]*(?:\\.\\d*)?|\\.\\d+|[×÷+−]")
    private val amountPattern = Regex("^(-?)(\\d*)(?:\\.(\\d{0,2}))?$")

    /** Cents as the keypad shows them: 1234 as "12.34". */
    fun show(cents: Long): String {
        val whole = Math.abs(cents) / 100
        val part = (Math.abs(cents) % 100).toString().padStart(2, '0')
        return "${if (cents < 0) "-" else ""}$whole.$part"
    }

    /** An amount as typed ("12.50", "1,200", "7") in cents, or null when it isn't one. */
    fun cents(text: String): Long? {
        val m = amountPattern.matchEntire(text.replace(",", "")) ?: return null
        val (sign, whole, part) = m.destructured
        if (whole.isEmpty() && part.isEmpty()) return null
        val value = (whole.ifEmpty { "0" }.toLongOrNull() ?: return null) * 100 + part.padEnd(2, '0').toLong()
        return if (sign.isNotEmpty()) -value else value
    }

    fun tokens(text: String): List<String> = tokenPattern.findAll(text).map { it.value }.toList()

    /** What the keypad shows, in cents: × and ÷ before + and −. Null when it ends on an operator or divides by zero. */
    fun value(text: String): Long? {
        val list = tokens(text)
        if (list.isEmpty() || isOp(list.last())) return null
        val values = ArrayList<Long>()
        val ops = ArrayList<String>()
        for (token in list) {
            if (isOp(token)) { ops.add(token); continue }
            val v = cents(token) ?: return null
            val op = ops.lastOrNull()
            if (op == "×" || op == "÷") {
                ops.removeAt(ops.size - 1)
                val left = BigDecimal.valueOf(values.removeAt(values.size - 1))
                if (op == "÷" && v == 0L) return null
                val result = if (op == "×") left.multiply(BigDecimal.valueOf(v)).divide(BigDecimal(100), 0, RoundingMode.HALF_UP)
                    else left.multiply(BigDecimal(100)).divide(BigDecimal.valueOf(v), 0, RoundingMode.HALF_UP)
                values.add(runCatching { result.longValueExact() }.getOrNull() ?: return null)
            } else values.add(v)
        }
        var total = values.first()
        for (i in 1 until values.size) total = if (ops[i - 1] == "−") total - values[i] else total + values[i]
        return total
    }

    /** The keypad's text after a key: a digit, an operator, "⌫" or "=". */
    fun press(text: String, key: String): String {
        val list = tokens(text)
        val last = list.lastOrNull()
        if (key.length == 1 && key[0].isDigit()) {
            if (last == null || isOp(last)) return (list + show(key.toLong())).joinToString(" ")
            val current = cents(last) ?: 0L
            // Twelve digits is already more than a budget holds; Money.parse rejects the rest.
            if (Math.abs(current) >= 100_000_000_000L) return text
            val sign = if (current < 0) -1 else 1
            return (list.dropLast(1) + show(current * 10 + sign * key.toLong())).joinToString(" ")
        }
        if (isOp(key)) {
            if (last == null) return text
            return (if (isOp(last)) list.dropLast(1) + key else list + key).joinToString(" ")
        }
        if (key == "⌫") {
            if (last == null) return text
            if (isOp(last)) return list.dropLast(1).joinToString(" ")
            val shorter = (cents(last) ?: 0L) / 10
            return (if (shorter != 0L) list.dropLast(1) + show(shorter) else list.dropLast(1)).joinToString(" ")
        }
        if (key == "=") return value(text)?.let(::show) ?: text
        return text
    }

    /** Whether the text is a sum still to be worked out. */
    fun isSum(text: String) = tokens(text).any(::isOp)
}
