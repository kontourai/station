/**
 * Reads the build provenance back out of a packaged APK (station#3592).
 *
 * A stamp nobody reads is a label nothing derives, so the writer
 * (`scripts/lib/android-build-manifest.mjs`) and this reader ship together and
 * serve two callers:
 *
 *  - CI runs it against the APK it just built, so "the Android bundle carries
 *    its origin" is derived from the artefact rather than asserted by the step
 *    that was supposed to produce it. The 16 KB alignment gate next to it
 *    exists for the same reason: the build succeeds either way, so only the
 *    artefact proves anything.
 *  - A human runs it against an APK pulled off a live device to answer "what
 *    commit is this phone running?" — see docs/guides/android-build.md.
 *
 * Failure is loud in both directions. An APK with no `assets/station-build.json`
 * exits non-zero rather than printing an empty result: on the CI side that is a
 * broken packaging path, and on the device side it means the build predates
 * this change and its commit genuinely cannot be recovered. Reporting either as
 * a quiet success would recreate the exact hole this closes.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

export const APK_BUILD_MANIFEST_ENTRY = 'assets/station-build.json';
export const AAB_BUILD_MANIFEST_ENTRY = `base/${APK_BUILD_MANIFEST_ENTRY}`;

const FULL_GIT_SHA = /^[0-9a-f]{40}$/i;

/**
 * Validates the manifest bytes an APK carries. Returns `{ sha, branch, builtAt }`.
 *
 * Every field is checked rather than trusted: a partially-written or truncated
 * manifest that still parses as JSON would otherwise be read as provenance, and
 * a deployment decision made against a half-known sha is worse than one made
 * against a declared unknown.
 */
export function parseAndroidBuildProvenance(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${APK_BUILD_MANIFEST_ENTRY} is not valid JSON: ${error.message}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${APK_BUILD_MANIFEST_ENTRY} is not a JSON object`);
  }
  if (typeof parsed.sha !== 'string' || !FULL_GIT_SHA.test(parsed.sha)) {
    throw new Error(
      `${APK_BUILD_MANIFEST_ENTRY} carries no full 40-character commit sha`,
    );
  }
  if (typeof parsed.branch !== 'string' || parsed.branch.trim().length === 0) {
    throw new Error(`${APK_BUILD_MANIFEST_ENTRY} carries no branch`);
  }
  if (
    typeof parsed.builtAt !== 'string' ||
    Number.isNaN(Date.parse(parsed.builtAt))
  ) {
    throw new Error(
      `${APK_BUILD_MANIFEST_ENTRY} carries no parseable builtAt timestamp`,
    );
  }
  return {
    sha: parsed.sha,
    branch: parsed.branch.trim(),
    builtAt: parsed.builtAt,
  };
}

/**
 * Extracts one entry from an APK. `unzip` is the dependency rather than a
 * hand-rolled ZIP reader: it is present on macOS and on the Linux build
 * runners, and a second central-directory parser next to
 * `check-android-16kb-alignment.mjs`'s would be a maintenance cost with no
 * corresponding gain.
 */
export function readAndroidArchiveEntry(
  archivePath,
  entry = archivePath.endsWith('.aab')
    ? AAB_BUILD_MANIFEST_ENTRY
    : APK_BUILD_MANIFEST_ENTRY,
) {
  try {
    return execFileSync('unzip', ['-p', archivePath, entry], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw new Error(
      `Could not read ${entry} from ${archivePath}. The Android archive carries no build provenance (or \`unzip\` is unavailable): ${error.message}`,
    );
  }
}

/** Backwards-compatible APK-only entry point used by device inspection. */
export function readApkEntry(apkPath, entry = APK_BUILD_MANIFEST_ENTRY) {
  return readAndroidArchiveEntry(apkPath, entry);
}

/**
 * Extracts and validates the exact manifest bytes from a Play-bound AAB or
 * sibling APK.  JSON equality is intentionally insufficient: package writers
 * must carry the staged immutable record byte-for-byte, including its one
 * sampled build timestamp.
 */
export function extractAndroidBuildManifest(
  archivePath,
  { expectedPath, outputPath } = {},
) {
  const contents = readAndroidArchiveEntry(archivePath);
  if (contents.length === 0) {
    throw new Error(`${archivePath} has an empty packaged build manifest`);
  }
  parseAndroidBuildProvenance(contents.toString('utf8'));
  if (expectedPath) {
    const expected = readFileSync(expectedPath);
    if (!contents.equals(expected)) {
      throw new Error(
        `${archivePath} packaged build manifest does not byte-equal ${expectedPath}`,
      );
    }
  }
  if (outputPath) writeFileSync(outputPath, contents);
  return contents;
}

export function readAndroidBuildProvenance(archivePath) {
  const contents = readAndroidArchiveEntry(archivePath);
  if (contents.length === 0) {
    throw new Error(
      `${APK_BUILD_MANIFEST_ENTRY} is empty in ${archivePath}; the Android archive carries no build provenance`,
    );
  }
  return parseAndroidBuildProvenance(contents.toString('utf8'));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const archivePath = process.argv[2];
  if (!archivePath) {
    console.error(
      'Expected: read-android-build-provenance.mjs <apk-or-aab> [--expected <staged-manifest>] [--output <artifact-manifest>]',
    );
    process.exit(2);
  }
  try {
    const expectedIndex = process.argv.indexOf('--expected');
    const outputIndex = process.argv.indexOf('--output');
    const expectedPath =
      expectedIndex >= 0 ? process.argv[expectedIndex + 1] : undefined;
    const outputPath =
      outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
    if (
      (expectedIndex >= 0 && !expectedPath) ||
      (outputIndex >= 0 && !outputPath)
    ) {
      throw new Error('--expected and --output each require a path');
    }
    const contents = extractAndroidBuildManifest(archivePath, {
      expectedPath,
      outputPath,
    });
    const provenance = parseAndroidBuildProvenance(contents.toString('utf8'));
    console.log(JSON.stringify(provenance, null, 2));
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }
}
