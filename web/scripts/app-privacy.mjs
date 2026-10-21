// Generate the Android policy destination from the website's single source of policy text.
// Run from web/: node scripts/app-privacy.mjs. Commit the generated HTML with policy edits.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function appPrivacyHtml(source) {
  const article = source.match(/<article class="legal">([\s\S]*?)<\/article>/)?.[1];
  if (!article) throw new Error("Privacy policy article not found.");
  const content = article.replace(/<span data-website-only>[\s\S]*?<\/span>/g, "");
  if (/href="(?:https:\/\/urbudget\.app)?\/(?:account|buy|pricing|download)(?:[/?#"])/.test(content))
    throw new Error("The app policy must not link to checkout or the website account portal.");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>UrBudget app privacy policy</title>
  <meta name="description" content="How UrBudget handles local budgets, optional connections, purchases and reports, and how to request deletion.">
  <link rel="canonical" href="https://urbudget.app/privacy/app/">
  <meta name="color-scheme" content="light dark">
  <link rel="icon" href="/img/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/assets/site.css?v=2">
</head>
<body>
  <main id="main" class="container page-body">
    <h1>UrBudget privacy policy</h1>
    <article class="legal">${content}</article>
  </main>
</body>
</html>
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const privacy = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "privacy");
  mkdirSync(join(privacy, "app"), { recursive: true });
  writeFileSync(join(privacy, "app", "index.html"), appPrivacyHtml(readFileSync(join(privacy, "index.html"), "utf8")));
}
