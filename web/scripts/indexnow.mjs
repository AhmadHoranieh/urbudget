// Tells Bing and the other IndexNow search engines which pages a deploy changed, so they crawl
// them again soon instead of whenever they next pass by. Google doesn't take part; it reads the
// sitemap. https://www.indexnow.org/documentation
//
//   node scripts/indexnow.mjs <from-commit> <to-commit>   (from web/; deploy.yml runs this)
//   node scripts/indexnow.mjs --all                        (every page in the sitemap)
//
// The key is public by design: public/<key>.txt holds it, which shows the ping came from the
// site's owner. With no from-commit (a manual run of the workflow), every page is sent.

import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ORIGIN, indexablePages } from "./sitemap.mjs";

const pub = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "public");
const key = readdirSync(pub)
  .map((f) => f.match(/^([0-9a-f]{32})\.txt$/)?.[1])
  .find((k) => k && readFileSync(join(pub, `${k}.txt`), "utf8").trim() === k);
if (!key) throw new Error("No IndexNow key file (public/<32 hex characters>.txt) found");

const pages = indexablePages();
const [from, to = "HEAD"] = process.argv.slice(2);
let urls;
if (!from || from === "--all" || /^0+$/.test(from)) {
  urls = pages.map((p) => p.url);
} else {
  const changed = execFileSync("git", ["diff", "--name-only", "--relative", from, to, "--", "."], {
    cwd: pub,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  urls = pages.filter((p) => changed.includes(p.file)).map((p) => p.url);
}

if (!urls.length) {
  console.log("IndexNow: no page changed");
} else {
  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: new URL(ORIGIN).host, key, keyLocation: `${ORIGIN}/${key}.txt`, urlList: urls }),
  });
  console.log(`IndexNow: ${res.status} for ${urls.length} page(s)\n${urls.join("\n")}`);
  if (!res.ok) {
    console.log(await res.text());
    process.exitCode = 1;
  }
}
