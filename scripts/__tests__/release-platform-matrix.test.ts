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
      sha: '15401e2708722905149cbe54003bafc448d19848',
    });
    expect(nightlyDesktop?.currentEvidence).toMatchObject({
      status: 'VERIFIED',
      sha: '15401e2708722905149cbe54003bafc448d19848',
    });
    expect(stableIos?.currentEvidence).toMatchObject({
      status: 'NOT_VERIFIED',
      owner: '#844',
    });
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
