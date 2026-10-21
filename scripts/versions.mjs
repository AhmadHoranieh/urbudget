// Each app has its own version and release tag: desktop-v1.2.3, android-v1.2.3, ios-v1.2.3.
//
//   node scripts/versions.mjs                     each app's version, after checking its files agree
//   node scripts/versions.mjs android 1.0.8       sets one app's version (desktop's also sets the shared crates')
//   node scripts/versions.mjs --tag ios-v1.0.8    fails unless the tag names that app's current version
//
// Release workflows run --tag before building; on GitHub it also writes `app` and `version` to the
// step's outputs. Desktop's earlier tags (v1.0.7) still read as desktop tags.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+$/;
const n = String.raw`\r?\n`;

// A place a version is written: the text before it, then the version (up to the closing quote).
const field = (file, before, count = 1) => ({ file, pattern: new RegExp(`(${before})([^"\\r\\n;]+)`, "gm"), count });
const cargoPackage = (file, name) => field(file, String.raw`^\[package\]${n}name = "${name}"${n}version = "`);
const lockEntry = (file, name) => field(file, String.raw`${n}name = "${name}"${n}version = "`);

// The shared crates (crates/) follow the desktop version: desktop builds them in, and their
// version is what the engine reports to urbudget.app.
const crates = ["urbudget-core", "urbudget-services", "urbudget-android", "urbudget-ios"];

export const apps = {
  desktop: [
    field("desktop/package.json", String.raw`^  "version": "`),
    field("desktop/package-lock.json", String.raw`^  "version": "`),
    field("desktop/package-lock.json", String.raw`${n}    "": \{${n}      "name": "urbudget",${n}      "version": "`),
    field("desktop/src-tauri/tauri.conf.json", String.raw`^  "version": "`),
    cargoPackage("desktop/src-tauri/Cargo.toml", "urbudget"),
    ...["urbudget", "urbudget-core", "urbudget-services"].map((name) => lockEntry("desktop/src-tauri/Cargo.lock", name)),
    ...crates.map((name) => cargoPackage(`crates/${name}/Cargo.toml`, name)),
    ...crates.map((name) => lockEntry("crates/Cargo.lock", name)),
  ],
  android: [
    field("android/app/build.gradle.kts", String.raw`versionName = "`),
    // The default version code, from the version (see androidVersionCode).
    { ...field("android/app/build.gradle.kts", String.raw`gradleProperty\("versionCode"\)\.orElse\("`), code: true },
  ],
  ios: [
    field("ios/project.yml", String.raw`MARKETING_VERSION: "`),
    field("ios/UrBudget.xcodeproj/project.pbxproj", "MARKETING_VERSION = ", 2),
  ],
};
/** Google Play's version code for a version, in the scheme the Tauri Android app used: 1.2.3 is 1002003. */
export function androidVersionCode(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  if (minor > 999 || patch > 999) throw new Error(`${version}: Android version codes allow at most 999 minor and patch versions.`);
  return String(major * 1_000_000 + minor * 1_000 + patch);
}

/** The app and version a release tag names, or null for a tag that isn't a release tag. */
export function parseTag(tag) {
  const match = /^(?:(desktop|android|ios)-)?v(\d+\.\d+\.\d+)$/.exec(tag ?? "");
  return match ? { app: match[1] ?? "desktop", version: match[2] } : null;
}

const compare = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** Each app's version, checking that every file it's written in says the same. */
export function readVersions(root = repo) {
  const versions = {};
  for (const [app, fields] of Object.entries(apps)) {
    const found = fields.filter((f) => !f.code).flatMap((f) => {
      const values = [...readFileSync(join(root, f.file), "utf8").matchAll(f.pattern)].map((m) => m[2]);
      if (values.length !== f.count) throw new Error(`${f.file}: expected ${f.count} ${app} version${f.count > 1 ? "s" : ""}, found ${values.length}.`);
      return values.map((value) => ({ file: f.file, value }));
    });
    const version = found[0].value;
    const other = found.find((f) => f.value !== version);
    if (other) throw new Error(`${app}: ${other.file} says ${other.value}, but ${found[0].file} says ${version}.`);
    if (!SEMVER.test(version)) throw new Error(`${app}: ${version} isn't a version such as 1.2.3.`);
    for (const f of fields.filter((f) => f.code)) {
      const code = readFileSync(join(root, f.file), "utf8").match(new RegExp(f.pattern.source, "m"))?.[2];
      if (code !== androidVersionCode(version)) {
        throw new Error(`${app}: ${f.file} has version code ${code}, but ${version}'s is ${androidVersionCode(version)}.`);
      }
    }
    versions[app] = version;
  }
  return versions;
}

/** Sets one app's version in every file it's written in. Versions only go up. */
export function setVersion(app, version, root = repo) {
  if (!apps[app]) throw new Error(`Unknown app ${app}: use ${Object.keys(apps).join(", ")}.`);
  if (!SEMVER.test(version ?? "")) throw new Error(`${version} isn't a version such as 1.2.3.`);
  const current = readVersions(root)[app];
  if (compare(version, current) < 0) throw new Error(`${app} is at ${current}; versions only go up.`);
  const texts = new Map();
  for (const f of apps[app]) {
    const text = texts.get(f.file) ?? readFileSync(join(root, f.file), "utf8");
    const value = f.code ? androidVersionCode(version) : version;
    texts.set(f.file, text.replace(f.pattern, (_, before) => before + value));
  }
  for (const [file, text] of texts) writeFileSync(join(root, file), text);
  return readVersions(root)[app];
}

function main(args) {
  if (args[0] === "--tag") {
    const tag = parseTag(args[1]);
    if (!tag) throw new Error(`${args[1] ?? "(none)"} isn't a release tag such as desktop-v1.2.3, android-v1.2.3 or ios-v1.2.3.`);
    const version = readVersions()[tag.app];
    if (version !== tag.version) {
      throw new Error(`${args[1]} names ${tag.app} ${tag.version}, but the source is ${tag.app} ${version}. ` +
        `Set it with \`node scripts/versions.mjs ${tag.app} ${tag.version}\` and tag that commit.`);
    }
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `app=${tag.app}\nversion=${version}\n`);
    console.log(`${tag.app} ${version}`);
  } else if (args.length === 2) {
    const [app, version] = args;
    setVersion(app, version);
    console.log(`${app} is now ${version}. Commit it, then tag that commit to release it:`);
    console.log(`  git tag ${app}-v${version} && git push origin main ${app}-v${version}`);
  } else if (args.length === 0) {
    for (const [app, version] of Object.entries(readVersions())) console.log(`${app}: ${version} (tag ${app}-v${version})`);
  } else {
    throw new Error("Usage: node scripts/versions.mjs [<desktop|android|ios> <version> | --tag <tag>]");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
