import { spawnSync } from 'node:child_process';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PORTABLE_SERVER_TARGETS } from '../../packages/shared/src/portable-server-targets.mjs';
import {
  canonicalManifestJson,
  type ReleaseManifestPayload,
  selectArtifact,
  verifyReleaseManifest,
} from '../../packages/shared/src/release-manifest.js';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  canonicalJson,
  platformPayload,
  signEnvelope,
} from './fixtures/release-manifest-v2.js';

/**
 * One golden corpus, run through both verifiers of the schema v2 release
 * manifest (#2675): the signer's CLI (scripts/ecosystem-manifest.mjs, as a
 * child process) and packages/shared's release-manifest.ts. Each vector
 * names the exact decision; the two must agree except where a vector records
 * the deliberate difference (the shared verifier accepts schema v2 only).
 */

const root = resolve(import.meta.dirname, '../..');
const script = join(root, 'scripts/ecosystem-manifest.mjs');
const makeTempDir = trackTempDirs();

function run(args: string[]) {
  const { STATION_ECOSYSTEM_ALLOW_INSECURE_TEST_URLS: _insecure, ...env } =
    process.env;
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
    windowsHide: true,
  });
}

function pem(key: KeyObject, type: 'spki' | 'pkcs8'): string {
  return key.export({ format: 'pem', type }) as string;
}

// Throwaway keys. The test builds its own pinned table and passes it in;
// config/release-manifest-keys.json is never involved.
const releaseKey = generateKeyPairSync('ed25519');
const nightlyKey = generateKeyPairSync('ed25519');
const rogueKey = generateKeyPairSync('ed25519');
const KEYS = {
  keys: [
    {
      keyId: 'fixture-nightly',
      algorithm: 'ed25519',
      publicKeySpkiPem: pem(nightlyKey.publicKey, 'spki'),
      channels: ['nightly'],
    },
    {
      keyId: 'fixture-release',
      algorithm: 'ed25519',
      publicKeySpkiPem: pem(releaseKey.publicKey, 'spki'),
      channels: ['stable', 'preview'],
    },
  ],
};

type Artifact = Record<string, unknown>;
const artifacts = (payload = platformPayload()) =>
  payload.artifacts as Artifact[];

/** The nightly platform payload with its artifacts replaced. */
function withArtifacts(
  edit: (list: Artifact[]) => Artifact[],
): Record<string, unknown> {
  return platformPayload({
    artifacts: edit(artifacts().map((artifact) => ({ ...artifact }))),
  });
}

function withArtifact(index: number, edit: Artifact): Record<string, unknown> {
  return withArtifacts((list) => {
    list[index] = { ...list[index], ...edit };
    return list;
  });
}

const STABLE = { channel: 'stable', version: '1.2.3', releaseTag: 'v1.2.3' };

const V1_PAYLOAD = {
  schemaVersion: 1,
  channel: 'stable',
  version: '1.2.3',
  releaseTag: 'v1.2.3',
  sourceSha: 'a'.repeat(40),
  publishedAt: '2026-08-16T00:00:00.000Z',
  artifacts: {
    macos: {
      name: 'station-1.2.3.dmg',
      url: 'https://example.test/station-1.2.3.dmg',
      sha256: 'b'.repeat(64),
    },
    portable: {
      name: 'station-portable.tar.gz',
      url: 'https://example.test/station-portable.tar.gz',
      sha256: 'c'.repeat(64),
    },
  },
};

const nightly = (payload: unknown) =>
  signEnvelope(payload, 'fixture-nightly', nightlyKey.privateKey);
const release = (payload: unknown) =>
  signEnvelope(payload, 'fixture-release', releaseKey.privateKey);

type Outcome = 'accept' | string;
type Vector = {
  name: string;
  envelope: () => Record<string, unknown>;
  expected: Outcome;
  /** The shared verifier's outcome where it deliberately differs. */
  sharedExpected?: Outcome;
};

