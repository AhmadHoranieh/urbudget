// Checks the static site in public/: the sitemap lists every indexable page, each page says
// where it lives and what it's about, and no internal link points at a missing file.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
// @ts-expect-error: a plain JavaScript script, run by node
import { ORIGIN, indexablePages } from "../scripts/sitemap.mjs";
// @ts-expect-error: a plain JavaScript script, run by node
import { appPrivacyHtml } from "../scripts/app-privacy.mjs";
import { noteSections } from "../public/assets/release-notes.js";

const pub = resolve(__dirname, "..", "public");
const read = (file: string) => readFileSync(join(pub, file), "utf8");
const pages: { file: string; url: string }[] = indexablePages();
const htmlFiles = readdirSync(pub, { recursive: true })
  .map((f) => String(f).replaceAll("\\", "/"))
  .filter((f) => f.endsWith(".html"));

// Paths the Worker answers itself (wrangler.jsonc run_worker_first), not files in public/.
const WORKER_PATHS = [/^\/download\/(windows|macos|store)$/, /^\/releases\//, /^\/api\//, /^\/admin\/?$/];

const meta = (html: string, attr: string, name: string) =>
  html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`))?.[1];

describe("site", () => {
  it("keeps each Keep a Changelog heading and its list in one release-note card", () => {
    const notes = "### Added\r\n\r\n- Choose plans by name.\r\n- Manage saved tokens.\r\n\r\n### Changed\r\n\r\n- Clearer target deadlines.\r\n\r\n### Fixed\r\n\r\n- Preserve the selected category.\r\n";
    expect(noteSections(notes)).toEqual([
      ["Added", "- Choose plans by name.", "- Manage saved tokens."],
      ["Changed", "- Clearer target deadlines."],
      ["Fixed", "- Preserve the selected category."],
    ]);
  });
  it("preserves legacy release-note blocks and leaves embedded markup as text", () => {
    expect(noteSections("Improvements\n- Easier selection.\n\nFixes\n* Correct totals.\n\nA final note.")).toEqual([
      ["Improvements", "- Easier selection."],
      ["Fixes", "* Correct totals."],
      ["A final note."],
    ]);
    expect(noteSections("### Fixed\n\n- <img src=x onerror=alert(1)>\n\nMore <b>details</b>.")).toEqual([
      ["Fixed", "- <img src=x onerror=alert(1)>", "More <b>details</b>."],
    ]);
    expect(noteSections(" \n\n ")).toEqual([]);
  });
  it("keeps scheduling and credential help consistent with the current application", () => {
    expect(read("guides/budget-by-paycheck/index.html")).not.toContain("Scheduled page");
    expect(read("guides/budget-by-paycheck/index.html")).toContain("transaction register");
    for (const file of ["index.html", "bank-sync/index.html"]) {
      expect(read(file), file).not.toContain("Credential Manager");
      expect(read(file), file).toContain("encrypted vault");
    }
  });
  it("matches screenshot dimensions and responsive descriptors to the actual images", async () => {
    const dimensions = new Map<string, { width?: number; height?: number }>();
    for (const file of readdirSync(join(pub, "img")).filter(f => f.endsWith(".webp"))) {
      dimensions.set(`/img/${file}`, await sharp(join(pub, "img", file)).metadata());
    }
    for (const file of htmlFiles) {
      for (const [tag] of read(file).matchAll(/<(?:img|source)\b[^>]*>/g)) {
        for (const [, url, width] of tag.matchAll(/(\/img\/[^\s,"<>]+\.webp)\s+(\d+)w/g)) {
          expect(Number(width), `${file}: ${url} srcset`).toBe(dimensions.get(url)?.width);
        }
        const src = tag.match(/\bsrc="([^"]+)"/)?.[1];
        const meta = src && dimensions.get(src);
        if (meta && tag.startsWith("<img")) {
          expect(Number(tag.match(/\bwidth="(\d+)"/)?.[1]), `${file}: ${src} width`).toBe(meta.width);
          expect(Number(tag.match(/\bheight="(\d+)"/)?.[1]), `${file}: ${src} height`).toBe(meta.height);
        }
      }
    }
  });
  it("keeps the app policy in sync without website navigation or checkout links", () => {
    const app = read("privacy/app/index.html");
    expect(app, "run node scripts/app-privacy.mjs after editing the policy").toBe(appPrivacyHtml(read("privacy/index.html")));
    expect(app).not.toMatch(/<(?:nav|script)\b/);
    expect(app).not.toMatch(/href="(?:https:\/\/urbudget\.app)?\/(?:account|buy|pricing|download)\//);
    expect(app).toContain('id="assistant-reports"');
    expect(app).toContain('id="your-choices"');
  });
  it("lists every indexable page in the sitemap, and nothing else", () => {
    const listed = [...read("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).sort();
    expect(listed, "run npm run sitemap").toEqual(pages.map((p) => p.url).sort());
  });

  it.each(pages)("$url has its own canonical URL, title and description", ({ file, url }) => {
    const html = read(file);
    expect(html.match(/<link rel="canonical" href="([^"]+)"/)?.[1]).toBe(url);
    expect(meta(html, "property", "og:url")).toBe(url);
    expect(html.match(/<title>([^<]+)<\/title>/)?.[1].length).toBeGreaterThan(10);
    expect(meta(html, "name", "description")?.length).toBeGreaterThan(50);
  });

  it("gives every page a different title and description", () => {
    const titles = pages.map(({ file }) => read(file).match(/<title>([^<]+)<\/title>/)?.[1]);
    const descriptions = pages.map(({ file }) => meta(read(file), "name", "description"));
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it("has valid JSON-LD on every page", () => {
    for (const file of htmlFiles) {
      for (const [, json] of read(file).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
        expect(() => JSON.parse(json), file).not.toThrow();
      }
    }
  });

  it("links only to pages and files that exist", () => {
    const broken: string[] = [];
    for (const file of htmlFiles) {
      const html = read(file);
      const links = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1].replace(`${ORIGIN}`, ""));
      for (const link of links) {
        if (!link.startsWith("/") || link.startsWith("//")) continue;
        const path = decodeURI(link.split(/[?#]/)[0]);
        if (WORKER_PATHS.some((re) => re.test(path))) continue;
        const target = path.endsWith("/") ? join(pub, path, "index.html") : join(pub, path);
        if (!existsSync(target)) broken.push(`${file} → ${link}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("lists only pages that exist in llms.txt", () => {
    const urls = [...read("llms.txt").matchAll(/\]\((https:\/\/urbudget\.app\/[^)]*)\)/g)].map((m) => m[1]);
    const missing = urls.filter((url) => !pages.some((p) => p.url === url));
    expect(urls.length).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });
});
