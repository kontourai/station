/**
 * Build provenance for the packaged desktop app (station#1085).
 *
 * `./station start` derives the STATION_BUILD_* values from the build manifest
 * the CLI writes next to the server bundle. The desktop shell has no CLI in the
 * loop — Tauri runs `npm run build:desktop:resources` and then spawns
 * `dist-server/command-station.js` itself — so nothing wrote that manifest, nothing set
 * those variables, and the packaged app has never been able to report which
 * commit it is running.
 *
 * This writes the same `station-build.json` next to the bundled server, in the
 * same shape `packages/cli/src/commands/lifecycle.ts` reads, so the desktop
 * shell can read it out of its own resource directory at spawn time.
 *
 * One deliberate divergence from the CLI's `resolveSourceBuildManifest`: that
 * one throws when neither `.git` nor a valid `.station-release.json` is
 * present, because a CLI build with no provenance is a build the CLI refuses to
 * promote. Here a missing manifest must not fail the desktop build — the app
 * still works, and `readBuildProvenance` now reports whatever it does have
 * (instance and boot id) rather than nothing. Absence degrades; it does not
 * fabricate.
 *
 * ## The derivation is platform-neutral; only the writers are not (station#3592)
 *
 * `deriveBuildManifest` and `BUILD_MANIFEST_FILENAME` describe *a checkout*,
 * not a bundle format, so every platform that wants to say which commit it was
 * built from calls them — `scripts/lib/android-build-manifest.mjs` stages the
 * identical bytes under the same filename into the Android APK's assets.
 * Keeping one derivation is the point: a second one is how the two platforms
 * start disagreeing about what a sha means.
 *
 * The module keeps its `desktop-` name because the two things it *writes* are
 * genuinely desktop-scoped — `writeDesktopBuildManifest` targets `dist-server`
 * (the bundled Node server the desktop shell spawns, which Android does not
 * have) and `deriveServerBuildIdentity` bakes that same server's identity into
 * the esbuild banner. Android imports the shared derivation, not either writer.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizedGitEnvironment } from './git-environment.mjs';

export const BUILD_MANIFEST_FILENAME = 'station-build.json';
export const PACKAGED_RELEASE_MANIFEST_FILENAME = '.station-release.json';

const FULL_GIT_SHA = /^[0-9a-f]{40}$/i;

/**
 * `process.env` without Git location overrides, so an inherited value cannot
 * silently retarget the spawned git at a different repository (issue #104).
 * `GIT_INDEX_FILE` matters too: an inherited index can hide staged dirty
 * source. Mirrors the transfer gate's complete scrub list.
 */
export { sanitizedGitEnvironment } from './git-environment.mjs';

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: sanitizedGitEnvironment(),
  }).trim();
}

/**
 * The packaged-release manifest a portable tarball carries, when the desktop
 * app is built from an unpacked release rather than a checkout. Validated
 * conservatively: anything that does not parse as the shape the release
 * packager writes is treated as absent rather than trusted.
 */