const VECTORS: Vector[] = [
  {
    name: 'a valid nightly v2 envelope',
    envelope: () => nightly(platformPayload()),
    expected: 'accept',
  },
  {
    name: 'a valid stable v2 envelope under the release key',
    envelope: () => release(platformPayload(STABLE)),
    expected: 'accept',
  },
  {
    name: 'a valid v2 envelope publishing one platform',
    envelope: () => nightly(withArtifacts((list) => [list[3]])),
    expected: 'accept',
  },
  {
    name: 'duplicate platforms',
    envelope: () => nightly(withArtifacts((list) => [list[0], ...list])),
    expected: 'duplicate platform artifact darwin-arm64',
  },
  {
    name: 'artifacts not sorted by os',
    envelope: () =>
      nightly(withArtifacts((list) => [list[3], list[0], list[1], list[2]])),
    expected: 'platform artifacts are not sorted by os, then arch',
  },
  {
    name: 'artifacts not sorted by arch within an os',
    envelope: () => nightly(withArtifacts((list) => [list[1], list[0]])),
    expected: 'platform artifacts are not sorted by os, then arch',
  },
  {
    name: 'a name that does not match its format',
    envelope: () =>
      nightly(withArtifact(0, { name: 'station-server-darwin-arm64.zip' })),
    expected:
      'platform artifact darwin-arm64 name must be station-server-darwin-arm64.tar.gz',
  },
  {
    name: 'a name for another platform',
    envelope: () =>
      nightly(withArtifact(3, { name: 'station-server-linux-arm64.tar.gz' })),
    expected:
      'platform artifact linux-x64 name must be station-server-linux-x64.tar.gz',
  },
  {
    name: 'zip on linux',
    envelope: () =>
      nightly(
        withArtifact(3, {
          format: 'zip',
          name: 'station-server-linux-x64.zip',
        }),
      ),
    expected: 'platform artifact linux-x64 format must be tar.gz',
  },
  {
    name: 'tar.gz on win32',
    envelope: () =>
      nightly(
        withArtifact(4, {
          format: 'tar.gz',
          name: 'station-server-win32-x64.tar.gz',
        }),
      ),
    expected: 'platform artifact win32-x64 format must be zip',
  },
  {
    name: 'an unsupported target',
    envelope: () =>
      nightly(
        withArtifact(4, {
          arch: 'arm64',
          name: 'station-server-win32-arm64.zip',
        }),
      ),
    expected: 'platform artifact win32-arm64 is not a supported target',
  },
  ...[0, -1, 1.5, '100', null].map((size) => ({
    name: `size ${JSON.stringify(size)}`,
    envelope: () => nightly(withArtifact(2, { size })),
    expected: 'platform artifact linux-arm64 size is invalid',
  })),
  {
    name: 'an uppercase sha256',
    envelope: () => nightly(withArtifact(2, { sha256: 'A'.repeat(64) })),
    expected: 'platform artifact linux-arm64 sha256 is invalid',
  },
  {
    name: 'an http artifact URL',
    envelope: () =>
      nightly(
        withArtifact(0, {
          url: 'http://example.test/station-server-darwin-arm64.tar.gz',
        }),
      ),
    expected: 'platform artifact darwin-arm64 url is not a canonical HTTPS URL',
  },
  {
    name: 'a non-canonical artifact URL',
    envelope: () =>
      nightly(
        withArtifact(0, {
          url: 'HTTPS://example.test/station-server-darwin-arm64.tar.gz',
        }),
      ),
    expected: 'platform artifact darwin-arm64 url is not a canonical HTTPS URL',
  },
  {
    name: 'no artifacts',
    envelope: () => nightly(withArtifacts(() => [])),
    expected: 'invalid artifact set',
  },
  {
    name: 'the retired single portable artifact',
    envelope: () =>
      nightly(
        platformPayload({
          artifacts: { portable: V1_PAYLOAD.artifacts.portable },
        }),
      ),
    expected: 'invalid artifact set',
  },
  {
    name: 'an extra payload key',
    envelope: () => nightly(platformPayload({ notes: 'x' })),
    expected: 'manifest payload has an unexpected shape',
  },
  {
    name: 'an extra artifact key',
    envelope: () => nightly(withArtifact(1, { signature: 'x' })),
    expected: 'platform artifact 1 has an unexpected shape',
  },
  {
    name: 'an extra launcher protocol key',
    envelope: () =>
      nightly(platformPayload({ launcherProtocol: { min: 1, max: 2, v: 3 } })),
    expected: 'invalid launcher protocol range',
  },
  {
    name: 'launcherProtocol.min > max',
    envelope: () =>
      nightly(platformPayload({ launcherProtocol: { min: 3, max: 2 } })),
    expected: 'invalid launcher protocol range',
  },
  {
    name: 'launcherProtocol.min 0',
    envelope: () =>
      nightly(platformPayload({ launcherProtocol: { min: 0, max: 2 } })),
    expected: 'invalid launcher protocol range',
  },
  {
    name: 'a malformed Node.js version',
    envelope: () => nightly(platformPayload({ nodeVersion: 'v24.21.0' })),
    expected: 'invalid Node.js version',
  },
  {
    name: 'a channel that does not match the version',
    envelope: () =>
      nightly(platformPayload({ version: '0.7.0', releaseTag: 'v0.7.0' })),
    expected: 'manifest channel does not match version',
  },
  {
    name: 'v1 keys under schema 2',
    envelope: () => release({ ...V1_PAYLOAD, schemaVersion: 2 }),
    expected: 'manifest payload has an unexpected shape',
  },
  {
    name: 'a v2 payload under schema 1',
    envelope: () => release({ ...platformPayload(STABLE), schemaVersion: 1 }),
    expected: 'manifest payload has an unexpected shape',
    sharedExpected: 'unsupported manifest schema',
  },
  {
    name: 'a valid schema 1 envelope',
    envelope: () => release(V1_PAYLOAD),
    expected: 'accept',
    sharedExpected: 'unsupported manifest schema',
  },
  {
    name: 'an unknown schema',
    envelope: () => nightly(platformPayload({ schemaVersion: 3 })),
    expected: 'unsupported manifest schema',
  },
  {
    name: 'an extra envelope key',
    envelope: () => ({ ...nightly(platformPayload()), note: 'x' }),
    expected: 'manifest envelope has an unexpected shape',
  },
  {
    name: 'an unpinned key',
    envelope: () =>
      signEnvelope(platformPayload(), 'fixture-rogue', rogueKey.privateKey),
    expected: 'manifest signing key fixture-rogue is not pinned',
  },
  {
    name: 'the nightly key signing a stable manifest',
    envelope: () =>
      signEnvelope(
        platformPayload(STABLE),
        'fixture-nightly',
        nightlyKey.privateKey,
      ),
    expected:
      'signing key fixture-nightly is not authorized for channel stable',
  },
  {
    name: 'the release key signing a nightly manifest',
    envelope: () =>
      signEnvelope(platformPayload(), 'fixture-release', releaseKey.privateKey),
    expected:
      'signing key fixture-release is not authorized for channel nightly',
  },
  {
    name: 'an unpinned key labelled as a pinned one',
    envelope: () =>
      signEnvelope(platformPayload(), 'fixture-nightly', rogueKey.privateKey),
    expected: 'manifest signature did not verify',
  },
  {
    name: 'a tampered signature',
    envelope: () => {
      const envelope = nightly(platformPayload());
      const bytes = Buffer.from(envelope.signature as string, 'base64');
      bytes[10] ^= 0x01;
      return { ...envelope, signature: bytes.toString('base64') };
    },
    expected: 'manifest signature did not verify',
  },
  {
    name: 'a tampered payload byte',
    envelope: () => {
      const envelope = nightly(platformPayload());
      const payload = structuredClone(envelope.payload) as Record<
        string,
        unknown
      >;
      const artifact = (payload.artifacts as Artifact[])[3];
      artifact.sha256 = `5${(artifact.sha256 as string).slice(1)}`;
      return { ...envelope, payload };
    },
    expected: 'manifest signature did not verify',
  },
];

