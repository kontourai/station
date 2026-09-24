import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CHAT_ATTACHMENT_MAX_SESSION_ENCODED_BYTES } from '@kontourai/station-contracts/chat-attachment';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
    // ...and the viewer is told why there is no picture.
    expect(payload.output).toBe(
      'Captured the page.\n[image not shown: image-1.png could not be stored]',
    );
  });

  test("a store failure rewrites the adapter's own [image: name] marker in place", () => {
    mkdirSync(join(dir, 'attachments'), { recursive: true });
    writeFileSync(join(dir, 'attachments', digest.slice(0, 2)), 'occupied');
    store.appendEvent({
      ...(screenshotResult('thread-a') as Extract<
        CanonicalRuntimeEvent,
        { method: 'tool.completed' }
      >),
      output: {
        content: [
          { type: 'text', text: 'Took it' },
          { type: 'text', text: '[image: image-1.png]' },
        ],
      },
    });
    expect(persistedToolRow('thread-a').payload.output).toEqual({
      content: [
        { type: 'text', text: 'Took it' },
        {
          type: 'text',
          text: '[image not shown: image-1.png could not be stored]',
        },
      ],
    });
  });

  test('bytes that are not the declared image type are never stored', () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    store.appendEvent({
      ...(screenshotResult('thread-a') as Extract<
        CanonicalRuntimeEvent,
        { method: 'tool.completed' }
      >),
      attachments: [
        {
          kind: 'image',
          name: 'image-1.png',
          mimeType: 'image/png',
          size: html.length,
          dataUrl: `data:image/png;base64,${html.toString('base64')}`,
        },
      ],
    });
    const { payload } = persistedToolRow('thread-a');
    expect(payload.status).toBe('success');
    expect(payload.attachments[0]).not.toHaveProperty('blobRef');
    expect(payload.output).toBe(
      'Captured the page.\n[image not shown: image-1.png is not a valid image/png image]',
    );
    const htmlRef = `sha256-${createHash('sha256').update(html).digest('hex')}`;
    expect(store.readAttachmentBlob(htmlRef)).toBeUndefined();
  });

  test('a tool image is charged to the chat attachment budget, and is dropped with a note when it is spent', () => {
    store.appendEvent(screenshotResult('thread-a'));
    // Charged: the budget now holds this image's encoded bytes, so a user
    // reservation that would have fit an empty chat no longer does.
    expect(() =>
      store.reserveAttachmentCapacity(
        'thread-a',
        CHAT_ATTACHMENT_MAX_SESSION_ENCODED_BYTES - dataUrl.length + 1,
      ),
    ).toThrow('attachment history limit');

    // Spent: a chat whose budget is full keeps the terminal, not the image.
    store.reserveAttachmentCapacity(
      'thread-b',
      CHAT_ATTACHMENT_MAX_SESSION_ENCODED_BYTES,
    );
    store.appendEvent(screenshotResult('thread-b'));
    const { payload } = persistedToolRow('thread-b');
    expect(payload.status).toBe('success');
    expect(payload.attachments[0]).not.toHaveProperty('blobRef');
    expect(payload.output).toBe(
      "Captured the page.\n[image not shown: image-1.png could not be stored: this chat's attachment storage is full]",
    );
    expect(store.listAttachmentThreads(ref)).toEqual(['thread-a']);
  });

  test('a bare reference to a digest held in another thread is not bound, and the route refuses it', async () => {
    // Bob's private thread legitimately holds the bytes.
    store.appendEvent(ownerTurn('thread-bob', 'bob'));
    store.appendEvent(screenshotResult('thread-bob'));
    expect(store.listAttachmentThreads(ref)).toEqual(['thread-bob']);

    // Mallory's replay/import/relay path names the same digest WITHOUT bytes.
    store.appendEvent(ownerTurn('thread-mallory', 'mallory'));
    store.appendEvent({
      ...(screenshotResult('thread-mallory') as Extract<
        CanonicalRuntimeEvent,
        { method: 'tool.completed' }
      >),
      attachments: [
        {
          kind: 'image',
          name: 'image-1.png',
          mimeType: 'image/png',
          size: pixels.length,
          blobRef: ref,
        },
      ],
    });

    expect(store.listAttachmentThreads(ref)).toEqual(['thread-bob']);
    const { payload } = persistedToolRow('thread-mallory');
    expect(payload.attachments[0]).not.toHaveProperty('blobRef');
    expect(payload.output).toBe(
      'Captured the page.\n[image not shown: image-1.png is not stored on this Station]',
    );

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
    store.appendEvent(screenshotResult('thread-a'));
    const replay = {
      ...(screenshotResult('thread-a') as Extract<
        CanonicalRuntimeEvent,
        { method: 'tool.completed' }
      >),
      eventId: 'tool-thread-a-replay',
      attachments: [
        {
          kind: 'image' as const,
          name: 'image-1.png',
          mimeType: 'image/png' as const,
          size: pixels.length,
          blobRef: ref,
        },
      ],
    };
    store.appendEvent(replay);
    const replayed = store
      .listEvents('thread-a')
      .find((event) => event.payload.eventId === 'tool-thread-a-replay')!
      .payload as Extract<CanonicalRuntimeEvent, { method: 'tool.completed' }>;
    expect(replayed.attachments?.[0]?.blobRef).toBe(ref);
    expect(replayed.output).toBe('Captured the page.');
  });

  const chargedBytes = (threadId: string): number => {
    const db = new DatabaseSync(join(dir, 'orchestration.sqlite'));
    try {
      const row = db
        .prepare(
          'SELECT encoded_bytes FROM orchestration_attachment_quota WHERE thread_id = ?',
        )
        .get(threadId) as { encoded_bytes?: number } | undefined;
      return Number(row?.encoded_bytes ?? 0);
    } finally {
      db.close();
    }
  };

  test('the live path charges a tool image once, and the append keeps the charge', () => {
    store.appendEvent(store.projectLiveEvent(screenshotResult('thread-a')));
    expect(chargedBytes('thread-a')).toBe(dataUrl.length);
  });

  test('replaying the same raw event id charges nothing more (duplicate refunds)', () => {
    store.appendEvent(screenshotResult('thread-a'));
    store.appendEvent(screenshotResult('thread-a'));
    expect(store.appendEventIfAbsent(screenshotResult('thread-a'))).toBe(
      undefined,
    );
    expect(chargedBytes('thread-a')).toBe(dataUrl.length);
  });

  test('an append that fails refunds the charge, and its retry charges once', () => {
    const spy = vi
      .spyOn(
        store as unknown as { appendIngressedEvent: () => number },
        'appendIngressedEvent',
      )
      .mockImplementationOnce(() => {
        throw new Error('simulated append failure');
      });
    expect(() => store.appendEvent(screenshotResult('thread-a'))).toThrow(
      'simulated append failure',
    );
    expect(chargedBytes('thread-a')).toBe(0);
    spy.mockRestore();
    store.appendEvent(screenshotResult('thread-a'));
    expect(chargedBytes('thread-a')).toBe(dataUrl.length);
  });

  test('projecting the same live event twice charges once', () => {
    store.projectLiveEvent(screenshotResult('thread-a'));
    const projected = store.projectLiveEvent(screenshotResult('thread-a'));
    store.appendEvent(projected);
    expect(chargedBytes('thread-a')).toBe(dataUrl.length);
  });

  test('an object-shaped output without a content list still tells the viewer', () => {
    mkdirSync(join(dir, 'attachments'), { recursive: true });
    writeFileSync(join(dir, 'attachments', digest.slice(0, 2)), 'occupied');
    store.appendEvent({
      ...(screenshotResult('thread-a') as Extract<
        CanonicalRuntimeEvent,
        { method: 'tool.completed' }
      >),
      output: { url: 'https://example.test', width: 1280 },
    });
    expect(persistedToolRow('thread-a').payload.output).toEqual({
      url: 'https://example.test',
      width: 1280,
      stationNote: '[image not shown: image-1.png could not be stored]',
    });
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
