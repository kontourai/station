import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { followUpTargetMatchesBinding } from '../../../tools/station-control-delegation.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const makeTempDir = trackTempDirs();
const stores: EventStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});
const authority = (userId = 'owner') =>
  sessionReadAuthorityFromRequest(userId, undefined, undefined);

function fixture() {
  const store = new EventStore(
    join(makeTempDir('session-caller-reads-'), 'events.sqlite'),
  );
  stores.push(store);
  store.upsertSession({
    provider: 'claude',
    threadId: 'thread',
    status: 'closed',
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
  });
  let sequence = 0;
  function append(event: Record<string, unknown>) {
    store.appendEvent({
      eventId: `event-${++sequence}`,
      threadId: 'thread',
      provider: 'claude',
      createdAt: '2026-10-22T00:00:00.000Z',
      ...event,
    } as CanonicalRuntimeEvent);
  }
  append({
    method: 'session.started',
    sessionId: 'thread',
    metadata: {
      userId: 'owner',
      environmentId: 'local',
      targetKind: 'agent',
      targetId: 'helper',
      agentSlug: 'helper',
    },
  });
  const service = new OrchestrationService({
    eventStore: store,
    eventBus: new EventBus(),
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    logger: { debug() {}, warn() {}, info() {}, error() {} },
  } as never);
  service.initialize();
  return { store, service, append };
}

// Caller-level contract: metadata reads must not touch image bytes or replay deltas.
// A mutation to the legacy listEvents path must fail here, not at a helper mock.
test('authorized existence, binding and conversation reads keep image bytes lazy', async () => {
  const { store, service, append } = fixture();
  const pixels = Buffer.alloc(6 * 1024, 7);
  append({
    method: 'turn.started',
    turnId: 'turn',
    prompt: 'Read this image',
    attachments: [
      {
        kind: 'image',
        name: 'image.png',
        mimeType: 'image/png',
        size: pixels.length,
        dataUrl: `data:image/png;base64,${pixels.toString('base64')}`,
      },
    ],
  });
  append({
    method: 'turn.completed',
    turnId: 'turn',
    outputText: 'Done',
    finishReason: 'stop',
  });
  append({ method: 'content.text-delta', turnId: 'turn', delta: 'tail' });
  const full = await service.readSession('thread', authority());
  expect(
    full?.events.find((event) => event.method === 'turn.started'),
  ).toHaveProperty('attachments.0.dataUrl');
  const blobs = vi.spyOn(store['attachmentBlobs'], 'read');
  const replay = vi.spyOn(store, 'listEvents');
  expect(service.hasReadableSession('thread', authority())).toBe(true);
  expect(service.hasReadableSession('missing', authority())).toBe(false);
  expect(service.hasReadableSession('thread', authority('stranger'))).toBe(
    false,
  );
  const detail = await service.readSession('thread', authority(), {
    eventMethods: ['session.started', 'session.configured'],
  });
  expect(detail?.events.map((event) => event.method)).toEqual([
    'session.started',
  ]);
  expect(detail?.session).toMatchObject({
    eventCount: 4,
    lastEventMethod: 'content.text-delta',
    displayTitle: full?.session.displayTitle,
    lifecycleState: full?.session.lifecycleState,
  });
  expect(
    await followUpTargetMatchesBinding(
      service,
      'thread',
      { agent: 'helper' },
      authority(),
    ),
  ).toBe(true);
  const messages = service.readSessionMessages('thread', authority());
  expect(messages.length).toBeGreaterThan(0);
  expect(JSON.stringify(messages)).toContain('blobRef');
  expect(JSON.stringify(messages)).not.toContain('data:image');
  const conversation = await service.sessionQueries.read(
    { type: 'conversation', threadId: 'thread' },
    authority(),
  );
  expect(conversation.status).toBe('found');
  expect(JSON.stringify(conversation)).toContain('blobRef');
  expect(JSON.stringify(conversation)).not.toContain('data:image');
  expect(
    await service.readSession('thread', authority('stranger'), {
      eventMethods: ['session.started'],
    }),
  ).toBeNull();
  expect(replay).not.toHaveBeenCalled();
  expect(blobs).not.toHaveBeenCalled();
});

