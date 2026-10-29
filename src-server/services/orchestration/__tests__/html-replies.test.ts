import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { CanonicalRuntimeEvent } from '../../../providers/adapter-shape.js';
import { mapAcpSessionUpdate } from '../../../providers/adapters/acp-adapter-events.js';
import { AcpToolUpdateSupervisor } from '../../../providers/adapters/acp-tool-update-supervisor.js';
import { EventStore } from '../event-store.js';

const makeTempDir = trackTempDirs();
test('EventStore deletes page bytes with each publishing member and rolls pages back when session deletion rolls back', () => {
  const file = join(makeTempDir('html-reply-deletion-'), 'events.sqlite');
  let store = new EventStore(file);
  for (const threadId of ['root', 'successor'])
    store.upsertSession({
      provider: 'codex',
      threadId,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  const root = store.htmlReplyPages().publish('root', 'conversation', {
    version: 1,
    html: '<h1>Root page</h1>',
    height: 400,
  });
  const child = store.htmlReplyPages().publish('successor', 'conversation', {
    version: 1,
    html: '<h1>Successor page</h1>',
    height: 400,
  });
  store.close();
  store = new EventStore(file);
  const peer = new DatabaseSync(file);
  try {
    expect(store.htmlReplyPages().read(root)?.html).toBe('<h1>Root page</h1>');
    peer.exec(
      "CREATE TRIGGER refuse_session_delete BEFORE DELETE ON provider_session_state BEGIN SELECT RAISE(ABORT, 'injected deletion refusal'); END",
    );
    expect(() => store.deleteThread('root')).toThrow(
      'injected deletion refusal',
    );
    expect(store.htmlReplyPages().read(root)?.html).toBe('<h1>Root page</h1>');
    peer.exec('DROP TRIGGER refuse_session_delete');
    store.deleteThread('root');
    expect(store.htmlReplyPages().read(root)).toBeUndefined();
    expect(store.htmlReplyPages().read(child)?.html).toBe(
      '<h1>Successor page</h1>',
    );
    store.deleteThread('successor');
    expect(store.htmlReplyPages().read(child)).toBeUndefined();
    expect(() =>
      store.htmlReplyPages().publish('root', 'conversation', {
        version: 1,
        html: 'late write',
        height: 400,
      }),
    ).toThrow('no longer exists');
  } finally {
    peer.close();
    store.close();
  }
});

test('conversation page quota covers successive publishing sessions without truncating pages', () => {
  const file = join(makeTempDir('html-reply-quota-'), 'events.sqlite');
  const store = new EventStore(file);
  try {
    for (const threadId of ['root', 'successor'])
      store.upsertSession({
        provider: 'codex',
        threadId,
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    for (let i = 0; i < 32; i++)
      store.htmlReplyPages().publish('root', 'conversation', {
        version: 1,
        html: String(i),
        height: 400,
      });
    expect(() =>
      store.htmlReplyPages().publish('successor', 'conversation', {
        version: 1,
        html: 'over quota',
        height: 400,
      }),
    ).toThrow('32 pages');
  } finally {
    store.close();
  }
});

test.each([
  ['Tool: station-control/html_render', undefined, true],
  ['Display title', 'mcp__station-control__html_render', true],
  ['Tool: attacker/html_render', undefined, false],
  ['html_render', undefined, false],
] as const)(
  'ACP lifecycle %s / %s persists only a qualified publication reference',
  (title, name, allowed) => {
    const store = new EventStore(
      join(makeTempDir('html-acp-reference-'), 'events.sqlite'),
    );
    const session = {
      provider: 'acp' as const,
      threadId: 'acp-publisher',
      status: 'running' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.upsertSession(session);
    const reference = {
      version: 1,
      pageId: '00000000-0000-4000-8000-000000000001',
      sessionId: session.threadId,
    };
    const publish = (event: CanonicalRuntimeEvent) => {
      store.appendEvent(event);
    };
    const supervisor = new AcpToolUpdateSupervisor(session, publish);
    const ctx = {
      provider: 'acp' as const,
      session,
      activeTurnId: 'turn',
      publish,
      toolUpdateSupervisor: supervisor,
    };
    try {
      store.appendEvent({
        eventId: 'turn-start',
        provider: 'acp',
        threadId: session.threadId,
        method: 'turn.started',
        turnId: 'turn',
        prompt: 'Publish',
        createdAt: new Date().toISOString(),
      });
      mapAcpSessionUpdate(
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'call',
          title,
          ...(name ? { name } : {}),
        },
        ctx,
      );
      mapAcpSessionUpdate(
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call',
          status: 'completed',
          rawOutput: {
            content: [
              { type: 'text', text: JSON.stringify({ htmlReply: reference }) },
            ],
          },
        },
        ctx,
      );
      const completed = store
        .listConversationEventWindowByTurn([session.threadId], {
          turnLimit: 1,
          direction: 'newest',
        })
        .events.find((row) => row.method === 'tool.completed');
      expect(completed?.payload.method).toBe('tool.completed');
      if (completed?.payload.method !== 'tool.completed')
        throw new Error('Missing ACP completion');
      expect(completed.payload.toolName).toBe(name ?? title);
      expect(completed.payload.htmlReply).toEqual(
        allowed ? reference : undefined,
      );
    } finally {
      supervisor.settleUnresolvedAtSessionEnd();
      store.close();
    }
  },
);

test.each(['read_file', 'mcp__station-control__html_render'])(
  'ingress discards an incoming page reference for %s and only snapshots a qualified result reference',
  (toolName) => {
    const store = new EventStore(
      join(makeTempDir('html-ingress-ref-'), 'events.sqlite'),
    );
    const derived = {
      version: 1 as const,
      sessionId: 'publisher',
      pageId: '00000000-0000-4000-8000-000000000001',
    };
    const forged = {
      ...derived,
      pageId: '00000000-0000-4000-8000-000000000002',
    };
    const event = {
      eventId: 'completion',
      provider: 'codex' as const,
      threadId: 'publisher',
      turnId: 'turn',
      createdAt: new Date().toISOString(),
      method: 'tool.completed' as const,
      toolCallId: 'call',
      itemId: 'call',
      toolName,
      status: 'success' as const,
      htmlReply: forged,
      output: {
        content: [
          { type: 'text', text: JSON.stringify({ htmlReply: derived }) },
        ],
      },
    };
    try {
      store.appendEvent({
        eventId: 'start',
        provider: event.provider,
        threadId: event.threadId,
        turnId: event.turnId,
        createdAt: event.createdAt,
        method: 'turn.started',
        prompt: 'Publish',
      });
      store.appendEvent(event);
      expect(
        store.listEvents('publisher').find((row) => row.id === event.eventId)
          ?.payload,
      ).not.toHaveProperty('htmlReply');
      const completion = store
        .listEventWindowByTurn('publisher', { turnLimit: 1 })
        .events.find((row) => row.id === event.eventId);
      expect(completion?.payload.method).toBe('tool.completed');
      if (completion?.payload.method !== 'tool.completed')
        throw new Error('Missing completion');
      expect(completion.payload.htmlReply).toEqual(
        toolName === 'read_file' ? undefined : derived,
      );
      expect(completion.payload.htmlReply).not.toEqual(forged);
    } finally {
      store.close();
    }
  },
);
