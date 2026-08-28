import type { PermissionOption } from '@agentclientprotocol/sdk';
import { describe, expect, test } from 'vitest';
import type {
  CanonicalRuntimeEvent,
  ProviderSession,
} from '../adapter-shape.js';
import {
  type AcpMapperContext,
  type AcpMapperState,
  extractReportedModelFromConfigOptions,
  mapAcpDecisionToApprovalStatus,
  mapAcpDecisionToOutcome,
  mapAcpExtensionNotification,
  mapAcpSessionUpdate,
  mapAcpStopReasonToFinishReason,
} from '../adapters/acp-adapter-events.js';
import { AcpToolUpdateSupervisor } from '../adapters/acp-tool-update-supervisor.js';

function makeSession(): ProviderSession {
  return {
    provider: 'acp',
    threadId: 'thread-1',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeCtx(
  events: CanonicalRuntimeEvent[],
  overrides?: Partial<AcpMapperContext>,
): AcpMapperContext {
  const session = makeSession();
  return {
    provider: 'acp',
    session,
    activeTurnId: 'turn-1',
    publish: (event) => {
      events.push(event);
    },
    toolUpdateSupervisor: new AcpToolUpdateSupervisor(session, (event) =>
      events.push(event),
    ),
    ...overrides,
  };
}

const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Reject always', kind: 'reject_always' },
];

describe('mapAcpSessionUpdate — plan', () => {
  test('maps a plan update to plan.updated with entries and statuses', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const ctx = makeCtx(events);

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read the file', priority: 'high', status: 'pending' },
          {
            content: 'Write the fix',
            priority: 'medium',
            status: 'in_progress',
          },
          { content: 'Run tests', priority: 'low', status: 'completed' },
        ],
      } as any,
      ctx,
    );

    expect(events.at(-1)).toMatchObject({
      provider: 'acp',
      threadId: 'thread-1',
      turnId: 'turn-1',
      method: 'plan.updated',
      entries: [
        { content: 'Read the file', status: 'pending' },
        { content: 'Write the fix', status: 'in_progress' },
        { content: 'Run tests', status: 'completed' },
      ],
    });
  });
});

describe('mapAcpSessionUpdate — usage_update', () => {
  test('maps ACP context used/size exactly without inventing token categories or cost', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const ctx = makeCtx(events);

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'usage_update',
        used: 0,
        size: 200_000,
        cost: { amount: 12.34, currency: 'EUR' },
      } as any,
      ctx,
    );

    expect(events.at(-1)).toMatchObject({
      provider: 'acp',
      threadId: 'thread-1',
      turnId: 'turn-1',
      method: 'token-usage.updated',
      contextTokens: 0,
      contextWindowTokens: 200_000,
    });
    expect(events[0]).not.toHaveProperty('promptTokens');
    expect(events[0]).not.toHaveProperty('completionTokens');
    expect(events[0]).not.toHaveProperty('totalTokens');
    expect(events[0]).not.toHaveProperty('reportedCostUsd');
  });

  test.each([
    { used: -1, size: 200_000 },
    { used: Number.NaN, size: 200_000 },
    { used: 100, size: 0 },
    { used: 100, size: -1 },
    { used: 100, size: Number.POSITIVE_INFINITY },
  ])(
    'does not publish a context observation for invalid usage %#',
    (update) => {
      const events: CanonicalRuntimeEvent[] = [];

      mapAcpSessionUpdate(
        { sessionUpdate: 'usage_update', ...update } as any,
        makeCtx(events),
      );

      expect(events).toEqual([]);
    },
  );
});

