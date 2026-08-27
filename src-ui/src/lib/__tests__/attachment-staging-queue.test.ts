import { describe, expect, test, vi } from 'vitest';

const { prepare, upload, capability } = vi.hoisted(() => ({
  prepare: vi.fn(),
  upload: vi.fn(),
  capability: vi.fn(),
}));
vi.mock('@kontourai/station-sdk/client', () => ({
  getAttachmentStagingCapability: capability,
  prepareAttachmentStage: prepare,
  uploadAttachmentStage: upload,
}));

import { stageComposerAttachments } from '../attachment-staging-queue.js';

const attachment = (id: string) => ({
  id,
  name: `${id}.txt`,
  type: 'text/plain',
  size: 5,
  data: 'data:text/plain;base64,aGVsbG8=',
});

describe('stageComposerAttachments', () => {
  test('uses the only explicit legacy handshake and otherwise caps concurrent uploads at three', async () => {
    capability.mockResolvedValueOnce({ state: 'legacy' });
    await expect(
      stageComposerAttachments('http://station.test', [attachment('legacy')]),
    ).resolves.toMatchObject({ kind: 'legacy-inline' });

    capability.mockResolvedValueOnce({
      state: 'supported',
      version: 1,
      maxConcurrentUploads: 3,
    });
    let active = 0;
    let maxActive = 0;
    prepare.mockImplementation(async (_base, input) => ({
      ...input,
      stageId: input.name,
      uploadGrant: input.name,
      expiresAt: '2030-01-01T00:00:00.000Z',
    }));
    upload.mockImplementation(async (_base, stage) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return {
        stageId: stage.stageId,
        source: 'current-composer',
        kind: stage.kind,
        name: stage.name,
        mimeType: stage.mimeType,
        size: stage.size,
        digest:
          'sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        expiresAt: stage.expiresAt,
      };
    });
    await expect(
      stageComposerAttachments('http://station.test', [
        attachment('a'),
        attachment('b'),
        attachment('c'),
        attachment('d'),
      ]),
    ).resolves.toMatchObject({ kind: 'staged' });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  test('blocks an unknown capability rather than silently inlining bytes', async () => {
    capability.mockResolvedValueOnce({ state: 'unknown' });
    await expect(
      stageComposerAttachments('http://station.test', [attachment('blocked')]),
    ).rejects.toThrow('does not advertise');
  });
});
