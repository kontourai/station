import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createAttachmentRoutes } from '../../../routes/orchestration/attachments.js';
import { attachmentBlobRefFor } from '../attachment-blob-store.js';
import { EventStore } from '../event-store.js';

/**
 * #2483: a `turn.started` attachment that arrives as a bare blob reference —
 * no bytes — binds to its thread only when this store wrote those bytes while
 * projecting the same live event, or when the reference is already bound to
 * that thread. Content addressing makes a digest computable by anyone holding
 * the bytes, so a replayed, imported or relayed event naming one must not make
 * another user's private upload readable through a new thread.
 */

const pixels = Buffer.alloc(6 * 1024, 7);
const dataUrl = `data:image/png;base64,${pixels.toString('base64')}`;

type TurnStarted = Extract<CanonicalRuntimeEvent, { method: 'turn.started' }>;

function uploadTurn(
  eventId: string,
  threadId: string,
  userId: string,
): TurnStarted {
  return {
    eventId,
    provider: 'claude',
    threadId,
    createdAt: '2026-09-24T00:00:00.000Z',
    method: 'turn.started',
    turnId: `turn-${eventId}`,
    prompt: 'what is in this screenshot?',
    metadata: { userId },
    attachments: [
      {
        kind: 'image',
        name: 'screenshot.png',
        mimeType: 'image/png',
        size: pixels.length,
        dataUrl,
      },
    ],
  };
}

function bareRefTurn(
  eventId: string,
  threadId: string,
  userId: string,
  blobRef: string,
): TurnStarted {
  const { dataUrl: _bytes, ...descriptor } = uploadTurn(
    eventId,
    threadId,
    userId,
  ).attachments![0]!;
  return {
    ...uploadTurn(eventId, threadId, userId),
    attachments: [{ ...descriptor, blobRef }],
  };
}

