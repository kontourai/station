import { describe, expect, test } from 'vitest';
import type { ComposerAttachmentStageSnapshot } from '../../types';
import {
  readAttachmentStages,
  readPlanArtifact,
} from '../persisted-chat-shape';

// A permanent staging refusal must survive a reload: without its flag the
// chip falls back to "Upload failed" and the line under it says to choose the
// file again, which fails the same way (#545).
describe('persisted attachment stages', () => {
  const failed = (
    flags: Partial<ComposerAttachmentStageSnapshot>,
  ): ComposerAttachmentStageSnapshot => ({
    clientAttachmentId: 'a1',
    name: 'screenshot.webp',
    mimeType: 'image/webp',
    size: 1_048_576,
    state: 'failed',
    progress: 0,
    error: 'Unable to resolve a principal: no paired device',
    ...flags,
  });

  test.each([
    ['callerUnresolved', { callerUnresolved: true }],
    ['capacityFull', { capacityFull: true }],
  ] as const)('keeps %s across a JSON round trip', (_label, flags) => {
    const [stage] = readAttachmentStages(
      JSON.parse(JSON.stringify([failed(flags)])),
    );
    expect(stage).toMatchObject({ state: 'failed', ...flags });
  });

  test('drops a flag that is not literally true', () => {
    const [stage] = readAttachmentStages([
      { ...failed({}), callerUnresolved: 'yes', capacityFull: 1 },
    ]);
    expect(stage).not.toHaveProperty('callerUnresolved');
    expect(stage).not.toHaveProperty('capacityFull');
  });
});

// docs/design/event-content-spill.md: a plan stored out of line keeps its
// Load full content action across a reload.
describe('a persisted plan stored out of line', () => {
  const entries = {
    $stationContent: 1,
    ref: `sha256-${'a'.repeat(64)}`,
    kind: 'json',
    bytes: 90_000,
    preview: '[{"content":"Step one"',
  };
  const plan = (spilled: unknown) => ({
    source: 'canonical',
    rawText: 'Step one',
    steps: [],
    updatedAt: '2026-10-26T00:00:00.000Z',
    spilled,
  });

  test('keeps what Load full content resolves', () => {
    expect(
      readPlanArtifact(plan({ threadId: 'thread-1', entries }))?.spilled,
    ).toEqual({ threadId: 'thread-1', entries });
  });

  test('drops a spilled record with no reference in it', () => {
    expect(
      readPlanArtifact(plan({ threadId: 'thread-1', entries: [] })),
    ).not.toHaveProperty('spilled');
  });
});
