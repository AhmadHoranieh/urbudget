package app.urbudget.nativeapp.ui

import org.junit.Assert.*
import org.junit.Test

class AssistantMarkdownTest {
    @Test fun largeReportTableBecomesIndividualLazyRowsWithoutLosingData() {
        val source = buildString {
            append("# Report\n\n| Payee | Amount |\n| --- | ---: |\n")
            repeat(10_000) { append("| Payee $it | $it |\n") }
            append("\nAll rows included.")
        }
        val document = markdownDocumentBlocks(source)
        assertEquals(10_003, document.size)
        assertEquals("heading", document.first().kind)
        assertEquals(listOf("Payee", "Amount"), document[1].rows.single())
        assertEquals(listOf("Payee 9999", "9999"), document[10_001].rows.single())
        assertEquals("All rows included.", document.last().text)
        assertTrue(document.none { it.kind == "table" })
    }

    @Test fun chatAndReportKeepCodeHeadingsAndCompleteParagraphs() {
        val source = "# Summary\n\n- First item\n```text\nexact | values\n```\n---\n**Final** [source](https://example.com)"
        val blocks = markdownBlocks(source)
        assertEquals(listOf("heading", "text", "code", "rule", "text"), blocks.map { it.kind })
        assertEquals("• First item", blocks[1].text)
        assertEquals("exact | values", blocks[2].text)
        assertEquals(blocks, markdownDocumentBlocks(source))
    }
}
