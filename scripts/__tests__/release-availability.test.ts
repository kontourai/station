import { describe, expect, test } from 'vitest';
import { projectReleaseAvailability } from '../release-availability.mjs';

const evidence = (channel: 'preview' | 'stable' = 'preview') => ({
  channel,
  success: true,
  sourceSha: 'a'.repeat(40),
  tag: channel === 'preview' ? 'v1.2.3-preview.1' : 'v1.2.3',
  version: channel === 'preview' ? '1.2.3-preview.1' : '1.2.3',
  inventory: {
    schemaVersion: 2,
    tag: channel === 'preview' ? 'v1.2.3-preview.1' : 'v1.2.3',
    sourceSha: 'a'.repeat(40),
    channel,
  },
  inventorySha: 'b'.repeat(64),
  attestation: { sourceSha: 'a'.repeat(40), inventorySha: 'b'.repeat(64) },
  release: {
    effect: 'published',
    draft: false,
    public: true,
    tag: channel === 'preview' ? 'v1.2.3-preview.1' : 'v1.2.3',
    sourceSha: 'a'.repeat(40),
  },
  sbomPredicates: {
    portable: 'npm/runtime',
    desktop: 'npm/runtime,rust/native',
    mobile: 'npm/runtime,rust/native',
    container: 'container/image',
  },
});

describe('release availability projector', () => {
  test('advances only exact completed preview/stable release evidence idempotently', () => {
    expect(projectReleaseAvailability(['stage:source'], evidence())).toEqual({
      kind: 'preview',
      add: ['stage:preview'],
      remove: ['stage:source'],
    });
    expect(
      projectReleaseAvailability(['stage:preview'], evidence()),
    ).toMatchObject({ kind: 'unchanged' });
    expect(
      projectReleaseAvailability(['stage:preview'], evidence('stable')),
    ).toEqual({
      kind: 'stable',
      add: ['stage:stable'],
      remove: ['stage:preview'],
    });
  });
  test.each([
    'success',
    'sourceSha',
    'tag',
    'inventory',
    'attestation',
    'release',
    'sbomPredicates',
  ])('rejects laundered or incomplete %s evidence', (field) => {
    const value: any = evidence();
    if (field === 'success') value.success = false;
    else if (field === 'sourceSha') value.sourceSha = 'b'.repeat(40);
    else if (field === 'tag') value.tag = 'v9.9.9';
    else if (field === 'inventory') value.inventory.sourceSha = 'b'.repeat(40);
    else if (field === 'attestation')
      value.attestation.inventorySha = 'c'.repeat(64);
    else if (field === 'release') value.release.effect = 'dry-run';
    else value.sbomPredicates.mobile = 'container/image';
    expect(projectReleaseAvailability(['stage:source'], value)).toMatchObject({
      kind: 'ignored',
    });
  });
  test('rejects private/draft release state, invalid inventory digest, and crossed channel facts', () => {
    for (const mutate of [
      (value: any) => (value.release.public = false),
      (value: any) => (value.release.draft = true),
      (value: any) => (value.inventorySha = '0'.repeat(64)),
      (value: any) => (value.inventorySha = 'not-a-digest'),
      (value: any) => (value.inventory.channel = 'stable'),
    ]) {
      const value: any = evidence();
      mutate(value);
      expect(projectReleaseAvailability(['stage:source'], value)).toMatchObject(
        {
          kind: 'ignored',
        },
      );
    }
  });
});
