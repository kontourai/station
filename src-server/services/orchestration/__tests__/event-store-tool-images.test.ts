import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createAttachmentRoutes } from '../../../routes/orchestration/attachments.js';
import { EventStore, MAX_EVENT_STORE_INGRESS_BYTES } from '../event-store.js';

/**
 * Images a TOOL returned to the model ride `tool.completed.attachments` and go
 * through the same EventStore ingress as a user's pasted image: the bytes
 * become a content-addressed blob bound to the thread, the persisted and live
 * forms carry only the reference, and `GET /api/attachments/:ref` authorizes
 * the fetch through that binding. That route is the only way a remote device
 * (phone, web over tailnet) ever sees the picture.
 */

// A real, decodable 1x1 PNG, padded past the 64 KiB ordinary ingress ceiling
// with a trailing chunk so the test proves the attachment allowance, not a
// small event that would have fit anyway.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const pixels = Buffer.concat([PNG_1X1, Buffer.alloc(96 * 1024, 7)]);
const dataUrl = `data:image/png;base64,${pixels.toString('base64')}`;
const digest = createHash('sha256').update(pixels).digest('hex');
const ref = `sha256-${digest}`;

function ownerTurn(threadId: string, userId: string): CanonicalRuntimeEvent {
  return {
    eventId: `turn-${threadId}`,
    provider: 'claude',
    threadId,
    createdAt: '2026-09-23T00:00:00.000Z',
    method: 'turn.started',
    turnId: 'turn-1',
    prompt: 'take a screenshot',
    metadata: { userId },
  };
}

function screenshotResult(threadId: string): CanonicalRuntimeEvent {
  return {
    eventId: `tool-${threadId}`,
    provider: 'claude',
    threadId,
    createdAt: '2026-09-23T00:00:01.000Z',
    method: 'tool.completed',
    turnId: 'turn-1',
    itemId: 'call-1',
    toolCallId: 'call-1',
    toolName: 'mcp__browser__screenshot',
    status: 'success',
    output: 'Captured the page.',
    attachments: [
      {
        kind: 'image',
        name: 'image-1.png',
        mimeType: 'image/png',
        size: pixels.length,
        dataUrl,
      },
    ],
  };
}

