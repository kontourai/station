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
    const projection = projectReleasePlatformMatrix({ matrix, ledger });
    const nightlyAndroid = projection.cells.find(
      (cell) => cell.channel === 'nightly' && cell.platform === 'android',
    );
    const nightlyDesktop = projection.cells.find(
      (cell) => cell.channel === 'nightly' && cell.platform === 'macos',
    );
    const stableIos = projection.cells.find(
      (cell) => cell.channel === 'stable' && cell.platform === 'ios',
    );
    expect(nightlyAndroid?.currentEvidence).toMatchObject({
      status: 'VERIFIED',
      sha: ledger.find((entry: any) => entry.channel === 'nightly-android').sha,
    });
    expect(nightlyDesktop?.currentEvidence).toMatchObject({
      status: 'VERIFIED',
      sha: ledger.find((entry: any) => entry.channel === 'nightly-desktop').sha,
    });
    expect(stableIos?.currentEvidence).toMatchObject({
      status: 'NOT_VERIFIED',
      owner: '#844',
    });
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
    expect(converged).toMatchObject({
      status: 'VERIFIED',
      sourceSha: sharedSha,
      configuredPlatforms: ['macos', 'android'],
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

    const unowned = structuredClone(readReleasePlatformMatrix());
    unowned.cells.stable.ios.buildJob = 'release.yml#missing-job';
    expect(
      validateReleasePlatformMatrix({ matrix: unowned, root, ledger }),
    ).toContain(
      'stable:ios.buildJob references missing release.yml#missing-job',
    );
  });
});
