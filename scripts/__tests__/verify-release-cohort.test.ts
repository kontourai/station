import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  assertNightlyVersionRelationship,
  ghAttestationArgs,
  parseAndroidManifestIdentity,
  parseGithubReleaseObservation,
  parseGithubTagReference,
  parseLatestUpdaterManifest,
  parseMacosInfoPlist,
  parseVerifiedAttestation,
} from '../verify-release-cohort.mjs';

const sourceSha = 'a'.repeat(40);
const identity = {
  android: {
    packageName: 'io.kontourai.station.nightly',
    versionCode: 242800,
    versionName: '0.1.3-nightly.2428',
  },
  desktop: {
    bundleVersion: '242800',
    releaseTag: 'nightly-desktop',
    version: '0.1.3-nightly.2428',
  },
};
const macRecords = [
  { name: 'latest.json', sha256: '1'.repeat(64), size: 1 },
  {
    name: 'station-nightly-desktop-macos-aarch64.app.tar.gz',
    sha256: '2'.repeat(64),
    size: 2,
  },
  {
    name: 'station-nightly-desktop-macos-aarch64.app.tar.gz.sig',
    sha256: '3'.repeat(64),
    size: 3,
  },
  {
    name: 'station-nightly-desktop-macos-aarch64.dmg',
    sha256: '4'.repeat(64),
    size: 4,
  },
];
const certificate = {
  certificateIssuer: 'CN=Fulcio',
  issuer: 'https://token.actions.githubusercontent.com',
  subjectAlternativeName:
    'https://github.com/kontourai/station/.github/workflows/nightly-native-cohort.yml@refs/heads/main',
  runInvocationURI:
    'https://github.com/kontourai/station/actions/runs/112061/attempts/1',
};
const attestation = (record: any) => [
  {
    attestation: { id: 'bundle' },
    verificationResult: {
      signature: { certificate },
      verifiedTimestamps: [
        {
          type: 'tlog',
          uri: 'https://rekor.sigstore.dev',
          timestamp: '2026-08-30T00:00:00.000Z',
        },
      ],
      statement: { subject: [{ digest: { sha256: record.sha256 } }] },
    },
  },
];

