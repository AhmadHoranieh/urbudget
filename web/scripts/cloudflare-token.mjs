// Stores the Cloudflare API token GitHub uses to deploy the site (.github/workflows/deploy.yml)
// and put published releases on urbudget.app (publish.yml). Needs the GitHub CLI, signed in.
//   node scripts/cloudflare-token.mjs
// Make the token at dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom token,
// for this account: Workers R2 Storage, Workers Scripts and D1, all Edit; for the urbudget.app
// zone: Workers Routes, Edit. Then copy it. It's taken from the
// clipboard, checked with Cloudflare (it must reach the releases bucket), and stored with
// `gh secret set` without being shown; the account id goes in as a repository variable.
import { execFileSync } from "node:child_process";

const ACCOUNT = "501b893f975002082793dfd789f13058";
const BUCKET = "urbudget-releases";
const api = (path, token) =>
  fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${token}` } })
    .then((response) => response.json())
    .catch(() => ({ success: false }));

/** The token works when it can see the releases bucket. */
async function works(token) {
  const bucket = await api(`/accounts/${ACCOUNT}/r2/buckets/${BUCKET}`, token);
  return bucket.success === true;
}

function clipboard() {
  try {
    return process.platform === "win32"
      ? execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      : execFileSync("pbpaste", { encoding: "utf8" });
  } catch {
    return "";
  }
}

console.log("Copy the new Cloudflare API token. Waiting for it…");
let tried = "";
let token = "";
for (;;) {
  const copied = clipboard().trim();
  if (copied !== tried && /^[\w-]{30,80}$/.test(copied)) {
    tried = copied;
    if (await works(copied)) {
      token = copied;
      break;
    }
    console.log("That token can't reach the releases bucket (it needs Workers R2 Storage · Edit). Copy another.");
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

execFileSync("gh", ["secret", "set", "CLOUDFLARE_API_TOKEN"], { input: token, stdio: ["pipe", "inherit", "inherit"] });
execFileSync("gh", ["variable", "set", "CLOUDFLARE_ACCOUNT_ID", "--body", ACCOUNT], { stdio: "inherit" });
console.log("Stored. Publishing a release on GitHub now puts its installers on urbudget.app.");