describe('EventStore ingress for tool-returned images', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-images-'));
    store = new EventStore(join(dir, 'orchestration.sqlite'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const persistedToolRow = (threadId: string) => {
    const db = new DatabaseSync(join(dir, 'orchestration.sqlite'));
    try {
      const row = db
        .prepare(
          `SELECT payload FROM orchestration_events
           WHERE thread_id = ? AND method = 'tool.completed'`,
        )
        .get(threadId) as { payload: string };
      return { raw: row.payload, payload: JSON.parse(row.payload) };
    } finally {
      db.close();
    }
  };

  test('the live form and the persisted row carry a blob reference, never the bytes', () => {
    store.appendEvent(ownerTurn('thread-a', 'alice'));
    const live = store.projectLiveEvent(screenshotResult('thread-a'));

    // What SSE sends: descriptor + reference, no data URL.
    const liveAttachment = (
      live as Extract<CanonicalRuntimeEvent, { method: 'tool.completed' }>
    ).attachments?.[0];
    expect(liveAttachment).toEqual({
      kind: 'image',
      name: 'image-1.png',
      mimeType: 'image/png',
      size: pixels.length,
      blobRef: ref,
    });
    expect(Buffer.byteLength(JSON.stringify(live))).toBeLessThan(
      MAX_EVENT_STORE_INGRESS_BYTES,
    );

    store.appendEvent(live);
    const { raw, payload } = persistedToolRow('thread-a');
    expect(payload.attachments).toEqual([liveAttachment]);
    expect(raw).not.toContain('base64,');
    // The bytes are in the blob store, byte-identical.
    expect(store.readAttachmentBlob(ref)?.equals(pixels)).toBe(true);
  });

  test('appending the raw adapter event directly strips and binds it the same way', () => {
    store.appendEvent(ownerTurn('thread-a', 'alice'));
    store.appendEvent(screenshotResult('thread-a'));

    expect(persistedToolRow('thread-a').payload.attachments[0].blobRef).toBe(
      ref,
    );
    expect(store.listAttachmentThreads(ref)).toEqual(['thread-a']);
  });

  test('the attachment route serves the tool image to its thread owner and to nobody else', async () => {
    store.appendEvent(ownerTurn('thread-a', 'alice'));
    store.appendEvent(store.projectLiveEvent(screenshotResult('thread-a')));

    // Composed exactly as `runtime-routes.ts` composes it, against the REAL
    // binding index and owner narrowing; only the session-read predicate is a
    // stand-in (alice owns thread-a).
    const readable: Record<string, string[]> = {
      alice: ['thread-a'],
      mallory: [],
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

    const owner = await app.request(`/api/attachments/${ref}`, {
      headers: { Authorization: 'Bearer alice' },
    });
    expect(owner.status).toBe(200);
    expect(Buffer.from(await owner.arrayBuffer()).equals(pixels)).toBe(true);

    const stranger = await app.request(`/api/attachments/${ref}`, {
      headers: { Authorization: 'Bearer mallory' },
    });
    expect(stranger.status).toBe(404);
  });

  test('projection places the image right after the tool row, as a fetchable reference', () => {
    store.appendEvent(ownerTurn('thread-a', 'alice'));
    store.appendEvent(store.projectLiveEvent(screenshotResult('thread-a')));
    store.appendEvent({
      eventId: 'done',
      provider: 'claude',
      threadId: 'thread-a',
      createdAt: '2026-09-23T00:00:02.000Z',
      method: 'turn.completed',
      turnId: 'turn-1',
    });

    const messages = projectRuntimeEventsToMessages(
      store.listEvents('thread-a').map((event) => event.payload),
    );
    const assistant = messages.find((message) => message.role === 'assistant');
    expect(assistant?.parts.map((part) => part.type)).toEqual([
      'tool-invocation',
      'file',
    ]);
    expect(assistant?.parts[1]).toEqual({
      type: 'file',
      blobRef: ref,
      mediaType: 'image/png',
      name: 'image-1.png',
      toolCallId: 'call-1',
      sourceEventId: 'tool-thread-a',
    });
  });

  test('a blob write failure keeps the tool terminal and an honest byte-less descriptor', () => {
    // Occupy the shard directory with a file so the blob write fails.
    mkdirSync(join(dir, 'attachments'), { recursive: true });
    writeFileSync(join(dir, 'attachments', digest.slice(0, 2)), 'occupied');

    store.appendEvent(ownerTurn('thread-a', 'alice'));
    store.appendEvent(screenshotResult('thread-a'));

    const { raw, payload } = persistedToolRow('thread-a');
    // The terminal survives (the row does not run forever)...
    expect(payload.status).toBe('success');
    // ...and the image is named without any claim to bytes or a preview.
    expect(payload.attachments).toEqual([
      {
        kind: 'image',
        name: 'image-1.png',
        mimeType: 'image/png',
        size: pixels.length,
      },
    ]);
    expect(raw).not.toContain('base64,');
    expect(store.listAttachmentThreads(ref)).toEqual([]);
  });

  test('a non-allowlisted tool image is refused at ingress, never persisted', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const event = screenshotResult('thread-a') as Extract<
      CanonicalRuntimeEvent,
      { method: 'tool.completed' }
    >;
    expect(() =>
      store.appendEvent({
        ...event,
        attachments: [
          {
            kind: 'image',
            name: 'x.svg',
            mimeType: 'image/svg+xml' as 'image/png',
            size: svg.length,
            dataUrl: `data:image/svg+xml;base64,${svg.toString('base64')}`,
          },
        ],
      }),
    ).toThrow('not supported');
    expect(store.listEvents('thread-a')).toEqual([]);
  });
});