function sharedOutcome(envelope: unknown, keys: unknown = KEYS): Outcome {
  try {
    verifyReleaseManifest(envelope, keys);
    return 'accept';
  } catch (error) {
    return (error as Error).message;
  }
}

describe('release manifest golden vectors (#2675)', () => {
  it.each(VECTORS)('$name', ({ envelope, expected, sharedExpected }) => {
    const dir = makeTempDir('station-release-manifest-vectors-');
    const keysPath = join(dir, 'keys.json');
    writeFileSync(keysPath, JSON.stringify(KEYS));
    const value = envelope();
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(value));

    const signer = run([
      'verify',
      '--manifest',
      manifestPath,
      '--keys',
      keysPath,
    ]);
    if (expected === 'accept') {
      expect(signer.status, signer.stderr).toBe(0);
      expect(JSON.parse(signer.stdout)).toEqual(value.payload);
    } else {
      expect(signer.status).toBe(1);
      expect(signer.stderr.trim()).toBe(expected);
    }
    expect(sharedOutcome(value)).toBe(sharedExpected ?? expected);
  });

  it('covers every target, and zip exactly on win32', () => {
    // Pinned independently of the shared table the verifiers read.
    expect(
      PORTABLE_SERVER_TARGETS.map(({ os, arch, format }) => [os, arch, format]),
    ).toEqual([
      ['darwin', 'arm64', 'tar.gz'],
      ['darwin', 'x64', 'tar.gz'],
      ['linux', 'arm64', 'tar.gz'],
      ['linux', 'x64', 'tar.gz'],
      ['win32', 'x64', 'zip'],
    ]);
    expect(
      artifacts().map((artifact) => `${artifact.os}-${artifact.arch}`),
    ).toEqual(PORTABLE_SERVER_TARGETS.map(({ os, arch }) => `${os}-${arch}`));
  });
});