describe('EventStore binding of turn.started attachment references (#2483)', () => {
  let dir: string;
  let store: EventStore;
  let ref: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'turn-attachments-'));
    store = new EventStore(join(dir, 'orchestration.sqlite'));
    ref = attachmentBlobRefFor(pixels);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const persistedAttachment = (threadId: string, eventId: string) =>
    (
      store
        .listEvents(threadId)
        .find((event) => event.payload.eventId === eventId)!
        .payload as TurnStarted
    ).attachments![0]!;

  test('a bare reference to a digest held in another thread is not bound, and the route refuses it', async () => {
    // Bob's private thread legitimately holds the upload.
    store.appendEvent(uploadTurn('evt-bob', 'thread-bob', 'bob'));
    expect(store.listAttachmentThreads(ref)).toEqual(['thread-bob']);

    // Mallory's replay/import/relay path names the same digest WITHOUT bytes.
    store.appendEvent(
      bareRefTurn('evt-mallory', 'thread-mallory', 'mallory', ref),
    );

    expect(store.listAttachmentThreads(ref)).toEqual(['thread-bob']);
    const kept = persistedAttachment('thread-mallory', 'evt-mallory');
    expect(kept).not.toHaveProperty('blobRef');
    expect(kept).not.toHaveProperty('dataUrl');
    expect(kept).toMatchObject({
      name: 'screenshot.png',
      mimeType: 'image/png',
    });

    const readable: Record<string, string[]> = {
      bob: ['thread-bob'],
      mallory: ['thread-mallory'],
    };
    const principalOf = (request: Request) =>
      (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
    const app = new Hono();
    app.route(
      '/api/attachments',
      createAttachmentRoutes({
        readAttachment: (candidate) => store.readAttachmentBlob(candidate),
        threadsForAttachment: (candidate, request) =>
          store.listAttachmentCandidateThreads(candidate, principalOf(request)),
        canReadSession: (threadId, request) =>
          (readable[principalOf(request)] ?? []).includes(threadId),
      }),
    );
    const mallory = await app.request(`/api/attachments/${ref}`, {
      headers: { Authorization: 'Bearer mallory' },
    });
    expect(mallory.status).toBe(404);
    const bob = await app.request(`/api/attachments/${ref}`, {
      headers: { Authorization: 'Bearer bob' },
    });
    expect(bob.status).toBe(200);
  });

  test('a bare reference already bound to the same thread keeps its preview', () => {
    store.appendEvent(uploadTurn('evt-a', 'thread-a', 'alice'));
    store.appendEvent(bareRefTurn('evt-a-replay', 'thread-a', 'alice', ref));
    expect(persistedAttachment('thread-a', 'evt-a-replay').blobRef).toBe(ref);
    expect(store.listAttachmentThreads(ref)).toEqual(['thread-a']);
  });

  test('the live path keeps the reference it wrote while projecting the same event', () => {
    const projected = store.projectLiveEvent(
      uploadTurn('evt-live', 'thread-live', 'alice'),
    ) as TurnStarted;
    expect(projected.attachments?.[0]?.blobRef).toBe(ref);
    expect(store.listAttachmentThreads(ref)).toEqual([]);

    store.appendEvent(projected);
    expect(persistedAttachment('thread-live', 'evt-live').blobRef).toBe(ref);
    expect(store.listAttachmentThreads(ref)).toEqual(['thread-live']);
  });

  test("a live projection does not vouch for a different event's bare reference", () => {
    store.projectLiveEvent(uploadTurn('evt-live', 'thread-live', 'alice'));
    // Same digest, but a different event on a different thread: the pending
    // record is keyed by thread and event, so it proves nothing here.
    store.appendEvent(bareRefTurn('evt-other', 'thread-other', 'mallory', ref));
    expect(persistedAttachment('thread-other', 'evt-other')).not.toHaveProperty(
      'blobRef',
    );
    expect(store.listAttachmentThreads(ref)).not.toContain('thread-other');
  });

  test('a live projection vouches only for its own event on the same thread', () => {
    store.projectLiveEvent(uploadTurn('evt-live', 'thread-live', 'alice'));
    // Same thread, different event: the pending record is keyed by thread AND
    // event, so an unrelated event naming the digest is not vouched for.
    store.appendEvent(bareRefTurn('evt-sibling', 'thread-live', 'alice', ref));
    expect(
      persistedAttachment('thread-live', 'evt-sibling'),
    ).not.toHaveProperty('blobRef');
    expect(store.listAttachmentThreads(ref)).toEqual([]);
  });

  test('the import/replay append path applies the same rule', () => {
    store.appendEvent(uploadTurn('evt-bob', 'thread-bob', 'bob'));
    store.appendEventIfAbsent(
      bareRefTurn('evt-imported', 'thread-mallory', 'mallory', ref),
    );
    expect(
      persistedAttachment('thread-mallory', 'evt-imported'),
    ).not.toHaveProperty('blobRef');
    expect(store.listAttachmentThreads(ref)).toEqual(['thread-bob']);
  });

  test('a projection refused part-way leaves nothing to vouch for a later append', () => {
    const twoFiles = uploadTurn('evt-refused', 'thread-r', 'alice');
    const other = Buffer.alloc(6 * 1024, 9);
    twoFiles.attachments = [
      twoFiles.attachments![0]!,
      {
        ...twoFiles.attachments![0]!,
        name: 'second.png',
        size: other.length,
        dataUrl: `data:image/png;base64,${other.toString('base64')}`,
      },
    ];
    // The first attachment's bytes are written; the second write fails, so
    // the projection throws after recording the first ref as this event's.
    const blobs = (
      store as unknown as {
        attachmentBlobs: { write(base64: string): string | undefined };
      }
    ).attachmentBlobs;
    const realWrite = blobs.write.bind(blobs);
    let writes = 0;
    const spy = vi
      .spyOn(blobs, 'write')
      .mockImplementation((base64) =>
        ++writes === 1 ? realWrite(base64) : undefined,
      );
    expect(() => store.projectLiveEvent(twoFiles)).toThrow(
      'could not store attachment bytes',
    );
    expect(writes).toBe(2);
    spy.mockRestore();

    // The same thread and event id arriving later reference-only: the refused
    // projection's write must not count as this ingress having written it.
    store.appendEvent(bareRefTurn('evt-refused', 'thread-r', 'alice', ref));
    expect(persistedAttachment('thread-r', 'evt-refused')).not.toHaveProperty(
      'blobRef',
    );
    expect(store.listAttachmentThreads(ref)).toEqual([]);
  });
});
