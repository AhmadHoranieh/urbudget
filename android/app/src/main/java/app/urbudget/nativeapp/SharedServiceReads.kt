package app.urbudget.nativeapp

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async

/** A screen can leave while a blocking JNI read finishes. Reopening joins that request instead
 * of queuing another network download; cancellation detaches only that screen's subscriber. */
internal class SharedServiceReads(private val scope: CoroutineScope) {
    private val pending = mutableMapOf<String, Deferred<Any?>>()
    suspend fun request(key: String, read: suspend () -> Any?): Any? {
        val result = synchronized(pending) {
            pending[key] ?: scope.async(start = CoroutineStart.LAZY) { read() }.also { task ->
                pending[key] = task
                task.invokeOnCompletion { synchronized(pending) { if (pending[key] === task) pending.remove(key) } }
            }
        }
        result.start()
        return result.await()
    }
}
