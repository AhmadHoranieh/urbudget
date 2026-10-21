package app.urbudget.nativeapp.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.urbudget.nativeapp.AssistantController
import app.urbudget.nativeapp.AssistantState
import org.json.JSONObject
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

@Composable
internal fun AssistantSettingsDialog(controller: AssistantController, close: () -> Unit) {
    val settingsState = remember(controller) { controller.state.map { it.copy(streaming = "", thinking = "", thread = null, entries = emptyList()) }.distinctUntilChanged() }
    val state by settingsState.collectAsStateWithLifecycle(AssistantState())
    val status = state.status
    var key by remember { mutableStateOf("") }
    var deleteHistory by remember { mutableStateOf(false) }
    val provider = status?.text("provider") ?: "chatgpt"
    val ready = status?.optBoolean("ready") == true
    val modelChoices = remember(state.models) { listOf("" to "Provider default") + state.models.map { it.text("id") to it.text("name", it.text("id")) } }
    val signingIn = "signIn" in state.busy || status?.optBoolean("signingIn") == true
    Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth().fillMaxHeight(.94f).padding(12.dp), shape = MaterialTheme.shapes.large) {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Assistant settings", style = MaterialTheme.typography.headlineSmall)
                Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text("Answers use your budget and the files you attach. Changes are proposed for your review. Your chosen provider processes the conversation.")
                    Choice("Provider", provider, listOf("chatgpt" to "ChatGPT plan · browser sign-in", "openai" to "OpenAI API key", "anthropic" to "Anthropic API key")) {
                        if (!signingIn) { key = ""; controller.settings(JSONObject().put("provider", it)) }
                    }
                    if (provider == "chatgpt") {
                        Text(if (ready) "Signed in ${status?.optJSONObject("account")?.text("email").orEmpty()}" else "Sign in in your browser, then return here. Your ChatGPT plan must allow this app's usage.")
                        if (signingIn) {
                            LinearProgressIndicator(Modifier.fillMaxWidth())
                            OutlinedButton(controller::cancelSignIn) { Text("Cancel sign-in") }
                        } else if (ready) OutlinedButton(controller::signOut, enabled = "signOut" !in state.busy) { Text("Sign out") }
                        else Button(controller::signIn) { Text("Continue with ChatGPT") }
                        Row { TextButton({ controller.openLink("usage") }) { Text("Plan usage") }; TextButton({ controller.openLink("disconnect") }) { Text("Connected apps") } }
                    } else {
                        val saved = status?.optBoolean(if (provider == "openai") "hasOpenaiKey" else "hasAnthropicKey") == true
                        Text("API usage is billed by ${if (provider == "openai") "OpenAI" else "Anthropic"}. The key is checked with your provider before saving.")
                        if (saved) OutlinedButton({ controller.forgetKey(provider) }, enabled = "key" !in state.busy) { Text("Remove saved key") }
                        else {
                            FilledField(key, { key = it }, label = { Text("API key") }, visualTransformation = PasswordVisualTransformation(), singleLine = true, modifier = Modifier.fillMaxWidth())
                            Button({ controller.setKey(provider, key) { key = "" } }, enabled = key.isNotBlank() && "key" !in state.busy) { Text(if ("key" in state.busy) "Checking key…" else "Verify and save key") }
                        }
                        TextButton({ controller.openLink(if (provider == "openai") "openaiKeys" else "anthropicKeys") }) { Text("Get an API key") }
                    }
                    status?.text("storage")?.takeIf(String::isNotEmpty)?.let { Text("Credentials: $it", style = MaterialTheme.typography.bodySmall) }
                    if (ready && status?.text("storage").isNullOrEmpty()) Text("Credentials are kept in memory until the app closes.", style = MaterialTheme.typography.bodySmall)
                    if (ready) {
                        Choice("Model", status?.text("model").orEmpty(), modelChoices) {
                            controller.settings(JSONObject().put("model", it))
                        }
                        TextButton(controller::models, enabled = "models" !in state.busy) { Text("Refresh available models") }
                    }
                    HorizontalDivider()
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) { Text("Share transaction memos"); Text("Include memo text in budget lookups sent to the provider.", style = MaterialTheme.typography.bodySmall) }
                        Switch(status?.optBoolean("shareMemos", true) ?: true, { controller.settings(JSONObject().put("shareMemos", it)) })
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) { Text("Keep conversation history"); Text("Saved only in this budget's folder. Existing history stays until deleted.", style = MaterialTheme.typography.bodySmall) }
                        Switch(status?.optBoolean("keepHistory", true) ?: true, { controller.settings(JSONObject().put("keepHistory", it)) })
                    }
                    OutlinedButton({ deleteHistory = true }) { Text("Delete all conversations and attachments") }
                }
                TextButton(close, Modifier.align(Alignment.End)) { Text("Done") }
            }
        }
    }
    if (deleteHistory) AlertDialog(onDismissRequest = { deleteHistory = false }, title = { Text("Delete all assistant history?") },
        text = { Text("This deletes every conversation and attached file for the open budget on this device. Running replies are stopped.") },
        confirmButton = { TextButton({ controller.deleteAll(); deleteHistory = false }) { Text("Delete all") } },
        dismissButton = { TextButton({ deleteHistory = false }) { Text("Cancel") } })
}