// A fixed ed25519 key (seed 0x01..0x20): a fixed key and payload give a
// fixed signature.
function goldenPrivateKey(): KeyObject {
  const seed = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
  return createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      seed,
    ]),
    format: 'der',
    type: 'pkcs8',
  });
}

const GOLDEN_ARTIFACT_BASE =
  'https://github.com/kontourai/station/releases/download/v0.7.0-nightly.12/';
// The exact bytes the signer and both verifiers derive from platformPayload():
// recursively sorted keys, no whitespace. Written out, not computed.
const GOLDEN_CANONICAL =
  '{"artifacts":[' +
  `{"arch":"arm64","format":"tar.gz","name":"station-server-darwin-arm64.tar.gz","os":"darwin","sha256":"${'1'.repeat(64)}","size":100000001,"url":"${GOLDEN_ARTIFACT_BASE}station-server-darwin-arm64.tar.gz"},` +
  `{"arch":"x64","format":"tar.gz","name":"station-server-darwin-x64.tar.gz","os":"darwin","sha256":"${'2'.repeat(64)}","size":100000002,"url":"${GOLDEN_ARTIFACT_BASE}station-server-darwin-x64.tar.gz"},` +
  `{"arch":"arm64","format":"tar.gz","name":"station-server-linux-arm64.tar.gz","os":"linux","sha256":"${'3'.repeat(64)}","size":100000003,"url":"${GOLDEN_ARTIFACT_BASE}station-server-linux-arm64.tar.gz"},` +
  `{"arch":"x64","format":"tar.gz","name":"station-server-linux-x64.tar.gz","os":"linux","sha256":"${'4'.repeat(64)}","size":100000004,"url":"${GOLDEN_ARTIFACT_BASE}station-server-linux-x64.tar.gz"},` +
  `{"arch":"x64","format":"zip","name":"station-server-win32-x64.zip","os":"win32","sha256":"${'5'.repeat(64)}","size":100000005,"url":"${GOLDEN_ARTIFACT_BASE}station-server-win32-x64.zip"}` +
  '],"channel":"nightly","launcherProtocol":{"max":1,"min":1},"nodeVersion":"24.21.0","publishedAt":"2026-09-25T00:00:00.000Z","releaseTag":"v0.7.0-nightly.12","schemaVersion":2,"sourceSha":"0123456789abcdef0123456789abcdef01234567","version":"0.7.0-nightly.12"}';
const GOLDEN_SIGNATURE =
  'PaHnpuyGJmDJNsPkpMU+5U/lFpxmWFKSC25Y9+0YIZ6Q+icmpOF6x93HH1bT4vXP5TeDDTVwwPnkXBQ12JJ3AA==';