describe('mapAcpSessionUpdate — content and tool events', () => {
  test('maps agent_message_chunk text content to content.text-delta', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const ctx = makeCtx(events);

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello there' },
        messageId: 'message-1',
      } as any,
      ctx,
    );

    expect(events.at(-1)).toMatchObject({
      method: 'content.text-delta',
      itemId: 'message-1',
      delta: 'Hello there',
    });
  });

  test('maps a completed tool_call_update through the bounded typed projection', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const ctx = makeCtx(events);

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'ls',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'file-a' } },
        ],
      } as any,
      ctx,
    );

    expect(events.at(-1)).toMatchObject({
      method: 'tool.completed',
      toolCallId: 'tool-1',
      status: 'success',
      output: [{ type: 'text', text: 'file-a' }],
    });
  });

  test('emits tool.progress for an in_progress tool_call_update', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const ctx = makeCtx(events);

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'ls',
        status: 'in_progress',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'partial output' },
          },
        ],
      } as any,
      ctx,
    );

    expect(events.at(-1)).toMatchObject({
      method: 'tool.progress',
      toolCallId: 'tool-1',
      itemId: 'tool-1',
      message: 'partial output',
    });
  });

  test('does not invent progress for a metadata-only tool_call_update', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const ctx = makeCtx(events);

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'ls',
      } as any,
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: 'tool.started',
      toolCallId: 'tool-1',
      toolName: 'ls',
    });
  });

  test('extracts diff-typed content on an in_progress tool_call_update via tool.progress', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const ctx = makeCtx(events);

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'edit',
        status: 'in_progress',
        content: [
          {
            type: 'diff',
            path: 'src/a.ts',
            oldText: 'line1\nline2',
            newText: 'line1\nline2 changed',
          },
        ],
      } as any,
      ctx,
    );

    expect(events.at(-1)).toMatchObject({
      method: 'tool.progress',
      toolCallId: 'tool-1',
      message: 'Modified: src/a.ts\nline1\nline2 changed',
    });
  });

  test('preserves diff type on a completed tool_call_update', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const ctx = makeCtx(events);

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'edit',
        status: 'completed',
        content: [
          {
            type: 'diff',
            path: 'src/new.ts',
            oldText: null,
            newText: 'brand new content',
          },
        ],
      } as any,
      ctx,
    );

    expect(events.at(-1)).toMatchObject({
      method: 'tool.completed',
      toolCallId: 'tool-1',
      status: 'success',
      output: [
        {
          type: 'diff',
          path: 'src/new.ts',
          newText: 'brand new content',
        },
      ],
    });
  });
});

