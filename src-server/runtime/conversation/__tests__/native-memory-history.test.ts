import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UIMessage } from 'ai';
import { afterEach, expect, test } from 'vitest';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { createPromptOnlyMemoryView } from '../../../adapters/file/memory-adapter-prompt-view.js';
import type { ConversationContextBoundaryMarker } from '../../../services/orchestration/conversation-context-boundary-module.js';
import type { ConversationSessionLineage } from '../../../services/orchestration/conversation-session-lineage.js';
import { captureNativeMemoryContinuity } from '../../../services/orchestration/native-memory-continuity.js';
import {
  createAuthorizedTurnCorrelation,
  currentNativeMemoryHistory,
  issueAuthorizedTurnCorrelationHandoff,
  readNativeMemoryRelayCompanion,
  runWithAuthorizedTurnCorrelation,
} from '../authorized-turn-correlation.js';
import { createNativeMemoryHistoryCompanion } from '../native-memory-history.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const text = (
  id: string,
  role: 'user' | 'assistant',
  value: string,
): UIMessage => ({ id, role, parts: [{ type: 'text', text: value }] });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-history-'));
  roots.push(root);
  const adapter = new FileMemoryAdapter({ projectHomeDir: root });
  const ids = ['foreign', 'a', 'b', 'c'];
  const lineage: ConversationSessionLineage[] = ids.map(
    (sessionId, ordinal) => ({
      conversationId: 'conversation',
      sessionId,
      ordinal,
      ...(ordinal ? { predecessorSessionId: ids[ordinal - 1] } : {}),
      createdAt: `2026-09-06T00:00:0${ordinal}Z`,
    }),
  );
  const boundaries = new Map<string, ConversationContextBoundaryMarker>();
  let authorized = true;
  const scope = {
    provider: 'station-agent' as const,
    agentId: 'assistant',
    userId: 'owner',
  };
  const capture = () =>
    captureNativeMemoryContinuity(
      { currentSessionId: 'c', scope },
      {
        conversationForSession: (id) =>
          lineage.find((row) => row.sessionId === id),
        conversationSessions: () => lineage,
        contextBoundaryForSuccessor: (id) => boundaries.get(id),
        readSession: async (sessionId) => ({
          sessionId,
          ...scope,
          ...(sessionId === 'foreign'
            ? { provider: 'codex', agentId: 'codex' }
            : {}),
        }),
        isAuthorityCurrent: () => authorized,
      },
    );
  for (const id of ids.slice(1))
    await adapter.createConversation({
      id,
      resourceId: 'assistant',
      userId: 'owner',
      title: id,
      metadata: {},
    });
  const first = text(
    'first-user',
    'user',
    `Retain GRAPHITE-77 ${'x'.repeat(20_000)}`,
  );
  const structured: UIMessage = {
    id: 'first-answer',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Stored structured response.' },
      {
        type: 'dynamic-tool',
        toolName: 'lookup',
        toolCallId: 'call-1',
        state: 'output-available',
        input: { key: 'k' },
        output: { value: 42 },
      },
      {
        type: 'file',
        mediaType: 'text/plain',
        url: 'data:text/plain;base64,SGk=',
      },
    ],
  };
  await adapter.addMessage(first, 'owner', 'a');
  await adapter.addMessage(structured, 'owner', 'a');
  await adapter.addMessage(
    text(
      'failed',
      'user',
      '[SYSTEM_EVENT] [CHAT_ERROR] private failed attempt',
    ),
    'owner',
    'a',
  );
  await adapter.addMessage(
    text('second-user', 'user', 'Second turn'),
    'owner',
    'b',
  );
  await adapter.addMessage(
    text('second-answer', 'assistant', 'Second response'),
    'owner',
    'b',
  );
  const companion = async () =>
    createNativeMemoryHistoryCompanion({
      binding: await capture(),
      readCanonicalSession: async (id) => [
        text(`${id}-prefix`, 'assistant', 'Earlier authorized harness context'),
      ],
    });
  return {
    root,
    adapter,
    capture,
    companion,
    boundaries,
    first,
    structured,
    revoke: () => {
      authorized = false;
    },
  };
}