describe('release manifest signer CLI (#2675)', () => {
  it('signs the golden vector that the shared verifier accepts', () => {
    const dir = makeTempDir('station-release-manifest-golden-');
    const privateKey = goldenPrivateKey();
    const privatePath = join(dir, 'golden-private.pem');
    writeFileSync(privatePath, pem(privateKey, 'pkcs8'));
    const payloadPath = join(dir, 'payload.json');
    writeFileSync(payloadPath, JSON.stringify(platformPayload()));
    const manifestPath = join(dir, 'golden.json');
    const created = run([
      'create',
      '--payload',
      payloadPath,
      '--private-key',
      privatePath,
      '--key-id',
      'station-golden-vector',
      '--allow-unpinned-key',
      '--output',
      manifestPath,
    ]);
    expect(created.status, created.stderr).toBe(0);
    const envelope = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(envelope.signature).toBe(GOLDEN_SIGNATURE);
    expect(canonicalJson(envelope.payload)).toBe(GOLDEN_CANONICAL);
    expect(canonicalManifestJson(envelope.payload)).toBe(GOLDEN_CANONICAL);
    const goldenKeys = {
      keys: [
        {
          keyId: 'station-golden-vector',
          algorithm: 'ed25519',
          publicKeySpkiPem: pem(createPublicKey(privateKey), 'spki'),
          channels: ['nightly'],
        },
      ],
    };
    expect(sharedOutcome(envelope, goldenKeys)).toBe('accept');
  });

  it('refuses to sign a v2 payload that breaks the schema', () => {
    const dir = makeTempDir('station-release-manifest-create-');
    const privatePath = join(dir, 'private.pem');
    writeFileSync(privatePath, pem(nightlyKey.privateKey, 'pkcs8'));
    const sign = (payload: unknown) => {
      const payloadPath = join(dir, 'payload.json');
      const output = join(dir, 'out.json');
      writeFileSync(payloadPath, JSON.stringify(payload));
      const result = run([
        'create',
        '--payload',
        payloadPath,
        '--private-key',
        privatePath,
        '--key-id',
        'fixture-nightly',
        '--allow-unpinned-key',
        '--output',
        output,
      ]);
      return { ...result, written: existsSync(output) };
    };
    const unsorted = sign(withArtifacts((list) => list.reverse()));
    expect(unsorted.status).toBe(1);
    expect(unsorted.stderr.trim()).toBe(
      'platform artifacts are not sorted by os, then arch',
    );
    expect(unsorted.written).toBe(false);
    const good = sign(platformPayload());
    expect(good.status, good.stderr).toBe(0);
    expect(good.written).toBe(true);
  });
});

const PREVIEW = {
  version: '0.7.0-preview.3',
  channel: 'preview',
  sha: 'c'.repeat(40),
};
const BASE_URL = `https://github.com/kontourai/station/releases/download/v${PREVIEW.version}/`;

/**
 * An archive descriptor in the shape the portable archive build writes
 * beside each archive (`<archive>.json`, describePortableArchive in #2705).
 */
function descriptor(
  os: string,
  arch: string,
  format: string,
  overrides: Record<string, unknown> = {},
) {
  const name = `station-server-${os}-${arch}.${format}`;
  return {
    schemaVersion: 1,
    name,
    target: `${os}-${arch}`,
    format,
    sha256: createHashHex(name),
    size: 90_000_000 + name.length,
    root: 'station',
    launcher: `station/bin/station${os === 'win32' ? '.cmd' : ''}`,
    node: {
      version: '24.21.0',
      distribution: `node-v24.21.0-${os === 'win32' ? 'win' : os}-${arch}.${format}`,
      sha256: 'd'.repeat(64),
    },
    release: {
      schemaVersion: 2,
      sha: PREVIEW.sha,
      ref: `v${PREVIEW.version}`,
      createdAt: '2026-09-26T00:00:00.000Z',
      channel: 'beta',
      releaseChannel: 'preview',
      prerelease: true,
    },
    unpacked: { bytes: 300_000_000, files: 20_000, longestRelativePath: 180 },
    ...overrides,
  };
}

function createHashHex(seed: string): string {
  return Buffer.from(seed.padEnd(32, '.').slice(0, 32)).toString('hex');
}