describe('mapAcpSessionUpdate — tool name / argument resolution (chat-dock-maximize-readiness)', () => {
  test('tool_call prefers the programmatic name over the descriptive title', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const ctx = makeCtx(events);

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Editing the source file',
        name: 'edit_file',
        rawInput: { path: 'src/a.ts' },
      } as any,
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: 'tool.started',
      toolCallId: 'tool-1',
      toolName: 'edit_file',
      arguments: { path: 'src/a.ts' },
    });
  });

  test('tool_call falls back to the descriptive title when no programmatic name is present', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const ctx = makeCtx(events);

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'List directory',
      } as any,
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: 'tool.started',
      toolCallId: 'tool-1',
      toolName: 'List directory',
    });
  });

  test('retains a late programmatic name arriving in a follow-up tool_call_update and re-emits a corrected tool.started', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const state = {};
    const ctx = makeCtx(events, { state });

    // Initial start carries only the human title.
    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Editing the source file',
      } as any,
      ctx,
    );
    // Follow-up update carries the real programmatic name + raw input.
    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'in_progress',
        name: 'edit_file',
        rawInput: { path: 'src/a.ts' },
      } as any,
      ctx,
    );

    const starts = events.filter((e) => e.method === 'tool.started');
    expect(starts).toHaveLength(2);
    expect(starts[0]).toMatchObject({ toolName: 'Editing the source file' });
    expect(starts[1]).toMatchObject({
      toolName: 'edit_file',
      arguments: { path: 'src/a.ts' },
    });
  });

  test('does not re-emit tool.started when a follow-up update carries no new name or rawInput', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const state = {};
    const ctx = makeCtx(events, { state });

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'ls',
      } as any,
      ctx,
    );
    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'in_progress',
        content: [
          { type: 'content', content: { type: 'text', text: 'running' } },
        ],
      } as any,
      ctx,
    );

    const starts = events.filter((e) => e.method === 'tool.started');
    expect(starts).toHaveLength(1);
  });

  test('tool.completed prefers the programmatic name and retains a late name from the start', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const state = {};
    const ctx = makeCtx(events, { state });

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Editing the source file',
        name: 'edit_file',
      } as any,
      ctx,
    );
    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
      } as any,
      ctx,
    );

    const completed = events.find((e) => e.method === 'tool.completed');
    expect(completed).toMatchObject({
      toolName: 'edit_file',
      status: 'success',
    });
  });

  test('a terminal update can correct the displayed tool name and arguments', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const state = {};
    const ctx = makeCtx(events, { state });

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-terminal',
        title: 'Reading a file',
      } as any,
      ctx,
    );
    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-terminal',
        status: 'completed',
        name: 'read',
        rawInput: { filePath: 'src/index.ts' },
        rawOutput: 'done',
      } as any,
      ctx,
    );

    expect(events).toEqual([
      expect.objectContaining({
        method: 'tool.started',
        toolName: 'Reading a file',
      }),
      expect.objectContaining({
        method: 'tool.started',
        toolName: 'read',
        arguments: { filePath: 'src/index.ts' },
      }),
      expect.objectContaining({
        method: 'tool.completed',
        toolName: 'read',
        output: 'done',
      }),
    ]);
  });

  test('an explicit empty content replacement clears raw-output fallback', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const state = {};
    const ctx = makeCtx(events, { state });

    // Start with rawOutput already set; an explicit empty array replaces it.
    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Run tests',
        rawOutput: { exitCode: 0, stdout: 'all tests passed' },
      } as any,
      ctx,
    );
    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        content: [],
      } as any,
      ctx,
    );

    const completed = events.find((e) => e.method === 'tool.completed');
    expect(completed).toMatchObject({ status: 'success' });
    expect(completed?.output).toEqual([]);
  });

  test('prefers structured content output over rawOutput on completion', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const state = {};
    const ctx = makeCtx(events, { state });

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Run tests',
        rawOutput: 'raw-fallback',
      } as any,
      ctx,
    );
    mapAcpSessionUpdate(
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'structured' } },
        ],
      } as any,
      ctx,
    );

    const completed = events.find((e) => e.method === 'tool.completed');
    expect(completed?.output).toEqual([{ type: 'text', text: 'structured' }]);
  });
});

describe('mapAcpSessionUpdate — content-block parity (image/resource)', () => {
  test('renders image content as a markdown image on agent_message_chunk', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const ctx = makeCtx(events);

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'image',
          data: 'abc123',
          mimeType: 'image/png',
        },
        messageId: 'message-1',
      } as any,
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: 'content.text-delta',
      itemId: 'message-1',
      delta: '\n![image](data:image/png;base64,abc123)\n',
    });
  });

  test('renders resource content as a fenced code block on agent_message_chunk', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const ctx = makeCtx(events);

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'resource',
          resource: { uri: 'file:///a.txt', text: 'file contents' },
        },
        messageId: 'message-1',
      } as any,
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: 'content.text-delta',
      itemId: 'message-1',
      delta: '\n```\nfile contents\n```\n',
    });
  });

  test('renders image content as a markdown image on agent_thought_chunk', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const ctx = makeCtx(events);

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'agent_thought_chunk',
        content: {
          type: 'image',
          uri: 'https://example.com/img.png',
          data: 'abc123',
          mimeType: 'image/png',
        },
        messageId: 'message-1',
      } as any,
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: 'content.reasoning-delta',
      itemId: 'message-1',
      delta: '\n![image](https://example.com/img.png)\n',
    });
  });

  test('renders resource content as a fenced code block on agent_thought_chunk', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const ctx = makeCtx(events);

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'agent_thought_chunk',
        content: {
          type: 'resource',
          resource: { uri: 'file:///a.txt' },
        },
        messageId: 'message-1',
      } as any,
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: 'content.reasoning-delta',
      itemId: 'message-1',
      delta: '\n```\nfile:///a.txt\n```\n',
    });
  });
});

