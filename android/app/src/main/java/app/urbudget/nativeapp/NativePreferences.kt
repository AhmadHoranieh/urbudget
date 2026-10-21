package app.urbudget.nativeapp

import android.content.Context

class NativePreferences(context: Context) {
    private val preferences = context.getSharedPreferences("native-preferences", Context.MODE_PRIVATE)
    var automaticSync: Boolean
        get() = preferences.getBoolean("automaticSync", true)
        set(value) { preferences.edit().putBoolean("automaticSync", value).apply() }
    var automaticSchedules: Boolean
        get() = preferences.getBoolean("automaticSchedules", true)
        set(value) { preferences.edit().putBoolean("automaticSchedules", value).apply() }
    var theme: String
        get() = preferences.getString("theme", "system") ?: "system"
        set(value) { preferences.edit().putString("theme", value).apply() }
    /** The desktop's display preferences that mean something on a phone (SettingsPage.tsx). */
    var newCleared: Boolean
        get() = preferences.getBoolean("newCleared", false)
        set(value) { preferences.edit().putBoolean("newCleared", value).apply() }
    var showNeeded: Boolean
        get() = preferences.getBoolean("showNeeded", true)
        set(value) { preferences.edit().putBoolean("showNeeded", value).apply() }
    var showUpcoming: Boolean
        get() = preferences.getBoolean("showUpcoming", true)
        set(value) { preferences.edit().putBoolean("showUpcoming", value).apply() }
    var startPage: String
        get() = preferences.getString("startPage", "budget") ?: "budget"
        set(value) { preferences.edit().putString("startPage", value).apply() }
}
