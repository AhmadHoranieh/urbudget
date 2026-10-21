import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker, { app } from "../src/index";
import { testEnv, type TestEnv } from "./fakes";

let env: TestEnv;
beforeEach(async () => {
  env = await testEnv();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Reports must not send emails or call another service."); }));
});
afterEach(() => vi.unstubAllGlobals());
const submit = (body: unknown, headers: Record<string, string> = {}) => app.request("/api/v1/assistant-reports", {
  method: "POST",
  headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.1", ...headers },
  body: JSON.stringify(body),
}, env);

it("stores only the explicitly submitted excerpt and explanation, without an account or email delivery", async () => {
  const response = await submit({ text: " <script>private excerpt</script> ", reason: " Harmful suggestion " });
  expect(response.status).toBe(201);
  const { id } = await response.json() as { id: string };
  expect(id).toMatch(/^rep_[\w-]+$/);
  expect(env.DB.sqlite.prepare("SELECT * FROM assistant_reports").get()).toEqual({
    id, created_at: expect.any(String), reply: "<script>private excerpt</script>", reason: "Harmful suggestion",
  });
  expect(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
  expect(fetch).not.toHaveBeenCalled();
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

it.each([
  null, [], { text: "" }, { text: "  " }, { text: 1 }, { text: "reply", reason: 1 },
  { text: "reply", conversation: "Do not collect me" }, { text: "x".repeat(4001) },
  { text: "reply", reason: "x".repeat(1001) }, { text: "😀".repeat(2001) },
])("rejects malformed, excessive or additional report data: %j", async (body) => {
  expect((await submit(body)).status).toBe(400);
  expect(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM assistant_reports").get()).toEqual({ n: 0 });
});

it("accepts Unicode at the same text limit as the form and Rust bridge", async () => {
  expect((await submit({ text: "😀".repeat(2000), reason: "رأي" })).status).toBe(201);
});

it("bounds actual streamed bytes even with a misleading Content-Length", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(32_769)); }, cancel,
  });
  const request = new Request("http://localhost/api/v1/assistant-reports", {
    method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "1" },
    body: stream, duplex: "half",
  } as RequestInit & { duplex: "half" });
  expect((await app.request(request, {}, env)).status).toBe(413);
  expect(cancel).toHaveBeenCalled();
  expect(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM assistant_reports").get()).toEqual({ n: 0 });
});

it("rejects non-JSON submissions and declared oversized requests", async () => {
  expect((await submit({ text: "reply" }, { "Content-Type": "text/plain" })).status).toBe(415);
  expect((await submit({ text: "reply" }, { "Content-Length": "32769" })).status).toBe(413);
});

it("limits anonymous submissions without putting the raw IP in the report or rate-limit row", async () => {
  for (let i = 0; i < 5; i++) expect((await submit({ text: "reply" })).status).toBe(201);
  expect((await submit({ text: "reply" })).status).toBe(429);
  expect((await submit({ text: "reply" }, { "CF-Connecting-IP": "192.0.2.2" })).status).toBe(201);
  expect(JSON.stringify(env.DB.sqlite.prepare("SELECT * FROM rate_limits").all())).not.toContain("192.0.2.");
});

it("allows only an admin to review and delete reports, and does not copy their content into audit logs", async () => {
  const { id } = await (await submit({ text: "sensitive excerpt", reason: "reason" })).json() as { id: string };
  const adminPath = `/api/v1/admin/assistant-reports/${id}`;
  const originalDevCodes = env.DEV_LOGIN_CODES;
  env.DEV_LOGIN_CODES = undefined;
  expect((await app.request("/api/v1/admin/assistant-reports", {}, env)).status).toBe(403);
  expect((await app.request(adminPath, { method: "DELETE" }, env)).status).toBe(403);
  env.DEV_LOGIN_CODES = originalDevCodes;
  const list = await app.request("/api/v1/admin/assistant-reports", {}, env);
  expect(await list.json()).toMatchObject({ reports: [{ id, reply: "sensitive excerpt", reason: "reason" }], hasMore: false });
  expect((await app.request(adminPath, { method: "DELETE", headers: { Origin: "https://untrusted.example" } }, env)).status).toBe(403);
  expect((await app.request(adminPath, { method: "DELETE", headers: { Origin: "http://localhost" } }, env)).status).toBe(200);
  expect(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM assistant_reports").get()).toEqual({ n: 0 });
  expect(env.DB.sqlite.prepare("SELECT action, detail FROM admin_log").get()).toEqual({ action: "delete_assistant_report", detail: id });
});

it("paginates reports and rejects invalid offsets", async () => {
  const insert = env.DB.sqlite.prepare("INSERT INTO assistant_reports VALUES (?, ?, ?, '')");
  for (let i = 0; i < 51; i++) insert.run(`rep_${i}`, "2026-10-19T12:00:00.000Z", "reply");
  const first = await (await app.request("/api/v1/admin/assistant-reports", {}, env)).json() as { reports: unknown[]; hasMore: boolean };
  expect(first.reports).toHaveLength(50);
  expect(first.hasMore).toBe(true);
  const last = await (await app.request("/api/v1/admin/assistant-reports?offset=50", {}, env)).json() as { reports: unknown[]; hasMore: boolean };
  expect(last.reports).toHaveLength(1);
  expect(last.hasMore).toBe(false);
  expect((await app.request("/api/v1/admin/assistant-reports?offset=-1", {}, env)).status).toBe(400);
});

it("removes reports older than 90 days during scheduled cleanup", async () => {
  const insert = env.DB.sqlite.prepare("INSERT INTO assistant_reports VALUES (?, ?, ?, '')");
  insert.run("rep_old", new Date(Date.now() - 91 * 86_400_000).toISOString(), "old");
  insert.run("rep_recent", new Date().toISOString(), "recent");
  await worker.scheduled({} as ScheduledController, env);
  expect(env.DB.sqlite.prepare("SELECT id FROM assistant_reports").all()).toEqual([{ id: "rep_recent" }]);
});