export function readPackagedReleaseManifest(projectRoot) {
  try {
    const parsed = JSON.parse(
      readFileSync(
        join(projectRoot, PACKAGED_RELEASE_MANIFEST_FILENAME),
        'utf8',
      ),
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    if (parsed.schemaVersion !== 2) return null;
    if (typeof parsed.sha !== 'string' || !FULL_GIT_SHA.test(parsed.sha)) {
      return null;
    }
    if (typeof parsed.ref !== 'string' || parsed.ref.trim().length === 0) {
      return null;
    }
    return { sha: parsed.sha, ref: parsed.ref.trim() };
  } catch {
    return null;
  }
}

/**
 * `{ sha, branch, builtAt }` for this checkout, or `null` when neither a git
 * checkout nor a packaged-release manifest can supply one.
 *
 * Deliberately no longer carries a `Desktop` in its name: nothing about a
 * commit sha is desktop-specific, and the Android writer calls this too
 * (station#3592).
 */
export function deriveBuildManifest(
  projectRoot,
  { git = runGit, builtAt = new Date().toISOString(), env = process.env } = {},
) {
  if (existsSync(join(projectRoot, '.git'))) {
    try {
      const sha = git(['rev-parse', 'HEAD'], projectRoot);
      // A detached release checkout reports `HEAD` as its branch; the
      // promotion runner can name the verified source branch explicitly
      // without weakening the sha, exactly as the CLI allows.
      const branch =
        env.STATION_BUILD_BRANCH?.trim() ||
        git(['rev-parse', '--abbrev-ref', 'HEAD'], projectRoot);
      if (FULL_GIT_SHA.test(sha) && branch.length > 0) {
        return { sha, branch, builtAt };
      }
    } catch {
      // Fall through to the packaged-release manifest.
    }
  }

  const release = readPackagedReleaseManifest(projectRoot);
  if (release) return { sha: release.sha, branch: release.ref, builtAt };
  return null;
}

/**
 * `{ sha?, builtAt?, channel?, dirty? } | null` — the server's build-time
 * baked identity, read at runtime as an esbuild banner global
 * (`globalThis.__STATION_SERVER_BUILD__`). A valid baked value is authoritative
 * over ambient `STATION_BUILD_SHA`/`STATION_BUILD_BUILT_AT`/`STATION_CHANNEL`
 * metadata: a packaged server must report the bytes it serves, not a
 * supervisor's potentially newer checkout. Missing or invalid baked fields
 * still fall back to those environment values.
 *
 * Reuses `deriveBuildManifest` for `sha`/`builtAt` rather than
 * duplicating its git plumbing. `channel` and `dirty` are each independently
 * try/caught: a failure determining one must not blank out the others — the
 * same "each field survives independently" doctrine `readBuildProvenance`
 * already applies at the runtime layer, applied here at the source. Returns
 * `null` only when EVERY field is undetermined; a CI build with no `.git`
 * still produces a build (absence degrades; it does not fabricate).
 */
export function deriveServerBuildIdentity(
  projectRoot,
  { git = runGit, builtAt = new Date().toISOString(), env = process.env } = {},
) {
  const identity = {};

  const desktopManifest = deriveBuildManifest(projectRoot, {
    git,
    builtAt,
    env,
  });
  if (desktopManifest) {
    identity.sha = desktopManifest.sha;
    identity.builtAt = desktopManifest.builtAt;
  }

  try {
    const configuredChannel =
      typeof env.STATION_CHANNEL === 'string' ? env.STATION_CHANNEL.trim() : '';
    const channel =
      configuredChannel || (desktopManifest ? 'source-checkout' : '');
    if (channel.length > 0) identity.channel = channel;
  } catch {
    // Determining the channel must not blank out sha/builtAt/dirty.
  }

  try {
    const status = git(['status', '--porcelain'], projectRoot);
    identity.dirty = status.length > 0;
  } catch {
    // No `.git` (or git unavailable) leaves dirty undetermined without
    // blanking out sha/builtAt/channel.
  }

  return Object.keys(identity).length > 0 ? identity : null;
}

/**
 * Writes the manifest next to the bundled server. Returns the written path, or
 * `null` when no provenance could be derived (the desktop build continues; the
 * app then reports partial provenance).
 */
export function writeDesktopBuildManifest(
  projectRoot,
  { serverDir = 'dist-server', ...options } = {},
) {
  const serverRoot = join(projectRoot, serverDir);
  if (!existsSync(serverRoot) || !statSync(serverRoot).isDirectory()) {
    throw new Error(
      `Cannot write desktop build provenance: ${serverRoot} does not exist. Build the server before staging desktop resources.`,
    );
  }
  const manifest = deriveBuildManifest(projectRoot, options);
  if (!manifest) return null;
  const manifestPath = join(serverRoot, BUILD_MANIFEST_FILENAME);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}
