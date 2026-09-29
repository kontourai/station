import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { PORTABLE_SERVER_TARGETS } from '../../packages/shared/src/portable-server-targets.mjs';
import { STATION_RELEASE_RINGS } from '../../packages/shared/src/release-rings.generated.mjs';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  assertNotRegressing,
  checkArchives,
  compareRingVersions,
  createDryRunKeys,
  PORTABLE_LAUNCHER_PROTOCOL,
  parseRingVersion,
  publicationLocations,
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
 * A `node` on PATH that makes every pinned-table verify
 * (`ecosystem-manifest.mjs verify` without `--keys`) use `$SHIM_KEYS`: the
 * only way to make the throwaway envelope "verify against the pinned table"
 * without the release key, so the refusal branch actually runs.
 */
function pinnedTableShim() {
  const bin = freshDir('shim');
  writeFileSync(
    join(bin, 'node'),
    [
      '#!/bin/sh',
      'case "$1 $2" in',
      '  *ecosystem-manifest.mjs\\ verify)',
      '    case " $* " in *" --keys "*) ;; *) exec "$REAL_NODE" "$@" --keys "$SHIM_KEYS" ;; esac ;;',
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

describe('publication checks for stable and preview', () => {
  it('refuses to replace the rolling manifest with an equal or older version', () => {
    for (const [ring, current, newer, older] of [
      ['stable', '1.2.3', '1.2.4', '1.2.2'],
      ['preview', '1.2.3-preview.4', '1.2.3-preview.5', '1.2.3-preview.3'],
    ] as const) {
      const { output } = assemblePayload(ring, current);
      const { envelope, keyTable } = signWithThrowaway(ring, output);
      expect(
        assertNotRegressing(ring, {
          current: envelope,
          keys: keyTable,
          candidateVersion: newer,
        }),
      ).toEqual({ current });
      for (const candidate of [current, older])
        expect(() =>
          assertNotRegressing(ring, {
            current: envelope,
            keys: keyTable,
            candidateVersion: candidate,
          }),
        ).toThrow(
          `refusing to replace the rolling ${ring} manifest ${current} with ${candidate}, which is not newer`,
        );
      expect(
        assertNotRegressing(ring, {
          current: null,
          keys: keyTable,
          candidateVersion: newer,
        }),
      ).toEqual({ current: null });
    }
  });

  it('refuses an equal version through the CLI the publish job runs', () => {
    const { output } = assemblePayload('stable', '1.2.3');
    const { manifest, keysPath } = signWithThrowaway('stable', output);
    const run = (candidate: string) =>
      runNode('scripts/portable-release-publication.mjs', [
        'not-regressing',
        '--ring',
        'stable',
        '--candidate-version',
        candidate,
        '--current',
        manifest,
        '--keys',
        keysPath,
      ]);
    expect(run('1.2.4').status).toBe(0);
    const equal = run('1.2.3');
    expect(equal.status).toBe(1);
    expect(equal.stderr).toContain('which is not newer');
    // Against the pinned table the throwaway rolling manifest does not
    // verify, and that is refused rather than overwritten.
    const pinned = runNode('scripts/portable-release-publication.mjs', [
      'not-regressing',
      '--ring',
      'stable',
      '--candidate-version',
      '1.2.4',
      '--current',
      manifest,
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
      const { signed } = runReleaseSteps('stable', '1.2.3', pinnedTableShim());
      expect(signed.status).toBe(1);
      expect(signed.stderr).toContain(
        'the dry-run manifest verified against the pinned key table',
      );
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
  const steps = job.steps ?? [];
  const index = (name: string) => {
    const found = steps.findIndex((step) => step.name === name);
    expect(found, name).toBeGreaterThanOrEqual(0);
    return found;
  };

  it('gates every signing and host publication step on the literal owner variable', () => {
    const gated = steps.filter((step) => step.if?.includes(GATE_VARIABLE));
    expect(gated.map((step) => step.name)).toEqual([
      'Sign the host-stream manifest with the pinned release key',
      'Verify the signed host-stream manifest with the pinned key table',
      "Require the owner's rolling host-stream pointer release",
      'Refuse to publish over a newer or equal rolling host-stream manifest',
      'Attach the signed host-stream manifest to the versioned release',
      'Re-download the versioned host-stream assets and compare them with the manifest',
      'Refuse to replace a newer or equal rolling host-stream manifest',
      'Replace the rolling host-stream manifest (last)',
      'Re-fetch and re-verify the rolling host-stream manifest with the pinned key',
    ]);
    for (const step of gated) expect(step.if, step.name).toBe(GATE);
    const effects = steps.filter(isHostEffect);
    expect(effects.map((step) => step.name)).toEqual([
      'Sign the host-stream manifest with the pinned release key',
      'Attach the signed host-stream manifest to the versioned release',
      'Replace the rolling host-stream manifest (last)',
    ]);
    for (const step of effects) expect(step.if, step.name).toBe(GATE);
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
    expect(JSON.stringify(release)).not.toContain(SIGNING_SECRET);
  });

  it('replaces the rolling pointer last, after the versioned assets are public, verified and not regressing', () => {
    const rolling = index('Replace the rolling host-stream manifest (last)');
    expect(steps[rolling].run).toContain(
      'gh release upload "$ROLLING_TAG" --repo "$GITHUB_REPOSITORY" --clobber "$RUNNER_TEMP/host-manifest/$MANIFEST_ASSET"',
    );
    // Nothing else writes the rolling pointer.
    for (const [position, step] of steps.entries())
      if (position !== rolling)
        expect(step.run ?? '', step.name).not.toMatch(
          /gh release (upload|create|edit|delete)[^\n]*"\$ROLLING_TAG"/,
        );
    const order = [
      'Plan the host-stream manifest publication',
      'Dry-run sign the host-stream manifest with a throwaway key',
      'Sign the host-stream manifest with the pinned release key',
      'Verify the signed host-stream manifest with the pinned key table',
      "Require the owner's rolling host-stream pointer release",
      'Refuse to publish over a newer or equal rolling host-stream manifest',
      'Attach the signed host-stream manifest to the versioned release',
      'Publish release and compensate to draft until feed verifies',
      'Re-download the versioned host-stream assets and compare them with the manifest',
      'Refuse to replace a newer or equal rolling host-stream manifest',
      'Replace the rolling host-stream manifest (last)',
      'Re-fetch and re-verify the rolling host-stream manifest with the pinned key',
    ].map(index);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The last not-regressing check immediately precedes the replacement, and
    // the pinned-key re-verification immediately follows it.
    expect(
      index('Refuse to replace a newer or equal rolling host-stream manifest'),
    ).toBe(rolling - 1);
    expect(
      index(
        'Re-fetch and re-verify the rolling host-stream manifest with the pinned key',
      ),
    ).toBe(rolling + 1);
    const reverify = steps[rolling + 1].run ?? '';
    expect(reverify).toContain('--manifest "$ROLLING_MANIFEST_URL"');
    expect(reverify).not.toMatch(/--keys|--public-key/);
    const versioned =
      steps[
        index(
          'Re-download the versioned host-stream assets and compare them with the manifest',
        )
      ].run ?? '';
    expect(versioned).toContain('verify-assets --payload');
    expect(versioned).toContain('--manifest "$VERSIONED_MANIFEST_URL"');
    for (const name of [
      'Refuse to publish over a newer or equal rolling host-stream manifest',
      'Refuse to replace a newer or equal rolling host-stream manifest',
    ])
      expect(steps[index(name)].run).toContain(
        'not-regressing --ring "$RELEASE_RING" --candidate-version "$RELEASE_VERSION" --current "$ROLLING_MANIFEST_URL"',
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
    // The attestation loop exempts only the signed manifest, by its exact
    // name for this ring, after the inventory revalidation verified it.
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
      index('Download and revalidate every staged release asset'),
    ).toBeLessThan(
      index('Verify GitHub provenance for every downloaded asset'),
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
        env: {
          RUNNER_TEMP: runnerTemp,
          RELEASE_RING: ring,
          RELEASE_VERSION: version,
          GITHUB_REPOSITORY: REPOSITORY,
        } as Record<string, string>,
      };
    }

    it('dry-runs without any secret and never verifies against the pinned table', () => {
      const dryRun =
        namedStep(
          job,
          'Dry-run sign the host-stream manifest with a throwaway key',
        ).run ?? '';
      const ok = workspace('preview', '1.2.3-preview.4');
      const passed = runStep(dryRun, ok);
      expect(passed.status, passed.stderr).toBe(0);
      expect(passed.stdout).toContain(
        `verified 1.2.3-preview.4 (${RELEASE_DRY_RUN_KEY_ID})`,
      );
      const refused = workspace('stable', '1.2.3');
      const shimmed = runStep(dryRun, {
        cwd: refused.cwd,
        env: {
          ...refused.env,
          PATH: `${pinnedTableShim()}:${process.env.PATH ?? ''}`,
          REAL_NODE: process.execPath,
          SHIM_KEYS: join(
            refused.env.RUNNER_TEMP,
            'host-dry-run',
            'dry-run-keys.json',
          ),
        },
      });
      expect(shimmed.status).toBe(1);
      expect(shimmed.stderr).toContain(
        'the dry-run host manifest verified against the pinned key table',
      );
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
