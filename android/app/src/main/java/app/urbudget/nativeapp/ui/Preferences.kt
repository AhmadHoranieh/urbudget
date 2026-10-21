package app.urbudget.nativeapp.ui

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import app.urbudget.nativeapp.NativePreferences

/**
 * The app preferences screens read, as state: changing one in Settings shows at once wherever it's
 * used. Without a store (previews, tests) they keep the desktop's defaults in memory.
 */
@Stable
internal class UiPreferences(private val store: NativePreferences?) {
    private var cleared by mutableStateOf(store?.newCleared ?: false)
    private var needed by mutableStateOf(store?.showNeeded ?: true)
    private var upcoming by mutableStateOf(store?.showUpcoming ?: true)
    private var start by mutableStateOf(store?.startPage ?: "budget")
    private var schedules by mutableStateOf(store?.automaticSchedules ?: true)

    val newCleared get() = cleared
    val showNeeded get() = needed
    val showUpcoming get() = upcoming
    val startPage get() = start
    val automaticSchedules get() = schedules

    fun setNewCleared(value: Boolean) { cleared = value; store?.newCleared = value }
    fun setShowNeeded(value: Boolean) { needed = value; store?.showNeeded = value }
    fun setShowUpcoming(value: Boolean) { upcoming = value; store?.showUpcoming = value }
    fun setStartPage(value: String) { start = value; store?.startPage = value }
    fun setAutomaticSchedules(value: Boolean) { schedules = value; store?.automaticSchedules = value }
}

internal val LocalPreferences = staticCompositionLocalOf { UiPreferences(null) }
