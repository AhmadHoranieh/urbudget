// Runs the desktop app on the QA budget with a debugging port for scripts/qa/cdp.mjs.
// Usage: npm run qa [-- --release]. Creates the QA budget on first use.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const dataDir = resolve(here, "../../../migration-qa");
if (!existsSync(join(dataDir, "budget.sqlite3")))
  spawnSync(process.execPath, [join(here, "make-qa-budget.mjs"), dataDir], { stdio: "inherit" });
const release = process.argv.includes("--release");
const child = spawn(process.execPath, [resolve(here, "../tauri.mjs"), "dev", ...(release ? ["--release"] : [])], {
  stdio: "inherit",
  env: {
    ...process.env,
    LOCAL_BUDGET_DATA_DIR: dataDir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${process.env.CDP_PORT ?? 9222}`,
    // Release builds only honour LOCAL_BUDGET_DATA_DIR with debug assertions on.
    ...(release ? { CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS: "true" } : {}),
  },
});
child.on("exit", (code) => (process.exitCode = code ?? 1));