describe('mapAcpSessionUpdate — row 11 adapter state (no canonical event)', () => {
  test('mutates ctx.state for current_mode_update instead of publishing', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const state: { currentModeId?: string } = {};
    const ctx = makeCtx(events, { state });

    mapAcpSessionUpdate(
      {
        sessionUpdate: 'current_mode_update',
        currentModeId: 'plan-mode',
      } as any,
      ctx,
    );

    expect(events).toHaveLength(0);
    expect(state.currentModeId).toBe('plan-mode');
  });
});

describe('mapAcpExtensionNotification', () => {
  test('maps _kiro.dev/mcp/oauth_request to extension.notification with namespace _kiro.dev and url payload', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const ctx = makeCtx(events);

    mapAcpExtensionNotification(
      '_kiro.dev/mcp/oauth_request',
      { url: 'https://example.com/oauth/authorize', serverName: 'github' },
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: 'acp',
      threadId: 'thread-1',
      method: 'extension.notification',
      namespace: '_kiro.dev',
      type: 'mcp/oauth_request',
      payload: {
        url: 'https://example.com/oauth/authorize',
        serverName: 'github',
      },
    });
  });

  test('maps _kiro.dev/compaction/status to extension.notification', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const ctx = makeCtx(events);

    mapAcpExtensionNotification(
      '_kiro.dev/compaction/status',
      { status: 'in_progress' },
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: 'extension.notification',
      namespace: '_kiro.dev',
      type: 'compaction/status',
      payload: { status: 'in_progress' },
    });
  });

  test('falls back to method-as-namespace when the extension method has no slash', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const ctx = makeCtx(events);

    mapAcpExtensionNotification('metadata', { foo: 'bar' }, ctx);

    expect(events[0]).toMatchObject({
      namespace: 'metadata',
      type: 'metadata',
      payload: { foo: 'bar' },
    });
  });

  test('_kiro.dev/commands/available populates ctx.state.slashCommands while still publishing extension.notification (passthrough preserved)', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const state: {
      slashCommands?: Array<{
        name: string;
        description: string;
        argumentHint?: string;
      }>;
    } = {};
    const ctx = makeCtx(events, { state });

    mapAcpExtensionNotification(
      '_kiro.dev/commands/available',
      {
        commands: [
          {
            name: 'deploy',
            description: 'Deploy the app',
            input: { hint: '<env>' },
          },
          { name: 'status' },
        ],
      },
      ctx,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: 'extension.notification',
      namespace: '_kiro.dev',
      type: 'commands/available',
    });
    expect(state.slashCommands).toEqual([
      { name: 'deploy', description: 'Deploy the app', argumentHint: '<env>' },
      { name: 'status', description: '', argumentHint: undefined },
    ]);
  });

  test('does not grant commands semantics to the unevidenced _kiro spelling', () => {
    const events: CanonicalRuntimeEvent[] = [];
    const state: AcpMapperState = {};
    const ctx = makeCtx(events, { state });

    mapAcpExtensionNotification(
      '_kiro/commands/available',
      { commands: [{ name: 'speculative' }] },
      ctx,
    );

    expect(state.slashCommands).toBeUndefined();
    expect(events[0]).toMatchObject({
      method: 'extension.notification',
      namespace: '_kiro',
      type: 'commands/available',
    });
  });

  // archive#4084 (review fix round F1): retention is now routed through the
  // exact-tuple binding registry, not a structural type-prefix guess.
  // mapAcpExtensionNotification retains a bound notification on
  // ctx.state.turnErrorNotifications as a side effect, alongside publishing
  // the ordinary extension.notification event. The adapter-level
  // integration probe (acp-adapter.test.ts) proves this reaches an enriched
  // runtime.error; these are unit tests of the retention/extraction itself.
  describe('acp.turn-error-cause retention (station#4084)', () => {
    test('retains the exact evidenced tuple _kiro.dev/error/rate_limit on ctx.state.turnErrorNotifications (live #1860 shape)', () => {
      const events: CanonicalRuntimeEvent[] = [];
      const state: AcpMapperState = {};
      const ctx = makeCtx(events, { state });

      mapAcpExtensionNotification(
        '_kiro.dev/error/rate_limit',
        { message: 'The monthly usage limit has been reached' },
        ctx,
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        method: 'extension.notification',
        namespace: '_kiro.dev',
        type: 'error/rate_limit',
      });
      expect(state.turnErrorNotifications).toEqual([
        {
          method: '_kiro.dev/error/rate_limit',
          message: 'The monthly usage limit has been reached',
        },
      ]);
    });

    test('does not retain a non-bound notification (e.g. compaction/status)', () => {
      const events: CanonicalRuntimeEvent[] = [];
      const state: AcpMapperState = {};
      const ctx = makeCtx(events, { state });

      mapAcpExtensionNotification(
        '_kiro.dev/compaction/status',
        { status: 'in_progress' },
        ctx,
      );

      expect(state.turnErrorNotifications).toBeUndefined();
    });

    test('does not retain an error-adjacent notification whose payload has no human-readable message (opaque error: unknown)', () => {
      const events: CanonicalRuntimeEvent[] = [];
      const state: AcpMapperState = {};
      const ctx = makeCtx(events, { state });

      // _kiro.dev/agent/config_error carries an opaque `error: unknown`, not
      // a `message` string, AND is not the bound tuple either way.
      mapAcpExtensionNotification(
        '_kiro.dev/agent/config_error',
        { path: '/tmp/agents/broken.json', error: { code: 'EPARSE' } },
        ctx,
      );

      expect(state.turnErrorNotifications).toBeUndefined();
    });

    // F1: exact-tuple matching, not structural. A different type under the
    // same `_kiro.dev` namespace — even one that also reads as
    // "error-shaped" and carries a real message — is unmatched until it is
    // itself observed and added to the registry with its own evidence.
    test('does not retain an unevidenced sibling tuple under the same namespace (_kiro.dev/error/quota_exceeded)', () => {
      const events: CanonicalRuntimeEvent[] = [];
      const state: AcpMapperState = {};
      const ctx = makeCtx(events, { state });

      mapAcpExtensionNotification(
        '_kiro.dev/error/quota_exceeded',
        { message: 'Quota exceeded for this billing period.' },
        ctx,
      );

      expect(events[0]).toMatchObject({
        namespace: '_kiro.dev',
        type: 'error/quota_exceeded',
      });
      expect(state.turnErrorNotifications).toBeUndefined();
    });

    // F1: exact-tuple matching also means a different NAMESPACE never
    // matches on type alone, even the identical type string.
    test('does not retain the same type string from an unevidenced namespace', () => {
      const events: CanonicalRuntimeEvent[] = [];
      const state: AcpMapperState = {};
      const ctx = makeCtx(events, { state });

      mapAcpExtensionNotification(
        'other-vendor/error/rate_limit',
        { message: 'Rate limited by a different engine.' },
        ctx,
      );

      expect(state.turnErrorNotifications).toBeUndefined();
    });

    // F3: the JSON-RPC decoder does not validate params — a bound method can
    // still arrive with null, undefined, or a non-object payload. Must not
    // throw, and must not retain (fail closed).
    test('does not throw and does not retain when the bound tuple arrives with null params', () => {
      const events: CanonicalRuntimeEvent[] = [];
      const state: AcpMapperState = {};
      const ctx = makeCtx(events, { state });

      expect(() =>
        mapAcpExtensionNotification(
          '_kiro.dev/error/rate_limit',
          null as unknown as Record<string, unknown>,
          ctx,
        ),
      ).not.toThrow();
      expect(state.turnErrorNotifications).toBeUndefined();
    });

    test('does not throw and does not retain when the bound tuple arrives with omitted (undefined) params', () => {
      const events: CanonicalRuntimeEvent[] = [];
      const state: AcpMapperState = {};
      const ctx = makeCtx(events, { state });

      expect(() =>
        mapAcpExtensionNotification(
          '_kiro.dev/error/rate_limit',
          undefined as unknown as Record<string, unknown>,
          ctx,
        ),
      ).not.toThrow();
      expect(state.turnErrorNotifications).toBeUndefined();
    });

    // F2/M1: while the current turn's window is snapshotted as suppressed,
    // retention is withheld even for the exact evidenced tuple — the
    // ordinary extension.notification event still publishes. The mapper
    // consults ONLY the frozen `turnErrorNotificationsSuppressed` snapshot
    // (M1), never the live `quarantinedTurnIds` set directly — this test
    // sets both, matching what `sendTurn` actually does at turn start.
    test('withholds retention while the turn is snapshotted as suppressed, but still publishes extension.notification', () => {
      const events: CanonicalRuntimeEvent[] = [];
      const state: AcpMapperState = {
        quarantinedTurnIds: new Set(['turn-being-cancelled']),
        turnErrorNotificationsSuppressed: true,
      };
      const ctx = makeCtx(events, { state });

      mapAcpExtensionNotification(
        '_kiro.dev/error/rate_limit',
        { message: 'The monthly usage limit has been reached' },
        ctx,
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ method: 'extension.notification' });
      expect(state.turnErrorNotifications).toBeUndefined();
    });

    // M1: the mapper must consult ONLY the frozen snapshot, never the live
    // set directly — a non-empty quarantinedTurnIds with no (or false)
    // turnErrorNotificationsSuppressed must NOT suppress retention. This is
    // the exact case a leak-cleanup deletion produces mid-replacement-turn
    // if the mapper were (incorrectly) re-deriving suppression from the
    // live set on every notification instead of the turn-start snapshot.
    test('M1: a non-empty quarantinedTurnIds alone does not suppress retention — only the frozen snapshot does', () => {
      const events: CanonicalRuntimeEvent[] = [];
      const state: AcpMapperState = {
        // Live set still has an entry (leak-cleanup hasn't run yet, or
        // never applies to this turn) but this turn's own snapshot was
        // never marked suppressed.
        quarantinedTurnIds: new Set(['some-other-cancelled-turn']),
      };
      const ctx = makeCtx(events, { state });

      mapAcpExtensionNotification(
        '_kiro.dev/error/rate_limit',
        { message: 'The monthly usage limit has been reached' },
        ctx,
      );

      expect(state.turnErrorNotifications).toEqual([
        {
          method: '_kiro.dev/error/rate_limit',
          message: 'The monthly usage limit has been reached',
        },
      ]);
    });

    // F4b: the retained array is capped so a never-settling turn cannot grow
    // it unboundedly; only the most recent entries are kept.
    test('caps retained notifications, dropping the oldest once the cap is exceeded', () => {
      const events: CanonicalRuntimeEvent[] = [];
      const state: AcpMapperState = {};
      const ctx = makeCtx(events, { state });

      for (let i = 1; i <= 6; i++) {
        mapAcpExtensionNotification(
          '_kiro.dev/error/rate_limit',
          { message: `notification ${i}` },
          ctx,
        );
      }

      expect(state.turnErrorNotifications).toHaveLength(4);
      expect(state.turnErrorNotifications?.map((n) => n.message)).toEqual([
        'notification 3',
        'notification 4',
        'notification 5',
        'notification 6',
      ]);
    });
  });
});

