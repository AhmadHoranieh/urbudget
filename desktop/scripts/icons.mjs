// Draws every desktop icon from assets/icon.svg:
//   node scripts/icons.mjs
// src-tauri/icons (the app, the installers and the macOS bundle) comes from `tauri icon`; only the
// files already there are kept, so its Android and iOS sets stay out of the repo. msix/Assets (the
// Store package's Start, taskbar and Store images) is drawn here at the sizes the manifest names.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const svg = join(desktop, "assets", "icon.svg");

const icons = join(desktop, "src-tauri", "icons");
const tmp = mkdtempSync(join(tmpdir(), "urbudget-icons-"));
try {
  execFileSync(process.execPath, [join(desktop, "scripts", "tauri.mjs"), "icon", svg, "-o", tmp], { stdio: "inherit" });
  for (const name of readdirSync(icons)) cpSync(join(tmp, name), join(icons, name));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const assets = join(desktop, "msix", "Assets");
const source = readFileSync(svg);
/** The icon drawn straight at size × size, so small sizes stay sharp. */
const icon = (size) => sharp(source, { density: (72 * size) / 1024 }).resize(size, size).png();

const squares = {
  "StoreLogo.png": 50,
  "Square44x44Logo.png": 44,
  "Square71x71Logo.png": 71,
  "Square150x150Logo.png": 150,
  "Square310x310Logo.png": 310,
};
// Taskbar and Start list sizes. "Unplated" is the taskbar's version with no tile behind it; the
// icon brings its own background, so it's the same picture.
for (const size of [16, 24, 32, 48, 256]) {
  squares[`Square44x44Logo.targetsize-${size}.png`] = size;
  squares[`Square44x44Logo.targetsize-${size}_altform-unplated.png`] = size;
}
for (const [name, size] of Object.entries(squares)) await icon(size).toFile(join(assets, name));

// The wide Start tile: the icon in the middle of a clear 310 × 150.
const wide = 124;
await sharp({ create: { width: 310, height: 150, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: await icon(wide).toBuffer(), left: (310 - wide) / 2, top: (150 - wide) / 2 }])
  .png()
  .toFile(join(assets, "Wide310x150Logo.png"));

console.log(`src-tauri/icons and msix/Assets (${Object.keys(squares).length + 1} images) drawn from assets/icon.svg`);
