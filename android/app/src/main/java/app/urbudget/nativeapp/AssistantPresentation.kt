package app.urbudget.nativeapp

import org.json.JSONObject

/** Append tokens once; publish at a bounded cadence instead of copying a reply for every token. */
internal class AssistantStreamBuffer {
    private val reply = StringBuilder()
    private val reasoning = StringBuilder()
    private var changed = false

    fun append(text: String, thinking: Boolean = false) {
        if (text.isEmpty()) return
        (if (thinking) reasoning else reply).append(text)
        changed = true
    }

    fun clearReply() { reply.clear(); changed = true }
    fun clear() { reply.clear(); reasoning.clear(); changed = false }
    fun drain(): Pair<String, String>? = if (!changed) null else {
        changed = false
        reply.toString() to reasoning.toString()
    }
}

/** All comparisons run on a worker. Unchanged messages retain their Compose/render caches. */
internal data class AssistantThreadPresentation(val thread: JSONObject, val entries: List<JSONObject>)

internal fun assistantThreadPresentation(thread: JSONObject, previous: AssistantThreadPresentation?): AssistantThreadPresentation {
    val sameThread = previous?.thread?.optString("id") == thread.optString("id")
    if (sameThread && sameJson(previous?.thread, thread)) return previous!!
    val entries = thread.records("entries").mapIndexed { index, entry ->
        val old = if (sameThread) previous?.entries?.getOrNull(index) else null
        if (old != null && sameJson(old, entry)) old else entry
    }
    return AssistantThreadPresentation(thread, entries)
}
