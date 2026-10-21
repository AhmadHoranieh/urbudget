import { useEffect, useState } from "react";
import { Copy, LoaderCircle } from "lucide-react";
import { errorText } from "../format";
import { useToast } from "../ui";
import { assistant, type Model, type Provider, type Status } from "./api";
import "./assistant.css";

const SERVICES: [Provider, string][] = [
  ["chatgpt", "ChatGPT plan (sign in)"],
  ["openai", "OpenAI API key"],
  ["anthropic", "Anthropic API key (Claude)"],
];

/** Settings › Assistant: which service it uses, privacy, conversations, and (on a computer) other AI apps. */
export function AssistantSettings() {
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fail = (e: unknown) => toast({ message: errorText(e), tone: "error" });
  const run = async (label: string, work: () => Promise<Status | void>) => {
    setBusy(label);
    try {
      const next = await work();
      if (next) setStatus(next);
    } catch (e) {
      fail(e);
      setStatus(await assistant.status().catch(() => status));
    } finally {
      setBusy("");
    }
  };
  useEffect(() => {
    void assistant.status().then(setStatus).catch(fail);
  }, []);
  useEffect(() => {
    setModels([]);
    if (status?.ready) void assistant.models().then(setModels).catch(() => setModels([]));
  }, [status?.provider, status?.ready]);

  if (!status)
    return (
      <section className="panel">
        <h2>Assistant</h2>
        <LoaderCircle size={16} className="spin" />
      </section>
    );
  const keyed = status.provider !== "chatgpt";
  const hasKey = status.provider === "openai" ? status.hasOpenaiKey : status.hasAnthropicKey;
  const config = JSON.stringify(status.mcp.config, null, 2);
  return (
    <>
      <section className="panel assistant-settings">
        <h2>Assistant</h2>
        <p className="help">
          It answers questions about your budget, reads the files you attach, and proposes changes. Nothing changes until you
          apply it.
        </p>
        <div className="setting-list">
          <div className="setting-row">
            <span>
              <strong>Service</strong>
              <small>Your ChatGPT Plus or Pro plan, or your own API key, pays for the assistant.</small>
            </span>
            <select
              aria-label="Service"
              value={status.provider}
              disabled={!!busy}
              onChange={(e) => void run("provider", () => assistant.settings({ provider: e.target.value as Provider }))}
            >
              {SERVICES.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {!keyed ? (
            <div className="setting-row">
              <span>
                <strong>ChatGPT account</strong>
                <small>
                  {status.ready
                    ? `Signed in${status.account?.email ? ` as ${status.account.email}` : ""}. ${
                        status.storage ? `The sign-in is kept in ${status.storage}.` : "You'll sign in again next time."
                      }`
                    : "Opens your browser to sign in, then comes back here."}
                </small>
              </span>
              {status.ready ? (
                <button className="secondary" disabled={!!busy} onClick={() => void run("out", assistant.signOut)}>
                  Sign out
                </button>
              ) : busy === "in" ? (
                <button className="secondary" onClick={() => void assistant.cancelSignIn()}>
                  <LoaderCircle size={14} className="spin" /> Cancel sign-in
                </button>
              ) : (
                <button className="primary" disabled={!!busy} onClick={() => void run("in", assistant.signIn)}>
                  Continue with ChatGPT
                </button>
              )}
            </div>
          ) : (
            <div className="setting-row">
              <span>
                <strong>API key</strong>
                <small>
                  {hasKey
                    ? `Saved${status.storage ? ` in ${status.storage}` : " until the app closes"}.`
                    : `Create one in your ${status.provider === "openai" ? "OpenAI" : "Anthropic"} account. Usage is billed there.`}
                </small>
              </span>
              {hasKey ? (
                <button className="secondary" disabled={!!busy} onClick={() => void run("forget", () => assistant.forgetKey(status.provider))}>
                  Remove key
                </button>
              ) : (
                <form
                  className="assistant-key"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run("key", async () => {
                      const next = await assistant.setKey(status.provider, key);
                      setKey("");
                      return next;
                    });
                  }}
                >
                  <input
                    type="password"
                    aria-label="API key"
                    placeholder={status.provider === "openai" ? "sk-…" : "sk-ant-…"}
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    autoComplete="off"
                  />
                  <button className="primary" disabled={!key.trim() || !!busy}>
                    {busy === "key" ? <LoaderCircle size={14} className="spin" /> : null} Save key
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => void assistant.open(status.provider === "openai" ? "openaiKeys" : "anthropicKeys")}
                  >
                    Get a key
                  </button>
                </form>
              )}
            </div>
          )}

          <div className="setting-row">
            <span>
              <strong>Model</strong>
              <small>{status.ready ? "The list comes from your account." : "Sign in or add a key to choose."}</small>
            </span>
            <select
              aria-label="Model"
              value={status.model ?? ""}
              disabled={!status.ready || !!busy}
              onChange={(e) => void run("model", () => assistant.settings({ model: e.target.value }))}
            >
              <option value="">Default{models[0] && status.provider !== "anthropic" ? ` (${models[0].name})` : ""}</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          <label className="setting-row toggle">
            <span>
              <strong>Share memos</strong>
              <small>Dates, payees, amounts and categories are always shared when the assistant looks something up.</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={status.shareMemos}
              onChange={(e) => void run("memos", () => assistant.settings({ shareMemos: e.target.checked }))}
            />
          </label>
          <label className="setting-row toggle">
            <span>
              <strong>Keep conversations</strong>
              <small>Saved with each budget's files on this computer. When off, they're forgotten when the app closes.</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={status.keepHistory}
              onChange={(e) => void run("keep", () => assistant.settings({ keepHistory: e.target.checked }))}
            />
          </label>
          <div className="setting-row">
            <span>
              <strong>Conversations and attachments</strong>
              <small>For the open budget.</small>
            </span>
            {confirmDelete ? (
              <span className="assistant-key">
                <button className="secondary" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
                <button
                  className="danger"
                  onClick={() =>
                    void run("delete", async () => {
                      await assistant.deleteAll();
                      setConfirmDelete(false);
                      toast({ message: "Deleted the assistant's conversations and attachments." });
                    })
                  }
                >
                  Delete all
                </button>
              </span>
            ) : (
              <button className="secondary" onClick={() => setConfirmDelete(true)}>
                Delete all conversations
              </button>
            )}
          </div>
          {!keyed && (
            <div className="setting-row">
              <span>
                <strong>Usage</strong>
                <small>Counts toward your ChatGPT plan, like using ChatGPT. You can set a limit for UrBudget in ChatGPT.</small>
              </span>
              <button className="secondary" onClick={() => void assistant.open("usage")}>
                Manage usage
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="panel assistant-settings">
        <h2>Use your budget in other AI apps</h2>
        <p className="help">
          Claude Desktop and other apps that support MCP can read the open budget: months, transactions, reports and forecasts.
          They can't change anything. Add this to the app's MCP settings (in Claude Desktop: Settings › Developer › Edit Config).
        </p>
        <pre className="assistant-mcp">{config}</pre>
        <div>
          <button
            className="secondary"
            onClick={() =>
              void navigator.clipboard
                .writeText(config)
                .then(() => toast({ message: "Copied." }))
                .catch(fail)
            }
          >
            <Copy size={14} /> Copy
          </button>
        </div>
      </section>
    </>
  );
}
