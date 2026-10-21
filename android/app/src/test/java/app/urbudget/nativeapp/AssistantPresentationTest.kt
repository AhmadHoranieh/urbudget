package app.urbudget.nativeapp

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AssistantPresentationTest {
    @Test fun tokenBurstsPreserveExactTextAcrossBatchedPublications() {
        val buffer = AssistantStreamBuffer()
        val expected = StringBuilder()
        repeat(20_000) { index ->
            val token = "$index · "
            expected.append(token)
            buffer.append(token)
            if (index % 64 == 0) assertEquals(expected.toString(), buffer.drain()!!.first)
        }
        assertEquals(expected.toString(), buffer.drain()!!.first)
        assertNull(buffer.drain())
    }

    @Test fun completingMessageAndSwitchingConversationDoNotLeakBufferedText() {
        val buffer = AssistantStreamBuffer()
        buffer.append("private reply")
        buffer.append("reasoning", thinking = true)
        buffer.clearReply()
        assertEquals("" to "reasoning", buffer.drain())
        buffer.append("late chunk")
        buffer.clear()
        assertNull(buffer.drain())
        buffer.append("new conversation")
        assertEquals("new conversation" to "", buffer.drain())
    }

    @Test fun largeUnchangedPollKeepsTheEntirePublishedPresentation() {
        val thread = conversation("one", 5_000)
        val first = assistantThreadPresentation(thread, null)
        val refreshed = assistantThreadPresentation(JSONObject(thread.toString()), first)
        assertSame(first, refreshed)
        assertSame(first.entries, refreshed.entries)
    }

    @Test fun appendingReplyOrUpdatingProposalOnlyInvalidatesChangedEntries() {
        val original = conversation("one", 500)
        val first = assistantThreadPresentation(original, null)
        val next = JSONObject(original.toString())
        next.getJSONArray("entries").getJSONObject(300).put("text", "Rechecked proposal")
        next.getJSONArray("entries").put(JSONObject().put("kind", "assistant").put("text", "Final reply"))
        val refreshed = assistantThreadPresentation(next, first)
        assertEquals(501, refreshed.entries.size)
        repeat(500) { if (it != 300) assertSame(first.entries[it], refreshed.entries[it]) }
        assertNotSame(first.entries[300], refreshed.entries[300])
        assertEquals("Message 300", first.entries[300].getString("text"))
        assertEquals("Rechecked proposal", refreshed.entries[300].getString("text"))
    }

    @Test fun anotherConversationNeverReusesOldEntryReferences() {
        val first = assistantThreadPresentation(conversation("one", 20), null)
        val second = assistantThreadPresentation(conversation("two", 20), first)
        repeat(20) { assertNotSame(first.entries[it], second.entries[it]) }
    }

    private fun conversation(id: String, count: Int) = JSONObject().put("id", id).put("running", false)
        .put("entries", JSONArray((0 until count).map { JSONObject().put("kind", "assistant").put("text", "Message $it") }))
}
