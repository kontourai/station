/**
 * #4828: Codex and ACP native web reads mark the conversation, through the
 * adapters' real notification handlers. The Codex fixture follows the
 * app-server's generated `ItemCompletedNotification` with a `webSearch`
 * `ThreadItem` (`codex app-server generate-ts`, codex-cli 0.167.0).
 */
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { sharedUntrustedContentLedger } from '../../services/plugins/untrusted-content-policy.js';
import type {
  CanonicalRuntimeEvent,
  ProviderSession,
} from '../adapter-shape.js';
import { mapAcpSessionUpdate } from '../adapters/acp-adapter-events.js';
import { AcpToolUpdateSupervisor } from '../adapters/acp-tool-update-supervisor.js';
import { routeCodexChildNotification } from '../adapters/codex-adapter-child-work.js';
import { handleCodexNotification } from '../adapters/codex-adapter-notifications.js';
import type { CodexSessionRecord } from '../adapters/codex-adapter-types.js';

const marked = (id: string) =>
  sharedUntrustedContentLedger.conversationHasRead(id);

class FakeWritable extends Writable {
  _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

function codexRecord(threadId: string): CodexSessionRecord {
  const session: ProviderSession = {
    provider: 'codex',
    threadId,
    status: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  return {
    externalThreadId: threadId,
    codexThreadId: `codex-${threadId}`,
    process: {
      stdin: new FakeWritable(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: () => true,
      on() {
        return this as any;
      },
      once() {
        return this as any;
      },
      removeListener() {
        return this as any;
      },
    },
    session,
    rpcRequestCounter: 0,
    pendingRpcRequests: new Map(),
    turnInvocationIds: new Map(),
    pendingApprovals: new Map(),
    approvedTools: new Set(),
    lastSessionState: 'idle',
    turnOutput: new Map(),
    toolNames: new Map(),
    openToolCalls: new Map(),
    stopped: false,
  } as CodexSessionRecord;
}

const completed = (codexThreadId: string, type: string) => ({
  method: 'item/completed',
  params: {
    threadId: codexThreadId,
    turnId: 'turn-1',
    completedAtMs: 1_767_225_600_000,
    item:
      type === 'webSearch'
        ? {
            type: 'webSearch',
            id: 'ws_1',
            query: 'station release notes',
            action: {
              type: 'openPage',
              url: 'https://example.com/notes',
            },
          }
        : {
            type: 'commandExecution',
            id: 'cmd_1',
            command: 'ls',
            aggregatedOutput: '',
            exitCode: 0,
            status: 'completed',
          },
  },
});

describe('Codex web searches mark the conversation (#4828)', () => {
  test("a completed webSearch item on the session's thread marks it", async () => {
    const record = codexRecord('codex-web-own');
    expect(await marked('codex-web-own')).toBe(false);
    await handleCodexNotification({
      record,
      notification: completed(record.codexThreadId, 'webSearch'),
      nowIso: () => '2026-01-01T00:00:00.000Z',
      publish: () => {},
    });
    expect(await marked('codex-web-own')).toBe(true);
  });

  test('a completed command does not mark it', async () => {
    const record = codexRecord('codex-web-command');
    await handleCodexNotification({
      record,
      notification: completed(record.codexThreadId, 'commandExecution'),
      nowIso: () => '2026-01-01T00:00:00.000Z',
      publish: () => {},
    });
    expect(await marked('codex-web-command')).toBe(false);
  });

  test("a subagent's web search marks the parent conversation", async () => {
    const record = codexRecord('codex-web-parent');
    routeCodexChildNotification(
      {
        record,
        nowIso: () => '2026-01-01T00:00:00.000Z',
        publish: () => {},
      },
      'codex-subagent-thread',
      completed('codex-subagent-thread', 'webSearch'),
    );
    expect(await marked('codex-web-parent')).toBe(true);
  });
});

describe('ACP fetch tool calls mark the conversation (#4828)', () => {
  function context(threadId: string) {
    const session: ProviderSession = {
      provider: 'acp',
      threadId,
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const events: CanonicalRuntimeEvent[] = [];
    return {
      provider: 'acp' as const,
      session,
      activeTurnId: 'turn-1',
      publish: (event: CanonicalRuntimeEvent) => events.push(event),
      toolUpdateSupervisor: new AcpToolUpdateSupervisor(session, (event) =>
        events.push(event),
      ),
    };
  }

  test('a tool call the agent reports with kind fetch marks it', async () => {
    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Fetch https://example.com',
        kind: 'fetch',
        status: 'pending',
      },
      context('acp-web-fetch'),
    );
    expect(await marked('acp-web-fetch')).toBe(true);
  });

  test('a fetch kind reported only on an update marks it', async () => {
    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-2',
        kind: 'fetch',
        status: 'completed',
      },
      context('acp-web-fetch-update'),
    );
    expect(await marked('acp-web-fetch-update')).toBe(true);
  });

  test('a read of a local file does not mark it', async () => {
    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-3',
        title: 'Read README.md',
        kind: 'read',
        status: 'pending',
      },
      context('acp-web-read'),
    );
    expect(await marked('acp-web-read')).toBe(false);
  });
});
