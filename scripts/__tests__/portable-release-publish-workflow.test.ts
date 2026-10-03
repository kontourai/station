import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import { PORTABLE_SERVER_TARGETS } from '../../packages/shared/src/portable-server-targets.mjs';
import { STATION_RELEASE_RINGS } from '../../packages/shared/src/release-rings.generated.mjs';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  checkArchives,
  compareRingVersions,
  createDryRunKeys,
  FETCH_TIMEOUT_MS,
  fetchBytes,
  isStaleRollingManifest,
  ManifestMismatchError,
  PORTABLE_LAUNCHER_PROTOCOL,
  parseRingVersion,
  publicationLocations,
  verifyManifestLocation,
  verifyPublishedAssets,
} from '../lib/portable-publication.mjs';
import {
  PUBLIC_MANIFEST_POINTERS,
  PUBLIC_RELEASE_BASE_URL,
  rollingManifestUrl,
} from '../lib/public-release-locations.mjs';
import {
  PORTABLE_LAUNCHER_PROTOCOL as NIGHTLY_LAUNCHER_PROTOCOL,
  NIGHTLY_MANIFEST_ASSET,
  publicationLocations as nightlyPublicationLocations,
  ROLLING_NIGHTLY_TAG,
} from '../portable-nightly-publication.mjs';
import {
  assertReleasePayload,
  planRollingPointer,
  RELEASE_DRY_RUN_KEY_ID,
  RELEASE_SIGNING_KEY_ID,
} from '../portable-release-publication.mjs';
import {
  buildPrebuiltArchive,
  hostTarget,
} from './fixtures/prebuilt-archive.js';

/**
 * #2959: the signed host-stream manifest for tagged stable and preview
 * releases. release.yml assembles and dry-run signs it on every tag;
 * publish-release.yml signs it with the release key and replaces the ring's
 * rolling pointer only behind the owner's gate. These tests read the real
 * workflow graphs, run their shell steps and the real CLIs as children, and
 * pin the one BASE_URL every location derives from.
 */

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  needs?: string | string[];
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: unknown;
  permissions?: Record<string, string>;
  environment?: unknown;
  env?: Record<string, string>;
  steps?: Step[];
};
type Workflow = { jobs: Record<string, Job> };

const repoRoot = resolve(import.meta.dirname, '../..');
const readWorkflow = (name: string) =>
  load(
    readFileSync(join(repoRoot, '.github/workflows', name), 'utf8'),
  ) as Workflow;
const release = readWorkflow('release.yml');
const publish = readWorkflow('publish-release.yml');
const GATE_VARIABLE = 'STATION_PORTABLE_RELEASE_PUBLISH';
const SIGNING_SECRET = 'STATION_PORTABLE_RELEASE_MANIFEST_SIGNING_KEY';
const expr = (inner: string) => `\${{ ${inner} }}`;
const GATE = expr(`vars.${GATE_VARIABLE} == 'enabled'`);
const REPOSITORY = 'kontourai/station';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const NODE_VERSION = JSON.parse(
  readFileSync(
    join(repoRoot, 'config/portable-server-node-runtime.json'),
    'utf8',
  ),
).version as string;

