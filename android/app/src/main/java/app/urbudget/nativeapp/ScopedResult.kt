package app.urbudget.nativeapp

/** A result is displayable only for the exact budget, range and filters requested. */
data class ScopedResult<T>(val scope: Any, val value: T) {
    fun forScope(current: Any): T? = value.takeIf { scope == current }
}
