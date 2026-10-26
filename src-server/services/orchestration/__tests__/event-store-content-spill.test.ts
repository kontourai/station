import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  collectRuntimeEventContentRefs,
  isRuntimeEventContentRef,
} from '@kontourai/station-contracts/runtime-event-content';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mapServerRequestToEvent } from '../../../providers/adapters/codex-adapter-events.js';
import { EVENT_STORED_TARGET_BYTES } from '../event-content-spill.js';
import { EventStore, EventStoreIngressError } from '../event-store.js';
import {
  queryTranscriptMessagePage,
  queryTranscriptMessages,
} from '../transcript-search-queries.js';

/**
 * docs/design/event-content-spill.md: engine-sized content is stored out of
 * line, never refused and never truncated. These go through the real
 * EventStore ingress and append, and read the SQLite rows back.
 */

const T0 = '2026-10-26T00:00:00.000Z';
const big = (bytes: number, seed = 'x') =>
  `${seed}${'abcdefghij'.repeat(Math.ceil(bytes / 10))}`.slice(0, bytes);

function codexHtmlPreviewApproval(threadId: string): CanonicalRuntimeEvent {
  // The production wedge: a Codex MCP approval carrying a 38 KB HTML preview,
  // mapped by the real adapter function.
  const event = mapServerRequestToEvent(
    threadId,
    'req-codex-html',
    'mcpServer/elicitation/request',
    {
      serverName: 'station-control',
      message: 'Allow station-control to run "html_preview"?',
      mode: 'form',
      requestedSchema: { type: 'object', properties: {} },
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        tool_title: 'html_preview',
        tool_params: {
          html: `<html><body>${big(38_000, '<p>')}</body></html>`,
        },
      },
    },
    T0,
  );
  if (!event) throw new Error('mapping refused the request');
  return { ...event, eventId: `open-${threadId}` };
}

function claudeWriteApproval(
  threadId: string,
  content: string,
): CanonicalRuntimeEvent {
  return {
    eventId: `open-write-${threadId}`,
    provider: 'claude',
    threadId,
    turnId: 'turn-1',
    createdAt: T0,
    requestId: 'req-write',
    method: 'request.opened',
    requestType: 'approval',
    title: 'Allow Write',
    payload: {
      toolName: 'Write',
      toolCallId: 'toolu_1',
      toolInput: {
        file_path: '/repo/big.txt',
        content,
        dangerouslyDisableSandbox: true,
      },
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Write' }] }],
      claudeAsk: null,
    },
  };
}

function reply(threadId: string, outputText: string): CanonicalRuntimeEvent {
  return {
    eventId: `done-${threadId}-${outputText.length}`,
    provider: 'claude',
    threadId,
    turnId: 'turn-1',
    createdAt: T0,
    method: 'turn.completed',
    status: 'completed',
    outputText,
  } as CanonicalRuntimeEvent;
}