const makeTempDir = trackTempDirs({ lifetime: 'file' });
const scratch = makeTempDir('station-portable-release-');
let scratchCount = 0;
const freshDir = (label: string) => {
  scratchCount += 1;
  const dir = join(scratch, `${label}-${scratchCount}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

function runNode(script: string, args: string[], env = {}) {
  return spawnSync(process.execPath, [join(repoRoot, script), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    windowsHide: true,
    timeout: 60_000,
  });
}

function namedStep(job: Job, name: string): Step {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`missing step ${name}`);
  return step;
}

/**
 * The download-artifact tree the host-manifest job reads: one
 * station-server-<target> directory per build job, each holding the archive
 * and the descriptor the builder writes beside it
 * (scripts/lib/portable-server-archive.mjs describePortableArchive).
 */
function writeArchiveTree(
  ring: 'stable' | 'preview',
  version: string,
  dir = freshDir('archives'),
) {
  mkdirSync(dir, { recursive: true });
  const runtime = STATION_RELEASE_RINGS[ring];
  for (const { os, arch, format } of PORTABLE_SERVER_TARGETS) {
    const target = `${os}-${arch}`;
    const name = `station-server-${target}.${format}`;
    const job = join(dir, `station-server-${target}`);
    mkdirSync(job);
    const bytes = Buffer.from(`host archive ${target} ${version}\n`);
    writeFileSync(join(job, name), bytes);
    const descriptor = {
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
        sha: SHA,
        ref: `v${version}`,
        createdAt: '2026-09-29T00:00:00.000Z',
        channel: runtime.runtimeChannel,
        releaseChannel: ring,
        prerelease: runtime.prerelease,
      },
      unpacked: { bytes: 300_000_000, files: 20_000, longestRelativePath: 180 },
    };
    writeFileSync(
      join(job, `${name}.json`),
      `${JSON.stringify(descriptor, null, 2)}\n`,
    );
  }
  return dir;
}

/** Runs a workflow `run:` body the way GitHub runs a bash step. */
function runStep(
  run: string,
  { cwd, env }: { cwd: string; env: Record<string, string> },
) {
  return spawnSync(
    'bash',
    ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      windowsHide: true,
      timeout: 120_000,
    },
  );
}

/**
 * A `node` on PATH for running workflow bash with a test key table. In
 * `keys` mode every verify that would use the pinned table (no `--keys`) gets
 * `--keys "$SHIM_KEYS"`: the only way to make a throwaway envelope "verify
 * against the pinned table" without the release key, so refusal branches
 * actually run. In `wrong` mode the pinned `ecosystem-manifest.mjs verify`
 * fails for an unrelated reason instead.
 */
function nodeShim(mode: 'keys' | 'wrong' = 'keys') {
  const bin = freshDir('shim');
  writeFileSync(
    join(bin, 'node'),
    [
      '#!/bin/sh',
      'case " $* " in *" --keys "*) exec "$REAL_NODE" "$@" ;; esac',
      'case "$1 $2" in',
      mode === 'wrong'
        ? '  *ecosystem-manifest.mjs\\ verify) echo "ENOENT: unrelated failure" >&2; exit 1 ;;'
        : '  *ecosystem-manifest.mjs\\ verify) exec "$REAL_NODE" "$@" --keys "$SHIM_KEYS" ;;',
      '  *portable-release-publication.mjs\\ verify|*portable-release-publication.mjs\\ pointer-plan)',
      '    exec "$REAL_NODE" "$@" --keys "$SHIM_KEYS" ;;',
      'esac',
      'exec "$REAL_NODE" "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'node'), 0o755);
  return bin;
}

describe('the one BASE_URL every public manifest location derives from', () => {
  it('is the public repository release download base', () => {
    // Literal pin next to the constant: a repoint is a reviewed change here.
    expect(PUBLIC_RELEASE_BASE_URL).toBe(
      'https://github.com/kontourai/station/releases/download/',
    );
    expect(PUBLIC_MANIFEST_POINTERS).toEqual({
      stable: {
        rollingTag: 'portable-stable',
        manifestAsset: 'station-portable-stable-manifest.json',
      },
      preview: {
        rollingTag: 'portable-preview',
        manifestAsset: 'station-portable-preview-manifest.json',
      },
      nightly: {
        rollingTag: 'portable-nightly',
        manifestAsset: 'station-portable-nightly-manifest.json',
      },
    });
    // One pointer per installable ring, and no other.
    expect(Object.keys(PUBLIC_MANIFEST_POINTERS).sort()).toEqual(
      Object.keys(STATION_RELEASE_RINGS).sort(),
    );
  });

  it('gives Nightly byte-identical locations, derived from the constant', () => {
    const nightly = nightlyPublicationLocations(
      REPOSITORY,
      '0.1.11-nightly.245600',
    );
    // The URLs Nightly published before the constant existed.
    expect(nightly).toEqual({
      releaseTag: 'v0.1.11-nightly.245600',
      baseUrl:
        'https://github.com/kontourai/station/releases/download/v0.1.11-nightly.245600/',
      rollingTag: 'portable-nightly',
      manifestAsset: 'station-portable-nightly-manifest.json',
      rollingManifestUrl:
        'https://github.com/kontourai/station/releases/download/portable-nightly/station-portable-nightly-manifest.json',
    });
    expect(nightly.rollingManifestUrl).toBe(rollingManifestUrl('nightly'));
    expect(nightly.baseUrl.startsWith(PUBLIC_RELEASE_BASE_URL)).toBe(true);
    expect(ROLLING_NIGHTLY_TAG).toBe(
      PUBLIC_MANIFEST_POINTERS.nightly.rollingTag,
    );
    expect(NIGHTLY_MANIFEST_ASSET).toBe(
      PUBLIC_MANIFEST_POINTERS.nightly.manifestAsset,
    );
  });

  it('names each release ring its own rolling pointer under the same base', () => {
    expect(publicationLocations('stable', REPOSITORY, '1.2.3')).toEqual({
      releaseTag: 'v1.2.3',
      baseUrl: `${PUBLIC_RELEASE_BASE_URL}v1.2.3/`,
      rollingTag: 'portable-stable',
      manifestAsset: 'station-portable-stable-manifest.json',
      rollingManifestUrl: `${PUBLIC_RELEASE_BASE_URL}portable-stable/station-portable-stable-manifest.json`,
    });
    expect(
      publicationLocations('preview', REPOSITORY, '1.2.3-preview.4')
        .rollingManifestUrl,
    ).toBe(
      `${PUBLIC_RELEASE_BASE_URL}portable-preview/station-portable-preview-manifest.json`,
    );
    const cli = runNode('scripts/portable-release-publication.mjs', [
      'locations',
      '--ring',
      'preview',
      '--repository',
      REPOSITORY,
      '--version',
      '1.2.3-preview.4',
    ]);
    expect(cli.status, cli.stderr).toBe(0);
    expect(cli.stdout.split('\n')).toEqual([
      'release_tag=v1.2.3-preview.4',
      `base_url=${PUBLIC_RELEASE_BASE_URL}v1.2.3-preview.4/`,
      'rolling_tag=portable-preview',
      'manifest_asset=station-portable-preview-manifest.json',
      `versioned_manifest_url=${PUBLIC_RELEASE_BASE_URL}v1.2.3-preview.4/station-portable-preview-manifest.json`,
      `rolling_manifest_url=${PUBLIC_RELEASE_BASE_URL}portable-preview/station-portable-preview-manifest.json`,
      '',
    ]);
  });

  it('reads one launcher protocol range for every ring', () => {
    expect(PORTABLE_LAUNCHER_PROTOCOL).toEqual({ min: 1, max: 1 });
    expect(NIGHTLY_LAUNCHER_PROTOCOL).toBe(PORTABLE_LAUNCHER_PROTOCOL);
  });
});

describe('stable and preview versions under the shared verifier grammar', () => {
  it('parses each ring only in its own shape', () => {
    expect(parseRingVersion('stable', '1.2.3')).toEqual([1n, 2n, 3n]);
    expect(parseRingVersion('preview', '1.2.3-preview.4')).toEqual([
      1n,
      2n,
      3n,
      4n,
    ]);
    for (const [ring, version] of [
      ['stable', '1.2.3-preview.1'],
      ['stable', '01.2.3'],
      ['preview', '1.2.3'],
      ['preview', '1.2.3-preview.0'],
      ['preview', '1.2.3-nightly.4'],
      ['stable', 'v1.2.3'],
    ])
      expect(() => parseRingVersion(ring, version), version).toThrow(
        `is not a ${ring} version`,
      );
    expect(() => parseRingVersion('beta', '1.2.3')).toThrow(
      'beta is not a release ring',
    );
  });

  it('orders numerically, never lexically', () => {
    expect(compareRingVersions('stable', '1.2.9', '1.2.10')).toBe(-1);
    expect(compareRingVersions('stable', '1.10.0', '1.9.99')).toBe(1);
    expect(compareRingVersions('stable', '1.2.3', '1.2.3')).toBe(0);
    expect(
      compareRingVersions('preview', '1.2.3-preview.9', '1.2.3-preview.10'),
    ).toBe(-1);
    expect(
      compareRingVersions('preview', '1.2.4-preview.1', '1.2.3-preview.99'),
    ).toBe(1);
  });

  it('refuses a ring the release key does not publish', () => {
    const cli = runNode('scripts/portable-release-publication.mjs', [
      'locations',
      '--ring',
      'nightly',
      '--repository',
      REPOSITORY,
      '--version',
      '1.2.3-nightly.4',
    ]);
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain('--ring must be stable or preview');
  });
});

/** Assembles through the real assembler, as the release workflow does. */
function assemblePayload(ring: 'stable' | 'preview', version: string) {
  const archives = writeArchiveTree(ring, version);
  const output = join(freshDir('payload'), 'payload.json');
  const result = runNode('scripts/ecosystem-manifest.mjs', [
    'assemble',
    '--descriptors',
    archives,
    '--version',
    version,
    '--channel',
    ring,
    '--source-sha',
    SHA,
    '--base-url',
    publicationLocations(ring, REPOSITORY, version).baseUrl,
    '--node-version',
    NODE_VERSION,
    '--launcher-protocol-min',
    '1',
    '--launcher-protocol-max',
    '1',
    '--published-at',
    '2026-09-29T01:00:00.000Z',
    '--output',
    output,
  ]);
  expect(result.status, result.stderr).toBe(0);
  return {
    archives,
    output,
    payload: JSON.parse(readFileSync(output, 'utf8')),
  };
}

function signWithThrowaway(
  ring: 'stable' | 'preview',
  payloadPath: string,
  keyId = RELEASE_DRY_RUN_KEY_ID,
) {
  const dir = freshDir('keys');
  const { privateKeyPem, keyTable } = createDryRunKeys(ring, keyId);
  writeFileSync(join(dir, 'key.pem'), privateKeyPem, { mode: 0o600 });
  writeFileSync(join(dir, 'keys.json'), JSON.stringify(keyTable));
  const manifest = join(dir, 'manifest.json');
  const created = runNode('scripts/ecosystem-manifest.mjs', [
    'create',
    '--payload',
    payloadPath,
    '--key-id',
    keyId,
    '--private-key',
    join(dir, 'key.pem'),
    '--allow-unpinned-key',
    '--output',
    manifest,
  ]);
  expect(created.status, created.stderr).toBe(0);
  return {
    manifest,
    keysPath: join(dir, 'keys.json'),
    keyTable,
    envelope: JSON.parse(readFileSync(manifest, 'utf8')),
  };
}

/** One throwaway key that signs several payloads, and its key table. */
function keyring(ring: 'stable' | 'preview') {
  const dir = freshDir('keyring');
  const { privateKeyPem, keyTable } = createDryRunKeys(
    ring,
    RELEASE_DRY_RUN_KEY_ID,
  );
  writeFileSync(join(dir, 'key.pem'), privateKeyPem, { mode: 0o600 });
  const keysPath = join(dir, 'keys.json');
  writeFileSync(keysPath, JSON.stringify(keyTable));
  let count = 0;
  return {
    keysPath,
    keyTable,
    sign(payloadPath: string) {
      count += 1;
      const manifest = join(dir, `manifest-${count}.json`);
      const created = runNode('scripts/ecosystem-manifest.mjs', [
        'create',
        '--payload',
        payloadPath,
        '--key-id',
        RELEASE_DRY_RUN_KEY_ID,
        '--private-key',
        join(dir, 'key.pem'),
        '--allow-unpinned-key',
        '--output',
        manifest,
      ]);
      expect(created.status, created.stderr).toBe(0);
      return manifest;
    },
  };
}

describe('publication checks for stable and preview', () => {
  it('plans the rolling pointer: forward, idempotent rerun, never backwards', () => {
    for (const [ring, current, newer, older] of [
      ['stable', '1.2.3', '1.2.4', '1.2.2'],
      ['preview', '1.2.3-preview.4', '1.2.3-preview.5', '1.2.3-preview.3'],
    ] as const) {
      const keys = keyring(ring);
      const served = readFileSync(
        keys.sign(assemblePayload(ring, current).output),
      );
      const signed = (version: string) =>
        readFileSync(keys.sign(assemblePayload(ring, version).output));
      const plan = (
        candidateVersion: string,
        signedBytes: Buffer,
        extra = {},
      ) =>
        planRollingPointer({
          ring,
          candidateVersion,
          currentBytes: served,
          signedBytes,
          keys: keys.keyTable,
          allowEmptyBootstrap: false,
          rollingTag: `portable-${ring}`,
          ...extra,
        });
      expect(plan(newer, signed(newer))).toEqual({
        action: 'replace',
        current,
      });
      // A rerun after the pointer already moved to these exact bytes.
      expect(plan(current, served)).toEqual({ action: 'unchanged', current });
      // An older tag (a desktop rollback) leaves the host pointer alone.
      expect(plan(older, signed(older))).toEqual({
        action: 'skip-older',
        current,
      });
      // The same version with other bytes is refused, never replaced.
      const other = assemblePayload(ring, current);
      const otherPayload = JSON.parse(readFileSync(other.output, 'utf8'));
      otherPayload.publishedAt = '2026-09-30T00:00:00.000Z';
      writeFileSync(other.output, JSON.stringify(otherPayload));
      expect(() =>
        plan(current, readFileSync(keys.sign(other.output))),
      ).toThrow(
        `the rolling ${ring} manifest already names ${current} with different bytes than this run signed; inspect portable-${ring} before re-running`,
      );
      // A served manifest that does not verify is refused, not overwritten.
      expect(() =>
        plan(newer, signed(newer), { keys: keyring(ring).keyTable }),
      ).toThrow('manifest signature did not verify');
      // A validly signed manifest for another version is not this candidate.
      expect(() => plan(newer, signed(older))).toThrow(
        `the signed manifest names ${older}, not the candidate ${newer}`,
      );
      // An empty pointer needs the owner's explicit bootstrap.
      expect(() => plan(newer, signed(newer), { currentBytes: null })).toThrow(
        `the rolling pointer portable-${ring} serves no ${ring} manifest; confirm it is new, then re-run with allow_empty_host_manifest_bootstrap for its first publish only`,
      );
      expect(
        plan(newer, signed(newer), {
          currentBytes: null,
          allowEmptyBootstrap: true,
        }),
      ).toEqual({ action: 'replace', current: null });
    }
  });

  it('plans through the CLI the workflow runs, refusing an empty pointer without bootstrap', () => {
    const keys = keyring('stable');
    const current = keys.sign(assemblePayload('stable', '1.2.3').output);
    const candidate = keys.sign(assemblePayload('stable', '1.2.4').output);
    const run = (location: string, extra: string[] = []) =>
      runNode('scripts/portable-release-publication.mjs', [
        'pointer-plan',
        '--ring',
        'stable',
        '--candidate-version',
        '1.2.4',
        '--current',
        location,
        '--signed',
        candidate,
        '--keys',
        keys.keysPath,
        ...extra,
      ]);
    const forward = run(current);
    expect(forward.status, forward.stderr).toBe(0);
    expect(forward.stdout).toBe('action=replace\n');
    const missing = join(
      freshDir('empty'),
      'station-portable-stable-manifest.json',
    );
    const empty = run(missing, ['--allow-empty-bootstrap', 'false']);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('serves no stable manifest');
    expect(run(missing, ['--allow-empty-bootstrap', 'true']).stdout).toBe(
      'action=replace\n',
    );
    const invalid = run(missing, ['--allow-empty-bootstrap', 'yes']);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain(
      '--allow-empty-bootstrap must be true or false',
    );
    // Against the pinned table the throwaway rolling manifest does not verify.
    const pinned = runNode('scripts/portable-release-publication.mjs', [
      'pointer-plan',
      '--ring',
      'stable',
      '--candidate-version',
      '1.2.4',
      '--current',
      current,
      '--signed',
      candidate,
    ]);
    expect(pinned.status).toBe(1);
    expect(pinned.stderr).toContain(
      `manifest signing key ${RELEASE_DRY_RUN_KEY_ID} is not pinned`,
    );
  });

  it('refuses a corrupted archive byte and a size mismatch', () => {
    const { archives, output, payload } = assemblePayload('stable', '1.2.3');
    expect(checkArchives(payload, archives)).toHaveLength(5);
    const cli = (payloadPath: string) =>
      runNode('scripts/portable-release-publication.mjs', [
        'check-archives',
        '--payload',
        payloadPath,
        '--archives',
        archives,
      ]);
    expect(cli(output).status).toBe(0);
    const path = join(
      archives,
      'station-server-linux-x64',
      'station-server-linux-x64.tar.gz',
    );
    const bytes = readFileSync(path);
    bytes[3] ^= 0x01;
    writeFileSync(path, bytes);
    const flipped = cli(output);
    expect(flipped.status).toBe(1);
    expect(flipped.stderr).toContain(
      'station-server-linux-x64.tar.gz is not the archive the manifest signs',
    );
    bytes[3] ^= 0x01;
    writeFileSync(path, bytes);
    expect(cli(output).status).toBe(0);
    // Same bytes, but a payload claiming another size.
    const resized = structuredClone(payload);
    resized.artifacts[0].size += 1;
    const resizedPath = join(freshDir('resized'), 'payload.json');
    writeFileSync(resizedPath, JSON.stringify(resized));
    const sized = cli(resizedPath);
    expect(sized.status).toBe(1);
    expect(sized.stderr).toContain(
      'station-server-darwin-arm64.tar.gz is not the archive the manifest signs',
    );
  });

  it('fails a GET to a host that never answers within the per-request bound', async () => {
    expect(FETCH_TIMEOUT_MS).toBe(30_000);
    // Accepts the connection and sends headers, then never sends the body.
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-length': '10' });
      response.flushHeaders();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      // Without the bound the GET would wait for undici's own ~300s timeout;
      // the guard turns that into a readable failure instead of a test hang.
      const hung = new Promise<string>((done) => {
        guard = setTimeout(() => done('still waiting after 5s'), 5_000);
      });
      await expect(
        Promise.race([
          fetchBytes(`http://127.0.0.1:${port}/manifest.json`, {
            attempts: 2,
            delayMs: 10,
            timeoutMs: 200,
          }),
          hung,
        ]),
      ).rejects.toThrow(/aborted|timeout/i);
    } finally {
      clearTimeout(guard);
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  });

  it('refuses a re-downloaded archive with the signed size but other bytes', async () => {
    const signed = Buffer.from('station-server archive bytes');
    const url = `${PUBLIC_RELEASE_BASE_URL}v1.2.3/station-server-linux-x64.tar.gz`;
    const payload = {
      artifacts: [
        {
          name: 'station-server-linux-x64.tar.gz',
          url,
          size: signed.length,
          sha256: createHash('sha256').update(signed).digest('hex'),
        },
      ],
    };
    let served = signed;
    const fetchImpl = async () => new Response(served);
    await expect(
      verifyPublishedAssets(payload, { fetchImpl, attempts: 1 }),
    ).resolves.toBeUndefined();
    // One flipped byte: same length, so only the digest can catch it.
    served = Buffer.from(signed);
    served[3] ^= 0x01;
    expect(served.length).toBe(signed.length);
    await expect(
      verifyPublishedAssets(payload, { fetchImpl, attempts: 1 }),
    ).rejects.toThrow(
      `station-server-linux-x64.tar.gz at ${url} is not the archive the manifest signs`,
    );
  });

  it('refuses a manifest whose payload is not the expected one', () => {
    const { output } = assemblePayload('preview', '1.2.3-preview.4');
    const other = assemblePayload('preview', '1.2.3-preview.5');
    const { manifest, keysPath } = signWithThrowaway('preview', other.output);
    const verify = (expected: string) =>
      runNode('scripts/portable-release-publication.mjs', [
        'verify',
        '--ring',
        'preview',
        '--manifest',
        manifest,
        '--keys',
        keysPath,
        '--expected-payload',
        expected,
      ]);
    expect(verify(other.output).status).toBe(0);
    const wrong = verify(output);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain(
      'manifest payload for 1.2.3-preview.5 is not the payload this run signed (1.2.3-preview.4)',
    );
    // A validly signed manifest for the other ring is refused too.
    const stable = runNode('scripts/portable-release-publication.mjs', [
      'verify',
      '--ring',
      'stable',
      '--manifest',
      manifest,
      '--keys',
      keysPath,
      '--expected-payload',
      other.output,
    ]);
    expect(stable.status).toBe(1);
  });

  it('retries a re-verify only while the served manifest is an older version (#3013)', () => {
    const older = new ManifestMismatchError('1.2.2', '1.2.3');
    expect(isStaleRollingManifest('stable', older, { version: '1.2.3' })).toBe(
      true,
    );
    for (const error of [
      new ManifestMismatchError('1.2.3', '1.2.3'),
      new ManifestMismatchError('1.2.4', '1.2.3'),
      new ManifestMismatchError('1.2.3-preview.1', '1.2.3'),
      new Error('manifest signature did not verify'),
    ])
      expect(
        isStaleRollingManifest('stable', error, { version: '1.2.3' }),
        error.message,
      ).toBe(false);
    expect(
      isStaleRollingManifest(
        'preview',
        new ManifestMismatchError('1.2.3-preview.3', '1.2.3-preview.4'),
        { version: '1.2.3-preview.4' },
      ),
    ).toBe(true);
  });

  // The predicate above is only half of #3013: the pointer job's
  // `verify --manifest <https URL>` runs verifyManifestLocation, whose retry
  // loop is taken only for a remote location. The shell-step tests serve the
  // pointer as a local path, so they never reach it.
  describe('the remote re-verify the pointer job runs', () => {
    const keys = keyring('stable');
    const expected = assemblePayload('stable', '1.2.3');
    const bytesFor = (payloadPath: string) =>
      readFileSync(keys.sign(payloadPath));
    const otherBytesSameVersion = () => {
      const path = join(freshDir('same-version'), 'payload.json');
      writeFileSync(
        path,
        JSON.stringify({
          ...expected.payload,
          publishedAt: '2026-09-29T02:00:00.000Z',
        }),
      );
      return bytesFor(path);
    };
    const URL = rollingManifestUrl('stable');

    /** Serves `responses` in order (the last repeats); returns the outcome. */
    async function reverify(responses: Buffer[]) {
      const served: string[] = [];
      vi.useFakeTimers();
      vi.stubGlobal('fetch', async (url: string) => {
        served.push(url);
        const body = responses[Math.min(served.length, responses.length) - 1];
        return new Response(new Uint8Array(body), { status: 200 });
      });
      try {
        const settled = verifyManifestLocation(
          'stable',
          URL,
          keys.keyTable,
          expected.payload,
        ).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        await vi.runAllTimersAsync();
        return { result: await settled, fetches: served.length, served };
      } finally {
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    }

    it("waits out an older cached manifest, then accepts this run's bytes", async () => {
      const older = bytesFor(assemblePayload('stable', '1.2.2').output);
      const { result, fetches, served } = await reverify([
        older,
        older,
        bytesFor(expected.output),
      ]);
      expect(result.ok, String(!result.ok && result.error)).toBe(true);
      expect(fetches).toBe(3);
      expect(new Set(served)).toEqual(new Set([URL]));
    });

    it('fails at once, without retrying, on the same version with other bytes or a newer version', async () => {
      for (const [label, bytes, fetched] of [
        ['same version, other bytes', otherBytesSameVersion(), '1.2.3'],
        [
          'newer version',
          bytesFor(assemblePayload('stable', '1.2.4').output),
          '1.2.4',
        ],
      ] as const) {
        const { result, fetches } = await reverify([
          bytes,
          bytesFor(expected.output),
        ]);
        expect(result.ok, label).toBe(false);
        expect(!result.ok && result.error, label).toBeInstanceOf(
          ManifestMismatchError,
        );
        expect(String(!result.ok && result.error), label).toContain(
          `manifest payload for ${fetched} is not the payload this run signed (1.2.3)`,
        );
        expect(fetches, label).toBe(1);
      }
    });

    it('gives up on staleness that outlasts the bounded wait', async () => {
      const older = bytesFor(assemblePayload('stable', '1.2.2').output);
      const { result, fetches } = await reverify([older]);
      expect(result.ok).toBe(false);
      expect(String(!result.ok && result.error)).toContain(
        'manifest payload for 1.2.2 is not the payload this run signed (1.2.3)',
      );
      // REVERIFY_ATTEMPTS (30) reads, ten seconds apart: five minutes.
      expect(fetches).toBe(30);
    });
  });

  it("binds the payload to this release's versioned assets under the BASE_URL", () => {
    const { payload } = assemblePayload('stable', '1.2.3');
    const expected = {
      repository: REPOSITORY,
      version: '1.2.3',
      sourceSha: SHA,
    };
    expect(assertReleasePayload('stable', payload, expected)).toBe(payload);
    const moved = structuredClone(payload);
    moved.artifacts[2].url = moved.artifacts[2].url.replace(
      '/v1.2.3/',
      '/portable-stable/',
    );
    expect(() => assertReleasePayload('stable', moved, expected)).toThrow(
      "payload is not this release's stable host build: station-server-linux-arm64.tar.gz url",
    );
    expect(() =>
      assertReleasePayload('stable', payload, {
        ...expected,
        version: '1.2.4',
      }),
    ).toThrow('version 1.2.3 (expected 1.2.4)');
    expect(() => assertReleasePayload('preview', payload, expected)).toThrow(
      'is not a preview version',
    );
  });
});

