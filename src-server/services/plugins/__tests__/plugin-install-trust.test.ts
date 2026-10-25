/**
 * Signer pinning, `plugins.lock` membership, provenance and tier decisions
 * (#2998). Identities come from real Sigstore bundles verified offline by
 * `plugin-sigstore-verifier.ts`; see that test for fixture provenance. The
 * test pin stands in for Station's (still empty) Kontour pin, pointing at
 * astral-sh/uv's release workflow.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  decidePluginTrust,
  matchesSignerPin,
  PluginsLockError,
  type PluginsLockMembership,
  parsePluginsLock,
  pluginProvenance,
  pluginSigner,
  type SigstoreSignerPin,
  type VerifiedPluginSignature,
} from '../plugin-install-trust.js';
import {
  createPluginSigstoreVerifier,
  type SigstoreCertificateIdentity,
} from '../plugin-sigstore-verifier.js';

const verifier = createPluginSigstoreVerifier();

function verifiedIdentity(
  name: string,
  artifactDigest: string,
): SigstoreCertificateIdentity {
  // The fixture file's own bytes, exactly as captured.
  const bundleBytes = readFileSync(
    new URL(`../__fixtures__/sigstore/${name}.sigstore.json`, import.meta.url),
  );
  const result = verifier.verify({ bundleBytes, artifactDigest });
  if (result.state !== 'verified')
    throw new Error(`fixture ${name} did not verify: ${result.reason}`);
  return result.identity;
}

const UV_0135_DIGEST =
  'sha256:138cb5269b045cb3da1caa0de6295b0a8d8d97d02377b56972a4c46f9811185d';
const UV_0134_DIGEST =
  'sha256:23827f3966eec04bdddc62eb418de9bb7dcb8dc5f3c956addc26f84dd7dfbeca';
const RUFF_DIGEST =
  'sha256:32d7fb690b8096f0940544e5191f2845b4c6499c1d1925c21810783d5418c7af';
const uv0135 = verifiedIdentity('uv-0.13.5-dist-manifest.slsa', UV_0135_DIGEST);
const uv0134 = verifiedIdentity('uv-0.13.4-dist-manifest.slsa', UV_0134_DIGEST);
const ruff = verifiedIdentity('ruff-0.17.2-dist-manifest.slsa', RUFF_DIGEST);

const TEST_PIN: SigstoreSignerPin = {
  issuer: 'https://token.actions.githubusercontent.com',
  repository: 'astral-sh/uv',
  repositoryId: '699532645',
  ownerId: '115962839',
  workflowPath: '.github/workflows/release.yml',
  refPattern: 'refs/heads/main',
  trigger: 'workflow_dispatch',
  runnerEnvironment: 'github-hosted',
};
const PINS = [TEST_PIN];
const LOCKED_NAME = 'fixture-coding';

function lockOf(...names: string[]): PluginsLockMembership {
  return parsePluginsLock(
    {
      version: 1,
      plugins: names.map((name) => ({ name, sigstoreIdentity: TEST_PIN })),
    },
    PINS,
  );
}

function sigstore(
  identity: SigstoreCertificateIdentity,
): VerifiedPluginSignature {
  return { kind: 'sigstore', identity };
}

describe('pinned identity matching', () => {
  test('the pinned workflow identity matches every release it signs', () => {
    expect(matchesSignerPin(uv0135, TEST_PIN)).toBe(true);
    expect(matchesSignerPin(uv0134, TEST_PIN)).toBe(true);
  });

  test('each pinned field refuses a mismatch on its own', () => {
    const variants: Array<[string, Partial<SigstoreSignerPin>]> = [
      ['wrong repository', { repository: 'astral-sh/ruff' }],
      ['wrong repository id (re-created repository)', { repositoryId: '1' }],
      ['wrong owner id', { ownerId: '1' }],
      ['wrong workflow path', { workflowPath: '.github/workflows/ci.yml' }],
      ['wrong ref (release tags only)', { refPattern: 'refs/tags/v*' }],
      ['wrong trigger', { trigger: 'push' }],
      ['wrong issuer', { issuer: 'https://accounts.google.com' }],
    ];
    for (const [label, change] of variants) {
      expect(matchesSignerPin(uv0135, { ...TEST_PIN, ...change }), label).toBe(
        false,
      );
    }
  });

  test('a pattern ref matches only within one path segment', () => {
    const tagged: SigstoreCertificateIdentity = {
      ...uv0135,
      sourceRepositoryRef: 'refs/tags/v1.2.0',
      subjectAlternativeName:
        'https://github.com/astral-sh/uv/.github/workflows/release.yml@refs/tags/v1.2.0',
      buildConfigUri:
        'https://github.com/astral-sh/uv/.github/workflows/release.yml@refs/tags/v1.2.0',
    };
    const pin = { ...TEST_PIN, refPattern: 'refs/tags/v*' };
    expect(matchesSignerPin(tagged, pin)).toBe(true);
    expect(
      matchesSignerPin(
        {
          ...tagged,
          sourceRepositoryRef: 'refs/tags/v1/evil',
          subjectAlternativeName: `${tagged.subjectAlternativeName.split('@')[0]}@refs/tags/v1/evil`,
          buildConfigUri: `${tagged.subjectAlternativeName.split('@')[0]}@refs/tags/v1/evil`,
        },
        pin,
      ),
    ).toBe(false);
  });

  test('a reusable workflow hosted elsewhere does not stand in for the pinned file', () => {
    const reusable = {
      ...uv0135,
      // The pinned file is the top-level workflow; the signing job runs in
      // a reusable workflow it calls from another repository.
      subjectAlternativeName:
        'https://github.com/someone/else/.github/workflows/release.yml@refs/heads/main',
      buildConfigUri: uv0135.subjectAlternativeName,
    };
    expect(matchesSignerPin(reusable, TEST_PIN)).toBe(false);
  });

  test('another workflow calling the pinned file through workflow_call does not match', () => {
    const called = {
      ...uv0135,
      buildConfigUri:
        'https://github.com/astral-sh/uv/.github/workflows/wrapper.yml@refs/heads/main',
    };
    expect(matchesSignerPin(called, TEST_PIN)).toBe(false);
  });

  test('a self-hosted runner does not match a github-hosted pin', () => {
    expect(ruff.runnerEnvironment).toBe('self-hosted');
    expect(
      matchesSignerPin(ruff, {
        ...TEST_PIN,
        repository: 'astral-sh/ruff',
        repositoryId: ruff.repositoryId,
      }),
    ).toBe(false);
  });
});

describe('plugins.lock membership', () => {
  test('an entry naming a pinned identity is a member', () => {
    expect([...lockOf('a-plugin', LOCKED_NAME).keys()]).toEqual([
      'a-plugin',
      LOCKED_NAME,
    ]);
  });

  test('malformed or widening locks are refused', () => {
    const cases: Array<[string, unknown]> = [
      [
        'identity that is not pinned',
        {
          version: 1,
          plugins: [
            {
              name: LOCKED_NAME,
              sigstoreIdentity: { ...TEST_PIN, repository: 'astral-sh/ruff' },
            },
          ],
        },
      ],
      [
        'unsorted names',
        {
          version: 1,
          plugins: ['b', 'a'].map((name) => ({
            name,
            sigstoreIdentity: TEST_PIN,
          })),
        },
      ],
      [
        'duplicate names',
        {
          version: 1,
          plugins: ['a', 'a'].map((name) => ({
            name,
            sigstoreIdentity: TEST_PIN,
          })),
        },
      ],
      [
        'unknown entry field',
        {
          version: 1,
          plugins: [
            { name: 'a', sigstoreIdentity: TEST_PIN, capabilities: ['x'] },
          ],
        },
      ],
      [
        'non-canonical name',
        {
          version: 1,
          plugins: [{ name: 'Bad Name', sigstoreIdentity: TEST_PIN }],
        },
      ],
      ['wrong version', { version: 2, plugins: [] }],
      [
        'more than 256 entries',
        {
          version: 1,
          plugins: Array.from({ length: 257 }, (_, index) => ({
            name: `p${String(index).padStart(3, '0')}`,
            sigstoreIdentity: TEST_PIN,
          })),
        },
      ],
    ];
    for (const [label, lock] of cases) {
      expect(() => parsePluginsLock(lock, PINS), label).toThrow(
        PluginsLockError,
      );
    }
  });

  test('with no pinned identity, no lock entry is accepted', () => {
    expect(() =>
      parsePluginsLock(
        {
          version: 1,
          plugins: [{ name: LOCKED_NAME, sigstoreIdentity: TEST_PIN }],
        },
        [],
      ),
    ).toThrow(PluginsLockError);
  });
});

describe('provenance', () => {
  const lock = lockOf(LOCKED_NAME);

  test('pinned identity plus a lock entry for the manifest name is kontour', () => {
    expect(
      pluginProvenance({
        signature: sigstore(uv0135),
        manifestName: LOCKED_NAME,
        pins: PINS,
        lock,
      }),
    ).toBe('kontour');
  });

  test('the pinned identity releasing a name outside the lock is publisher', () => {
    expect(
      pluginProvenance({
        signature: sigstore(uv0135),
        manifestName: 'starter-template',
        pins: PINS,
        lock,
      }),
    ).toBe('publisher');
  });

  test('lock-name squatting: another verified identity shipping a locked name is publisher', () => {
    expect(
      pluginProvenance({
        signature: sigstore(ruff),
        manifestName: LOCKED_NAME,
        pins: PINS,
        lock,
      }),
    ).toBe('publisher');
  });

  test('a lock entry naming pin A does not make a release signed under pin B kontour', () => {
    // Pin A covers release tags only, which uv's main-branch run does not
    // match; pin B covers that run. The entry names A.
    const pinA = { ...TEST_PIN, refPattern: 'refs/tags/v*' };
    const pinB = TEST_PIN;
    const pins = [pinA, pinB];
    expect(matchesSignerPin(uv0135, pinA)).toBe(false);
    expect(matchesSignerPin(uv0135, pinB)).toBe(true);
    const lockNamingA = parsePluginsLock(
      {
        version: 1,
        plugins: [{ name: LOCKED_NAME, sigstoreIdentity: pinA }],
      },
      pins,
    );
    expect(
      pluginProvenance({
        signature: sigstore(uv0135),
        manifestName: LOCKED_NAME,
        pins,
        lock: lockNamingA,
      }),
    ).toBe('publisher');
  });

  test('a wrong ref under the pinned repository and workflow is publisher', () => {
    expect(
      pluginProvenance({
        signature: sigstore(uv0135),
        manifestName: LOCKED_NAME,
        pins: [{ ...TEST_PIN, refPattern: 'refs/tags/v*' }],
        lock: parsePluginsLock(
          {
            version: 1,
            plugins: [
              {
                name: LOCKED_NAME,
                sigstoreIdentity: { ...TEST_PIN, refPattern: 'refs/tags/v*' },
              },
            ],
          },
          [{ ...TEST_PIN, refPattern: 'refs/tags/v*' }],
        ),
      }),
    ).toBe('publisher');
  });

  test('a registry ed25519 signer is publisher and no signature is unsigned', () => {
    const base = { manifestName: LOCKED_NAME, pins: PINS, lock };
    expect(
      pluginProvenance({
        ...base,
        signature: { kind: 'ed25519', keyId: 'primary', keyFingerprint: 'f' },
      }),
    ).toBe('publisher');
    expect(pluginProvenance({ ...base, signature: null })).toBe('unsigned');
  });
});

describe('tier decisions (d1 acceptance)', () => {
  const lock = lockOf(LOCKED_NAME);

  function install(
    signature: VerifiedPluginSignature,
    contentDigest: string,
    previous: Parameters<typeof decidePluginTrust>[0]['previous'],
  ) {
    const provenance = pluginProvenance({
      signature,
      manifestName: LOCKED_NAME,
      pins: PINS,
      lock,
    });
    const signer = pluginSigner(signature);
    return {
      signer,
      provenance,
      decision: decidePluginTrust({
        previous,
        signer,
        provenance,
        contentDigest,
      }),
    };
  }

  test('a new unsigned install records tier 3', () => {
    expect(install(null, UV_0135_DIGEST, null)).toEqual({
      signer: null,
      provenance: 'unsigned',
      decision: { kind: 'initial', tier: 3 },
    });
  });

  test('a new kontour install records tier 2', () => {
    expect(install(sigstore(uv0135), UV_0135_DIGEST, null)).toEqual({
      provenance: 'kontour',
      signer: {
        kind: 'sigstore',
        issuer: 'https://token.actions.githubusercontent.com',
        identity:
          'https://github.com/astral-sh/uv/.github/workflows/release.yml',
        repositoryId: '699532645',
        ownerId: '115962839',
      },
      decision: { kind: 'initial', tier: 2 },
    });
  });

  test('a changed digest under the same pinned identity keeps the tier', () => {
    const first = install(sigstore(uv0134), UV_0134_DIGEST, null);
    for (const tier of [2, 3] as const) {
      expect(
        install(sigstore(uv0135), UV_0135_DIGEST, {
          signer: first.signer,
          contentDigest: UV_0134_DIGEST,
          tier,
        }).decision,
      ).toEqual({ kind: 'inherited', tier });
    }
  });

  test('the pinned workflow run from another branch by push never inherits tier 2', () => {
    // The security review's reproduction: same workflow file, so the same
    // signer, but a ref and trigger the pin does not admit.
    const branch: SigstoreCertificateIdentity = {
      ...uv0135,
      sourceRepositoryRef: 'refs/heads/attacker',
      trigger: 'push',
      subjectAlternativeName:
        'https://github.com/astral-sh/uv/.github/workflows/release.yml@refs/heads/attacker',
      buildConfigUri:
        'https://github.com/astral-sh/uv/.github/workflows/release.yml@refs/heads/attacker',
    };
    const first = install(sigstore(uv0135), UV_0135_DIGEST, null);
    expect(first.decision).toEqual({ kind: 'initial', tier: 2 });
    const update = install(sigstore(branch), UV_0134_DIGEST, {
      signer: first.signer,
      contentDigest: UV_0135_DIGEST,
      tier: 2,
    });
    expect(update.signer).toEqual(first.signer);
    expect(update).toMatchObject({
      provenance: 'publisher',
      decision: {
        kind: 'new-decision',
        reason: 'tier-exceeds-provenance',
        tier: 3,
      },
    });
  });

  test('a publisher update under the same signer keeps tier 3 but never keeps tier 2', () => {
    const publisherSigner = pluginSigner(sigstore(ruff));
    const update = (tier: 2 | 3) =>
      decidePluginTrust({
        previous: {
          signer: publisherSigner,
          contentDigest: UV_0134_DIGEST,
          tier,
        },
        signer: publisherSigner,
        provenance: 'publisher',
        contentDigest: RUFF_DIGEST,
      });
    expect(update(3)).toEqual({ kind: 'inherited', tier: 3 });
    expect(update(2)).toEqual({
      kind: 'new-decision',
      reason: 'tier-exceeds-provenance',
      tier: 3,
    });
  });

  test('a different identity produces a new, untrusted decision', () => {
    const first = install(sigstore(uv0135), UV_0135_DIGEST, null);
    expect(
      install(sigstore(ruff), RUFF_DIGEST, {
        signer: first.signer,
        contentDigest: UV_0135_DIGEST,
        tier: 2,
      }),
    ).toMatchObject({
      provenance: 'publisher',
      decision: { kind: 'new-decision', reason: 'signer-changed', tier: 3 },
    });
  });

  test('a registry key change is a new decision even under the same key label', () => {
    const before = pluginSigner({
      kind: 'ed25519',
      keyId: 'primary',
      keyFingerprint: 'a'.repeat(64),
    });
    expect(
      decidePluginTrust({
        previous: { signer: before, contentDigest: UV_0134_DIGEST, tier: 2 },
        signer: pluginSigner({
          kind: 'ed25519',
          keyId: 'primary',
          keyFingerprint: 'b'.repeat(64),
        }),
        provenance: 'publisher',
        contentDigest: UV_0135_DIGEST,
      }),
    ).toEqual({ kind: 'new-decision', reason: 'signer-changed', tier: 3 });
  });

  test('an unsigned plugin has no pin, so changed bytes are a new decision; same bytes are unchanged', () => {
    const previous = {
      signer: null,
      contentDigest: UV_0134_DIGEST,
      tier: 2 as const,
    };
    expect(install(null, UV_0135_DIGEST, previous).decision).toEqual({
      kind: 'new-decision',
      reason: 'unsigned-content-changed',
      tier: 3,
    });
    expect(install(null, UV_0134_DIGEST, previous).decision).toEqual({
      kind: 'unchanged',
      tier: 2,
    });
  });

  test('a signature appearing on a previously unsigned plugin is a signer change', () => {
    expect(
      install(sigstore(uv0135), UV_0135_DIGEST, {
        signer: null,
        contentDigest: UV_0134_DIGEST,
        tier: 3,
      }).decision,
    ).toEqual({ kind: 'new-decision', reason: 'signer-changed', tier: 2 });
  });
});

describe('pinned signer identity', () => {
  test('strips exactly the source ref, even when the ref contains @', () => {
    const ref = 'refs/tags/v1@beta';
    const identity: SigstoreCertificateIdentity = {
      ...uv0135,
      sourceRepositoryRef: ref,
      subjectAlternativeName: `https://github.com/astral-sh/uv/.github/workflows/release.yml@${ref}`,
      buildConfigUri: `https://github.com/astral-sh/uv/.github/workflows/release.yml@${ref}`,
    };
    expect(pluginSigner(sigstore(identity))).toMatchObject({
      identity: 'https://github.com/astral-sh/uv/.github/workflows/release.yml',
    });
  });

  test('a SAN at a ref other than the source ref is kept whole', () => {
    const identity: SigstoreCertificateIdentity = {
      ...uv0135,
      subjectAlternativeName:
        'https://github.com/someone/else/.github/workflows/release.yml@refs/tags/v2',
    };
    expect(pluginSigner(sigstore(identity))).toMatchObject({
      identity:
        'https://github.com/someone/else/.github/workflows/release.yml@refs/tags/v2',
    });
  });
});
