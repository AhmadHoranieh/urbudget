package app.urbudget.nativeapp

import org.junit.Assert.*
import org.junit.Test
import org.junit.Before
import org.junit.After
import org.json.JSONObject

class MoneyTest {
    @Before @After fun resetFormat() { Money.configure(JSONObject().put("currency", "SAR")) }
    @Test fun desktopNumberPreferencesRoundTripWithoutAmbiguousSeparators() {
        Money.configure(JSONObject().put("currency", "EUR").put("dateFormat", "dmy").put("numberFormat", JSONObject().put("decimal", ",").put("group", ".").put("symbol", "after")))
        assertEquals(-123456L, Money.parse("-1.234,56"))
        assertEquals("-1.234,56 €", Money.format(-123456, "EUR"))
        assertEquals("-1234,56", Money.editable(-123456))
        assertEquals("15/10/2026", Money.date("2026-10-15"))
        assertThrows(IllegalArgumentException::class.java) { Money.parse("1,234.56") }
    }
    @Test fun parsesExactCentsWithoutFloatingPointRounding() {
        assertEquals(101L, Money.parse("1.01"))
        assertEquals(-123456L, Money.parse("-1,234.56"))
        assertEquals(123456L, Money.parse("١٬٢٣٤٫٥٦"))
        assertEquals(1_000_000_000_000L, Money.parse("10000000000.00"))
    }

    @Test fun rejectsAmbiguousOverPrecisionAndOversizedAmounts() {
        listOf("1.001", "12,34", "1e8", "NaN", "10000000000.01", "", "1,23.45").forEach { text ->
            try { Money.parse(text); fail("Expected rejection for $text") } catch (_: IllegalArgumentException) {}
        }
    }

    @Test fun editableFormattingRoundTripsAllSupportedValues() {
        listOf(0L, 1L, -1L, 123456L, -999999999999L).forEach { value ->
            assertEquals(value, Money.parse(Money.editable(value)))
        }
    }

    @Test fun cachedFormatsRetainExactExtremesAndPreferenceChanges() {
        Money.configure(JSONObject().put("currency", "USD").put("numberFormat", JSONObject().put("symbol", "none").put("group", ",")))
        assertEquals("0.01", Money.format(1, "USD"))
        assertEquals("-0.01", Money.format(-1, "USD"))
        assertEquals("-92,233,720,368,547,758.08", Money.format(Long.MIN_VALUE, "USD"))
        Money.configure(JSONObject().put("currency", "EUR").put("dateFormat", "dmmmy").put("numberFormat", JSONObject().put("decimal", ",").put("group", " ").put("symbol", "after")))
        assertEquals("1 234,56 €", Money.format(123456, "EUR"))
        assertEquals(123456L, Money.parse("1 234,56"))
        assertEquals("15 Oct 2026", Money.date("2026-10-15"))
        assertEquals("not-a-date", Money.date("not-a-date"))
    }
}
