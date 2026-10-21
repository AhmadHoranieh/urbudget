// Writes public/sitemap.xml from the pages in public/.
//
//   node scripts/sitemap.mjs        (from web/, or npm run sitemap)
//
// Every public/**/index.html is listed unless it has a noindex robots tag or robots.txt
// disallows its path. A page's lastmod is the date of the last commit that changed it, or today
// when it has changes that aren't committed yet, so run this just before committing.
// test/site.test.ts fails when the sitemap and the pages disagree.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pub = join(root, "public");
export const ORIGIN = "https://urbudget.app";

/** The pages search engines may index: { file (relative to public/, with /), url }, home first. */
export function indexablePages() {
  const disallowed = readFileSync(join(pub, "robots.txt"), "utf8")
    .split("\n")
    .map((line) => line.match(/^Disallow:\s*(\S+)/i)?.[1])
    .filter(Boolean);
  return readdirSync(pub, { recursive: true })
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => f === "index.html" || f.endsWith("/index.html"))
    .map((file) => ({ file, path: "/" + file.slice(0, -"index.html".length) }))
    .filter(({ path }) => !disallowed.some((prefix) => path.startsWith(prefix)))
    .filter(({ file }) => !/<meta name="robots" content="[^"]*noindex/.test(readFileSync(join(pub, file), "utf8")))
    .sort((a, b) => (a.path === "/" ? -1 : b.path === "/" ? 1 : a.path.localeCompare(b.path)))
    .map(({ file, path }) => ({ file, url: ORIGIN + path }));
}

function lastmod(file) {
  const git = (...args) => execFileSync("git", args, { cwd: pub, encoding: "utf8" }).trim();
  const today = new Date().toISOString().slice(0, 10);
  if (git("status", "--porcelain", "--", file)) return today;
  return git("log", "-1", "--format=%cs", "--", file) || today;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pages = indexablePages();
  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    ...pages.map(({ file, url }) => `  <url><loc>${url}</loc><lastmod>${lastmod(file)}</lastmod></url>`),
    `</urlset>`,
    ``,
  ].join("\n");
  writeFileSync(join(pub, "sitemap.xml"), xml);
  console.log(`sitemap.xml  ${pages.length} pages`);
}
