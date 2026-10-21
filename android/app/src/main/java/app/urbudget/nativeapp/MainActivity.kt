package app.urbudget.nativeapp

import android.os.Bundle
import android.content.Intent
import android.net.Uri
import androidx.activity.viewModels
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.debounce
import org.json.JSONObject
import java.io.File
import java.time.LocalDate
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import app.urbudget.nativeapp.ui.UrBudgetApp
import app.urbudget.nativeapp.ui.UrBudgetTheme

class MainActivity : ComponentActivity() {
    private val model: BudgetViewModel by viewModels()
    @OptIn(kotlinx.coroutines.FlowPreview::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { UrBudgetTheme { UrBudgetApp(model) } }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    NativeServices.events.collect { event ->
                        val payload = event.optJSONObject("payload") ?: return@collect
                        runCatching {
                            when (event.optString("event")) {
                                "host://open-url" -> {
                                    val uri = Uri.parse(payload.getString("url"))
                                    require(uri.scheme in setOf("https", "http"))
                                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                                }
                                "host://open-file" -> shareFile(payload.getString("path"))
                            }
                        }.onFailure { model.notifyError(it.message ?: "No app could open this file or link.") }
                    }
                }
                launch(Dispatchers.IO) {
                    runCatching { NativeServices.initialize(applicationContext) }
                    while (isActive) { runCatching { NativeServices.pollEvents() }; delay(300) }
                }
                launch(Dispatchers.IO) {
                    runCatching {
                        NativeServices.initialize(applicationContext)
                        if (NativePreferences(applicationContext).automaticSchedules) NativeServices.call("apply_due_schedules", JSONObject().put("through", LocalDate.now().toString()))
                    }
                    model.refresh()
                    while (isActive) { syncIfReady(); delay(60_000) }
                }
                launch(Dispatchers.IO) { NativeServices.saved.debounce(2_000).collect { syncIfReady() } }
            }
        }
    }

    private fun syncIfReady() {
        if (!NativePreferences(applicationContext).automaticSync) return
        runCatching {
            if (NativeServices.syncAutomatically()?.optBoolean("openChanged") == true) model.refresh()
        }
    }

    private suspend fun shareFile(path: String) {
        val exported = withContext(Dispatchers.IO) {
            val source = File(path).canonicalFile
            require(source.toPath().startsWith(filesDir.canonicalFile.toPath()) && source.isFile) { "The generated file is unavailable." }
            require(source.length() <= 64L * 1024 * 1024) { "This file is too large to share." }
            val directory = File(cacheDir, "exports").apply { mkdirs() }
            source.copyTo(File(directory, source.name), overwrite = true)
        }
        val uri = FileProvider.getUriForFile(this, "$packageName.files", exported)
        val type = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(exported.extension.lowercase()) ?: "application/octet-stream"
        try {
            startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        } catch (_: android.content.ActivityNotFoundException) {
            startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType(type).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "Share ${exported.name}"))
        }
    }
}
