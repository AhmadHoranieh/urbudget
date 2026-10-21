// Small CDP client for a dedicated QA app. Never point it at a personal budget or shared profile.
export async function connect(port = process.env.CDP_PORT ?? 9222) {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const candidates = pages.filter(p => p.type === "page" &&
    /^(https?:\/\/(127\.0\.0\.1|localhost|tauri\.localhost)(:|\/)|tauri:\/\/)/.test(p.url));
  if (candidates.length !== 1) throw new Error(`Expected one local QA window on ${port}; found ${candidates.length}`);
  const page = candidates[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onclose = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("QA window disconnected"));
    }
    pending.clear();
  };
  ws.onmessage = e => {
    const message = JSON.parse(e.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
  };
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timed out: ${method}`)); }, 30000);
      pending.set(key, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: key, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  return { send, evaluate, page, close() { ws.close(); } };
}
