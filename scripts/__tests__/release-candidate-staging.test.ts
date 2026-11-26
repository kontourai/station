/**
 * #4929: a release candidate tag stages end to end, through release.yml's own
 * step text, from the producer jobs to the validated draft inventory.
 *
 * Each producer job that can run off a runner runs its real `run:` text with
 * its `${{ }}` inputs substituted (portable, container descriptor, the three
 * host-manifest steps); the native jobs, which need signing hosts, are
 * replaced by files named exactly as their `cp` lines name them. The draft
 * assembler then runs its real admission and inventory steps, and the SBOM
 * context and SBOMs come from the real CLIs. A retired `-preview.N` set is
 * refused on the same path.
 */
import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import { PORTABLE_SERVER_TARGETS } from '../../packages/shared/src/portable-server-targets.mjs';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import { taggedStoreIdentity } from '../lib/native-release-config.mjs';
import {
  createWindowsReleaseSigningReceipt,
  windowsSigningReceiptAsset,
} from '../lib/windows-release-signing.mjs';
import { runReleaseAvailability } from '../release-availability-driver.mjs';
import {
  copyCandidateToFinal,
  createPromotionPlan,
  PROMOTION_RECEIPT_ASSET,
  verifyPromotionReceipt,
} from '../release-promotion.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const TAG = 'v0.1.11-rc.1';
const BASE_VERSION = '0.1.11';
const CREATED_AT = '2026-11-13T12:00:00.000Z';
const REPOSITORY = 'kontourai/station';
const DIGEST = `sha256:${'b'.repeat(64)}`;
const NODE_VERSION = JSON.parse(
  readFileSync(
    resolve(repoRoot, 'config/portable-server-node-runtime.json'),
    'utf8',
  ),
).version as string;

type Step = {
  id?: string;
  name?: string;
  run?: string;
  env?: Record<string, string>;
};
type Job = { steps?: Step[] };
const release = load(
  readFileSync(resolve(repoRoot, '.github/workflows/release.yml'), 'utf8'),
) as { jobs: Record<string, Job> };

function stepRun(job: string, match: (step: Step) => boolean): string {
  const run = release.jobs[job]?.steps?.find(match)?.run;
  if (typeof run !== 'string') throw new Error(`missing ${job} step`);
  return run;
}
const named = (name: string) => (step: Step) => step.name === name;

/** Substitute `${{ }}` inputs; an expression left over is a test bug. */
function resolveExpressions(run: string, values: Record<string, string>) {
  const resolved = run.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (whole, key) => {
    if (!(key in values)) throw new Error(`unresolved expression ${whole}`);
    return values[key];
  });
  return resolved;
}

function bash(run: string, cwd: string, env: Record<string, string>) {
  return spawnSyncBounded(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120_000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ...env,
      },
    },
  );
}

function node(args: string[], cwd = repoRoot) {
  return spawnSyncBounded(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
  });
}

function git(args: string[], cwd: string) {
  const result = spawnSyncBounded('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    // An inherited GIT_DIR would point the fixture at another repository.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
    ),
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return String(result.stdout).trim();
}

function minisignPublicKey(publicKey: KeyObject, keyId: Buffer) {
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const packet = Buffer.concat([
    Buffer.from('Ed'),
    keyId,
    der.subarray(der.length - 32),
  ]);
  return Buffer.from(
    `untrusted comment: minisign public key: TEST\n${packet.toString('base64')}\n`,
  ).toString('base64');
}

function minisignSignature(
  payload: Buffer,
  privateKey: KeyObject,
  keyId: Buffer,
) {
  const signature = sign(
    null,
    createHash('blake2b512').update(payload).digest(),
    privateKey,
  );
  const trustedComment = 'timestamp:1784988124\tfile:test\tprehashed';
  const globalSignature = sign(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment)]),
    privateKey,
  );
  return Buffer.from(
    [
      'untrusted comment: signature from tauri secret key',
      Buffer.concat([Buffer.from('ED'), keyId, signature]).toString('base64'),
      `trusted comment: ${trustedComment}`,
      globalSignature.toString('base64'),
      '',
    ].join('\n'),
  ).toString('base64');
}

const makeTempDir = trackTempDirs();

/** A scratch working directory that sees the repository's scripts and config. */
function workDir(prefix: string) {
  const dir = makeTempDir(prefix);
  for (const entry of ['scripts', 'config', 'packages', 'schemas'])
    symlinkSync(join(repoRoot, entry), join(dir, entry), 'dir');
  return dir;
}

