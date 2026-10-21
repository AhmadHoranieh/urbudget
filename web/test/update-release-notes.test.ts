import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain JavaScript script, run by node
import { updateReleaseNotes } from "../scripts/update-release-notes.mjs";

const release = { tagName: "v1.0.6", isDraft: false, body: "### Fixed\n\n- More reliable imports.\n" };
const update = (version: string) => ({
  version, date: "2026-10-20T14:30:00.123Z", notes: "Old notes",
  file: `UrBudget_${version}_x64-setup.exe`, signature: "original-signature", extra: { keep: true },
});
const manifest = () => ({
  version: "1.0.6", date: "2026-10-20", notes: "Old notes",
  platforms: {
    windows: { file: "UrBudget_1.0.6_x64-setup.exe", size: 12345, sha256: "a".repeat(64) },
    macos: { file: "UrBudget_1.0.5_universal.dmg", size: 54321, sha256: "b".repeat(64) },
  },
  updates: { "windows-x86_64": update("1.0.6"), "darwin-aarch64": update("1.0.5") },
  futureField: { preserve: [1, 2, 3] },
});

describe("updating published release notes", () => {
  it("preserves installer metadata, signatures, dates, unknown fields, and other releases exactly", () => {
    const original = manifest();
    const before = structuredClone(original);
    const expected = structuredClone(original);
    expected.notes = release.body;
    expected.updates["windows-x86_64"].notes = release.body;
    expect(updateReleaseNotes("v1.0.6", release, original)).toEqual(expected);
    expect(original).toEqual(before);
  });

  it("can refresh an older platform update without relabeling the latest release", () => {
    const original = manifest();
    const olderRelease = { ...release, tagName: "v1.0.5" };
    const expected = structuredClone(original);
    expected.updates["darwin-aarch64"].notes = release.body;
    expect(updateReleaseNotes("v1.0.5", olderRelease, original)).toEqual(expected);
  });

  it("reads desktop tags, with or without the app's name", () => {
    const expected = structuredClone(manifest());
    expected.notes = release.body;
    expected.updates["windows-x86_64"].notes = release.body;
    expect(updateReleaseNotes("desktop-v1.0.6", { ...release, tagName: "desktop-v1.0.6" }, manifest())).toEqual(expected);
  });

  it("rejects a release absent from the manifest", () => {
    expect(() => updateReleaseNotes("v1.0.7", { ...release, tagName: "v1.0.7" }, manifest())).toThrow("not present");
  });

  it.each([
    ["1.0.6", release],
    ["android-v1.0.6", { ...release, tagName: "android-v1.0.6" }],
    ["ios-v1.0.6", { ...release, tagName: "ios-v1.0.6" }],
    ["v1.0.6", { ...release, tagName: "v1.0.7" }],
    ["v1.0.6", { ...release, isDraft: true }],
    ["v1.0.6", { ...release, body: " \n\t" }],
    ["v1.0.6", null],
  ])("rejects an invalid tag or release (%s)", (tag, value) => {
    expect(() => updateReleaseNotes(tag, value, manifest())).toThrow();
  });

  it.each([
    null,
    { ...manifest(), version: "invalid" },
    { ...manifest(), platforms: {} },
    { ...manifest(), platforms: { windows: { file: "installer.exe" } } },
    { ...manifest(), updates: undefined },
    { ...manifest(), updates: { "windows-x86_64": { ...update("1.0.6"), signature: "" } } },
  ])("rejects incomplete or malformed manifest data", (value) => {
    expect(() => updateReleaseNotes("v1.0.6", release, value)).toThrow();
  });
});
