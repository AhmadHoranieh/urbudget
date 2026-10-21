// Prints installer downloads per week, system and source, newest week first. A source is a link's
// tag (`ref:hn` for urbudget.app/download/?ref=hn), the page of this site the button was on, or the
// site that linked here. The admin page shows the same counts.
//   node scripts/downloads.mjs [--local]
// Reads the production database unless --local. Needs `npx wrangler login`.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// A week is named by its Monday: date(day, '-6 days', 'weekday 1') is the Monday on or before `day`.
// People first; bots (crawlers, scripts, AI agents' browsers) and the team (browsers that opened the
// admin page) are counted apart.
const sql = `SELECT date(day, '-6 days', 'weekday 1') AS week, kind, platform, CASE source WHEN '' THEN '(unknown)' ELSE source END AS source,
  SUM(count) AS downloads FROM download_counts GROUP BY week, kind, platform, source
  ORDER BY week DESC, kind = 'person' DESC, kind, downloads DESC, platform, source`;
// Wrangler's own entry point, run by this Node with no shell in between, so the SQL's quotes
// arrive intact on Windows too.
const web = fileURLToPath(new URL("..", import.meta.url));
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const output = execFileSync(
  process.execPath,
  [wrangler, "d1", "execute", "urbudget", process.argv.includes("--local") ? "--local" : "--remote", "--json", "--command", sql],
  { cwd: web, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
const rows = JSON.parse(output)[0]?.results ?? [];
if (!rows.length) {
  console.log("No downloads counted yet.");
  process.exit(0);
}

const columns = [
  ["week", "Week of"],
  ["kind", "Who"],
  ["platform", "System"],
  ["source", "Source"],
  ["downloads", "Downloads"],
];
const widths = columns.map(([key, title]) => Math.max(title.length, ...rows.map((row) => String(row[key]).length)));
const line = (cells) =>
  cells.map((cell, i) => (i === cells.length - 1 ? String(cell).padStart(widths[i]) : String(cell).padEnd(widths[i]))).join("  ");
console.log(line(columns.map(([, title]) => title)));
rows.forEach((row, i) => {
  if (i > 0 && row.week !== rows[i - 1].week) console.log("");
  console.log(line(columns.map(([key]) => row[key])));
});
