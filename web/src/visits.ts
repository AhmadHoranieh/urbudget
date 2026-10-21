// Page views of urbudget.app as daily totals. The site's script (assets/site.js) sends one beacon
// per page with the page's path, where the visitor came from and any ?ref= tag; nothing about who
// is kept, and no cookie is set.
import { Hono } from "hono";
import type { AppEnv } from "./env";
import { downloadKind, normalizeRef } from "./releases";
import { now } from "./util";

/** A page of this site: letters, digits, `-`, `_` and `/`, up to 64. */
const PAGE = /^\/[a-z0-9/_-]{0,63}$/;

/** Where a visitor came from: a link's tag, another site, another page of this one, or '' when not known. */
export function visitSource(referrer: string | undefined, ref: string | null, origin: string): string {
  if (ref) return `ref:${ref}`;
  if (!referrer) return "";
  try {
    const url = new URL(referrer);
    if (url.origin === origin) return "internal";
    return /^https?:$/.test(url.protocol) ? url.hostname.replace(/^www\./, "").slice(0, 100) : "";
  } catch {
    return "";
  }
}

export const visits = new Hono<AppEnv>();

visits.post("/", async (c) => {
  // A beacon is a few dozen bytes; anything bigger isn't one.
  if (Number(c.req.header("Content-Length") ?? 0) > 2048) return c.body(null, 204);
  let body: { path?: unknown; referrer?: unknown; ref?: unknown } = {};
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    return c.body(null, 204);
  }
  const path = typeof body.path === "string" ? body.path.toLowerCase() : "";
  if (PAGE.test(path)) {
    const kind = downloadKind({
      agent: c.req.header("User-Agent"),
      referer: c.req.header("Referer"),
      fetchSite: c.req.header("Sec-Fetch-Site"),
      cookie: c.req.header("Cookie"),
    });
    const ref = normalizeRef(typeof body.ref === "string" ? body.ref : undefined);
    const source = visitSource(typeof body.referrer === "string" ? body.referrer : undefined, ref, new URL(c.req.url).origin);
    const counted = c.env.DB.prepare(
      `INSERT INTO page_views (day, path, source, kind, count) VALUES (?1, ?2, ?3, ?4, 1)
       ON CONFLICT(day, path, source, kind) DO UPDATE SET count = count + 1`,
    )
      .bind(now().slice(0, 10), path, source, kind)
      .run()
      .catch((error) => console.error("[visits]", error));
    // After the answer has gone out; tests have no ExecutionContext and wait for it instead.
    try {
      c.executionCtx.waitUntil(counted);
    } catch {
      await counted;
    }
  }
  return c.body(null, 204);
});