/** The release.yml portable job, in a fixture checkout that carries its packager. */
function portableProducer(artifacts: string) {
  const checkout = makeTempDir('station-rc-portable-');
  mkdirSync(join(checkout, 'scripts/lib'), { recursive: true });
  for (const file of [
    'scripts/package-portable-release.sh',
    'scripts/lib/release-tag.mjs',
    'scripts/lib/module-entry.mjs',
  ])
    copyFileSync(join(repoRoot, file), join(checkout, file));
  writeFileSync(join(checkout, 'tracked.txt'), 'portable\n');
  git(['init', '-q'], checkout);
  git(['config', 'user.name', 'Station Tests'], checkout);
  git(['config', 'user.email', 'station@example.invalid'], checkout);
  git(['add', '.'], checkout);
  git(['commit', '-qm', 'fixture'], checkout);
  const sha = git(['rev-parse', 'HEAD'], checkout);
  const run = resolveExpressions(
    stepRun('portable', (step) =>
      Boolean(step.run?.startsWith('scripts/package-portable-release.sh')),
    ),
    {
      'needs.preflight.outputs.tag': TAG,
      'needs.preflight.outputs.sha': sha,
      'needs.preflight.outputs.created_at': CREATED_AT,
    },
  );
  const packaged = bash(run, checkout, {});
  expect(packaged.status, packaged.stderr).toBe(0);
  cpSync(
    join(checkout, 'release-assets'),
    join(artifacts, 'station-portable'),
    {
      recursive: true,
    },
  );
  return sha;
}

it('stages same-source RCs independently and refuses an existing candidate image', () => {
  const cwd = workDir('station-rc-image-custody-');
  const output = join(cwd, 'github-output');
  const names = ['v0.1.11-rc.1', 'v0.1.11-rc.2'].map((tag) => {
    const result = bash(
      stepRun('container', (step) => step.id === 'metadata'),
      cwd,
      {
        RELEASE_TAG: tag,
        RELEASE_SHA: 'a'.repeat(40),
        RELEASE_CREATED_AT: CREATED_AT,
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_OUTPUT: output,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const name = readFileSync(output, 'utf8').match(/^staging_tag=(.+)$/m)?.[1];
    writeFileSync(output, '');
    if (!name) throw new Error('metadata did not emit a staging image');
    return name;
  });
  expect(names[0]).not.toBe(names[1]);
  const bin = join(cwd, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'docker'),
    '#!/bin/sh\n[ "$1 $2 $3" = "buildx imagetools inspect" ] || exit 2\n[ "$4" = "$EXISTING_IMAGE" ]\n',
    { mode: 0o755 },
  );
  const guard = stepRun(
    'container',
    named('Refuse to overwrite immutable source image staging'),
  );
  for (const [index, name] of names.entries()) {
    const result = bash(
      resolveExpressions(guard, { 'steps.metadata.outputs.staging_tag': name }),
      cwd,
      {
        PATH: `${bin}:${process.env.PATH}`,
        EXISTING_IMAGE: names[0],
      },
    );
    if (index === 0) {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Immutable image already exists');
    } else expect(result.status, result.stderr).toBe(0);
  }
  // The publication consumer must find the exact candidate staging image too.
  mkdirSync(join(cwd, 'release-assets'));
  writeFileSync(
    join(cwd, 'release-assets/station-container-release.json'),
    JSON.stringify({
      image: 'ghcr.io/kontourai/station',
      digest: DIGEST,
    }),
  );
  const published = load(
    readFileSync(
      join(repoRoot, '.github/workflows/publish-release.yml'),
      'utf8',
    ),
  ) as { jobs: Record<string, Job> };
  const promote = published.jobs.publish.steps?.find(
    (step) => step.name === 'Promote only the recorded immutable GHCR digest',
  )?.run;
  if (!promote) throw new Error('publication consumer is missing');
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
[ "$1 $2" = "buildx imagetools" ] || exit 2
case "$3" in
  inspect)
    case "$4" in *:staging-*) [ "$4" = "$EXISTING_IMAGE" ] || exit 1;; *:sha-*) [ -e "$DOCKER_CREATED" ] || exit 1;; esac
    printf '%s\n' "$IMAGE_DIGEST";;
  create) touch "$DOCKER_CREATED"; exit 0;;
  *) exit 2;;