/**
 * Writes descriptors one per subdirectory, as actions/download-artifact lays
 * out one artifact per build job.
 */
function writeDescriptors(
  dir: string,
  descriptors: ReturnType<typeof descriptor>[],
): string {
  const tree = join(dir, 'descriptors');
  descriptors.forEach((value, index) => {
    const job = join(tree, `job-${index}`);
    mkdirSync(job, { recursive: true });
    writeFileSync(join(job, `${value.name}.json`), JSON.stringify(value));
    // The archive itself sits beside its descriptor and is not read.
    writeFileSync(join(job, value.name as string), 'archive bytes');
  });
  return tree;
}

const ALL_DESCRIPTORS = () =>
  PORTABLE_SERVER_TARGETS.map(({ os, arch, format }) =>
    descriptor(os, arch, format),
  );

function assemble(
  dir: string,
  descriptors: ReturnType<typeof descriptor>[],
  overrides: Record<string, string> = {},
) {
  const output = join(dir, 'payload.json');
  const options = {
    '--descriptors': writeDescriptors(dir, descriptors),
    '--version': PREVIEW.version,
    '--channel': PREVIEW.channel,
    '--source-sha': PREVIEW.sha,
    '--base-url': BASE_URL,
    '--node-version': '24.21.0',
    '--launcher-protocol-min': '1',
    '--launcher-protocol-max': '2',
    '--published-at': '2026-09-26T01:00:00.000Z',
    '--output': output,
    ...overrides,
  };
  const result = run(['assemble', ...Object.entries(options).flat()]);
  return { ...result, output, written: existsSync(output) };
}

