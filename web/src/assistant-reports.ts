import { Hono } from "hono";
import type { AppEnv } from "./env";
import { ApiError, now, randomId, rateLimit, sha256 } from "./util";

const MAX_BYTES = 32_768;

/** Enforce the limit on streamed bytes too: Content-Length is not always present or reliable. */
async function reportBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json")
    throw new ApiError(415, "invalid_type", "Send the report as JSON.");
  const tooLarge = () => new ApiError(413, "report_too_large", "That report is too long. Shorten it and try again.");
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_BYTES) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "invalid_body", "Include the reply you want to report.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // Malformed JSON never reaches the database.
  }
  throw new ApiError(400, "invalid_body", "The report must be a JSON object.");
}

export const assistantReports = new Hono<AppEnv>();

assistantReports.post("/", async (c) => {
  // No login is required, and no account credential is read. Hash the daily IP bucket so the
  // rate-limit rows do not contain a raw address or a persistent device identifier.
  const day = now().slice(0, 10);
  const bucket = await sha256(`${day}:${c.req.header("CF-Connecting-IP") ?? "local"}`);
  await rateLimit(c.env.DB, `report:hour:${bucket}`, 5, 3600);
  await rateLimit(c.env.DB, `report:day:${bucket}`, 20, 86_400);
  await rateLimit(c.env.DB, "report:total", 1000, 86_400);
  const body = await reportBody(c.req.raw);
  if (Object.keys(body).some((key) => key !== "text" && key !== "reason"))
    throw new ApiError(400, "invalid_report", "Reports can include only the reply excerpt and your explanation.");
  if (typeof body.text !== "string" || (body.reason !== undefined && typeof body.reason !== "string"))
    throw new ApiError(400, "invalid_report", "Include the reply excerpt and an optional explanation.");
  const text = body.text.trim();
  const reason = (body.reason ?? "").trim();
  if (!text || text.length > 4000 || reason.length > 1000)
    throw new ApiError(400, "invalid_report", "Include 1–4,000 characters from the reply and at most 1,000 characters explaining the problem.");
  const id = randomId("rep");
  await c.env.DB.prepare("INSERT INTO assistant_reports (id, created_at, reply, reason) VALUES (?1, ?2, ?3, ?4)")
    .bind(id, now(), text, reason)
    .run();
  return c.json({ id }, 201);
});