esac
`,
    { mode: 0o755 },
  );
  const result = bash(promote, cwd, {
    PATH: `${bin}:${process.env.PATH}`,
    EXISTING_IMAGE: names[1],
    IMAGE_DIGEST: DIGEST,
    DOCKER_CREATED: join(cwd, 'created'),
    RELEASE_TAG: 'v0.1.11-rc.2',
    RELEASE_SHA: 'a'.repeat(40),
    RELEASE_MODE: 'promote',
    PUBLICATION_TAG: 'v0.1.11',
    RELEASE_VERSION: BASE_VERSION,
  });
  expect(result.status, result.stderr).toBe(0);
});

/** The release.yml container job's descriptor step. */
function containerProducer(artifacts: string, sha: string) {
  const cwd = workDir('station-rc-container-');
  const env = {
    RELEASE_TAG: TAG,
    RELEASE_SHA: sha,
    RELEASE_CREATED_AT: CREATED_AT,
    GITHUB_REPOSITORY: REPOSITORY,
  };
  const metadata = bash(
    stepRun('container', (step) => step.id === 'metadata'),
    cwd,
    { ...env, GITHUB_OUTPUT: join(cwd, 'github-output') },
  );
  expect(metadata.status, metadata.stderr).toBe(0);
  const run = resolveExpressions(
    stepRun(
      'container',
      named('Create immutable container release descriptor'),
    ),
    { 'steps.image.outputs.digest': DIGEST },
  );
  const described = bash(run, cwd, env);
  expect(described.status, described.stderr).toBe(0);
  cpSync(
    join(cwd, 'release-assets'),
    join(artifacts, 'station-container-release'),
    { recursive: true },
  );
}

/**
 * The host-archives job builds each archive at `--ref v<base version>` in the
 * Stable ring; this lays out its station-server-* artifacts with the
 * descriptor shape describePortableArchive writes, then runs the
 * host-manifest job's own steps.
 */
function hostStreamProducer(artifacts: string, sha: string) {
  const cwd = workDir('station-rc-host-');
  const runnerTemp = makeTempDir('station-rc-host-runner-');
  for (const { os, arch, format } of PORTABLE_SERVER_TARGETS) {
    const target = `${os}-${arch}`;
    const name = `station-server-${target}.${format}`;
    const job = join(runnerTemp, 'archives', `station-server-${target}`);
    mkdirSync(job, { recursive: true });
    const bytes = Buffer.from(`host archive ${target} ${BASE_VERSION}\n`);
    writeFileSync(join(job, name), bytes);
    writeFileSync(
      join(job, `${name}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        name,
        target,
        format,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        root: 'station',
        launcher: `station/bin/station${os === 'win32' ? '.cmd' : ''}`,
        node: {
          version: NODE_VERSION,
          distribution: `node-v${NODE_VERSION}-${os === 'win32' ? 'win' : os}-${arch}.${format}`,
          sha256: 'd'.repeat(64),
        },
        release: {
          schemaVersion: 2,
          sha,
          ref: `v${BASE_VERSION}`,
          createdAt: CREATED_AT,
          channel: 'stable',
          releaseChannel: 'stable',
          prerelease: false,
        },
        unpacked: {
          bytes: 300_000_000,
          files: 20_000,
          longestRelativePath: 180,
        },
      })}\n`,
    );
  }
  const env = {
    RUNNER_TEMP: runnerTemp,
    RELEASE_RING: 'stable',
    RELEASE_VERSION: BASE_VERSION,
    RELEASE_SHA: sha,
    RELEASE_TAG: TAG,
    GITHUB_REPOSITORY: REPOSITORY,
  };
  const output = join(runnerTemp, 'github-output');
  writeFileSync(output, '');
  const located = bash(
    stepRun(
      'host-manifest',
      named('Name the versioned release and the rolling manifest'),
    ),
    cwd,
    { ...env, GITHUB_OUTPUT: output },
  );
  expect(located.status, located.stderr).toBe(0);
  const baseUrl = /^base_url=(.*)$/m.exec(readFileSync(output, 'utf8'))?.[1];
  expect(baseUrl).toBe(
    `https://github.com/${REPOSITORY}/releases/download/${TAG}/`,
  );
  for (const name of [
    'Assemble the schema v2 payload from the archive descriptors',
    'Stage the host archives and payload as release assets',
  ]) {
    const step = bash(stepRun('host-manifest', named(name)), cwd, {
      ...env,
      BASE_URL: baseUrl ?? '',
    });
    expect(step.status, `${name}: ${step.stderr}`).toBe(0);
  }
  cpSync(join(cwd, 'release-assets'), join(artifacts, 'station-host-stream'), {
    recursive: true,
  });
}

/**
 * The native producers need signing hosts, so their files are written with
 * the names release.yml's own `cp` lines give them, and a throwaway updater
 * key signs the updater bundles.
 */