// Distinct risk: the real service must wire the narrow usage reader and reuse
// an unchanged projection, then invalidate it without leaking its mutable result.
test('usage polling reuses unchanged per-session projections and observes new usage', () => {
  const { store, service, append } = fixture();
  append({ method: 'turn.started', turnId: 'turn', prompt: 'large input' });
  append({
    method: 'token-usage.updated',
    turnId: 'turn',
    promptTokens: 10,
    completionTokens: 3,
  });
  append({
    method: 'tool.completed',
    turnId: 'turn',
    toolCallId: 'tool',
    toolName: 'read',
    status: 'success',
    output: 'large output',
  });
  append({ method: 'turn.completed', turnId: 'turn', finishReason: 'stop' });
  const replay = vi.spyOn(store, 'listEvents');
  const facts = vi.spyOn(store, 'listUsageEventPayloads');
  const first = service.listSessionUsage(authority());
  expect(first[0]?.usage).toMatchObject({
    inputTokens: 10,
    outputTokens: 3,
    turns: 1,
    toolCalls: 1,
  });
  first[0]!.usage.inputTokens = 999;
  expect(service.listSessionUsage(authority())[0]?.usage.inputTokens).toBe(10);
  expect(facts).toHaveBeenCalledTimes(1);
  expect(service.listSessionUsage(authority('stranger'))).toEqual([]);
  append({ method: 'token-usage.updated', turnId: 'next', promptTokens: 4 });
  expect(service.listSessionUsage(authority())[0]?.usage.inputTokens).toBe(14);
  expect(facts).toHaveBeenCalledTimes(2);
  expect(replay).not.toHaveBeenCalled();
  const payloads = store.listUsageEventPayloads('thread');
  expect(
    payloads.find((event) => event.method === 'turn.started'),
  ).not.toHaveProperty('prompt');
  expect(
    payloads.find((event) => event.method === 'tool.completed'),
  ).not.toHaveProperty('output');
});

test('portable consent scans only durable binding methods', () => {
  const { store, service, append } = fixture();
  const consent = {
    portableProjectId: 'portable',
    resourceId: 'git.example/project',
    localProjectId: 'local',
  };
  append({
    method: 'session.configured',
    sessionId: 'thread',
    metadata: { portableExecutionConsent: consent },
  });
  append({
    method: 'content.text-delta',
    turnId: 'turn',
    delta: 'unrelated transcript',
  });
  const replay = vi.spyOn(store, 'listEvents');
  expect(service.persistedPortableConsentOfThread('thread')).toEqual(consent);
  expect(replay).not.toHaveBeenCalled();
});

test('usage facts refuse malformed selected tool JSON instead of manufacturing a count', () => {
  const { store, service, append } = fixture();
  append({
    method: 'tool.completed',
    turnId: 'turn',
    toolCallId: 'tool',
    toolName: 'read',
    status: 'success',
    output: 'large output',
  });
  store['db']
    .prepare(
      "UPDATE orchestration_events SET payload = '{' WHERE method = 'tool.completed'",
    )
    .run();
  expect(() => service.readSessionUsage('thread', authority())).toThrow(
    'malformed JSON',
  );
});

test('hot global sequence reads compile once and retain fresh bindings', () => {
  const { store, append } = fixture();
  const prepare = vi.spyOn(store['db'], 'prepare');
  expect(store.readGlobalSequence('event-1')).toBe(1);
  expect(store.readGlobalSequence('missing')).toBeUndefined();
  append({ method: 'turn.started', turnId: 'next', prompt: 'next' });
  expect(store.readGlobalSequence('event-2')).toBe(2);
  expect(
    prepare.mock.calls.filter(
      ([sql]) =>
        sql === 'SELECT global_sequence FROM orchestration_events WHERE id = ?',
    ),
  ).toHaveLength(1);
});
