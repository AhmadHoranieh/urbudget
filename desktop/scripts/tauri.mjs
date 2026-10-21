import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const env = {
  ...process.env,
  PATH: `${join(homedir(), ".cargo", "bin")}${delimiter}${process.env.PATH ?? ""}`,
};
// Release builds sign their updates with the updater key, which never enters the repository
// (README › Updates). TAURI_SIGNING_PRIVATE_KEY, when set, wins.
const signingKey = join(homedir(), ".tauri", "urbudget-updater.key");
if (!env.TAURI_SIGNING_PRIVATE_KEY && existsSync(signingKey)) {
  env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(signingKey, "utf8").trim();
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
}
const child = spawn(
  process.execPath,
  [require.resolve("@tauri-apps/cli/tauri.js"), ...process.argv.slice(2)],
  { stdio: "inherit", env },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
