// Updates only notes for an existing release in a downloaded R2 manifest.
// node scripts/update-release-notes.mjs desktop-v1.0.8 release.json latest.json (or an earlier v1.0.6)
// release.json is `gh release view TAG --json tagName,body,isDraft`.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function updateReleaseNotes(tag, release, manifest) {
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = (value) => typeof value === "string" && value.trim().length > 0;
  const version = (value) => typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value);
  const tagged = /^(?:desktop-)?v(\d+\.\d+\.\d+)$/.exec(tag ?? "")?.[1];
  if (!tagged) throw new Error("Expected a desktop tag such as desktop-v1.0.8 or v1.0.6.");
  if (!object(release) || release.tagName !== tag || release.isDraft !== false || !text(release.body)) {
    throw new Error("Release must be published, match the tag, and contain nonempty notes.");
  }
  if (!object(manifest) || !version(manifest.version) || !text(manifest.date) || typeof manifest.notes !== "string" ||
      !object(manifest.platforms) || !Object.keys(manifest.platforms).length || !object(manifest.updates)) {
    throw new Error("Missing or invalid release manifest.");
  }
  for (const platform of Object.values(manifest.platforms)) {
    if (!object(platform) || !text(platform.file) || !Number.isSafeInteger(platform.size) || platform.size <= 0 ||
        typeof platform.sha256 !== "string" || !/^[a-f\d]{64}$/i.test(platform.sha256)) {
      throw new Error("Invalid installer metadata.");
    }
  }
  for (const update of Object.values(manifest.updates)) {
    if (!object(update) || !version(update.version) || !text(update.date) || typeof update.notes !== "string" ||
        !text(update.file) || !text(update.signature)) throw new Error("Invalid update metadata.");
  }
  const next = structuredClone(manifest);
  const targets = [next, ...Object.values(next.updates)].filter((entry) => entry.version === tagged);
  if (!targets.length) throw new Error(`${tag} is not present in the manifest; nothing changed.`);
  for (const entry of targets) entry.notes = release.body;
  return next;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [tag, releasePath, manifestPath] = process.argv.slice(2);
    if (!releasePath || !manifestPath) throw new Error("Usage: update-release-notes.mjs TAG release.json latest.json");
    const read = (path) => JSON.parse(readFileSync(path, "utf8"));
    const updated = updateReleaseNotes(tag, read(releasePath), read(manifestPath));
    writeFileSync(manifestPath, `${JSON.stringify(updated, null, 2)}\n`);
    console.log(`Updated notes for ${tag}; all other release metadata is unchanged.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
