// node --test scripts/versions.test.mjs
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { androidVersionCode, apps, parseTag, readVersions, repo, setVersion } from "./versions.mjs";

function copy() {
  const root = mkdtempSync(join(tmpdir(), "urbudget-versions-"));
  for (const file of new Set(Object.values(apps).flat().map((f) => f.file))) cpSync(join(repo, file), join(root, file));
  return root;
}

test("tags name one app's version; desktop's earlier tags are desktop tags", () => {
  assert.deepEqual(parseTag("desktop-v1.2.3"), { app: "desktop", version: "1.2.3" });
  assert.deepEqual(parseTag("android-v1.0.10"), { app: "android", version: "1.0.10" });
  assert.deepEqual(parseTag("ios-v2.0.0"), { app: "ios", version: "2.0.0" });
  assert.deepEqual(parseTag("v1.0.7"), { app: "desktop", version: "1.0.7" });
  for (const tag of ["1.0.7", "web-v1.0.0", "android-v1.0", "ios-v1.0.0-beta", "desktop-1.0.0", undefined]) {
    assert.equal(parseTag(tag), null, String(tag));
  }
});

test("Android version codes keep the Tauri app's scheme", () => {
  assert.equal(androidVersionCode("1.0.7"), "1000007");
  assert.equal(androidVersionCode("2.13.4"), "2013004");
  assert.throws(() => androidVersionCode("1.1000.0"));
});

test("every file of each app agrees in the repository", () => {
  const versions = readVersions();
  assert.deepEqual(Object.keys(versions), ["desktop", "android", "ios"]);
});

test("setting one app's version leaves the others alone", () => {
  const root = copy();
  try {
    const before = readVersions(root);
    setVersion("android", "9.8.7", root);
    setVersion("ios", "3.2.1", root);
    assert.deepEqual(readVersions(root), { desktop: before.desktop, android: "9.8.7", ios: "3.2.1" });
    assert.match(readFileSync(join(root, "android/app/build.gradle.kts"), "utf8"), /orElse\("9008007"\)/);
    assert.equal(readFileSync(join(root, "ios/UrBudget.xcodeproj/project.pbxproj"), "utf8").match(/MARKETING_VERSION = 3\.2\.1;/g).length, 2);

    setVersion("desktop", "8.0.0", root);
    assert.equal(readVersions(root).desktop, "8.0.0");
    const lock = readFileSync(join(root, "desktop/package-lock.json"), "utf8");
    assert.equal(JSON.parse(lock).packages[""].version, "8.0.0");
    // Only the app's own entries change, not its dependencies'.
    assert.equal(lock.match(/"version": "8\.0\.0"/g).length, 2);
    assert.match(readFileSync(join(root, "crates/Cargo.lock"), "utf8"), /name = "urbudget-ios"\nversion = "8\.0\.0"/);
    assert.match(readFileSync(join(root, "desktop/src-tauri/Cargo.lock"), "utf8"), /name = "urbudget-services"\nversion = "8\.0\.0"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("versions only go up, and a file that disagrees is named", () => {
  const root = copy();
  try {
    assert.throws(() => setVersion("ios", "0.9.0", root), /only go up/);
    assert.throws(() => setVersion("ios", "1.1", root), /isn't a version/);
    assert.throws(() => setVersion("web", "1.0.0", root), /Unknown app/);
    const yml = join(root, "ios/project.yml");
    writeFileSync(yml, readFileSync(yml, "utf8").replace(/MARKETING_VERSION: "[^"]+"/, 'MARKETING_VERSION: "5.5.5"'));
    assert.throws(() => readVersions(root), /ios: .*project\.pbxproj says .*, but ios\/project\.yml says 5\.5\.5/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
