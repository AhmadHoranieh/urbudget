package app.urbudget.nativeapp

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AmountPadTest {
    private fun keys(vararg pressed: String) = pressed.fold("") { text, key -> AmountPad.press(text, key) }

    @Test fun digitsComeInFromTheRightAsCents() {
        assertEquals("0.01", keys("1"))
        assertEquals("12.34", keys("1", "2", "3", "4"))
        assertEquals("1.20", keys("1", "2", "0"))
    }

    @Test fun backspaceTakesBackTheLastDigitThenOperator() {
        assertEquals("1.23", keys("1", "2", "3", "4", "⌫"))
        assertEquals("12.34", keys("1", "2", "3", "4", "+", "⌫"))
        assertEquals("", keys("5", "⌫"))
    }

    @Test fun aSecondOperatorReplacesTheFirst() {
        assertEquals("12.34 −", keys("1", "2", "3", "4", "+", "−"))
        assertEquals("", keys("+"))
    }

    @Test fun sumsFollowArithmeticOrder() {
        assertEquals(1500L, AmountPad.value("10.00 + 5.00"))
        assertEquals(2000L, AmountPad.value("10.00 + 5.00 × 2.00"))
        assertEquals(333L, AmountPad.value("10.00 ÷ 3.00"))
        assertEquals(-250L, AmountPad.value("2.50 − 5.00"))
        assertNull(AmountPad.value("10.00 +"))
        assertNull(AmountPad.value("10.00 ÷ 0.00"))
        assertEquals("20.00", keys("1", "0", "0", "0", "+", "1", "0", "0", "0", "="))
    }

    @Test fun seededAmountsKeepTheirSign() {
        assertEquals("-1.23", AmountPad.press("-0.12", "3"))
        assertEquals(-12L, AmountPad.cents("-0.12"))
        assertEquals(120000L, AmountPad.cents("1,200"))
    }

    @Test fun refusesDigitsPastWhatABudgetHolds() {
        val big = AmountPad.show(100_000_000_000L)
        assertEquals(big, AmountPad.press(big, "9"))
    }
}