function nativeProducers(
  artifacts: string,
  iosBundleVersion: string,
  sha: string,
) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const keyId = Buffer.from('12345678');
  const write = (artifact: string, file: string, signed = false) => {
    const path = join(artifacts, artifact, file);
    mkdirSync(dirname(path), { recursive: true });
    const bytes = Buffer.from(`${artifact}/${file}\n`);
    writeFileSync(path, bytes);
    if (signed)
      writeFileSync(`${path}.sig`, minisignSignature(bytes, privateKey, keyId));
  };
  for (const [artifact, stem, primary, updater] of [
    ['station-desktop-macos-aarch64', 'macos-aarch64', 'dmg', 'app.tar.gz'],
    ['station-desktop-macos-x86_64', 'macos-x86_64', 'dmg', 'app.tar.gz'],
    ['station-desktop-windows-x86_64', 'windows-x86_64', 'msi', 'msi.zip'],
    [
      'station-desktop-linux-x86_64',
      'linux-x86_64',
      'AppImage',
      'AppImage.tar.gz',
    ],
  ]) {
    write(artifact, `station-${TAG}-${stem}.${primary}`);
    write(artifact, `station-${TAG}-${stem}.${updater}`, true);
  }
  // Native files and their OS observations are fixtures; the inventory owner
  // must still validate the receipt against the candidate MSI's actual bytes.
  const installer = `station-${TAG}-windows-x86_64.msi`;
  const installerPath = join(
    artifacts,
    'station-desktop-windows-x86_64',
    installer,
  );
  const installerSha256 = createHash('sha256')
    .update(readFileSync(installerPath))
    .digest('hex');
  writeFileSync(
    join(
      artifacts,
      'station-desktop-windows-x86_64',
      windowsSigningReceiptAsset(TAG),
    ),
    JSON.stringify(
      createWindowsReleaseSigningReceipt({
        tag: TAG,
        sourceSha: sha,
        mode: 'unsigned',
        installer,
        installerSha256,
        observation: {
          installer: installerPath,
          installerSha256,
          authenticodeStatus: 'NotSigned',
          statusMessage: null,
          signerThumbprint: null,
        },
      }),
    ),
  );
  write('station-android', `station-${TAG}-android-universal.apk`);
  write('station-android', `station-${TAG}-android-universal.aab`);
  write(
    'station-ios-simulator-verification',
    `station-${TAG}-ios-simulator.app.tar.gz`,
  );
  // testflight-delivery.yml keeps the IPA under release-assets/ beside
  // receipts that are not release assets.
  const staged = `station-stable-ios-staged-${iosBundleVersion}`;
  write(staged, `release-assets/station-${TAG}-ios-device.ipa`);
  write(staged, 'provider-receipts/testflight-build.json');
  const hash = (artifact: string, file: string) =>
    createHash('sha256')
      .update(readFileSync(join(artifacts, artifact, file)))
      .digest('hex');
  const aabSha256 = hash(
    'station-android',
    `station-${TAG}-android-universal.aab`,
  );
  const ipaSha256 = hash(
    staged,
    `release-assets/station-${TAG}-ios-device.ipa`,
  );
  const androidDirectory = join(
    artifacts,
    `station-android-store-authority-${iosBundleVersion}`,
  );
  mkdirSync(androidDirectory, { recursive: true });
  writeFileSync(
    join(androidDirectory, 'android-store-authority.json'),
    JSON.stringify({
      kind: 'station.release-store-authority/v1',
      producerTag: TAG,
      sourceSha: sha,
      version: BASE_VERSION,
      android: {
        packageName: 'io.kontourai.station',
        versionCode: Number(iosBundleVersion),
        aabSha256,
        providerBundleSha256: aabSha256,
        sourceTrack: 'internal',
      },
    }),
  );
  const delivery = join(
    artifacts,
    `station-stable-ios-testflight-${iosBundleVersion}/provider-receipts`,
  );
  mkdirSync(delivery, { recursive: true });
  writeFileSync(
    join(delivery, 'testflight-build-receipt.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'testflight-build-receipt',
      provider: 'app-store-connect',
      appId: '123456789',
      buildId: '987654321',
      bundleId: 'io.kontourai.station',
      bundleVersion: iosBundleVersion,
      sourceSha: sha,
      providerSourceSha: sha,
      processingState: 'VALID',
      deliveryMode: 'uploaded',
      ipaSha256,
    }),
  );
  // Download-root neighbours that must never be admitted.
  write(
    'station-release-client-build-provenance-4242',
    'station-client-build.json',
  );
  write('station-container-sbom-source', 'station-container-source.json');
  return minisignPublicKey(publicKey, keyId);
}

/** A fragment component for an npm package URL, named as the URL names it. */
function npmComponent(purl: string) {
  const path = purl.slice('pkg:npm/'.length);
  const at = path.lastIndexOf('@');
  return {
    name: decodeURIComponent(path.slice(0, at)),
    purl,
    version: decodeURIComponent(path.slice(at + 1)),
  };
}

/**
 * Stand-ins for the npm, Rust and container scanner fragments, which need
 * the lockfile generator, cargo and a pulled image. Each carries the
 * lifecycle-allowlisted packages the real SBOM context lists for its scopes,
 * because generation requires every one of them to be inventoried.
 */
function writeSbomFragments(dir: string, context: SbomContext) {
  const { purlsByScope } = context.dependencyLifecycle;
  const runtime = [
    ...new Set([
      ...purlsByScope.portable,
      ...purlsByScope.desktop,
      ...purlsByScope.mobile,
    ]),
  ].sort();
  writeFileSync(
    join(dir, 'npm.fragment.json'),
    JSON.stringify({
      components: runtime.map(npmComponent),
      predicate: 'runtime',
      source: 'npm',
    }),
  );
  writeFileSync(
    join(dir, 'rust.fragment.json'),
    '{"components":[],"predicate":"native","source":"rust"}',
  );
  writeFileSync(
    join(dir, 'container.fragment.json'),
    JSON.stringify({
      components: [
        { name: 'bash', purl: 'pkg:deb/debian/bash@5.2', version: '5.2' },
        ...purlsByScope.container.map(npmComponent),
      ],
      predicate: 'image',
      source: 'container',
    }),
  );
}

type SbomContext = {
  tag: string;
  version: string;
  channel: string;
  dependencyLifecycle: { purlsByScope: Record<string, string[]> };
};

