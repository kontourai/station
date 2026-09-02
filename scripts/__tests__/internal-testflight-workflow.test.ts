import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const source = readFileSync(
  resolve(root, '.github/workflows/internal-testflight.yml'),
  'utf8',
);
const delivery = readFileSync(
  resolve(root, '.github/workflows/testflight-delivery.yml'),
  'utf8',
);
const signingWrapper = readFileSync(
  resolve(root, 'scripts/git-gpg-loopback-sign.sh'),
  'utf8',
);
const workflow = load(source) as {
  on?: Record<string, unknown>;
  jobs?: Record<string, any>;
};

describe('internal iOS TestFlight cohort workflow', () => {
  test('is dispatch-only and binds exactly current main', () => {
    expect(Object.keys(workflow.on ?? {})).toEqual(['workflow_dispatch']);
    expect(workflow.jobs?.plan?.needs).toEqual([
      'admit-stable',
      'admit-beta',
      'admit-nightly',
    ]);
    expect(source).toContain('test "$source_sha" = "$GITHUB_SHA"');
    expect(source).toContain('test "$remote_sha" = "$source_sha"');
    expect(source).toContain('ios-testflight-delivery-policy.mjs');
  });
  test('uses signed immutable internal authority and bounded receipts', () => {
    expect(source).toContain('ios-testflight/$channel/v$VERSION/$build');
    expect(source).toContain('git tag --sign');
    expect(source).toContain('git verify-tag --raw');
    expect(source).toContain('reused-after-race');
    expect(source).toContain('githubTagVerification:"valid"');
    expect(source).toContain('authority-recovery.json');
    expect(source).toContain('authority-gpg-registration.json');
    expect(source).toContain("gh api 'users/briananderson1222/gpg_keys'");
    expect(source).toContain('verify-ios-testflight-gpg-registration.mjs');
    expect(source).toContain(
      "git config user.email 'brian.anderson1222@gmail.com'",
    );
    expect(
      source.indexOf('verify-ios-testflight-gpg-registration.mjs'),
    ).toBeLessThan(source.indexOf('git tag --sign'));
    expect(source).toContain('retention-days: 30');
    expect(signingWrapper).toContain('--pinentry-mode loopback');
    expect(signingWrapper).not.toContain('--passphrase ');
    expect(delivery).toContain('verify-ios-testflight-internal-tag.mjs');
  });
  test('runs TestFlight only in Nightly then Beta then Stable order', () => {
    expect(
      Object.values(workflow.jobs ?? {})
        .map((job) => job?.uses)
        .filter(Boolean),
    ).toEqual([
      './.github/workflows/testflight-delivery.yml',
      './.github/workflows/testflight-delivery.yml',
      './.github/workflows/testflight-delivery.yml',
    ]);
    expect(workflow.jobs?.['deliver-beta']?.needs).toEqual([
      'plan',
      'deliver-nightly',
    ]);
    expect(workflow.jobs?.['deliver-stable']?.needs).toEqual([
      'plan',
      'deliver-beta',
    ]);
  });
  test('contains no public release or other publication surface', () => {
    const reusableCalls = Object.values(workflow.jobs ?? {})
      .map((job) => job?.uses)
      .filter(Boolean);
    expect(reusableCalls).toEqual([
      './.github/workflows/testflight-delivery.yml',
      './.github/workflows/testflight-delivery.yml',
      './.github/workflows/testflight-delivery.yml',
    ]);
    expect(source).not.toMatch(
      /uses:\s+\.\/\.github\/workflows\/(?!testflight-delivery\.yml)/,
    );
    expect(source).not.toContain('appStoreVersionSubmissions');
  });
});
