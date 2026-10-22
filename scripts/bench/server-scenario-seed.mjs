import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { getOrchestrationDatabasePath } from '@scenario/database-path';
import { EventStore } from '@scenario/event-store';
import { resolvePrincipal } from '@scenario/principal';

const options = JSON.parse(process.argv[2]);
const store = new EventStore(getOrchestrationDatabasePath(options.home));
// The coordinator has exchanged this disposable home's local-grant secret.
const principal = resolvePrincipal(null, 'personal', {
  locality: 'home-possession',
});
const createdAt = '2026-01-01T00:00:00.000Z';
const threadId = 'perf-history';
const base = { provider: 'claude', createdAt, principal };
function png(index) {
  const chunk = (name, data) => {
    const payload = Buffer.concat([Buffer.from(name), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(payload));
    return Buffer.concat([size, payload, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(128, 0);
  header.writeUInt32BE(128, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(128 * (1 + 128 * 4));
  let state = index + 1;
  for (let y = 0; y < 128; y += 1) {
    for (let x = 1; x <= 128 * 4; x += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      pixels[y * 513 + x] = state >>> 24;
    }
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
try {
  for (let i = 0; i < options.sessions; i += 1) {
    const id = i === 0 ? threadId : `perf-session-${i}`;
    store.upsertSession({
      ...base,
      updatedAt: createdAt,
      threadId: id,
      status: 'ready',
    });
    store.appendEvent({
      ...base,
      threadId: id,
      eventId: `${id}-start`,
      method: 'session.started',
      sessionId: id,
      metadata: { userId: principal.id, agentSlug: 'perf-deterministic' },
    });
  }
  // A deterministic engine event tape, using the same canonical ingress and
  // attachment projection as live writers. No adapter or model is invoked.
  for (let i = 0; i < options.turns; i += 1) {
    const turnId = `perf-turn-${i}`;
    const event = { ...base, threadId, turnId };
    const image = i >= options.turns - options.images;
    const bytes = image ? png(i) : undefined;
    store.appendEvent({
      ...event,
      eventId: `${turnId}-start`,
      method: 'turn.started',
      prompt: `Inspect fixture ${i}`,
      metadata: { userId: principal.id },
      ...(image
        ? {
            attachments: [
              {
                kind: 'image',
                name: `fixture-${i}.png`,
                mimeType: 'image/png',
                size: bytes.length,
                dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
              },
            ],
          }
        : {}),
    });
    for (let j = 0; j < 2; j += 1)
      store.appendEvent({
        ...event,
        eventId: `${turnId}-text-${j}`,
        method: 'content.text-delta',
        itemId: `${turnId}-answer`,
        delta: `Deterministic answer ${i}/${j}. `,
      });
    store.appendEvent({
      ...event,
      eventId: `${turnId}-end`,
      method: 'turn.completed',
      finishReason: 'stop',
      outputText: `Deterministic answer ${i}.`,
    });
  }
  const events = store.listEventPage(threadId, {
    afterSequence: 0,
    limit: 1 + options.turns * 4,
  }).events;
  assert.equal(
    events.length,
    1 + options.turns * 4,
    'seeded history event count',
  );
  const attachments = events.flatMap((row) => row.payload.attachments ?? []);
  assert.equal(attachments.length, options.images, 'seeded image count');
  assert(
    attachments.every((image) => image.blobRef && !image.dataUrl),
    'real writer must externalize image bytes',
  );
  console.log(
    JSON.stringify({
      sessions: store
        .readSessions()
        .filter((s) => s.threadId.startsWith('perf-')).length,
      events: events.length,
      images: attachments.length,
      threadId,
    }),
  );
} finally {
  store.close();
}