/** Every producer job for TAG, then assemble-draft up to the draft upload. */
function stageCandidate() {
  const runnerTemp = makeTempDir('station-rc-draft-');
  const artifacts = join(runnerTemp, 'station-release-producer-artifacts');
  mkdirSync(artifacts);
  const { bundleVersion } = taggedStoreIdentity(TAG);
  const sha = portableProducer(artifacts);
  containerProducer(artifacts, sha);
  hostStreamProducer(artifacts, sha);
  const updaterPublicKey = nativeProducers(artifacts, bundleVersion, sha);
  const work = workDir('station-rc-assemble-');
  const env = {
    RUNNER_TEMP: runnerTemp,
    RELEASE_TAG: TAG,
    RELEASE_SHA: sha,
    RELEASE_CREATED_AT: CREATED_AT,
    RELEASE_CHANNEL: 'stable',
    IOS_BUNDLE_VERSION: bundleVersion,
  };
  const admitted = bash(
    stepRun(
      'assemble-draft',
      named('Admit only producer release assets, never scanner scratch'),
    ),
    work,
    env,
  );
  expect(admitted.status, admitted.stderr).toBe(0);
  const assets = join(work, 'release-assets');
  const storeAuthority = bash(
    stepRun(
      'assemble-draft',
      named('Bind definitive store upload lineage to the candidate bytes'),
    ),
    work,
    env,
  );
  expect(storeAuthority.status, storeAuthority.stderr).toBe(0);
  // assemble-draft's SBOM step needs cargo and the pnpm generator; its two
  // tag-bound CLIs run for real against the admitted assets.
  const fragments = join(runnerTemp, 'station-release-sbom-fragments');
  mkdirSync(fragments);
  const context = node([
    'scripts/release-sbom-context.mjs',
    '--assets-dir',
    assets,
    '--tag',
    TAG,
    '--sha',
    sha,
    '--generated-at',
    CREATED_AT,
    '--output',
    join(fragments, 'context.json'),
  ]);
  expect(context.status, context.stderr).toBe(0);
  writeSbomFragments(
    fragments,
    JSON.parse(readFileSync(join(fragments, 'context.json'), 'utf8')),
  );
  const sboms = node([
    'scripts/generate-release-sboms.mjs',
    '--assets-dir',
    assets,
    '--fragments-dir',
    fragments,
    '--context',
    join(fragments, 'context.json'),
    '--npm-fragment',
    join(fragments, 'npm.fragment.json'),
    '--rust-fragment',
    join(fragments, 'rust.fragment.json'),
    '--container-fragment',
    join(fragments, 'container.fragment.json'),
  ]);
  expect(sboms.status, sboms.stderr).toBe(0);
  return { runnerTemp, work, assets, fragments, env, updaterPublicKey };
}

function assembleInventory(
  work: string,
  env: Record<string, string>,
  updaterPublicKey: string,
) {
  return bash(
    stepRun(
      'assemble-draft',
      named('Assemble and validate one deterministic inventory'),
    ),
    work,
    { ...env, TAURI_SIGNING_PUBLIC_KEY: updaterPublicKey },
  );
}