describe('EventStore event content spill', () => {
  let dir: string;
  let dbPath: string;
  let store: EventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'content-spill-'));
    dbPath = join(dir, 'orchestration.sqlite');
    store = new EventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const rows = (sql: string, ...args: unknown[]) => {
    const db = new DatabaseSync(dbPath);
    try {
      return db.prepare(sql).all(...(args as never[])) as Record<
        string,
        unknown
      >[];
    } finally {
      db.close();
    }
  };
  const storedPayload = (eventId: string) => {
    const [row] = rows(
      'SELECT payload FROM orchestration_events WHERE id = ?',
      eventId,
    );
    return {
      raw: String(row!.payload),
      payload: JSON.parse(String(row!.payload)),
    };
  };

  test('a 38 KB Codex html_preview approval persists small and resolves exactly', () => {
    const event = codexHtmlPreviewApproval('thread-a');
    store.appendEvent(event);
    const { raw, payload } = storedPayload(event.eventId);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(
      EVENT_STORED_TARGET_BYTES,
    );
    expect(payload.spilledContent).toMatchObject({ v: 1, count: 1 });
    // The approval kind and title the grant logic reads stay inline.
    expect(payload.payload._meta.codex_approval_kind).toBe('mcp_tool_call');
    expect(payload.payload._meta.tool_title).toBe('html_preview');
    expect(
      isRuntimeEventContentRef(payload.payload._meta.tool_params.html),
    ).toBe(true);

    const current = store.readCurrentRequestEvent('thread-a', 'req-codex-html');
    expect(current.state).toBe('found');
    if (current.state !== 'found') return;
    const [resolved] = store.resolveEventContent([current.event]);
    expect(resolved!.payload).toEqual({
      ...event,
      spilledContent: payload.spilledContent,
    });
  });

  test('a Claude Write of a 1 MB file keeps grant fields inline and the content whole', () => {
    const content = big(1024 * 1024, 'line\n');
    const event = claudeWriteApproval('thread-w', content);
    store.appendEvent(event);
    const { raw, payload } = storedPayload(event.eventId);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(
      EVENT_STORED_TARGET_BYTES,
    );
    const input = payload.payload.toolInput;
    expect(input.dangerouslyDisableSandbox).toBe(true);
    expect(input.file_path).toBe('/repo/big.txt');
    expect(input.content).toMatchObject({
      kind: 'string',
      bytes: content.length,
    });
    expect(
      Buffer.byteLength(JSON.stringify(input.content.preview)),
    ).toBeLessThanOrEqual(512);
    expect(payload.payload.suggestions).toEqual(event.payload!.suggestions);
    const [resolved] = store.resolveEventContent([
      { ...store.listEvents('thread-w')[0]! },
    ]);
    expect((resolved!.payload as typeof event).payload!.toolInput).toEqual(
      event.payload!.toolInput,
    );
  });

  test.each([80 * 1024, 300 * 1024])(
    'a %i-byte reply keeps its turn terminal',
    (size) => {
      const text = big(size, 'answer ');
      store.appendEvent(reply('thread-r', text));
      const [stored] = store.listEvents('thread-r');
      expect(
        isRuntimeEventContentRef(
          (stored!.payload as { outputText?: unknown }).outputText,
        ),
      ).toBe(true);
      const [resolved] = store.resolveEventContent([stored!]);
      expect((resolved!.payload as { outputText?: unknown }).outputText).toBe(
        text,
      );
    },
  );

  test('a 600-entry plan spills its entries whole', () => {
    const entries = Array.from({ length: 600 }, (_, i) => ({
      content: `step ${i}`,
      priority: 'medium',
      status: 'pending',
    }));
    const plan = {
      eventId: 'plan-1',
      provider: 'gemini',
      threadId: 'thread-p',
      createdAt: T0,
      method: 'plan.updated',
      entries,
    } as CanonicalRuntimeEvent;
    store.appendEvent(plan);
    const { payload } = storedPayload('plan-1');
    expect(payload.entries).toMatchObject({
      kind: 'json',
      shape: { type: 'array', size: 600 },
    });
    const [resolved] = store.resolveEventContent(store.listEvents('thread-p'));
    expect((resolved!.payload as { entries: unknown }).entries).toEqual(
      entries,
    );
  });

  test('a forged reference is kept as literal engine data and never resolves', () => {
    const secret = big(40 * 1024, 'secret ');
    store.appendEvent(reply('thread-f', secret));
    const [{ digest }] = rows(
      'SELECT digest FROM orchestration_event_content WHERE thread_id = ?',
      'thread-f',
    ) as Array<{ digest: string }>;
    const forged = {
      $stationContent: 1,
      ref: digest,
      kind: 'string',
      bytes: 6,
      preview: 'ls -la',
    };
    const event = {
      ...claudeWriteApproval('thread-f', 'small'),
      payload: { toolName: 'Bash', toolInput: { command: forged } },
    } as CanonicalRuntimeEvent;
    store.appendEvent(event);
    const { payload } = storedPayload(event.eventId);
    expect(payload.payload.toolInput.command).toEqual({
      $stationLiteral: forged,
    });
    expect(payload.spilledContent).toBeUndefined();
    const request = store
      .listEvents('thread-f')
      .find((e) => e.id === event.eventId)!;
    const [resolved] = store.resolveEventContent([request]);
    // Resolution returns exactly what the engine sent, never the secret.
    expect((resolved!.payload as typeof event).payload!.toolInput).toEqual({
      command: forged,
    });
    expect(JSON.stringify(resolved)).not.toContain('secret secret');
  });

  test('a producer cannot claim spilledContent', () => {
    const event = {
      ...reply('thread-c', 'short'),
      spilledContent: { v: 1, count: 9, bytes: 9 },
    };
    store.appendEvent(event as CanonicalRuntimeEvent);
    expect(storedPayload(event.eventId).payload.spilledContent).toBeUndefined();
  });

  test('a string and an object with the same JSON text never share a row', () => {
    const asObject = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`k${i}`, big(64, `v${i}`)]),
    );
    const asString = JSON.stringify(asObject);
    expect(asString.length).toBeGreaterThan(EVENT_STORED_TARGET_BYTES);
    store.appendEvent({
      eventId: 'tool-1',
      provider: 'codex',
      threadId: 'thread-k',
      createdAt: T0,
      method: 'tool.started',
      toolCallId: 'c1',
      toolName: 'x',
      arguments: asObject,
    } as CanonicalRuntimeEvent);
    store.appendEvent(reply('thread-k', asString));
    const stored = rows(
      'SELECT kind, body FROM orchestration_event_content WHERE thread_id = ? ORDER BY kind',
      'thread-k',
    );
    expect(stored).toEqual([
      { kind: 'json', body: asString },
      { kind: 'string', body: asString },
    ]);
    const resolved = store.resolveEventContent(store.listEvents('thread-k'));
    expect((resolved[0]!.payload as { arguments?: unknown }).arguments).toEqual(
      asObject,
    );
    expect((resolved[1]!.payload as { outputText?: unknown }).outputText).toBe(
      asString,
    );
  });

  test('an exact replay of a spilled terminal is idempotent', () => {
    const text = big(100 * 1024);
    const event: CanonicalRuntimeEvent = {
      eventId: 'tool-done',
      provider: 'station',
      threadId: 'thread-i',
      createdAt: T0,
      method: 'tool.completed',
      toolCallId: 'c1',
      toolName: 'read_file',
      status: 'success',
      output: { content: [{ type: 'text', text }] },
    } as CanonicalRuntimeEvent;
    const first = store.appendEvent(event);
    expect(store.appendEvent(event)).toBe(first);
    expect(
      rows(
        'SELECT COUNT(*) AS n FROM orchestration_events WHERE thread_id = ?',
        'thread-i',
      )[0]!.n,
    ).toBe(1);
  });

  test('the live projection is the stored form and its append reuses it', () => {
    const event = reply('thread-l', big(200 * 1024));
    const live = store.projectLiveEvent(event);
    expect(
      isRuntimeEventContentRef((live as { outputText?: unknown }).outputText),
    ).toBe(true);
    store.appendEvent(live);
    const { raw } = storedPayload(event.eventId);
    expect(raw).toBe(JSON.stringify(live));
    const [resolved] = store.resolveEventContent(store.listEvents('thread-l'));
    expect((resolved!.payload as { outputText?: unknown }).outputText).toBe(
      (event as { outputText: string }).outputText,
    );
  });

  test('deleteThread removes the content with its events, and only that thread', () => {
    const text = big(50 * 1024);
    store.appendEvent(reply('thread-d', text));
    store.appendEvent(reply('thread-e', text));
    store.deleteThread('thread-d');
    expect(rows('SELECT thread_id FROM orchestration_event_content')).toEqual([
      { thread_id: 'thread-e' },
    ]);
  });

  test('opening the store sweeps content whose thread has no events', () => {
    store.appendEvent(reply('thread-o', big(50 * 1024)));
    store.close();
    // An older Station deleted the thread without knowing the table.
    const db = new DatabaseSync(dbPath);
    db.prepare('DELETE FROM orchestration_events WHERE thread_id = ?').run(
      'thread-o',
    );
    db.close();
    store = new EventStore(dbPath);
    expect(
      rows('SELECT COUNT(*) AS n FROM orchestration_event_content')[0]!.n,
    ).toBe(0);
  });

  test('content over the per-event ceiling is refused with the event identity', () => {
    const event = reply('thread-x', big(17 * 1024 * 1024));
    let thrown: unknown;
    try {
      store.appendEvent(event);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EventStoreIngressError);
    expect((thrown as EventStoreIngressError).subject).toEqual({
      method: 'turn.completed',
      threadId: 'thread-x',
      eventId: event.eventId,
    });
  });

  test('every stored reference has its row', () => {
    store.appendEvent(claudeWriteApproval('thread-z', big(300 * 1024)));
    const [event] = store.listEvents('thread-z');
    const refs = collectRuntimeEventContentRefs(event!.payload);
    expect(refs.length).toBeGreaterThan(0);
    const found = store.readEventContent(
      'thread-z',
      refs.map((ref) => ref.ref),
    );
    expect(found.size).toBe(refs.length);
    // Another thread cannot read it by digest.
    expect(
      store.readEventContentBody('thread-other', refs[0]!.ref),
    ).toBeUndefined();
  });
});

