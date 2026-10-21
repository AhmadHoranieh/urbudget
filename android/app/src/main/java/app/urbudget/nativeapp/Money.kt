package app.urbudget.nativeapp

import java.math.BigDecimal
import java.math.RoundingMode
import java.text.NumberFormat
import java.util.Locale
import java.util.Currency
import java.util.concurrent.ConcurrentHashMap
import java.time.format.DateTimeFormatter
import org.json.JSONObject

/** Exact text conversion only; budget arithmetic belongs to Rust. The portable schema uses cents. */
object Money {
    @Volatile private var settings = Format()
    @Volatile private var dateFormat = "iso"
    data class Format(val decimal: String = ".", val group: String = ",", val symbol: String = "after") {
        private val grouped = if (group.isNotEmpty() && group != decimal) "|[0-9]{1,3}(?:${Regex.escape(group)}[0-9]{3})+" else ""
        val input = Regex("[+-]?(?:[0-9]+$grouped)(?:${Regex.escape(decimal)}[0-9]{1,2})?")
    }
    private val symbols = ConcurrentHashMap<String, String>()
    private val dates = mapOf("dmy" to "dd/MM/yyyy", "mdy" to "MM/dd/yyyy", "dmmmy" to "d MMM yyyy", "iso" to "yyyy-MM-dd")
        .mapValues { DateTimeFormatter.ofPattern(it.value, Locale.ENGLISH) }
    fun configure(budget: JSONObject) {
        dateFormat = budget.optString("dateFormat", "iso")
        val saved = budget.optJSONObject("numberFormat")
        val currency = budget.optString("currency", "SAR")
        val symbol = currencySymbol(currency)
        settings = Format(saved?.optString("decimal")?.takeIf { it in setOf(".", ",") } ?: ".",
            saved?.optString("group")?.takeIf { it in setOf(",", ".", " ", "'", "") } ?: ",",
            saved?.optString("symbol")?.takeIf { it in setOf("before", "after", "none") } ?: if (symbol == currency) "after" else "before")
    }
    private fun currencySymbol(currency: String) = symbols.computeIfAbsent(currency) { runCatching { Currency.getInstance(it).getSymbol(Locale.ENGLISH) }.getOrDefault(it) }
    fun parse(text: String, currency: String = "SAR"): Long {
        val format = settings
        val normalized = text.trim().replace("\u066b", format.decimal).replace("\u066c", format.group)
            .map { char -> if (char.isDigit()) Character.digit(char, 10).digitToChar() else char }.joinToString("")
        require(format.input.matches(normalized)) {
            "Enter an amount with up to two decimal places. Decimal separator: ${format.decimal}"
        }
        val ungrouped = if (format.group.isNotEmpty() && format.group != format.decimal) normalized.replace(format.group, "") else normalized
        val cents = try { BigDecimal(ungrouped.replace(format.decimal, ".")).movePointRight(2).longValueExact() }
            catch (_: ArithmeticException) { throw IllegalArgumentException("The amount is too large.") }
        require(cents in -1_000_000_000_000L..1_000_000_000_000L) { "The amount is too large." }
        return cents
    }

    fun format(amount: Long, currency: String = "SAR"): String {
        val format = settings
        // Slice the integer's decimal text: no floating point and no abs(Long.MIN_VALUE).
        val digits = amount.toString().removePrefix("-").padStart(3, '0')
        val whole = digits.dropLast(2)
        val grouped = buildString(whole.length + whole.length / 3) {
            whole.forEachIndexed { index, digit ->
                if (index > 0 && (whole.length - index) % 3 == 0) append(format.group)
                append(digit)
            }
        }
        val number = "$grouped${format.decimal}${digits.takeLast(2)}"
        val sign = if (amount < 0) "-" else ""
        val symbol = currencySymbol(currency)
        return when (format.symbol) {
            "before" -> "$sign$symbol${if (symbol == currency) " " else ""}$number"
            "none" -> "$sign$number"
            else -> "$sign$number $symbol"
        }
    }

    fun editable(amount: Long): String = BigDecimal.valueOf(amount, 2).toPlainString().replace(".", settings.decimal)
    /** The budget's decimal mark, for the keypad's display. */
    fun decimalMark(): String = settings.decimal
    fun date(iso: String): String = runCatching {
        java.time.LocalDate.parse(iso).format(dates[dateFormat] ?: dates.getValue("iso"))
    }.getOrDefault(iso)
}