describe('a release candidate stages through release.yml to a validated draft inventory (#4929)', () => {
  it('admits, inventories and validates a v0.1.11-rc.1 producer set as Stable 0.1.11 bytes at the candidate tag', () => {
    const { work, assets, fragments, env, updaterPublicKey } = stageCandidate();
    const sbomContext = JSON.parse(
      readFileSync(join(fragments, 'context.json'), 'utf8'),
    );
    expect(sbomContext).toMatchObject({
      tag: TAG,
      version: BASE_VERSION,
      channel: 'stable',
    });

    const inventoryStep = assembleInventory(work, env, updaterPublicKey);
    expect(inventoryStep.status, inventoryStep.stderr).toBe(0);
    const inventory = JSON.parse(
      readFileSync(join(assets, 'station-release-inventory.json'), 'utf8'),
    );
    expect(inventory).toMatchObject({
      tag: TAG,
      version: BASE_VERSION,
      channel: 'stable',
      container: { tag: TAG, tags: [TAG, `sha-${inventory.sourceSha}`] },
    });
    expect(
      inventory.variants.find(
        (variant: { id: string }) => variant.id === 'windows-x86_64',
      ),
    ).toMatchObject({
      platformSigning: { state: 'unsigned', proof: 'not-applicable' },
      updaterSigning: { state: 'signed', proof: 'tauri-updater-signature' },
    });
    expect(inventory.container.tags).not.toContain('latest');
    expect(inventory.container.tags).not.toContain(BASE_VERSION);
    // Location: every native asset is named for the candidate tag, iOS too.
    const native = inventory.assets
      .map(({ name }: { name: string }) => name)
      .filter((name: string) => name.startsWith('station-v'));
    expect(native.length).toBeGreaterThan(0);
    expect(
      native.every((name: string) => name.startsWith(`station-${TAG}-`)),
    ).toBe(true);
    expect(native).toContain(`station-${TAG}-ios-device.ipa`);
    // Identity: the host payload names the base version; its URLs name
    // where the bytes are staged, the candidate's release.
    const payload = JSON.parse(
      readFileSync(
        join(assets, 'station-server-manifest-payload.json'),
        'utf8',
      ),
    );
    expect(payload).toMatchObject({
      channel: 'stable',
      version: BASE_VERSION,
      releaseTag: `v${BASE_VERSION}`,
    });
    for (const artifact of payload.artifacts)
      expect(artifact.url).toBe(
        `https://github.com/${REPOSITORY}/releases/download/${TAG}/${artifact.name}`,
      );
    const ring = JSON.parse(
      readFileSync(join(assets, 'station-release-ring-stable.json'), 'utf8'),
    );
    expect(ring).toMatchObject({
      channel: 'stable',
      prerelease: false,
      ref: TAG,
    });
    expect(readdirSync(assets)).not.toContain('station-client-build.json');
    expect(readdirSync(assets)).not.toContain('station-container-source.json');

    // Execute draft creation with the real notes CLIs. Only the GitHub API and
    // gh transport are replaced; inspect the body actually handed to create.
    const bin = join(work, 'bin');
    mkdirSync(bin);
    const publishedNotes = join(work, 'published-notes.md');
    writeFileSync(
      join(bin, 'gh'),
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] !== 'release') process.exit(2);
if (args[1] === 'view') process.exit(1);
if (args[1] === 'create') {
  const { copyFileSync } = await import('node:fs');
  copyFileSync(args[args.indexOf('--notes-file') + 1], process.env.PUBLISHED_NOTES);
} else if (args[1] !== 'upload') process.exit(2);
`,
      { mode: 0o755 },
    );
    const preload = join(work, 'github-fixture.mjs');
    writeFileSync(
      preload,
      `globalThis.fetch = async (url) => {
  if (url.includes('/releases?')) return Response.json([{tag_name: 'v0.1.10'}]);
  if (url.includes('/tags?')) return Response.json([]);
  if (url.includes('/commits/v0.1.10')) return Response.json({sha: '${'b'.repeat(40)}'});
  if (url.endsWith('/generate-notes')) return Response.json({body: ${JSON.stringify('## What Changed\n* Candidate changelog fixture')}});
  throw new Error('Unexpected GitHub request: ' + url);
};`,
    );
    const draft = bash(
      stepRun(
        'assemble-draft',
        named('Create exactly one draft and upload validated assets'),
      ),
      work,
      {
        ...env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GITHUB_REPOSITORY: REPOSITORY,
        GH_TOKEN: 'fixture-token',
        NODE_OPTIONS: `--import=${preload}`,
        PUBLISHED_NOTES: publishedNotes,
      },
    );
    expect(draft.status, draft.stderr).toBe(0);
    const body = readFileSync(publishedNotes, 'utf8');
    expect(body).toContain('## What Changed\n* Candidate changelog fixture');
    expect(body).toContain('STATION_CHANNEL=stable sh');
    expect(body).toContain('is not Authenticode-signed yet (#3591)');
    expect(body).toContain(windowsSigningReceiptAsset(TAG));
  }, 240_000);

  it('refuses the same producer set staged under a retired -preview.N tag', () => {
    const { work, assets, env, updaterPublicKey } = stageCandidate();
    const previewTag = 'v0.1.11-preview.1';
    // The same bytes, named as a preview tag's producers would name them.
    for (const name of readdirSync(assets))
      if (name.startsWith(`station-${TAG}-`))
        renameSync(
          join(assets, name),
          join(
            assets,
            name.replace(`station-${TAG}-`, `station-${previewTag}-`),
          ),
        );
    const previewEnv = { ...env, RELEASE_TAG: previewTag };
    const inventoryStep = assembleInventory(work, previewEnv, updaterPublicKey);
    expect(inventoryStep.status).toBe(1);
    expect(inventoryStep.stderr).toContain(`invalid tag ${previewTag}`);

    const context = node([
      'scripts/release-sbom-context.mjs',
      '--assets-dir',
      assets,
      '--tag',
      previewTag,
      '--sha',
      env.RELEASE_SHA,
      '--generated-at',
      CREATED_AT,
      '--output',
      join(work, 'preview-context.json'),
    ]);
    expect(context.status).toBe(1);
    expect(context.stderr).toContain(`invalid tag ${previewTag}`);

    const admitted = bash(
      stepRun(
        'assemble-draft',
        named('Admit only producer release assets, never scanner scratch'),
      ),
      workDir('station-rc-preview-admit-'),
      { ...previewEnv, RELEASE_CHANNEL: 'preview' },
    );
    expect(admitted.status).toBe(1);
    expect(admitted.stderr).toContain('unknown release channel "preview"');
  }, 240_000);
});

async function promotionFixture() {
  const staged = stageCandidate();
  const assembled = assembleInventory(
    staged.work,
    staged.env,
    staged.updaterPublicKey,
  );
  expect(assembled.status, assembled.stderr).toBe(0);
  const plan = await createPromotionPlan({
    producerTag: TAG,
    sourceSha: staged.env.RELEASE_SHA,
    policySha: 'c'.repeat(40),
    workflowSha: 'd'.repeat(40),
    assetsDir: staged.assets,
  });
  const refs = new Map([[TAG, staged.env.RELEASE_SHA]]);
  const files = new Map<string, Map<string, Buffer>>([
    [
      TAG,
      new Map(
        readdirSync(staged.assets).map((name) => [
          name,
          readFileSync(join(staged.assets, name)),
        ]),
      ),
    ],
  ]);
  const states = new Map([
    [
      TAG,
      {
        id: 1,
        tag_name: TAG,
        draft: false,
        prerelease: true,
        body: 'Candidate changelog',
      },
    ],
  ]);
  const writes: string[] = [];
  const github = {
    source: async (tag: string) => refs.get(tag) ?? null,
    release: async (tag: string) => {
      const state = states.get(tag);
      if (!state) return null;
      return {
        ...state,
        assets: [...(files.get(tag) ?? [])].map(([name, bytes]) => ({
          name,
          size: bytes.length,
          digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        })),
      };
    },
    createRef: async (tag: string, sha: string) => {
      writes.push(`ref:${tag}`);
      refs.set(tag, sha);
      return { ref: `refs/tags/${tag}` };
    },
    createDraft: async (tag: string, _sha: string, body: string) => {
      writes.push(`draft:${tag}`);
      const value = {
        id: 2,
        tag_name: tag,
        draft: true,
        prerelease: false,
        body,
      };
      states.set(tag, value);
      files.set(tag, new Map());
      return value;
    },
    upload: async (_id: number, asset: { name: string }, directory: string) => {
      writes.push(`asset:${asset.name}`);
      const bytes = readFileSync(join(directory, asset.name));
      files.get(plan.publicationTag)!.set(asset.name, Buffer.from(bytes));
      return {
        name: asset.name,
        size: bytes.length,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      };
    },
  };
  const journalPath = join(staged.runnerTemp, 'promotion-journal.json');
  const receiptPath = join(staged.runnerTemp, PROMOTION_RECEIPT_ASSET);
  return {
    ...staged,
    plan,
    refs,
    files,
    states,
    writes,
    github,
    journalPath,
    receiptPath,
  };
}

describe('candidate-to-final artifact transfer through the real promotion owner', () => {
  it('copies every original byte/name to an immutable final draft and binds its lineage', {
    timeout: 240_000,
  }, async () => {
    const f = await promotionFixture();
    const result = await copyCandidateToFinal({
      plan: f.plan,
      assetsDir: f.assets,
      github: f.github,
      journalPath: f.journalPath,
      receiptPath: f.receiptPath,
    });
    expect(result).toEqual({ publicationTag: 'v0.1.11', repairOnly: false });
    expect(f.refs.get('v0.1.11')).toBe(f.env.RELEASE_SHA);
    expect(f.states.get('v0.1.11')).toMatchObject({
      draft: true,
      prerelease: false,
      body: expect.stringContaining('is not Authenticode-signed yet'),
    });
    const transferred = f.files.get('v0.1.11')!;
    expect([...transferred.keys()].sort()).toEqual(
      readdirSync(f.assets).sort(),
    );
    for (const [name, bytes] of transferred)
      expect(bytes).toEqual(readFileSync(join(f.assets, name)));
    const receipt = JSON.parse(readFileSync(f.receiptPath, 'utf8'));
    await expect(
      verifyPromotionReceipt(receipt, {
        publicationTag: 'v0.1.11',
        sourceSha: f.env.RELEASE_SHA,
        assetsDir: f.assets,
      }),
    ).resolves.toMatchObject({ producerTag: TAG, state: 'assets-verified' });
    expect(receipt).toMatchObject({
      policySha: 'c'.repeat(40),
      workflowSha: 'd'.repeat(40),
    });
    expect(
      receipt.assets.find((asset: { name: string }) =>
        asset.name.endsWith('-ios-device.ipa'),
      ).name,
    ).toBe(`station-${TAG}-ios-device.ipa`);
    const published = new Map(transferred);
    published.set(PROMOTION_RECEIPT_ASSET, readFileSync(f.receiptPath));
    const entries = [...published].map(([name, bytes], index) => ({
      id: index + 1,
      name,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      size: bytes.length,
    }));
    const finalRelease = {
      tag_name: 'v0.1.11',
      draft: false,
      prerelease: false,
      published_at: '2026-11-15T00:00:00.000Z',
      assets: entries,
    };
    const addLabel = vi.fn(),
      removeLabel = vi.fn();
    const verifyAttestation = vi.fn(
      async (
        path: string,
        authority: {
          tag?: string;
          sourceRef?: string;
          sourceSha: string;
          workflow: string;
        },
      ) => {
        if (path.endsWith(PROMOTION_RECEIPT_ASSET))
          expect(authority).toEqual({
            sourceRef: 'refs/heads/main',
            sourceSha: 'd'.repeat(40),
            workflow: '.github/workflows/publish-release.yml',
          });
        else
          expect(authority).toEqual({
            tag: TAG,
            sourceSha: f.env.RELEASE_SHA,
            workflow: '.github/workflows/release.yml',
          });
      },
    );
    const api = {
      repository: async () => ({ private: false, default_branch: 'main' }),
      releaseForTag: async () => finalRelease,
      tagSha: async () => f.env.RELEASE_SHA,
      listReleases: async () => [finalRelease],
      downloadAsset: async (id: number) =>
        published.get(entries.find((entry) => entry.id === id)!.name)!,
      verifyPolicyCommit: async (sha: string, branch: string) =>
        branch === 'main' && ['c'.repeat(40), 'd'.repeat(40)].includes(sha),
      verifyAttestation,
      addLabel,
      removeLabel,
    };
    await expect(
      runReleaseAvailability(
        {
          repository: { full_name: REPOSITORY },
          workflow: 'publish-release',
          success: true,
          tag: 'v0.1.11',
          sourceSha: f.env.RELEASE_SHA,
          channel: 'stable',
          allowEmptyBaseline: true,
        },
        { api, updaterPublicKey: f.updaterPublicKey },
      ),
    ).resolves.toMatchObject({
      kind: 'bootstrap-without-labels',
      projected: 0,
    });
    expect(verifyAttestation).toHaveBeenCalledTimes(entries.length);
    expect(addLabel).not.toHaveBeenCalled();
    expect(removeLabel).not.toHaveBeenCalled();
    // The caller authenticates the completed receipt before repair admission.
    f.files.set('v0.1.11', published);
    f.states.set('v0.1.11', {
      ...f.states.get('v0.1.11')!,
      draft: false,
      prerelease: false,
    });
    const writesBeforeRepair = [...f.writes];
    await expect(
      copyCandidateToFinal({
        plan: f.plan,
        assetsDir: f.assets,
        github: f.github,
        journalPath: join(f.runnerTemp, 'repair-journal.json'),
        receiptPath: f.receiptPath,
        repairReceipt: f.receiptPath,
      }),
    ).resolves.toEqual({ publicationTag: 'v0.1.11', repairOnly: true });
    expect(f.writes).toEqual(writesBeforeRepair);
    f.refs.delete('v0.1.11');
    f.states.delete('v0.1.11');
    f.files.delete('v0.1.11');
    await expect(
      copyCandidateToFinal({
        plan: f.plan,
        assetsDir: f.assets,
        github: f.github,
        journalPath: join(f.runnerTemp, 'missing-repair-journal.json'),
        receiptPath: f.receiptPath,
        repairReceipt: f.receiptPath,
      }),
    ).rejects.toThrow('repair destination is missing');
    expect(f.writes).toEqual(writesBeforeRepair);
  });

  it('refuses a same-SHA destination ref without completed attested recovery lineage', {
    timeout: 240_000,
  }, async () => {
    const f = await promotionFixture();
    f.refs.set('v0.1.11', f.env.RELEASE_SHA);
    await expect(
      copyCandidateToFinal({
        plan: f.plan,
        assetsDir: f.assets,
        github: f.github,
        journalPath: f.journalPath,
        receiptPath: f.receiptPath,
      }),
    ).rejects.toThrow('same-SHA ref is not recovery authority');
    expect(f.writes).toEqual([]);
  });

  it('refuses a mismatched remote producer asset before any write', {
    timeout: 240_000,
  }, async () => {
    const f = await promotionFixture();
    const name = [...f.files.get(TAG)!.keys()][0];
    f.files.get(TAG)!.set(name, Buffer.from('substituted producer bytes'));
    await expect(
      copyCandidateToFinal({
        plan: f.plan,
        assetsDir: f.assets,
        github: f.github,
        journalPath: f.journalPath,
        receiptPath: f.receiptPath,
      }),
    ).rejects.toThrow('remote asset bytes differ');
    expect(f.writes).toEqual([]);
  });

  it('retains UNKNOWN after a committed ref loses its response and refuses automatic reapplication', {
    timeout: 240_000,
  }, async () => {
    const f = await promotionFixture();
    const write = f.github.createRef;
    f.github.createRef = async (tag, sha) => {
      await write(tag, sha);
      throw new Error('lost response');
    };
    await expect(
      copyCandidateToFinal({
        plan: f.plan,
        assetsDir: f.assets,
        github: f.github,
        journalPath: f.journalPath,
        receiptPath: f.receiptPath,
      }),
    ).rejects.toThrow('UNKNOWN');
    expect(JSON.parse(readFileSync(f.journalPath, 'utf8'))).toMatchObject({
      state: 'unknown',
      effects: [{ name: 'create-final-ref', state: 'unknown' }],
    });
    await expect(
      copyCandidateToFinal({
        plan: f.plan,
        assetsDir: f.assets,
        github: f.github,
        journalPath: join(f.runnerTemp, 'retry.json'),
        receiptPath: f.receiptPath,
      }),
    ).rejects.toThrow('same-SHA ref is not recovery authority');
    expect(f.writes).toEqual(['ref:v0.1.11']);
  });
});
