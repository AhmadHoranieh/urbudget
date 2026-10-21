package app.urbudget.nativeapp

import org.junit.Assert.*
import org.junit.Test

class ReportScopeTest {
    @Test fun changedFiltersHidePreviousFiguresBeforeReplacementArrives() {
        val previous = ScopedResult("budget-a/october/all", 2500L)
        assertEquals(2500L, previous.forScope("budget-a/october/all"))
        assertNull(previous.forScope("budget-a/november/all"))
        assertNull(previous.forScope("budget-a/october/cash"))
        assertNull(previous.forScope("budget-b/october/all"))
    }

    @Test fun delayedOldResponseCannotBecomeCurrentReportOrForecast() {
        val delayed = ScopedResult("old-request", listOf(100L))
        assertNull(delayed.forScope("new-request"))
        assertEquals(listOf(200L), ScopedResult("new-request", listOf(200L)).forScope("new-request"))
    }
}
