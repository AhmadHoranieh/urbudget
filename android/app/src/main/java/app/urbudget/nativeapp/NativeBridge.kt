package app.urbudget.nativeapp

/** Versioned JNI boundary. All financial rules are implemented in urbudget-core. */
object NativeBridge {
    init { System.loadLibrary("urbudget_android") }
    external fun invoke(request: String): String
    external fun initialize(context: android.content.Context, directory: String): String
    external fun service(request: String): String
}

fun interface BudgetEngine {
    fun invoke(request: String): String
}