describe('release manifest assemble (#2675)', () => {
  it('builds a signable payload from archive descriptors alone', () => {
    const dir = makeTempDir('station-release-manifest-assemble-');
    // Descriptors in reverse order: the payload is sorted regardless.
    const descriptors = ALL_DESCRIPTORS().reverse();
    const result = assemble(dir, descriptors);
    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(readFileSync(result.output, 'utf8'));
    expect(payload).toEqual({
      schemaVersion: 2,
      channel: 'preview',
      version: PREVIEW.version,
      releaseTag: `v${PREVIEW.version}`,
      sourceSha: PREVIEW.sha,
      publishedAt: '2026-09-26T01:00:00.000Z',
      nodeVersion: '24.21.0',
      launcherProtocol: { min: 1, max: 2 },
      artifacts: [...descriptors].reverse().map((value) => ({
        os: value.target.split('-')[0],
        arch: value.target.split('-')[1],
        name: value.name,
        url: `${BASE_URL}${value.name}`,
        sha256: value.sha256,
        size: value.size,
        format: value.format,
      })),
    });

    // The assembled payload signs, and both verifiers accept the result.
    const privatePath = join(dir, 'release.pem');
    writeFileSync(privatePath, pem(releaseKey.privateKey, 'pkcs8'));
    const keysPath = join(dir, 'keys.json');
    writeFileSync(keysPath, JSON.stringify(KEYS));
    const manifestPath = join(dir, 'manifest.json');
    const created = run([
      'create',
      '--payload',
      result.output,
      '--private-key',
      privatePath,
      '--key-id',
      'fixture-release',
      '--allow-unpinned-key',
      '--output',
      manifestPath,
    ]);
    expect(created.status, created.stderr).toBe(0);
    const verified = run([
      'verify',
      '--manifest',
      manifestPath,
      '--keys',
      keysPath,
    ]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toEqual(payload);
    const envelope = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(verifyReleaseManifest(envelope, KEYS)).toEqual(payload);
  });

  const all = ALL_DESCRIPTORS;
  const REFUSALS: Array<{
    name: string;
    descriptors: () => ReturnType<typeof descriptor>[];
    options?: Record<string, string>;
    error: string;
  }> = [
    {
      name: 'a Node.js version other than the pinned one',
      descriptors: all,
      options: { '--node-version': '24.20.0' },
      error: 'archives bundle Node.js 24.21.0, not the pinned 24.20.0',
    },
    {
      name: 'descriptors that disagree on the Node.js version',
      descriptors: () => {
        const list = all();
        list[2] = { ...list[2], node: { ...list[2].node, version: '24.20.0' } };
        return list;
      },
      error:
        'archive descriptors disagree on the Node.js version: 24.21.0, 24.20.0',
    },
    {
      name: 'two descriptors for one target',
      descriptors: () => [...all(), all()[3]],
      error: 'duplicate archive descriptor for linux-x64',
    },
    {
      name: 'a malformed sha256',
      descriptors: () => {
        const list = all();
        list[1] = { ...list[1], sha256: 'F'.repeat(64) };
        return list;
      },
      error: 'station-server-darwin-x64.tar.gz.json: malformed sha256',
    },
    {
      name: 'a zero size',
      descriptors: () => {
        const list = all();
        list[4] = { ...list[4], size: 0 };
        return list;
      },
      error: 'station-server-win32-x64.zip.json: malformed size',
    },
    {
      name: 'a non-integer size',
      descriptors: () => {
        const list = all();
        list[4] = { ...list[4], size: '90000000' as unknown as number };
        return list;
      },
      error: 'station-server-win32-x64.zip.json: malformed size',
    },
    {
      name: 'an archive built from another commit',
      descriptors: () => {
        const list = all();
        list[0] = {
          ...list[0],
          release: { ...list[0].release, sha: 'e'.repeat(40) },
        };
        return list;
      },
      error: `station-server-darwin-arm64.tar.gz.json: built for v${PREVIEW.version} (preview) at ${'e'.repeat(40)}, not v${PREVIEW.version} (preview) at ${PREVIEW.sha}`,
    },
    {
      name: 'an unsupported target',
      descriptors: () => [...all(), descriptor('win32', 'arm64', 'zip')],
      error:
        'station-server-win32-arm64.zip.json: not a supported archive descriptor',
    },
    {
      name: 'a rolling base URL',
      descriptors: all,
      options: {
        '--base-url':
          'https://github.com/kontourai/station/releases/latest/download/',
      },
      error: `--base-url must name the versioned release v${PREVIEW.version}, not a rolling pointer`,
    },
    {
      name: 'a base URL for another release',
      descriptors: all,
      options: {
        '--base-url':
          'https://github.com/kontourai/station/releases/download/v0.7.0-preview.2/',
      },
      error: `--base-url must name the versioned release v${PREVIEW.version}, not a rolling pointer`,
    },
    {
      name: 'an http base URL',
      descriptors: all,
      options: { '--base-url': BASE_URL.replace('https:', 'http:') },
      error: '--base-url must be a canonical HTTPS URL ending in a slash',
    },
    {
      name: 'an empty descriptor directory',
      descriptors: () => [],
      error: 'no archive descriptors found under',
    },
  ];

  it.each(REFUSALS)('refuses $name', ({ descriptors, options, error }) => {
    const dir = makeTempDir('station-release-manifest-refuse-');
    if (descriptors().length === 0)
      mkdirSync(join(dir, 'descriptors'), { recursive: true });
    const result = assemble(dir, descriptors(), options);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(error);
    expect(result.written).toBe(false);
  });
});

describe('shared release manifest verifier (#2675)', () => {
  const payload = () => verifyReleaseManifest(nightly(platformPayload()), KEYS);

  it('refuses a validly signed manifest for another expected channel', () => {
    const envelope = nightly(platformPayload());
    expect(
      verifyReleaseManifest(envelope, KEYS, { expectedChannel: 'nightly' })
        .version,
    ).toBe('0.7.0-nightly.12');
    expect(() =>
      verifyReleaseManifest(envelope, KEYS, { expectedChannel: 'stable' }),
    ).toThrow(
      'manifest channel nightly does not match the expected channel stable',
    );
  });

  it('selects the host platform artifact and refuses one it does not publish', () => {
    const verified: ReleaseManifestPayload = payload();
    expect(selectArtifact(verified, 'win32', 'x64')).toEqual(artifacts()[4]);
    expect(selectArtifact(verified, 'linux', 'arm64').name).toBe(
      'station-server-linux-arm64.tar.gz',
    );
    expect(() => selectArtifact(verified, 'win32', 'arm64')).toThrow(
      'the release manifest has no server archive for win32-arm64',
    );
  });
});