describe('release.yml builds and dry-runs the host stream on every tag', () => {
  const archives = release.jobs['host-archives'];
  const manifest = release.jobs['host-manifest'];

  it("builds the tag's ring through the reusable archive workflow, read-only", () => {
    expect(archives.uses).toBe(
      './.github/workflows/portable-server-archives.yml',
    );
    expect(archives.with).toEqual({
      ref: expr('needs.preflight.outputs.sha'),
      version: expr('needs.preflight.outputs.version'),
      ring: expr('needs.preflight.outputs.channel'),
    });
    expect(archives.needs).toEqual(['preflight', 'full-regression']);
    expect(archives.permissions).toEqual({ contents: 'read' });
    expect(archives.secrets).toBeUndefined();
  });

  it('holds no write token and no secret, and signs only with a throwaway key', () => {
    expect(manifest.permissions).toEqual({
      contents: 'read',
      'id-token': 'write',
      attestations: 'write',
    });
    expect(JSON.stringify(manifest)).not.toMatch(
      /\bsecrets\.|github\.token|GITHUB_TOKEN|GH_TOKEN/,
    );
    for (const step of manifest.steps ?? []) {
      expect(step.run ?? '', step.name).not.toMatch(/gh release|gh api/);
      if ((step.run ?? '').includes('ecosystem-manifest.mjs create'))
        expect(step.run).toContain(
          `--key-id ${RELEASE_DRY_RUN_KEY_ID} --private-key "$keys/dry-run-private-key.pem" --allow-unpinned-key`,
        );
    }
    expect(JSON.stringify(manifest)).not.toContain(RELEASE_SIGNING_KEY_ID);
  });

  it('assembles every target with the shared launcher protocol range', () => {
    const assemble = namedStep(
      manifest,
      'Assemble the schema v2 payload from the archive descriptors',
    );
    expect(assemble.run).toContain(
      'from "./scripts/lib/portable-publication.mjs"',
    );
    expect(assemble.run).toContain('--channel "$RELEASE_RING"');
    expect(assemble.run).not.toMatch(/--allow-partial|--targets/);
    expect(assemble.run).not.toMatch(/--launcher-protocol-(min|max) [0-9]/);
  });

  it('stages the archives and payload through the existing draft assembly', () => {
    const staged = manifest.steps ?? [];
    const attest = staged.findIndex((step) =>
      step.uses?.startsWith('actions/attest-build-provenance@'),
    );
    const upload = staged.findIndex((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(attest).toBeGreaterThan(-1);
    expect(staged[attest].with).toEqual({ 'subject-path': 'release-assets/*' });
    expect(upload).toBe(attest + 1);
    expect(staged[upload].with).toMatchObject({ path: 'release-assets' });
    const assembleDraft = release.jobs['assemble-draft'];
    expect(assembleDraft.needs).toContain('host-manifest');
    expect(assembleDraft.if).toContain(
      "needs.host-manifest.result == 'success'",
    );
  });

  describe.skipIf(process.platform === 'win32')('its shell steps', () => {
    function runReleaseSteps(
      ring: 'stable' | 'preview',
      version: string,
      shim?: string,
    ) {
      // shim: a nodeShim() directory, or undefined for the real node.
      const runnerTemp = freshDir('runner');
      // download-artifact lays the station-server-* artifacts out here.
      writeArchiveTree(ring, version, join(runnerTemp, 'archives'));
      const env: Record<string, string> = {
        RUNNER_TEMP: runnerTemp,
        RELEASE_RING: ring,
        RELEASE_VERSION: version,
        RELEASE_SHA: SHA,
        GITHUB_REPOSITORY: REPOSITORY,
        BASE_URL: publicationLocations(ring, REPOSITORY, version).baseUrl,
      };
      const assembled = runStep(
        namedStep(
          manifest,
          'Assemble the schema v2 payload from the archive descriptors',
        ).run ?? '',
        { cwd: repoRoot, env },
      );
      expect(assembled.status, assembled.stderr).toBe(0);
      const signEnv = shim
        ? {
            ...env,
            PATH: `${shim}:${process.env.PATH ?? ''}`,
            REAL_NODE: process.execPath,
            SHIM_KEYS: join(runnerTemp, 'dry-run-keys', 'dry-run-keys.json'),
          }
        : env;
      const signed = runStep(
        namedStep(manifest, 'Sign with a throwaway key and verify').run ?? '',
        { cwd: repoRoot, env: signEnv },
      );
      return { runnerTemp, signed };
    }

    it('assembles, dry-run signs and verifies a stable and a preview payload', () => {
      for (const [ring, version] of [
        ['stable', '1.2.3'],
        ['preview', '1.2.3-preview.4'],
      ] as const) {
        const { runnerTemp, signed } = runReleaseSteps(ring, version);
        expect(signed.status, signed.stderr).toBe(0);
        expect(signed.stdout).toContain(
          `verified ${version} (${RELEASE_DRY_RUN_KEY_ID})`,
        );
        const payload = JSON.parse(
          readFileSync(
            join(runnerTemp, 'host-publication/payload.json'),
            'utf8',
          ),
        );
        expect(payload).toMatchObject({
          channel: ring,
          version,
          releaseTag: `v${version}`,
          launcherProtocol: PORTABLE_LAUNCHER_PROTOCOL,
          nodeVersion: NODE_VERSION,
        });
        expect(payload.artifacts).toHaveLength(PORTABLE_SERVER_TARGETS.length);
      }
    });

    it('fails the dry run if the throwaway envelope ever verifies against the pinned table', () => {
      const { signed } = runReleaseSteps('stable', '1.2.3', nodeShim());
      expect(signed.status).toBe(1);
      expect(signed.stderr).toContain(
        'the dry-run manifest verified against the pinned key table',
      );
    });

    it('fails the dry run when the pinned-key check fails for any other reason', () => {
      const { signed } = runReleaseSteps('stable', '1.2.3', nodeShim('wrong'));
      expect(signed.status).toBe(1);
      expect(signed.stderr).toContain(
        'the pinned-key check refused the dry-run manifest for an unexpected reason:',
      );
      expect(signed.stderr).toContain('ENOENT: unrelated failure');
    });
  });
});

/** Top-level `&&` conjuncts of a `${{ }}` expression. */
function conjuncts(expression: string): string[] {
  return expression
    .trim()
    .replace(/^\$\{\{|\}\}$/g, '')
    .split('&&')
    .map((part) => part.trim());
}

/** Evaluates a gate made only of `vars.X == 'literal'` conjuncts. */
function gateAllows(expression: string, vars: Record<string, string>) {
  return conjuncts(expression).every((part) => {
    const match = part.match(/^vars\.([A-Z_]+) == '([^']*)'$/);
    if (!match) throw new Error(`unrecognised gate conjunct: ${part}`);
    return (vars[match[1]] ?? '') === match[2];
  });
}

/** A step that changes the host stream's public state or signs with the release key. */
function isHostEffect(step: Step): boolean {
  const run = step.run ?? '';
  return (
    (/gh release (create|upload|edit|delete)/.test(run) &&
      run.includes('host-manifest/')) ||
    (run.includes('ecosystem-manifest.mjs create') &&
      !run.includes('--allow-unpinned-key'))
  );
}

describe('publish-release.yml signs and moves the host pointer only behind the owner gate', () => {
  const job = publish.jobs.publish;
  const pointerJob = publish.jobs['host-pointer'] as Job & {
    outputs?: unknown;
  };
  const steps = job.steps ?? [];
  const pointerSteps = pointerJob.steps ?? [];
  const index = (list: Step[], name: string) => {
    const found = list.findIndex((step) => step.name === name);
    expect(found, name).toBeGreaterThanOrEqual(0);
    return found;
  };
  const PLAN = 'Plan the rolling host-stream pointer';
  const REPLACE =
    'Replace the rolling host-stream manifest (last) and re-verify it';
  const UNCHANGED =
    'Re-verify the unchanged rolling host-stream manifest with the pinned key';
  const FETCH =
    'Fetch the signed host-stream manifest and payload from the versioned release';
  const VERIFY_FETCHED =
    'Verify the fetched host-stream manifest with the pinned key table';
  const CHECK_FETCHED = "Confirm the fetched payload is this run's release";

  it('gates every signing and host publication step on the literal owner variable', () => {
    const gated = steps.filter((step) => step.if?.includes(GATE_VARIABLE));
    expect(gated.map((step) => step.name)).toEqual([
      'Sign the host-stream manifest with the pinned release key',
      'Verify the signed host-stream manifest with the pinned key table',
      "Require the owner's rolling host-stream pointer release",
      PLAN,
      'Attach the signed host-stream manifest to the versioned release',
    ]);
    for (const step of gated) expect(step.if, step.name).toBe(GATE);
    // The pointer job carries the same literal as a top-level conjunct.
    expect(conjuncts(pointerJob.if ?? '')).toEqual([
      '!cancelled()',
      `vars.${GATE_VARIABLE} == 'enabled'`,
      "needs.resolve.result == 'success'",
      "needs.publish.outputs.released == 'true'",
    ]);
    expect(pointerJob.needs).toEqual(['resolve', 'publish']);
    const effects = [...steps, ...pointerSteps].filter(isHostEffect);
    expect(effects.map((step) => step.name)).toEqual([
      'Sign the host-stream manifest with the pinned release key',
      'Attach the signed host-stream manifest to the versioned release',
      REPLACE,
    ]);
    for (const step of steps.filter(isHostEffect))
      expect(step.if, step.name).toBe(GATE);
    for (const value of [undefined, '', 'true', 'Enabled', 'enabled ', 'on'])
      expect(
        gateAllows(GATE, value === undefined ? {} : { [GATE_VARIABLE]: value }),
        String(value),
      ).toBe(false);
    expect(gateAllows(GATE, { [GATE_VARIABLE]: 'enabled' })).toBe(true);
  });

  it('reads the release signing secret in one gated step of the protected publish job', () => {
    expect(job.environment).toBe('native-release-publish');
    expect(job.permissions?.contents).toBe('write');
    for (const [id, other] of Object.entries(publish.jobs))
      if (id !== 'publish')
        expect(JSON.stringify(other), id).not.toContain(SIGNING_SECRET);
    const secretSteps = steps.filter((step) =>
      JSON.stringify(step).includes(SIGNING_SECRET),
    );
    expect(secretSteps.map((step) => step.name)).toEqual([
      'Sign the host-stream manifest with the pinned release key',
    ]);
    expect(secretSteps[0].env).toEqual({
      SIGNING_KEY: expr(`secrets.${SIGNING_SECRET}`),
      MANIFEST_ASSET: expr('steps.host_plan.outputs.manifest_asset'),
    });
    expect(secretSteps[0].run).toContain(`--key-id ${RELEASE_SIGNING_KEY_ID}`);
    expect(JSON.stringify(pointerJob)).not.toMatch(/\bsecrets\./);
    expect(pointerJob.permissions).toEqual({ contents: 'write' });
    expect(JSON.stringify(release)).not.toContain(SIGNING_SECRET);
  });

  /** Evaluates host-pointer's `if:` for a scenario; only its own shapes. */
  function pointerJobRuns(scenario: {
    gate: string;
    resolve: string;
    released: string;
    cancelled?: boolean;
  }) {
    return conjuncts(pointerJob.if ?? '').every((part) => {
      if (part === '!cancelled()') return scenario.cancelled !== true;
      const known: Record<string, string> = {
        [`vars.${GATE_VARIABLE}`]: scenario.gate,
        'needs.resolve.result': scenario.resolve,
        'needs.publish.outputs.released': scenario.released,
      };
      const match = part.match(/^(\S+) == '([^']*)'$/);
      if (!match || !(match[1] in known))
        throw new Error(`unrecognised conjunct: ${part}`);
      return known[match[1]] === match[2];
    });
  }

  it('runs the pointer job once the release is public, even if a later publish step failed', () => {
    const enabled = { gate: 'enabled', resolve: 'success', released: 'true' };
    // publish's result is not an input: a ledger failure after publication
    // (publish = failure, released = true) still moves the host pointer.
    expect(pointerJobRuns(enabled)).toBe(true);
    for (const scenario of [
      { ...enabled, gate: '' },
      { ...enabled, gate: 'true' },
      { ...enabled, resolve: 'failure' },
      // publish failed or was skipped before the release became public.
      { ...enabled, released: '' },
      // The owner cancelled the run, even after the release became public.
      { ...enabled, cancelled: true },
    ])
      expect(pointerJobRuns(scenario), JSON.stringify(scenario)).toBe(false);
    // `released` is written only by its own step, after the release is
    // public and the desktop pointer verified, and before the ledger.
    expect((job as { outputs?: Record<string, string> }).outputs).toEqual({
      released: expr('steps.released.outputs.released'),
    });
    const released = index(steps, 'Record that the release is public');
    expect(steps[released]).toMatchObject({
      id: 'released',
      run: `echo 'released=true' >> "$GITHUB_OUTPUT"`,
    });
    expect(steps[released].if).toBeUndefined();
    for (const [position, step] of steps.entries())
      if (position !== released)
        expect(step.run ?? '', step.name).not.toContain('released=');
    expect(released).toBeGreaterThan(
      index(
        steps,
        'Publish release and compensate to draft until feed verifies',
      ),
    );
    expect(released).toBe(
      index(steps, 'Publish and verify the rolling desktop updater channel') +
        1,
    );
    for (const ledger of [
      'Mint the ledger push token',
      'Record the stable release in the deploy ledger',
    ])
      expect(index(steps, ledger)).toBeGreaterThan(released);
  });

  it('never lets a host-pointer failure skip the ledger or release availability', () => {
    // Only the pointer job writes the rolling pointer, after publish.
    for (const step of steps)
      expect(step.run ?? '', step.name).not.toMatch(
        /gh release (upload|create|edit|delete)[^\n]*"\$ROLLING_TAG"/,
      );
    const availability = publish.jobs['release-availability'];
    expect(availability.needs).toEqual(['resolve', 'publish']);
    expect(JSON.stringify(availability.if)).not.toContain('host-pointer');
    expect(
      index(steps, 'Record the stable release in the deploy ledger'),
    ).toBeGreaterThan(-1);
  });

  it('attaches the versioned manifest before publication and moves the pointer last', () => {
    const order = [
      'Plan the host-stream manifest publication',
      'Dry-run sign the host-stream manifest with a throwaway key',
      'Sign the host-stream manifest with the pinned release key',
      'Verify the signed host-stream manifest with the pinned key table',
      "Require the owner's rolling host-stream pointer release",
      PLAN,
      'Attach the signed host-stream manifest to the versioned release',
      'Publish release and compensate to draft until feed verifies',
    ].map((name) => index(steps, name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // No artifact hand-over: the job reads the public versioned release.
    expect(JSON.stringify(pointerJob)).not.toMatch(/-artifact@/);
    for (const step of steps)
      if (step.uses?.startsWith('actions/upload-artifact@'))
        expect(JSON.stringify(step), step.name).not.toContain('host-manifest');
    const pointerOrder = [
      FETCH,
      CHECK_FETCHED,
      VERIFY_FETCHED,
      'Re-download the versioned host-stream assets and compare them with the manifest',
      PLAN,
      REPLACE,
      UNCHANGED,
    ].map((name) => index(pointerSteps, name));
    expect(pointerOrder).toEqual([...pointerOrder].sort((a, b) => a - b));
    // Nothing after the replacement writes anything.
    for (const step of pointerSteps.slice(index(pointerSteps, REPLACE) + 1))
      expect(step.run ?? '', step.name).not.toMatch(/gh release/);
    const replace = pointerSteps[index(pointerSteps, REPLACE)];
    expect(replace.if).toBe(
      expr("steps.host_pointer.outputs.action == 'replace'"),
    );
    expect(pointerSteps[index(pointerSteps, UNCHANGED)].if).toBe(
      expr("steps.host_pointer.outputs.action == 'unchanged'"),
    );
    // Re-verification is pinned-key only.
    for (const name of [VERIFY_FETCHED, REPLACE, UNCHANGED])
      expect(pointerSteps[index(pointerSteps, name)].run).not.toMatch(
        /--keys|--public-key/,
      );
    // Both plans honor the owner's bootstrap input.
    const inputs = (
      load(
        readFileSync(
          join(repoRoot, '.github/workflows/publish-release.yml'),
          'utf8',
        ),
      ) as { on: { workflow_dispatch: { inputs: Record<string, unknown> } } }
    ).on.workflow_dispatch.inputs;
    expect(inputs.allow_empty_host_manifest_bootstrap).toMatchObject({
      required: false,
      default: false,
      type: 'boolean',
    });
    for (const list of [steps, pointerSteps])
      expect(
        list[index(list, PLAN)].env?.ALLOW_EMPTY_HOST_MANIFEST_BOOTSTRAP,
      ).toBe(expr('inputs.allow_empty_host_manifest_bootstrap'));
    // The replacement re-plans against the release's own bytes.
    expect(replace.env?.ALLOW_EMPTY_HOST_MANIFEST_BOOTSTRAP).toBe(
      expr('inputs.allow_empty_host_manifest_bootstrap'),
    );
  });

  it('checks the staged payload and archives before any signing', () => {
    const plan = namedStep(job, 'Plan the host-stream manifest publication');
    expect(plan.if).toBeUndefined();
    expect(plan.run).toContain(
      'check-payload --ring "$RELEASE_RING" --payload "$payload" --version "$RELEASE_VERSION" --source-sha "$RELEASE_SHA" --repository "$GITHUB_REPOSITORY"',
    );
    expect(plan.run).toContain(
      'check-archives --payload "$payload" --archives release-assets',
    );
    const provenance = namedStep(
      job,
      'Verify GitHub provenance for every downloaded asset',
    );
    expect(provenance.run).toContain(
      'host_manifest=$(node release-policy/scripts/portable-release-publication.mjs manifest-asset --ring "$RELEASE_RING")',
    );
    expect(provenance.run).toContain(
      'if [ "$(basename "$asset")" = "$host_manifest" ]; then continue; fi',
    );
    expect(
      index(steps, 'Download and revalidate every staged release asset'),
    ).toBeLessThan(
      index(steps, 'Verify GitHub provenance for every downloaded asset'),
    );
  });

  describe.skipIf(process.platform === 'win32')('its shell steps', () => {
    /** A publish job workspace: release-policy/ and the staged payload. */
    function workspace(ring: 'stable' | 'preview', version: string) {
      const cwd = freshDir('publish');
      symlinkSync(repoRoot, join(cwd, 'release-policy'));
      const { output } = assemblePayload(ring, version);
      mkdirSync(join(cwd, 'release-assets'));
      writeFileSync(
        join(cwd, 'release-assets', 'station-server-manifest-payload.json'),
        readFileSync(output),
      );
      const runnerTemp = freshDir('runner');
      return {
        cwd,
        payload: output,
        env: {
          RUNNER_TEMP: runnerTemp,
          RELEASE_TAG: `v${version}`,
          RELEASE_RING: ring,
          RELEASE_VERSION: version,
          GITHUB_REPOSITORY: REPOSITORY,
        } as Record<string, string>,
      };
    }

    const dryRunName =
      'Dry-run sign the host-stream manifest with a throwaway key';

    it('dry-runs without any secret and never verifies against the pinned table', () => {
      const dryRun = namedStep(job, dryRunName).run ?? '';
      const ok = workspace('preview', '1.2.3-preview.4');
      const passed = runStep(dryRun, ok);
      expect(passed.status, passed.stderr).toBe(0);
      expect(passed.stdout).toContain(
        `verified 1.2.3-preview.4 (${RELEASE_DRY_RUN_KEY_ID})`,
      );
      for (const [mode, message] of [
        [
          'keys',
          'the dry-run host manifest verified against the pinned key table',
        ],
        [
          'wrong',
          'the pinned-key check refused the dry-run host manifest for an unexpected reason:',
        ],
      ] as const) {
        const refused = workspace('stable', '1.2.3');
        const shimmed = runStep(dryRun, {
          cwd: refused.cwd,
          env: {
            ...refused.env,
            PATH: `${nodeShim(mode)}:${process.env.PATH ?? ''}`,
            REAL_NODE: process.execPath,
            SHIM_KEYS: join(
              refused.env.RUNNER_TEMP,
              'host-dry-run',
              'dry-run-keys.json',
            ),
          },
        });
        expect(shimmed.status, mode).toBe(1);
        expect(shimmed.stderr, mode).toContain(message);
      }
    });

    it('fails closed with a readable error when the gate is on but the secret is absent', () => {
      const sign =
        namedStep(
          job,
          'Sign the host-stream manifest with the pinned release key',
        ).run ?? '';
      const { cwd, env } = workspace('stable', '1.2.3');
      const result = runStep(sign, {
        cwd,
        env: {
          ...env,
          SIGNING_KEY: '',
          MANIFEST_ASSET: 'station-portable-stable-manifest.json',
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `${GATE_VARIABLE} is enabled, but ${SIGNING_SECRET} is not available in the native-release-publish environment`,
      );
    });

    const ASSET = 'station-portable-stable-manifest.json';

    /**
     * The pointer job's workspace: a fake `gh` whose releases are
     * directories, the public versioned release (signed manifest and payload)
     * and the rolling pointer (served as a file the scripts read). The job's
     * own fetch step is run first unless `fetch` is false.
     */
    function pointerWorkspace(
      candidate: string,
      served: string | null,
      options: {
        corruptUpload?: boolean;
        failUpload?: boolean;
        fetch?: boolean;
        /** Serve another version's validly signed manifest and payload. */
        swapTo?: string;
        /**
         * The cacheable download URL the plan reads serves this older,
         * validly signed version while the release itself holds `served`.
         */
        staleCopy?: string;
      } = {},
    ) {
      const keys = keyring('stable');
      const base = workspace('stable', candidate);
      const servedPayload = options.swapTo
        ? assemblePayload('stable', options.swapTo).output
        : base.payload;
      const signed = keys.sign(servedPayload);
      const releases = freshDir('releases');
      const versioned = join(releases, `v${candidate}`);
      mkdirSync(versioned);
      writeFileSync(join(versioned, ASSET), readFileSync(signed));
      writeFileSync(
        join(versioned, 'station-server-manifest-payload.json'),
        readFileSync(servedPayload),
      );
      const rolling = join(releases, 'portable-stable');
      mkdirSync(rolling);
      if (served === 'same')
        writeFileSync(join(rolling, ASSET), readFileSync(signed));
      else if (served !== null)
        writeFileSync(
          join(rolling, ASSET),
          readFileSync(keys.sign(assemblePayload('stable', served).output)),
        );
      let planReads = join(rolling, ASSET);
      if (options.staleCopy !== undefined) {
        planReads = join(freshDir('cdn'), ASSET);
        writeFileSync(
          planReads,
          readFileSync(
            keys.sign(assemblePayload('stable', options.staleCopy).output),
          ),
        );
      }
      const bin = freshDir('gh');
      writeFileSync(
        join(bin, 'gh'),
        [
          '#!/bin/sh',
          '[ "$1" = release ] || exit 97',
          'sub=$2; tag=$3; shift 3',
          'dir="$FAKE_RELEASES/$tag"',
          'echo "$sub $tag $*" >> "$FAKE_RELEASES/.log"',
          'case "$sub" in',
          '  view) ls "$dir" ;;',
          '  download)',
          '    patterns=""',
          '    while [ $# -gt 0 ]; do case "$1" in --dir) out=$2; shift ;; --pattern) patterns="$patterns $2"; shift ;; esac; shift; done',
          '    for pattern in $patterns; do cp "$dir/$pattern" "$out/$pattern" || exit 1; done ;;',
          '  upload)',
          '    for arg in "$@"; do case "$arg" in --*|"$GITHUB_REPOSITORY") ;; *) file=$arg ;; esac; done',
          '    name=$(basename "$file")',
          '    if [ -n "$FAKE_GH_FAIL_FIRST_UPLOAD" ] && [ ! -e "$FAKE_RELEASES/.failed" ]; then',
          '      touch "$FAKE_RELEASES/.failed"; echo "HTTP 502" >&2; exit 1',
          '    elif [ -n "$FAKE_GH_CORRUPT_FIRST_UPLOAD" ] && [ ! -e "$FAKE_RELEASES/.corrupted" ]; then',
          '      printf "{}" > "$dir/$name"; touch "$FAKE_RELEASES/.corrupted"',
          '    else cp "$file" "$dir/$name"; fi ;;',
          '  delete-asset) rm -f "$dir/$1" ;;',
          '  *) exit 98 ;;',
          'esac',
          '',
        ].join('\n'),
      );
      chmodSync(join(bin, 'gh'), 0o755);
      const output = join(base.env.RUNNER_TEMP, 'github-output');
      const summary = join(base.env.RUNNER_TEMP, 'step-summary');
      writeFileSync(output, '');
      writeFileSync(summary, '');
      const ws = {
        cwd: base.cwd,
        signed,
        versioned,
        rollingFile: join(rolling, ASSET),
        releases,
        output,
        summary,
        env: {
          ...base.env,
          RELEASE_SHA: SHA,
          PATH: `${bin}:${nodeShim()}:${process.env.PATH ?? ''}`,
          REAL_NODE: process.execPath,
          SHIM_KEYS: keys.keysPath,
          FAKE_RELEASES: releases,
          ...(options.corruptUpload
            ? { FAKE_GH_CORRUPT_FIRST_UPLOAD: '1' }
            : {}),
          ...(options.failUpload ? { FAKE_GH_FAIL_FIRST_UPLOAD: '1' } : {}),
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          ROLLING_TAG: 'portable-stable',
          MANIFEST_ASSET: ASSET,
          ROLLING_MANIFEST_URL: planReads,
          ALLOW_EMPTY_HOST_MANIFEST_BOOTSTRAP: 'false',
        } as Record<string, string>,
      };
      if (options.fetch !== false) {
        const fetched = runStep(
          pointerSteps[index(pointerSteps, FETCH)].run ?? '',
          ws,
        );
        expect(fetched.status, fetched.stderr).toBe(0);
      }
      return ws;
    }

    const stepRun = (name: string) =>
      pointerSteps[index(pointerSteps, name)].run ?? '';

    it('plans a rerun as unchanged and re-verifies without replacing', () => {
      const ws = pointerWorkspace('1.2.3', 'same');
      const plan = runStep(stepRun(PLAN), ws);
      expect(plan.status, plan.stderr).toBe(0);
      expect(readFileSync(ws.output, 'utf8')).toBe('action=unchanged\n');
      const reverify = runStep(stepRun(UNCHANGED), ws);
      expect(reverify.status, reverify.stderr).toBe(0);
      expect(reverify.stdout).toContain('verified 1.2.3');
      // The publish job's own plan step is the same script: a rerun passes it.
      const publishPlan = runStep(steps[index(steps, PLAN)].run ?? '', ws);
      expect(publishPlan.status, publishPlan.stderr).toBe(0);
    });

    it('leaves the pointer alone for an older tag (a desktop rollback) with a warning', () => {
      const ws = pointerWorkspace('1.2.2', '1.2.3');
      const before = readFileSync(ws.rollingFile);
      for (const run of [stepRun(PLAN), steps[index(steps, PLAN)].run ?? '']) {
        writeFileSync(ws.output, '');
        const plan = runStep(run, ws);
        expect(plan.status, plan.stderr).toBe(0);
        expect(readFileSync(ws.output, 'utf8')).toBe('action=skip-older\n');
        expect(plan.stdout).toContain(
          '::warning::v1.2.2 is older than the rolling stable host-stream manifest; the host pointer never moves backwards',
        );
        expect(readFileSync(ws.summary, 'utf8')).toContain(
          'v1.2.2 is older than the rolling stable host-stream manifest',
        );
        writeFileSync(ws.summary, '');
      }
      expect(readFileSync(ws.rollingFile)).toEqual(before);
    });

    it('refuses an empty pointer unless the owner bootstraps it', () => {
      const ws = pointerWorkspace('1.2.3', null);
      const refused = runStep(stepRun(PLAN), ws);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(
        'the rolling pointer portable-stable serves no stable manifest',
      );
      const allowed = runStep(stepRun(PLAN), {
        cwd: ws.cwd,
        env: { ...ws.env, ALLOW_EMPTY_HOST_MANIFEST_BOOTSTRAP: 'true' },
      });
      expect(allowed.status, allowed.stderr).toBe(0);
      expect(readFileSync(ws.output, 'utf8')).toBe('action=replace\n');
    });

    it('replaces a newer version and re-verifies it', () => {
      const ws = pointerWorkspace('1.2.4', '1.2.3');
      const plan = runStep(stepRun(PLAN), ws);
      expect(readFileSync(ws.output, 'utf8'), plan.stderr).toBe(
        'action=replace\n',
      );
      const replaced = runStep(stepRun(REPLACE), ws);
      expect(replaced.status, replaced.stderr).toBe(0);
      expect(readFileSync(ws.rollingFile)).toEqual(readFileSync(ws.signed));
      expect(replaced.stdout).toContain('verified 1.2.4');
    });

    it('never clobbers a newer pointer when the plan read a stale cached copy', () => {
      // The release holds 1.3.0; the cached URL the plan reads still serves
      // 1.2.0, so the plan says replace for the older candidate 1.2.5.
      const ws = pointerWorkspace('1.2.5', '1.3.0', { staleCopy: '1.2.0' });
      const before = readFileSync(ws.rollingFile);
      const plan = runStep(stepRun(PLAN), ws);
      expect(readFileSync(ws.output, 'utf8'), plan.stderr).toBe(
        'action=replace\n',
      );
      const replaced = runStep(stepRun(REPLACE), ws);
      // No upload at all: not a clobber followed by a restore.
      expect(readFileSync(join(ws.releases, '.log'), 'utf8')).not.toMatch(
        /^upload /m,
      );
      expect(replaced.status, replaced.stderr).toBe(0);
      expect(replaced.stdout).toContain(
        '::warning::v1.2.5 is older than the manifest portable-stable holds now (the plan read a stale copy)',
      );
      expect(readFileSync(ws.rollingFile)).toEqual(before);
    });

    it('refuses to clobber when the release holds the same version with other bytes', () => {
      const ws = pointerWorkspace('1.2.4', 'same', { staleCopy: '1.2.3' });
      // The same validly signed envelope, serialized differently.
      writeFileSync(
        ws.rollingFile,
        JSON.stringify(
          JSON.parse(readFileSync(ws.rollingFile, 'utf8')),
          null,
          1,
        ),
      );
      const before = readFileSync(ws.rollingFile);
      expect(before).not.toEqual(readFileSync(ws.signed));
      const replaced = runStep(stepRun(REPLACE), ws);
      // No upload at all: not a clobber followed by a restore.
      expect(readFileSync(join(ws.releases, '.log'), 'utf8')).not.toMatch(
        /^upload /m,
      );
      expect(replaced.status).toBe(1);
      expect(replaced.stderr).toContain(
        'the rolling stable manifest already names 1.2.4 with different bytes than this run signed',
      );
      expect(readFileSync(ws.rollingFile)).toEqual(before);
    });

    it('restores the previous manifest when the replaced pointer does not verify', () => {
      const ws = pointerWorkspace('1.2.4', '1.2.3', { corruptUpload: true });
      const before = readFileSync(ws.rollingFile);
      const replaced = runStep(stepRun(REPLACE), ws);
      expect(replaced.status).not.toBe(0);
      expect(replaced.stderr).toContain(
        '::warning::the rolling host-stream manifest did not verify; restoring portable-stable to its previous state',
      );
      expect(readFileSync(ws.rollingFile)).toEqual(before);
      // A rerun of the job then replaces it normally.
      const rerun = runStep(stepRun(REPLACE), ws);
      expect(rerun.status, rerun.stderr).toBe(0);
      expect(readFileSync(ws.rollingFile)).toEqual(readFileSync(ws.signed));
    });

    it('removes a failed bootstrap manifest instead of leaving it served', () => {
      const ws = pointerWorkspace('1.2.3', null, { corruptUpload: true });
      const replaced = runStep(stepRun(REPLACE), {
        cwd: ws.cwd,
        env: { ...ws.env, ALLOW_EMPTY_HOST_MANIFEST_BOOTSTRAP: 'true' },
      });
      expect(replaced.status).not.toBe(0);
      expect(existsSync(ws.rollingFile)).toBe(false);
      expect(readFileSync(join(ws.releases, '.log'), 'utf8')).toContain(
        `delete-asset portable-stable ${ASSET}`,
      );
    });

    it('says there is nothing to remove when a bootstrap upload failed before the asset existed', () => {
      const ws = pointerWorkspace('1.2.3', null, { failUpload: true });
      const replaced = runStep(stepRun(REPLACE), {
        cwd: ws.cwd,
        env: { ...ws.env, ALLOW_EMPTY_HOST_MANIFEST_BOOTSTRAP: 'true' },
      });
      expect(replaced.status).not.toBe(0);
      expect(replaced.stderr).toContain('nothing to remove');
      expect(replaced.stderr).not.toContain('could not remove');
      expect(readFileSync(join(ws.releases, '.log'), 'utf8')).not.toContain(
        'delete-asset',
      );
    });

    it('verifies the fetched manifest against the exact versioned payload before any pointer write', () => {
      const ws = pointerWorkspace('1.2.4', '1.2.3');
      const verify = runStep(stepRun(VERIFY_FETCHED), ws);
      expect(verify.status, verify.stderr).toBe(0);
      expect(verify.stdout).toContain('verified 1.2.4');
      // A substituted payload on the versioned release is refused.
      const tampered = pointerWorkspace('1.2.4', '1.2.3', { fetch: false });
      const payloadPath = join(
        tampered.versioned,
        'station-server-manifest-payload.json',
      );
      const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
      payload.publishedAt = '2026-09-30T00:00:00.000Z';
      writeFileSync(payloadPath, JSON.stringify(payload));
      expect(runStep(stepRun(FETCH), tampered).status).toBe(0);
      const refused = runStep(stepRun(VERIFY_FETCHED), tampered);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('is not the payload this run signed');
      // A manifest signed by any other key is refused.
      const forged = pointerWorkspace('1.2.4', '1.2.3', { fetch: false });
      writeFileSync(
        join(forged.versioned, ASSET),
        readFileSync(
          keyring('stable').sign(
            join(forged.versioned, 'station-server-manifest-payload.json'),
          ),
        ),
      );
      runStep(stepRun(FETCH), forged);
      const unsigned = runStep(stepRun(VERIFY_FETCHED), forged);
      expect(unsigned.status).toBe(1);
      expect(unsigned.stderr).toContain('manifest signature did not verify');
      for (const workspace of [tampered, forged])
        expect(
          readFileSync(join(workspace.releases, '.log'), 'utf8'),
        ).not.toMatch(/^upload /m);
    });

    it("refuses another release's validly signed manifest before any pointer write", () => {
      const ws = pointerWorkspace('1.2.3', '1.2.1', { swapTo: '1.2.2' });
      const checked = runStep(stepRun(CHECK_FETCHED), ws);
      expect(checked.status).toBe(1);
      expect(checked.stderr).toContain(
        "payload is not this release's stable host build: version 1.2.2 (expected 1.2.3)",
      );
      // The pinned verify alone cannot tell: manifest and payload agree.
      const verified = runStep(stepRun(VERIFY_FETCHED), ws);
      expect(verified.status, verified.stderr).toBe(0);
      // The plan refuses it independently.
      const plan = runStep(stepRun(PLAN), ws);
      expect(plan.status).toBe(1);
      expect(plan.stderr).toContain(
        'the signed manifest names 1.2.2, not the candidate 1.2.3',
      );
      expect(readFileSync(ws.output, 'utf8')).toBe('');
      expect(readFileSync(join(ws.releases, '.log'), 'utf8')).not.toMatch(
        /^upload /m,
      );
      // The matching release passes the same check.
      const own = pointerWorkspace('1.2.3', '1.2.1');
      const ok = runStep(stepRun(CHECK_FETCHED), own);
      expect(ok.status, ok.stderr).toBe(0);
    });

    it('records the release as public in the step output the pointer job keys on', () => {
      const output = join(freshDir('released'), 'github-output');
      writeFileSync(output, '');
      const result = runStep(
        steps[index(steps, 'Record that the release is public')].run ?? '',
        { cwd: repoRoot, env: { GITHUB_OUTPUT: output } },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe('released=true\n');
    });
  });
});

describe.skipIf(process.platform === 'win32')(
  'end to end: a stable manifest from the release pipeline installs with curl and tar',
  () => {
    it('assembles, signs under the release key id, and install.sh installs it', {
      timeout: 90_000,
    }, () => {
      const dir = freshDir('e2e');
      const version = '1.2.3';
      const archive = buildPrebuiltArchive(dir, version, { sha: SHA });
      const { id, os, arch } = hostTarget();
      // The builder's descriptor beside the archive, as download-artifact
      // hands it to the host-manifest job.
      writeFileSync(
        `${archive.archive}.json`,
        JSON.stringify({
          schemaVersion: 1,
          name: archive.name,
          target: id,
          format: 'tar.gz',
          sha256: archive.sha256,
          size: archive.size,
          root: 'station',
          launcher: 'station/bin/station',
          node: {
            version: process.versions.node,
            distribution: `node-v${process.versions.node}-${os}-${arch}.tar.gz`,
            sha256: 'd'.repeat(64),
          },
          release: {
            schemaVersion: 2,
            sha: SHA,
            ref: `v${version}`,
            createdAt: '2026-09-26T00:00:00.000Z',
            channel: 'stable',
            releaseChannel: 'stable',
            prerelease: false,
          },
          unpacked: { bytes: 1, files: 1, longestRelativePath: 1 },
        }),
      );
      const payloadPath = join(dir, 'payload.json');
      const assembled = runNode('scripts/ecosystem-manifest.mjs', [
        'assemble',
        '--descriptors',
        join(dir, 'archives'),
        '--version',
        version,
        '--channel',
        'stable',
        '--source-sha',
        SHA,
        '--base-url',
        publicationLocations('stable', REPOSITORY, version).baseUrl,
        '--node-version',
        process.versions.node,
        '--launcher-protocol-min',
        String(PORTABLE_LAUNCHER_PROTOCOL.min),
        '--launcher-protocol-max',
        String(PORTABLE_LAUNCHER_PROTOCOL.max),
        // Only this host's archive exists locally.
        '--targets',
        id,
        '--output',
        payloadPath,
      ]);
      expect(assembled.status, assembled.stderr).toBe(0);
      const checked = runNode('scripts/portable-release-publication.mjs', [
        'check-payload',
        '--ring',
        'stable',
        '--payload',
        payloadPath,
        '--version',
        version,
        '--source-sha',
        SHA,
        '--repository',
        REPOSITORY,
      ]);
      expect(checked.status, checked.stderr).toBe(0);
      // The one substitution: the signed URL points at the local archive,
      // because the release asset does not exist. Every other byte of the
      // payload is the assembler's.
      const payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
      payload.artifacts[0].url = pathToFileURL(archive.archive).href;
      const localPayload = join(dir, 'local-payload.json');
      writeFileSync(localPayload, JSON.stringify(payload));
      const { privateKeyPem, keyTable } = createDryRunKeys(
        'stable',
        RELEASE_SIGNING_KEY_ID,
      );
      writeFileSync(join(dir, 'release-key.pem'), privateKeyPem, {
        mode: 0o600,
      });
      const publicKey = join(dir, 'release-key.pub.pem');
      writeFileSync(publicKey, keyTable.keys[0].publicKeySpkiPem);
      expect(createPrivateKey(privateKeyPem).asymmetricKeyType).toBe('ed25519');
      const manifest = join(dir, 'station-portable-stable-manifest.json');
      // Signed as the publish job signs: the pinned release key id, no
      // --allow-unpinned-key.
      const signed = runNode(
        'scripts/ecosystem-manifest.mjs',
        [
          'create',
          '--payload',
          localPayload,
          '--key-id',
          RELEASE_SIGNING_KEY_ID,
          '--private-key',
          join(dir, 'release-key.pem'),
          '--output',
          manifest,
        ],
        { STATION_ECOSYSTEM_ALLOW_INSECURE_TEST_URLS: '1' },
      );
      expect(signed.status, signed.stderr).toBe(0);
      const fakeBin = join(dir, 'bin');
      mkdirSync(fakeBin);
      writeFileSync(
        join(fakeBin, 'gh'),
        '#!/bin/sh\necho gh-must-not-run >&2\nexit 99\n',
      );
      writeFileSync(
        join(fakeBin, 'npm'),
        '#!/bin/sh\necho npm-must-not-run >&2\nexit 99\n',
      );
      chmodSync(join(fakeBin, 'gh'), 0o755);
      chmodSync(join(fakeBin, 'npm'), 0o755);
      const { STATION_CHANNEL: _channel, ...inherited } = process.env;
      const installed = spawnSync('sh', [join(repoRoot, 'install.sh')], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 80_000,
        env: {
          ...inherited,
          HOME: join(dir, 'home'),
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          GH_TOKEN: '',
          GITHUB_TOKEN: '',
          STATION_ROOT: '',
          STATION_HOME: '',
          STATION_INSTALL_ROOT: '',
          STATION_BIN_DIR: '',
          STATION_VERSION: '',
          STATION_INSTALL_ALLOW_ROLLBACK: '',
          STATION_INSTALL_PUBLIC_MANIFEST_URL: pathToFileURL(manifest).href,
          // The test key stands in for the release key's bytes; the key id,
          // and so the pinned channel policy, is the real one.
          STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL:
            pathToFileURL(publicKey).href,
          STATION_INSTALL_ALLOW_INSECURE_TEST_URLS: '1',
          STATION_FIXTURE_CLI_LOG: join(dir, 'cli.log'),
        },
      });
      expect(installed.status, installed.stderr).toBe(0);
      const current = join(
        dir,
        'home',
        '.station',
        'installs',
        'stable',
        'current',
      );
      expect(
        JSON.parse(
          readFileSync(join(current, '.station-release.json'), 'utf8'),
        ),
      ).toMatchObject({ ref: 'v1.2.3', releaseChannel: 'stable', sha: SHA });
    });
  },
);