describe('mapAcpDecisionToOutcome — permission request decision mapping', () => {
  test('accept selects the allow_once option', () => {
    expect(mapAcpDecisionToOutcome('accept', PERMISSION_OPTIONS)).toEqual({
      outcome: 'selected',
      optionId: 'allow-once',
    });
  });

  test('acceptForSession selects the allow_always option', () => {
    expect(
      mapAcpDecisionToOutcome('acceptForSession', PERMISSION_OPTIONS),
    ).toEqual({
      outcome: 'selected',
      optionId: 'allow-always',
    });
  });

  test('decline selects the reject_once option', () => {
    expect(mapAcpDecisionToOutcome('decline', PERMISSION_OPTIONS)).toEqual({
      outcome: 'selected',
      optionId: 'reject-once',
    });
  });

  test('cancel always cancels regardless of offered options', () => {
    expect(mapAcpDecisionToOutcome('cancel', PERMISSION_OPTIONS)).toEqual({
      outcome: 'cancelled',
    });
  });

  test('falls back to allow_always when allow_once is not offered', () => {
    const options = PERMISSION_OPTIONS.filter(
      (option) => option.kind !== 'allow_once',
    );
    expect(mapAcpDecisionToOutcome('accept', options)).toEqual({
      outcome: 'selected',
      optionId: 'allow-always',
    });
  });

  test('falls back to cancelled when no option of the requested polarity is offered', () => {
    const onlyAllowOptions = PERMISSION_OPTIONS.filter((option) =>
      option.kind.startsWith('allow'),
    );
    expect(mapAcpDecisionToOutcome('decline', onlyAllowOptions)).toEqual({
      outcome: 'cancelled',
    });
  });
});

