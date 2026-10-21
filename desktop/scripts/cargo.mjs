import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
const args = process.argv.slice(2);
const run = (manifest) => new Promise((resolve) => {
  // Put Cargo options before the test-harness separator, if one was supplied.
  const separator = args.indexOf("--");
  const command = [...args];
  command.splice(separator < 0 ? command.length : separator, 0, "--manifest-path", manifest);
  const child = spawn("cargo", command, {
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${join(homedir(), ".cargo", "bin")}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
  child.on("error", (error) => { console.error(error.message); resolve(1); });
  child.on("exit", (code) => resolve(code ?? 1));
});
// Cargo does not run dependency unit tests. Keep the shared engine in the existing
// `npm test` gate after moving its source out of the Tauri application crate.
let code = args[0] === "test" ? await run("../crates/Cargo.toml") : 0;
if (code === 0) code = await run("src-tauri/Cargo.toml");
process.exitCode = code;
