/**
 * Build provenance for the packaged Android app (station#3592).
 *
 * The desktop bundle has stamped its origin since station#1085 —
 * `Station.app/Contents/Resources/dist-server/station-build.json` names the
 * sha, branch and build time — and that stamp is what makes "is the installed
 * app newer than mine?" a five-second question. The APK carried no equivalent:
 * the only version signal on a live device was `versionName=0.1.0`, which never
 * changes, so neither direction was decidable. You could not confirm a phone
 * was current, and you could not avoid clobbering something newer.
 *
 * This stages the SAME artifact — same derivation, same field shape, same
 * `station-build.json` filename — into the Android project's asset source
 * directory, which Gradle packages verbatim into the APK at
 * `assets/station-build.json`. Tauri's own `tauri.conf.json` reaches the APK
 * through that exact directory, which is what makes it the packaging path
 * rather than a guess.
 *
 * Two deliberate divergences from `writeDesktopBuildManifest`:
 *
 *  - It creates the assets directory. The desktop writer refuses when
 *    `dist-server/` is missing because a manifest describing a server bundle
 *    that was never built is a lie; the Android assets directory, by contrast,
 *    legitimately does not exist until something puts a file in it (Tauri
 *    creates it when it writes `tauri.conf.json`).
 *  - It still refuses when the Android project itself has not been generated.
 *    Writing a stamp into a phantom `gen/android` tree would produce a file no
 *    build ever reads, which is the failure mode this whole change exists to
 *    remove.
 *
 * Absence of provenance degrades rather than failing the build, matching the
 * desktop path: a checkout with neither `.git` nor a valid
 * `.station-release.json` yields `null` and an unstamped APK. What must never
 * happen is a stamp that is not derived from the tree being built.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILD_MANIFEST_FILENAME,
  deriveBuildManifest,
  readNativeClientBuildManifest,
} from './desktop-build-manifest.mjs';

/**
 * Where `tauri android init` generates the Gradle project. Its
 * `app/src/main/assets/` is the Android asset source set: everything in it is
 * packaged into the APK under `assets/`.
 */
export const ANDROID_PROJECT_DIR = join('src-desktop', 'gen', 'android');
export const ANDROID_ASSETS_DIR = join(
  ANDROID_PROJECT_DIR,
  'app',
  'src',
  'main',
  'assets',
);

/**
 * Stages the build manifest into the Android APK assets. Returns the written
 * path, or `null` when no provenance could be derived.
 *
 * Throws when the Android project has not been generated yet — the caller is
 * about to run `tauri android build`, which needs it anyway, and a stamp
 * written beside no build is worse than no stamp.
 *
 * `git`/`builtAt`/`env` are forwarded verbatim to `deriveBuildManifest`; they
 * are declared here so the forwarding is part of the checked signature rather
 * than something a caller discovers by reading the spread.
 *
 * @param {string} projectRoot
 * @param {{
 *   assetsDir?: string,
 *   projectDir?: string,
 *   git?: (args: string[], cwd: string) => string,
 *   builtAt?: string,
 *   env?: Record<string, string | undefined>,
 * }} [options]
 * @returns {string | null}
 */
export function writeAndroidBuildManifest(
  projectRoot,
  {
    assetsDir = ANDROID_ASSETS_DIR,
    projectDir = ANDROID_PROJECT_DIR,
    ...options
  } = {},
) {
  const generatedProject = join(projectRoot, projectDir);
  if (
    !existsSync(generatedProject) ||
    !statSync(generatedProject).isDirectory()
  ) {
    throw new Error(
      `Cannot stage Android build provenance: ${generatedProject} does not exist. Run \`npx tauri android init\` before building the APK.`,
    );
  }
  // A native artifact gets one wall-clock sample at the client staging seam.
  // Android must carry that exact source-derived record, not a later asset
  // writer timestamp. Direct utility callers retain the documented fallback.
  const manifest =
    readNativeClientBuildManifest(projectRoot) ??
    deriveBuildManifest(projectRoot, options);
  if (!manifest) return null;
  const assetsRoot = join(projectRoot, assetsDir);
  mkdirSync(assetsRoot, { recursive: true });
  const manifestPath = join(assetsRoot, BUILD_MANIFEST_FILENAME);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}