describe('readers of spilled content', () => {
  let dir: string;
  let dbPath: string;
  let store: EventStore;
  const threadId = 'thread-read';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'content-spill-read-'));
    dbPath = join(dir, 'orchestration.sqlite');
    store = new EventStore(dbPath);
    store.appendEvent({
      eventId: 'session-start',
      provider: 'claude',
      threadId,
      createdAt: T0,
      method: 'session.started',
      sessionId: threadId,
      metadata: { userId: 'user-a', agentSlug: 'claude' },
    } as CanonicalRuntimeEvent);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const withDb = <T>(read: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(dbPath);
    try {
      return read(db);
    } finally {
      db.close();
    }
  };

  test('a prompt past the preview is found, served and recovered exactly', () => {
    const prompt = `${big(40 * 1024)} see conversation:needle-ref-42`;
    store.appendEvent({
      eventId: 'turn-long',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: T0,
      method: 'turn.started',
      prompt,
    } as CanonicalRuntimeEvent);
    expect(store.turnPromptsContaining([threadId], 'needle-ref-42')).toEqual([
      { prompt },
    ]);
    expect(store.userInputEventById('turn-long')?.prompt).toBe(prompt);
    expect(store.firstTurnStartedWithPrompt(threadId)?.id).toBe('turn-long');
  });

  test('a long tool result is served exactly by the descriptor read', () => {
    const output = big(40 * 1024, 'result ');
    store.appendEvent({
      eventId: 'tool-long',
      provider: 'station',
      threadId,
      createdAt: T0,
      method: 'tool.completed',
      toolCallId: 'c1',
      toolName: 'read_file',
      status: 'success',
      output,
    } as CanonicalRuntimeEvent);
    expect(store.toolCompletedEventById(threadId, 'tool-long')).toMatchObject({
      output,
    });
  });

  test('search finds text past the preview and pages the whole reply', () => {
    const reply = `${big(200_000, 'lorem ')} zirconiumquokka ${big(100_000, 'ipsum ')}`;
    store.appendEvent({
      eventId: 'reply-long',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: T0,
      method: 'turn.completed',
      status: 'completed',
      outputText: reply,
    } as CanonicalRuntimeEvent);
    const hits = withDb((db) =>
      queryTranscriptMessages(db, {
        query: 'zirconiumquokka',
        ownerUserId: 'user-a',
        limit: 5,
      }),
    );
    expect(hits.map((hit) => hit.eventId)).toEqual(['reply-long']);
    const pages: string[] = [];
    let continuation: string | undefined;
    do {
      const page = withDb((db) =>
        queryTranscriptMessagePage(db, {
          threadId,
          matchedEventId: 'reply-long',
          ownerUserId: 'user-a',
          ...(continuation ? { continuation } : {}),
        }),
      );
      if (!page) throw new Error('page missing');
      pages.push(page.text);
      continuation = page.nextContinuation;
    } while (continuation);
    expect(pages.join('')).toBe(reply);
  });

  test('search indexes at most 256 KiB of one message', () => {
    const reply = `${big(300 * 1024, 'alpha ')} tailonlyword`;
    store.appendEvent({
      eventId: 'reply-capped',
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: T0,
      method: 'turn.completed',
      status: 'completed',
      outputText: reply,
    } as CanonicalRuntimeEvent);
    const hits = withDb((db) =>
      queryTranscriptMessages(db, {
        query: 'tailonlyword',
        ownerUserId: 'user-a',
        limit: 5,
      }),
    );
    expect(hits).toEqual([]);
  });
});