describe('mapAcpDecisionToApprovalStatus', () => {
  test.each([
    ['accept', 'approved'],
    ['acceptForSession', 'approved'],
    ['decline', 'denied'],
    ['cancel', 'cancelled'],
  ] as const)('%s -> %s', (decision, status) => {
    expect(mapAcpDecisionToApprovalStatus(decision)).toBe(status);
  });
});

describe('mapAcpStopReasonToFinishReason — stopReason table', () => {
  test.each([
    ['end_turn', 'stop'],
    ['max_tokens', 'max-tokens'],
    ['cancelled', 'cancelled'],
    ['max_turn_requests', 'other'],
    ['refusal', 'other'],
  ] as const)('%s -> %s', (reason, finishReason) => {
    expect(mapAcpStopReasonToFinishReason(reason)).toBe(finishReason);
  });
});

describe('station#1182 — extractReportedModelFromConfigOptions', () => {
  test('reads currentValue off the model-category select option', () => {
    expect(
      extractReportedModelFromConfigOptions([
        { id: 'a', category: 'thought_level', currentValue: 'high' },
        { id: 'b', category: 'model', currentValue: 'engine-native-opus' },
      ]),
    ).toBe('engine-native-opus');
  });

  test('is undefined for non-array, empty array, or no model-category option', () => {
    expect(extractReportedModelFromConfigOptions(undefined)).toBeUndefined();
    expect(extractReportedModelFromConfigOptions(null)).toBeUndefined();
    expect(extractReportedModelFromConfigOptions([])).toBeUndefined();
    expect(
      extractReportedModelFromConfigOptions([
        { id: 'a', category: 'thought_level', currentValue: 'high' },
      ]),
    ).toBeUndefined();
  });

  test('ignores a boolean-type model-category option with no currentValue string', () => {
    expect(
      extractReportedModelFromConfigOptions([
        { id: 'a', category: 'model', currentValue: true },
      ]),
    ).toBeUndefined();
  });

  test('trims and rejects a blank currentValue', () => {
    expect(
      extractReportedModelFromConfigOptions([
        { id: 'a', category: 'model', currentValue: '   ' },
      ]),
    ).toBeUndefined();
    expect(
      extractReportedModelFromConfigOptions([
        { id: 'a', category: 'model', currentValue: '  opus  ' },
      ]),
    ).toBe('opus');
  });
});