describe('protected release cohort verifier parsers', () => {
  test('uses exact non-shell attestation arguments accepted by gh before network', () => {
    const args = ghAttestationArgs('literal;not-a-shell.aab', sourceSha);
    expect(args).toEqual([
      'attestation',
      'verify',
      'literal;not-a-shell.aab',
      '--repo',
      'kontourai/station',
      '--source-ref',
      'refs/heads/main',
      '--source-digest',
      sourceSha,
      '--cert-identity',
      'https://github.com/kontourai/station/.github/workflows/nightly-native-cohort.yml@refs/heads/main',
      '--cert-oidc-issuer',
      'https://token.actions.githubusercontent.com',
      '--deny-self-hosted-runners',
      '--format',
      'json',
    ]);
    const result = spawnSync('gh', args, {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 30_000,
    });
    expect(`${result.stderr}${result.stdout}`).not.toMatch(
      /mutually exclusive|cannot be used with/i,
    );
  });

  test('accepts only authenticated certificate facts, verified timestamp, and staged subject', () => {
    const record = { name: 'asset', sha256: 'c'.repeat(64), size: 1 };
    expect(
      parseVerifiedAttestation(
        attestation(record),
        record,
        sourceSha,
        '112061',
        new Date('2026-08-30T00:01:00.000Z'),
      ),
    ).toMatchObject({
      subjectDigest: `sha256:${record.sha256}`,
      authenticatedWorkflowRunId: '112061',
      verifiedTimestampDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    for (const mutate of [
      (value: any) =>
        (value[0].verificationResult.signature.certificate.issuer = 'other'),
      (value: any) => (value[0].verificationResult.verifiedTimestamps = []),
      (value: any) =>
        (value[0].verificationResult.statement.subject[0].digest.sha256 =
          'd'.repeat(64)),
    ]) {
      const value = structuredClone(attestation(record));
      mutate(value);
      expect(() =>
        parseVerifiedAttestation(
          value,
          record,
          sourceSha,
          '112061',
          new Date('2026-08-30T00:01:00.000Z'),
        ),
      ).toThrow('exactly one');
    }
  });

  test('requires one coherent Nightly Android/macOS identity and parses AAB manifest identity', () => {
    expect(assertNightlyVersionRelationship(identity)).toMatchObject({
      day: 2428,
    });
    expect(() =>
      assertNightlyVersionRelationship({
        ...identity,
        desktop: { ...identity.desktop, bundleVersion: '242801' },
      }),
    ).toThrow('one nightly-build identity');
    expect(
      assertNightlyVersionRelationship({
        android: {
          ...identity.android,
          versionCode: 242807,
          versionName: '0.1.3-nightly.2428.7',
        },
        desktop: {
          ...identity.desktop,
          bundleVersion: '242807',
          version: '0.1.3-nightly.2428.7',
        },
      }),
    ).toMatchObject({ day: 2428, build: 7 });
    expect(
      parseAndroidManifestIdentity(
        '<manifest package="io.kontourai.station.nightly" android:versionCode="242800" android:versionName="0.1.3-nightly.2428"/>',
      ),
    ).toEqual(identity.android);
  });

  test('requires exact mutable-release tag, delivery inventory, provider state, and updater manifest', () => {
    const tag = parseGithubTagReference(
      {
        ref: 'refs/tags/nightly-desktop',
        object: { type: 'commit', sha: sourceSha },
      },
      identity.desktop.releaseTag,
      sourceSha,
    );
    const release = {
      id: 9,
      url: 'https://api.github.test/releases/9',
      tag_name: 'nightly-desktop',
      target_commitish: 'main',
      draft: false,
      prerelease: true,
      published_at: '2026-08-30T00:00:00.000Z',
      assets: macRecords.map((record, index) => ({
        id: index + 1,
        ...record,
        digest: `sha256:${record.sha256}`,
        url: `https://api.github.test/assets/${index + 1}`,
        browser_download_url: `https://github.test/${record.name}`,
      })),
    };
    expect(
      parseGithubReleaseObservation(
        release,
        { ...identity.desktop, sourceSha },
        macRecords,
        tag,
        new Date('2026-08-30T00:01:00.000Z'),
      ),
    ).toMatchObject({
      provider: 'github-releases',
      observedAt: expect.any(String),
    });
    expect(() =>
      parseGithubTagReference(
        {
          ref: 'refs/tags/nightly-desktop',
          object: { type: 'commit', sha: 'b'.repeat(40) },
        },
        identity.desktop.releaseTag,
        sourceSha,
      ),
    ).toThrow('exact cohort source SHA');
    expect(() =>
      parseGithubReleaseObservation(
        { ...release, draft: true },
        { ...identity.desktop, sourceSha },
        macRecords,
        tag,
        new Date('2026-08-30T00:01:00.000Z'),
      ),
    ).toThrow('rolling tag');
    expect(
      parseLatestUpdaterManifest(
        Buffer.from(
          JSON.stringify({
            version: identity.desktop.version,
            platforms: {
              'darwin-aarch64': {
                url: 'https://github.com/kontourai/station/releases/download/nightly-desktop/station-nightly-desktop-macos-aarch64.app.tar.gz',
                signature: 'signature',
              },
            },
          }),
        ),
        identity.desktop,
        Buffer.from('signature\n'),
      ),
    ).toMatchObject({ version: identity.desktop.version });
  });

  test('keeps final receipt construction out of structural cohort code', () => {
    const structural = readFileSync(
      join(process.cwd(), 'scripts/release-cohort.mjs'),
      'utf8',
    );
    const verifier = readFileSync(
      join(process.cwd(), 'scripts/verify-release-cohort.mjs'),
      'utf8',
    );
    expect(structural).not.toContain('station.release-cohort-final/v1');
    expect(verifier).toMatch(
      /async function main[\s\S]*station\.release-cohort-final\/v1/,
    );
    expect(verifier).toContain('defaultSpawnSync(apkanalyzer.apkanalyzerPath');
    expect(verifier).toContain("['-xOzf', path, '--', plists[0]]");
    expect(verifier).not.toContain("['-xzf', path, '-C'");
    expect(verifier).not.toContain('mkdtempSync');
  });

  test('parses only required string Info.plist identity fields', () => {
    expect(
      parseMacosInfoPlist(
        JSON.stringify({
          CFBundleIdentifier: 'io.kontourai.station.nightly',
          CFBundleShortVersionString: identity.desktop.version,
          CFBundleVersion: identity.desktop.bundleVersion,
        }),
      ),
    ).toMatchObject({ CFBundleVersion: identity.desktop.bundleVersion });
    expect(() => parseMacosInfoPlist('')).toThrow('not valid JSON');
    expect(() => parseMacosInfoPlist('{}')).toThrow('required string identity');
  });
});
