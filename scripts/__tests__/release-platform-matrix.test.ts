import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  projectReleasePlatformMatrix,
  readReleasePlatformMatrix,
  validateReleasePlatformMatrix,
} from '../release-platform-matrix.mjs';

const root = resolve(import.meta.dirname, '../..');
const ledger = JSON.parse(
  readFileSync(resolve(root, 'docs/reference/deploy-ledger.json'), 'utf8'),
);

describe('cross-platform release invariant matrix', () => {
  test('declares every channel and platform cell and binds configured jobs to workflows', () => {
    const matrix = readReleasePlatformMatrix();
    expect(validateReleasePlatformMatrix({ matrix, root, ledger })).toEqual([]);
    expect(Object.keys(matrix.cells)).toEqual([
      'development',
      'nightly',
      'preview',
      'stable',
    ]);
    for (const cells of Object.values(matrix.cells) as Record<string, any>[]) {
      expect(Object.keys(cells)).toEqual([
        'web-portable',
        'macos',
        'windows',
        'linux',
        'android',
        'ios',
      ]);
    }
  });

  test('derives evidence from receipts instead of hand-maintained green prose', () => {
    const matrix = readReleasePlatformMatrix();
    // A synthetic newest-first ledger (the order scripts/deploy-ledger.mjs
    // writes), so the derivation is proven independently of today's receipts.
    const newestDesktop = {
      channel: 'nightly-desktop',
      sha: 'c'.repeat(40),
      version: 'nightly-two',
      workflowRunUrl: 'https://example.test/run/2',
      timestampUtc: '2026-08-30T00:00:00Z',
    };
    const receiptLedger = [
      newestDesktop,
      { ...newestDesktop, channel: 'nightly-npm', sha: 'e'.repeat(40) },
      {
        ...newestDesktop,
        sha: 'd'.repeat(40),
        version: 'nightly-one',
        workflowRunUrl: 'https://example.test/run/1',
        timestampUtc: '2026-08-29T00:00:00Z',
      },
    ];
    const cell = (
      projection: ReturnType<typeof projectReleasePlatformMatrix>,
      channel: string,
      platform: string,
    ) =>
      projection.cells.find(
        (candidate) =>
          candidate.channel === channel && candidate.platform === platform,
      );
    const projection = projectReleasePlatformMatrix({
      matrix,
      ledger: receiptLedger,
    });
    const nightlyDesktop = cell(projection, 'nightly', 'macos');
    expect(nightlyDesktop?.currentEvidence).toEqual({
      status: 'VERIFIED',
      sha: newestDesktop.sha,
      version: newestDesktop.version,
      workflowRunUrl: newestDesktop.workflowRunUrl,
      observedAt: newestDesktop.timestampUtc,
    });
    // A ledger-backed cell without its receipt stays NOT_VERIFIED; another
    // channel's receipt never stands in for it.
    const nightlyAndroid = cell(projection, 'nightly', 'android');
    expect(nightlyAndroid?.currentEvidence).toEqual({
      status: 'NOT_VERIFIED',
      owner: '#844',
      reason: 'No nightly-android deploy-ledger entry exists.',
    });
    // Cells without a receipt source never turn green from the ledger.
    const nightlyWindows = cell(projection, 'nightly', 'windows');
    const nightlyIos = cell(projection, 'nightly', 'ios');
    for (const unverified of [nightlyWindows, nightlyIos]) {
      expect(unverified?.currentEvidence.status).toBe('NOT_VERIFIED');
    }
    // Each platform is required for its own promotion; the cohort publishes
    // per platform and discloses a partial night rather than withholding the
    // other platform (#1774).
    for (const required of [nightlyAndroid, nightlyDesktop, nightlyWindows]) {
      expect(required).toMatchObject({
        requiredForPromotion: true,
        availabilityPolicy: expect.stringContaining(
          'per-platform-native-cohort',
        ),
      });
      expect(required?.availabilityPolicy).not.toContain('atomic');
    }
    // Nightly iOS is delivered outside the atomic chain (#1774): its policy
    // must say so rather than claim a recovery lock the workflow never writes
    // for it, and its evidence stays NOT_VERIFIED until a processed channel
    // receipt exists.
    expect(nightlyIos).toMatchObject({
      requiredForPromotion: false,
      availabilityPolicy: expect.stringContaining('#1774'),
    });
    expect(nightlyIos?.availabilityPolicy).not.toContain(
      'recovery remains locked',
    );
    expect(nightlyIos?.availabilityPolicy).toContain('NOT_VERIFIED');
  });

  test('requires every configured channel receipt to converge on one source SHA', () => {
    const matrix = readReleasePlatformMatrix();
    const sharedSha = 'a'.repeat(40);
    const companionLedger = [
      {
        channel: 'nightly-android',
        sha: sharedSha,
        version: 'nightly-one',
        workflowRunUrl: 'https://example.test/run',
        timestampUtc: '2026-08-29T00:00:00Z',
      },
      {
        channel: 'nightly-desktop',
        sha: sharedSha,
        version: 'nightly-one',
        workflowRunUrl: 'https://example.test/run',
        timestampUtc: '2026-08-29T00:00:00Z',
      },
    ];
    const converged = projectReleasePlatformMatrix({
      matrix,
      ledger: companionLedger,
    }).channelEvidence.find((entry) => entry.channel === 'nightly');
    // The iOS channel is automated but has no provider receipt until Apple
    // accepts the first build. Two sibling receipts alone cannot make a
    // four-platform Nightly claim green.
    expect(converged).toMatchObject({
      status: 'NOT_VERIFIED',
      sourceSha: null,
      configuredPlatforms: ['macos', 'windows', 'android', 'ios'],
      verifiedPlatforms: ['macos', 'android'],
    });

    companionLedger[0].sha = 'b'.repeat(40);
    const divergent = projectReleasePlatformMatrix({
      matrix,
      ledger: companionLedger,
    }).channelEvidence.find((entry) => entry.channel === 'nightly');
    expect(divergent).toMatchObject({
      status: 'NOT_VERIFIED',
      sourceSha: null,
      reason: 'Configured nightly receipts disagree on source SHA.',
    });
  });

  test('limits the Linux in-app updater authority to AppImage packages', () => {
    const matrix = readReleasePlatformMatrix();
    for (const channel of ['preview', 'stable']) {
      expect(matrix.cells[channel].linux.updateAuthority).toContain(
        'AppImage only',
      );
      expect(matrix.cells[channel].linux.updateAuthority).toContain(
        'deb/rpm have no in-app updater',
      );
      expect(matrix.cells[channel].macos.updateAuthority).not.toContain(
        'AppImage',
      );
    }
  });

  test('fails when a platform disappears or configured job is unowned', () => {
    const missing = structuredClone(readReleasePlatformMatrix());
    delete missing.cells.stable.ios;
    expect(
      validateReleasePlatformMatrix({ matrix: missing, root, ledger }),
    ).toContain('missing cell stable:ios');

    const demoted = structuredClone(readReleasePlatformMatrix());
    demoted.cells.nightly.windows.requiredForPromotion = false;
    expect(
      validateReleasePlatformMatrix({ matrix: demoted, root, ledger }),
    ).toContain('nightly:windows.requiredForPromotion must be true');

    const unowned = structuredClone(readReleasePlatformMatrix());
    unowned.cells.stable.ios.buildJob = 'release.yml#missing-job';
    expect(
      validateReleasePlatformMatrix({ matrix: unowned, root, ledger }),
    ).toContain(
      'stable:ios.buildJob references missing release.yml#missing-job',
    );
  });
});