test('reopened native storage supplies full structured prior legs and canonical harness prefix without copying writes', async () => {
  const f = await fixture();
  const adapter = new FileMemoryAdapter({ projectHomeDir: f.root });
  const companion = await f.companion();
  const correlation = createAuthorizedTurnCorrelation({
    accountId: 'owner',
    sessionId: 'c',
  });
  const relay = issueAuthorizedTurnCorrelationHandoff(
    correlation,
    undefined,
    companion,
  );
  expect(readNativeMemoryRelayCompanion(relay)).toBe(companion);
  const view = createPromptOnlyMemoryView(adapter, 'assistant');
  const messages = await runWithAuthorizedTurnCorrelation(
    correlation,
    () => view.getMessages('owner', 'c'),
    companion,
  );
  expect(messages.map((message) => message.id)).toEqual([
    'foreign-prefix',
    'first-user',
    'first-answer',
    'second-user',
    'second-answer',
  ]);
  expect(messages[1].parts).toEqual(f.first.parts);
  expect(messages[2].parts).toEqual(f.structured.parts);
  expect(await adapter.getMessages('owner', 'c')).toEqual([]);
  await runWithAuthorizedTurnCorrelation(
    correlation,
    () => view.addMessage(text('new-child', 'user', 'New input'), 'owner', 'c'),
    companion,
  );
  expect(
    (await adapter.getMessages('owner', 'c')).map((message) => message.id),
  ).toEqual(['new-child']);
  expect(
    (await adapter.getMessages('owner', 'a')).map((message) => message.id),
  ).toEqual(['first-user', 'first-answer', 'failed']);
  expect(currentNativeMemoryHistory()).toBeUndefined();
});

test('one history limit applies after composition and filtering, not independently to every native leg', async () => {
  const f = await fixture();
  const history = await f.companion();
  expect(
    (await history.read(f.adapter, 'owner', 'c', { limit: 3 })).map(
      (message) => message.id,
    ),
  ).toEqual(['first-answer', 'second-user', 'second-answer']);
  expect(
    (
      await history.read(f.adapter, 'owner', 'c', {
        limit: 2,
        roles: ['assistant'],
      })
    ).map((message) => message.id),
  ).toEqual(['first-answer', 'second-answer']);
});

test('the same ALS turn cannot lend inherited history to another Agent view', async () => {
  const f = await fixture();
  const history = await f.companion();
  const correlation = createAuthorizedTurnCorrelation({
    accountId: 'owner',
    sessionId: 'c',
  });
  const otherView = createPromptOnlyMemoryView(f.adapter, 'different-agent');
  const messages = await runWithAuthorizedTurnCorrelation(
    correlation,
    () => otherView.getMessages('owner', 'c'),
    history,
  );
  expect(messages).toEqual([]);
  await expect(history.read(f.adapter, 'intruder', 'c')).rejects.toMatchObject({
    code: 'native_memory_continuity_unavailable',
  });
  await expect(history.read(f.adapter, 'owner', 'a')).rejects.toMatchObject({
    code: 'native_memory_continuity_unavailable',
  });
});

test('native record ownership is checked even when the home-wide store can find its ID', async () => {
  const f = await fixture();
  const history = await f.companion();
  await f.adapter.deleteConversation('a');
  await f.adapter.createConversation({
    id: 'a',
    resourceId: 'foreign-agent',
    userId: 'owner',
    title: 'Wrong owner',
    metadata: {},
  });
  expect((await f.adapter.getConversation('a'))?.resourceId).toBe(
    'foreign-agent',
  );
  await expect(history.read(f.adapter, 'owner', 'c')).rejects.toMatchObject({
    code: 'native_memory_continuity_unavailable',
  });
});

