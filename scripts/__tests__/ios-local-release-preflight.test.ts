import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { localIosReleasePreflight } from '../ios-local-release-preflight.mjs';
import { taggedStoreIdentity } from '../lib/native-release-config.mjs';

const packageVersion = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../..', 'package.json'), 'utf8'),
).version;
const stableTag = `v${packageVersion}`;
const betaTag = `${stableTag}-preview.1`;

const profilePath = resolve(
  import.meta.dirname,
  'fixtures/ios-profiles/app-store-realistic.plist',
);
const profile = readFileSync(profilePath, 'utf8').replace(
  'ABCDE12345.ai.kontour.station',
  'ABCDE12345.io.kontourai.station',
);
const certificate =
  /<key>DeveloperCertificates<\/key>\s*<array>\s*<data>([^<]+)/
    .exec(profile)?.[1]
    ?.trim() ?? '';
const fingerprint = createHash('sha1')
  .update(Buffer.from(certificate, 'base64'))
  .digest('hex')
  .toUpperCase();

function localTools(program: string, args: string[]) {
  if (program === 'security' && args[0] === 'cms') return profile;
  if (program === 'security')
    return `1) ${fingerprint} "Apple Distribution: Kontour (ABCDE12345)"`;
  if (program === 'rustup') return 'aarch64-apple-ios\naarch64-apple-ios-sim';
  if (program === 'git' && args.includes('status')) return '';
  if (program === 'git') return 'same-commit';
  return 'available';
}

describe('local iOS release preflight', () => {
  test('CLI in a path with spaces emits structured blockers for missing arguments', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'station ios preflight '));
    const script = resolve(root, 'ios local release preflight.mjs');
    cpSync(
      resolve(import.meta.dirname, '..', 'ios-local-release-preflight.mjs'),
      script,
    );
    cpSync(
      resolve(import.meta.dirname, '..', 'check-ios-store-profile.mjs'),
      resolve(root, 'check-ios-store-profile.mjs'),
    );
    cpSync(
      resolve(import.meta.dirname, '..', 'product-version.mjs'),
      resolve(root, 'product-version.mjs'),
    );
    cpSync(resolve(import.meta.dirname, '..', 'lib'), resolve(root, 'lib'), {
      recursive: true,
    });
    try {
      let failure: { status?: number; stdout?: string } | undefined;
      try {
        execFileSync(process.execPath, [script], {
          encoding: 'utf8',
          windowsHide: true,
        });
      } catch (error) {
        failure = error as { status?: number; stdout?: string };
      }
      expect(failure?.status).toBe(1);
      expect(JSON.parse(failure?.stdout ?? '')).toMatchObject({
        ready: false,
        blockers: ['Expected --tag <value>'],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('binds an explicit Stable tag, App Store profile, and public identity metadata', () => {
    expect(
      localIosReleasePreflight({
        tag: stableTag,
        profilePath,
        team: 'ABCDE12345',
        identity: 'Apple Distribution: Kontour (ABCDE12345)',
        now: new Date('2026-08-27T00:00:00Z'),
        runCommand: localTools,
      }),
    ).toMatchObject({
      ready: true,
      channel: 'stable',
      expectedBundleIdentifier: 'io.kontourai.station',
      buildNumber: taggedStoreIdentity(stableTag).bundleVersion,
    });
  });

  test('fails closed when a Beta tag is paired with a Stable provisioning profile', () => {
    const result = localIosReleasePreflight({
      tag: betaTag,
      profilePath,
      team: 'ABCDE12345',
      identity: 'Apple Distribution: Kontour (ABCDE12345)',
      now: new Date('2026-08-27T00:00:00Z'),
      runCommand: localTools,
    });
    expect(result.ready).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.stringContaining('does not match expected'),
    );
  });

  test('keeps release tag/package validation fail-closed', () => {
    const result = localIosReleasePreflight({
      tag: 'v0.0.1',
      profilePath,
      team: 'ABCDE12345',
      identity: 'Apple Distribution: Kontour (ABCDE12345)',
      now: new Date('2026-08-27T00:00:00Z'),
      runCommand: localTools,
    });
    expect(result.blockers).toContainEqual(
      expect.stringContaining('tag base version'),
    );
  });
});
