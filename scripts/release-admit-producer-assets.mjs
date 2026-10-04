#!/usr/bin/env node
/**
 * Admit the producer release assets that `release.yml`'s `assemble-draft`
 * publishes, and nothing else (#2977).
 *
 * `actions/download-artifact` without `merge-multiple` lays a run's artifacts
 * out as `<root>/<artifact-name>/...`. A single-directory upload
 * (`path: release-assets`) stores that directory's contents at the artifact
 * root, so the files land at `<root>/<artifact-name>/<file>` with no
 * `release-assets` component. A multi-path upload keeps paths relative to
 * their common ancestor, so the TestFlight staged artifact carries its IPA at
 * `<root>/<artifact-name>/release-assets/<file>` beside receipts that are not
 * release assets.
 *
 * The same root also holds artifacts that must never be published: the build
 * provenance descriptor, the container scanner inventory, the TestFlight
 * upload copy of the IPA. Sources are therefore an explicit allowlist, not a
 * path pattern. Every allowlisted directory must exist and hold at least one
 * regular file, so a silently dropped producer fails here rather than as a
 * later "missing asset", and two producers that emit one file name refuse
 * rather than overwrite each other.
 */
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { invokedDirectly } from './lib/module-entry.mjs';

const RELEASE_CHANNELS = ['preview', 'stable'];
const ARTIFACT_SEGMENT = /^[A-Za-z0-9._-]+$/;

function fail(message) {
  throw new Error(`Refusing to admit producer release assets: ${message}`);
}

/**
 * The producer artifacts whose files become draft release assets. Each
 * `artifact` is the `name:` of an `actions/upload-artifact` step in a job
 * `assemble-draft` needs; `directory` is where that artifact holds the files.
 * Adding a producer is one entry here.
 */
export function producerArtifactSources({ channel, iosBundleVersion } = {}) {
  if (!RELEASE_CHANNELS.includes(channel))
    fail(`unknown release channel ${JSON.stringify(channel)}`);
  const sources = [
    { artifact: 'station-desktop-macos-aarch64', directory: '.' },
    { artifact: 'station-desktop-macos-x86_64', directory: '.' },
    { artifact: 'station-desktop-windows-x86_64', directory: '.' },
    { artifact: 'station-desktop-linux-x86_64', directory: '.' },
    { artifact: 'station-portable', directory: '.' },
    // release.yml `host-manifest` (#2959): the five station-server archives
    // and the unsigned manifest payload, for both rings. The per-target
    // `station-server-<target>` build artifacts share the download root and
    // stay out: they also carry descriptors that are not release assets.
    { artifact: 'station-host-stream', directory: '.' },
    { artifact: 'station-android', directory: '.' },
    { artifact: 'station-container-release', directory: '.' },
  ];
  // Preview releases publish no iOS variant (release-variants.mjs); the
  // simulator job is skipped and the beta TestFlight IPA is not a draft asset.
  if (channel === 'stable') {
    if (!ARTIFACT_SEGMENT.test(iosBundleVersion ?? ''))
      fail(`invalid iOS bundle version ${JSON.stringify(iosBundleVersion)}`);
    sources.push(
      { artifact: 'station-ios-simulator-verification', directory: '.' },
      {
        // testflight-delivery.yml `deliver`: the audited IPA, uploaded with
        // receipts and identity files that stay out of the release.
        artifact: `station-stable-ios-staged-${iosBundleVersion}`,
        directory: 'release-assets',
      },
    );
  }
  return sources;
}

function sourceFiles(artifactsRoot, { artifact, directory }) {
  const label = directory === '.' ? artifact : `${artifact}/${directory}`;
  // Check each level with lstat so a symlinked artifact directory is refused
  // rather than followed.
  const levels = [join(artifactsRoot, artifact)];
  if (directory !== '.') levels.push(join(levels[0], directory));
  for (const level of levels) {
    if (!existsSync(level)) fail(`producer artifact ${label} is missing`);
    if (!lstatSync(level).isDirectory())
      fail(`producer artifact ${label} is not a directory`);
  }
  const path = levels.at(-1);
  const files = [];
  // Producer asset directories are flat; a nested directory or symlink means
  // the upload layout changed, so refuse rather than guess.
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.isFile()) fail(`${label}/${entry.name} is not a regular file`);
    files.push({ name: entry.name, from: join(path, entry.name), label });
  }
  if (files.length === 0) fail(`producer artifact ${label} is empty`);
  return files;
}

export function admitProducerAssets({
  artifactsRoot,
  outputDir,
  channel,
  iosBundleVersion,
}) {
  if (!artifactsRoot || !existsSync(artifactsRoot))
    fail(`artifacts root ${JSON.stringify(artifactsRoot)} does not exist`);
  if (!outputDir || !existsSync(outputDir))
    fail(`output directory ${JSON.stringify(outputDir)} does not exist`);
  // Plan every copy before writing one, so a refusal leaves no partial set.
  const planned = new Map();
  for (const source of producerArtifactSources({ channel, iosBundleVersion })) {
    for (const file of sourceFiles(artifactsRoot, source)) {
      const earlier = planned.get(file.name);
      if (earlier)
        fail(
          `${file.name} is produced by both ${earlier.label} and ${file.label}`,
        );
      planned.set(file.name, file);
    }
  }
  for (const [name, file] of planned)
    copyFileSync(file.from, join(outputDir, name), constants.COPYFILE_EXCL);
  return [...planned.keys()].sort();
}

const OPTIONS = {
  '--artifacts-root': 'artifactsRoot',
  '--output-dir': 'outputDir',
  '--channel': 'channel',
  '--ios-bundle-version': 'iosBundleVersion',
};

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = OPTIONS[argv[index]];
    if (!key) fail(`unknown option ${JSON.stringify(argv[index])}`);
    if (key in parsed) fail(`option ${argv[index]} is repeated`);
    if (index + 1 >= argv.length) fail(`option ${argv[index]} needs a value`);
    parsed[key] = argv[index + 1];
  }
  return parsed;
}

if (invokedDirectly(import.meta.url)) {
  try {
    const admitted = admitProducerAssets(parseArguments(process.argv.slice(2)));
    for (const name of admitted) console.log(`admitted ${name}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
