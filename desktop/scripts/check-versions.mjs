// The desktop app's version must agree across its package, lockfile, Cargo and Tauri files.
// The phone apps have their own versions (../../scripts/versions.mjs checks every app).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const json = (path) => JSON.parse(read(path));
const base = json("src-tauri/tauri.conf.json");
const pkg = json("package.json");
const lock = json("package-lock.json");
const cargo = read("src-tauri/Cargo.toml").match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1];
const cargoLock = read("src-tauri/Cargo.lock").split("[[package]]").find((block) => /\nname = "urbudget"\r?\n/.test(block));
const version = (block) => block?.match(/(?:^|\n)version = "([^"]+)"/)?.[1];
for (const [name, value] of [
  ["package.json", pkg.version], ["package-lock.json", lock.version],
  ["package-lock.json root", lock.packages?.[""]?.version],
  ["Cargo.toml", version(cargo)], ["Cargo.lock", version(cargoLock)],
]) assert.equal(value, base.version, `${name} must match the desktop Tauri version`);
assert.equal(base.identifier, "com.localbudget.desktop", "Keep the installed desktop app identity");
console.log(`desktop: ${base.version} (${base.identifier})`);
