import { describe, expect, test, vi } from 'vitest';

const { prepare, upload, capability, assertRawEgress } = vi.hoisted(() => ({
  prepare: vi.fn(),
  upload: vi.fn(),
  capability: vi.fn(),
  assertRawEgress: vi.fn(),
}));
vi.mock('@kontourai/station-sdk/client', () => ({
  assertClientRawEgressAllowed: assertRawEgress,
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
  test('keeps the source scope on every relay staging operation and waits for completion before reporting complete', async () => {
    const relay = 'http://source.test/api/environments/peers/receiver/chat-api';
    const scope = {
      apiBase: 'http://source.test',
      authorityKey: 'source-lease',
    };
    capability.mockResolvedValueOnce({
      state: 'supported',
      version: 1,
      maxConcurrentUploads: 3,
    });
    prepare.mockResolvedValueOnce({
      stageId: 'stage_one',
      uploadGrant: 'receiver-only',
    });
    let finish: (value: unknown) => void = () => {};
    const started = new Promise<void>((resolve) =>
      upload.mockImplementationOnce(async () => {
        resolve();
        return new Promise((done) => {
          finish = done;
        });
      }),
    );
    const updates: unknown[] = [];
    const waiting = stageComposerAttachments(
      relay,
      [attachment('remote')],
      undefined,
      (update) => updates.push(update),
      undefined,
      scope,
    );
    await started;
    expect(updates.at(-1)).toMatchObject({ state: 'uploading', progress: 0 });
    expect(capability).toHaveBeenCalledWith(
      relay,
      expect.objectContaining({ requestScope: scope }),
    );
    expect(prepare).toHaveBeenCalledWith(
      relay,
      expect.anything(),
      expect.objectContaining({ requestScope: scope }),
    );
    expect(upload).toHaveBeenCalledWith(
      relay,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ requestScope: scope }),
    );
    finish({ stageId: 'stage_one' });
    await expect(waiting).resolves.toMatchObject({
      kind: 'staged',
      references: [{ stageId: 'stage_one' }],
    });
    expect(updates.at(-1)).toMatchObject({ state: 'complete', progress: 1 });
  });
  test('refuses before querying or preparing a grant when raw egress is blocked', async () => {
    capability.mockReset();
    prepare.mockClear();
    assertRawEgress.mockReset();
    assertRawEgress.mockImplementationOnce(() => {
      throw new Error(
        'Browser broker routes do not support direct attachment upload yet.',
      );
    });

    await expect(
      stageComposerAttachments('http://station.test', [attachment('blocked')]),
    ).rejects.toThrow(
      'Browser broker routes do not support direct attachment upload',
    );
    expect(capability).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

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

  // The route answers 409 `stage_capacity` (5 stages per owner); the SDK
  // throws its ChatHttpError with that code. Retrying only asks for another
  // stage from a full login, so the stage is failed, not retryable.
  test('a full staging capacity is a failed stage that says why, not a Retry', async () => {
    capability.mockResolvedValueOnce({
      state: 'supported',
      version: 1,
      maxConcurrentUploads: 3,
    });
    prepare.mockReset();
    prepare.mockRejectedValueOnce(
      Object.assign(
        new Error(
          'Attachment staging capacity is full. Remove or send another attachment first.',
        ),
        { name: 'ChatHttpError', status: 409, code: 'stage_capacity' },
      ),
    );
    const updates: unknown[] = [];
    await stageComposerAttachments(
      'http://station.test',
      [attachment('sixth')],
      undefined,
      (update) => updates.push(update),
    ).catch(() => undefined);
    expect(updates.at(-1)).toMatchObject({
      clientAttachmentId: 'sixth',
      state: 'failed',
      capacityFull: true,
      error: expect.stringContaining('capacity is full'),
    });
  });

  // #545: the route answers 400 `principal_unresolved` when it cannot tell
  // who is asking. Retrying cannot change that, so it is not a Retry.
  test('an unresolvable caller is a failed stage, not a Retry', async () => {
    capability.mockResolvedValueOnce({
      state: 'supported',
      version: 1,
      maxConcurrentUploads: 3,
    });
    prepare.mockReset();
    prepare.mockRejectedValueOnce(
      Object.assign(
        new Error('Unable to resolve a principal: no paired device'),
        {
          name: 'ChatHttpError',
          status: 400,
          code: 'principal_unresolved',
        },
      ),
    );
    const updates: unknown[] = [];
    await stageComposerAttachments(
      'http://station.test',
      [attachment('unknown-caller')],
      undefined,
      (update) => updates.push(update),
    ).catch(() => undefined);
    expect(updates.at(-1)).toMatchObject({
      clientAttachmentId: 'unknown-caller',
      state: 'failed',
      callerUnresolved: true,
    });
    expect(updates.at(-1)).not.toHaveProperty('capacityFull');
  });
});
