package app.urbudget.nativeapp.ui

import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Pure synthetic render tests: no budget runtime, credentials, or network calls. */
@RunWith(AndroidJUnit4::class)
class LargeEditorUiTest {
    @get:Rule val compose = createComposeRule()

    @Test fun largeChoiceOnlyRendersVisibleOptionsAndCanSelectTheLastResult() {
        val selected = mutableStateOf("")
        val choices = List(2_000) { "$it" to "Category $it" }
        compose.setContent {
            MaterialTheme { Choice("Category", selected.value, choices) { selected.value = it } }
        }
        compose.onNodeWithTag("choice-open:Category").performClick()
        compose.waitUntil(5_000) {
            compose.onAllNodes(hasText("Category 0")).fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue("Offscreen options must not all be composed",
            compose.onAllNodes(hasText("Category ", substring = true)).fetchSemanticsNodes().size < 50)
        compose.onNodeWithText("Category 1999").assertDoesNotExist()
        compose.onNodeWithTag("choice-search:Category").performTextInput("Category 1999")
        val lastOption = hasText("Category 1999") and hasClickAction() and hasAnyAncestor(hasTestTag("choice-options:Category"))
        compose.waitUntil(5_000) {
            compose.onAllNodes(lastOption).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNode(lastOption).performClick()
        compose.runOnIdle { assertEquals("1999", selected.value) }
        compose.onNodeWithTag("choice-options:Category").assertDoesNotExist()
    }

    @Test fun largeReviewKeepsEveryRowReachableWithoutComposingAllRows() {
        val rows = List(2_000) { "Review row $it" }
        compose.setContent {
            MaterialTheme {
                LazyFormDialog("Synthetic review", onDismiss = {}) {
                    items(rows) { Text(it) }
                }
            }
        }
        compose.onNodeWithText("Review row 0").assertIsDisplayed()
        assertTrue("Review must only compose visible rows",
            compose.onAllNodes(hasText("Review row ", substring = true)).fetchSemanticsNodes().size < 50)
        compose.onNodeWithText("Review row 1999").assertDoesNotExist()
        compose.onNode(hasScrollToIndexAction()).performScrollToIndex(1_999)
        compose.onNodeWithText("Review row 1999").assertIsDisplayed()
    }

    @Test fun largeAssistantReportOnlyRendersVisibleRowsAndKeepsTheLastRowReachable() {
        val report = buildString {
            append("| Entry | Value |\n| --- | --- |\n")
            repeat(2_000) { append("| Report entry $it | $it |\n") }
        }
        compose.setContent {
            MaterialTheme { AssistantMarkdownDocument(report, Modifier.fillMaxSize()) }
        }
        compose.waitUntil(5_000) {
            compose.onAllNodes(hasText("Report entry 0")).fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue("Offscreen report rows must not all be composed",
            compose.onAllNodes(hasText("Report entry ", substring = true)).fetchSemanticsNodes().size < 50)
        compose.onNodeWithText("Report entry 1999").assertDoesNotExist()
        compose.onNode(hasScrollToIndexAction()).performScrollToIndex(2_000)
        compose.onNodeWithText("Report entry 1999").assertIsDisplayed()
    }
}