test('a new explicit empty boundary revokes the old projection and does not restore visible earlier transcript', async () => {
  const f = await fixture();
  const old = await f.companion();
  f.boundaries.set('c', {
    boundaryId: 'reset-c',
    conversationId: 'conversation',
    predecessorSessionId: 'b',
    successorSessionId: 'c',
    idempotencyKey: 'reset-key',
    policy: 'empty-next-cold-start',
    status: 'consumed',
    actorId: 'owner',
    createdAt: '2026-09-06T00:00:03Z',
  });
  await expect(old.read(f.adapter, 'owner', 'c')).rejects.toMatchObject({
    code: 'native_memory_continuity_unavailable',
  });
  expect(await (await f.companion()).read(f.adapter, 'owner', 'c')).toEqual([]);
  f.revoke();
  await expect(f.companion()).rejects.toMatchObject({
    code: 'native_memory_continuity_unavailable',
  });
});

test('authorizing a full native history grows linearly with its Session count', async () => {
  const measure = async (count: number) => {
    const ids = Array.from({ length: count }, (_, i) => `session-${i}`);
    const rows: ConversationSessionLineage[] = ids.map(
      (sessionId, ordinal) => ({
        conversationId: 'conversation',
        sessionId,
        ordinal,
        ...(ordinal ? { predecessorSessionId: ids[ordinal - 1] } : {}),
        createdAt: '2026-09-06T00:00:00Z',
      }),
    );
    let reads = 0;
    const scope = {
      provider: 'station-agent' as const,
      agentId: 'assistant',
      userId: 'owner',
    };
    const currentSessionId = ids.at(-1)!;
    const binding = await captureNativeMemoryContinuity(
      { currentSessionId, scope },
      {
        conversationForSession: (id) =>
          rows.find((row) => row.sessionId === id),
        conversationSessions: () => rows,
        contextBoundaryForSuccessor: () => undefined,
        isAuthorityCurrent: () => true,
        readSession: async (sessionId) => {
          reads++;
          return { sessionId, ...scope };
        },
      },
    );
    const history = createNativeMemoryHistoryCompanion({
      binding,
      readCanonicalSession: async () => [],
    });
    const adapter = {
      getConversation: async (id: string) => ({
        id,
        resourceId: 'assistant',
        userId: 'owner',
        title: id,
        metadata: {},
        createdAt: '',
        updatedAt: '',
      }),
      getMessages: async (_user: string, id: string) => [text(id, 'user', id)],
    } as unknown as import('@voltagent/core').StorageAdapter;
    reads = 0;
    const messages = await history.read(adapter, 'owner', currentSessionId);
    expect(messages.map((message) => message.id)).toEqual(ids);
    return reads;
  };
  const small = await measure(20);
  const large = await measure(40);
  expect(small).toBeGreaterThan(0);
  expect(large).toBeLessThanOrEqual(small * 2.2);
});

test('lost current-child memory refuses instead of manufacturing an empty history', async () => {
  const f = await fixture();
  await f.adapter.addMessage(
    text('current-prior', 'assistant', 'Current child already had history'),
    'owner',
    'c',
  );
  const history = await f.companion();
  await f.adapter.deleteConversation('c');
  await expect(history.read(f.adapter, 'owner', 'c')).rejects.toMatchObject({
    code: 'native_memory_continuity_unavailable',
  });
});

test('only owner-certified first use allows an absent current-child record', async () => {
  const f = await fixture();
  await f.adapter.deleteConversation('c');
  const history = createNativeMemoryHistoryCompanion({
    binding: await f.capture(),
    allowMissingCurrentRecord: true,
    readCanonicalSession: async () => [
      text('foreign-prefix', 'assistant', 'Earlier authorized context'),
    ],
  });
  expect(
    (await history.read(f.adapter, 'owner', 'c')).map((message) => message.id),
  ).toEqual([
    'foreign-prefix',
    'first-user',
    'first-answer',
    'second-user',
    'second-answer',
  ]);
  expect(await f.adapter.getConversation('c')).toBeNull();
});
