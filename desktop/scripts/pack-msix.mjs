// Packs the release build as an MSIX for the Microsoft Store (Windows only):
//   npm run tauri -- build && node scripts/pack-msix.mjs
// Stages urbudget.exe with msix/AppxManifest.xml and msix/Assets, indexes the images with
// makepri and packs with makeappx (both from the Windows SDK). The package is left unsigned:
// the Store signs it after certification. Writes src-tauri/target/msix/UrBudget_<version>_x64.msix.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const { version } = JSON.parse(readFileSync(join(desktop, "src-tauri", "tauri.conf.json"), "utf8"));
// The Store wants four parts with the last one 0.
const msixVersion = `${version.split("-")[0]}.0`;
const exe = join(desktop, "src-tauri", "target", "release", "urbudget.exe");
const out = join(desktop, "src-tauri", "target", "msix");
const stage = join(out, "stage");
const msix = join(out, `UrBudget_${version}_x64.msix`);

if (!existsSync(exe)) {
  console.error(`No ${exe}. Build first: npm run tauri -- build`);
  process.exit(1);
}

/** The newest x64 copy of a Windows SDK tool. */
function sdkTool(name) {
  const bin = join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  const found = readdirSync(bin)
    .filter((dir) => /^10\./.test(dir) && existsSync(join(bin, dir, "x64", name)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .pop();
  if (!found) throw new Error(`${name} not found: install the Windows SDK.`);
  return join(bin, found, "x64", name);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(exe, join(stage, "urbudget.exe"));
cpSync(join(desktop, "msix", "Assets"), join(stage, "Assets"), { recursive: true });
const manifest = readFileSync(join(desktop, "msix", "AppxManifest.xml"), "utf8").replace("{{VERSION}}", msixVersion);
writeFileSync(join(stage, "AppxManifest.xml"), manifest);

// resources.pri lets Windows pick the right-sized taskbar and Start images.
const makepri = sdkTool("makepri.exe");
const priconfig = join(out, "priconfig.xml");
execFileSync(makepri, ["createconfig", "/cf", priconfig, "/dq", "en-US", "/pv", "10.0.0", "/o"], { stdio: "inherit" });
execFileSync(makepri, ["new", "/pr", stage, "/cf", priconfig, "/mn", join(stage, "AppxManifest.xml"), "/of", join(stage, "resources.pri"), "/o"], { stdio: "inherit" });

execFileSync(sdkTool("makeappx.exe"), ["pack", "/d", stage, "/p", msix, "/o"], { stdio: "inherit" });
console.log(`\nMade ${msix} (version ${msixVersion}).`);
