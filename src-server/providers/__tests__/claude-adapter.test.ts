import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { expectCanonicalSessionLifecycle } from './adapter-contract-test-utils.js';

// The genuine built-in station-control server as it appears in a resolved
// agent's toolServers — required for `station-control_*` auto-approval to be
// honored (the reserved-name identity guard rejects a same-id impostor).
// (`builtinStationControlServerPath` is imported below, after the vi.mock block.)
const GENUINE_STATION_CONTROL_TOOLSERVER = {
  id: 'station-control',
  command: 'node',
  args: [builtinStationControlServerPath()],
};

const { mockDeleteSession, mockForkSession, mockListSessions, mockQuery } =
  vi.hoisted(() => ({
    mockDeleteSession: vi.fn(),
    mockForkSession: vi.fn(),
    mockListSessions: vi.fn(),
    mockQuery: vi.fn(),
  }));

const {
  mockBuildCliRuntimePrerequisites,
  mockAugmentedSpawnEnv,
  mockFindCliBinaryAsync,
  mockRunCliCommand,
} = vi.hoisted(() => ({
  mockBuildCliRuntimePrerequisites: vi.fn(),
  // #1551: the module-level default resolver. Reset to "no installed
  // claude" in beforeEach so every pre-existing test keeps today's
  // byte-identical `buildOptions` shape (no
  // `pathToClaudeCodeExecutable`), and so NO test in this suite can pass
  // because the machine running it happens to have `claude` on PATH.
  mockFindCliBinaryAsync: vi.fn(),
  // #1551: the shared bounded CLI probe. Reset to `null` in beforeEach so
  // this suite never spawns a real process, and so no version comparison is
  // decided by whatever `claude` the host happens to have.
  mockRunCliCommand: vi.fn(),
  // archive#1156: unset by default (resolves `undefined`) so every
  // existing test keeps today's byte-identical `buildOptions` shape
  // untouched -- only the dedicated 'archive#1156' describe block below opts a
  // test into a concrete augmented-env value via `mockResolvedValue`/
  // `mockRejectedValueOnce`.
  mockAugmentedSpawnEnv: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  deleteSession: mockDeleteSession,
  forkSession: mockForkSession,
  listSessions: mockListSessions,
  query: mockQuery,
}));

vi.mock('../auth/cli-auth.js', () => ({
  buildCliRuntimePrerequisites: mockBuildCliRuntimePrerequisites,
  augmentedSpawnEnv: mockAugmentedSpawnEnv,
  findCliBinaryAsync: mockFindCliBinaryAsync,
  runCliCommand: mockRunCliCommand,
}));

import { builtinStationControlServerPath } from '../../runtime/bootstrap/station-control-runtime-env.js';
import { engineSpawnTmpDirPath } from '../../services/infra/engine-spawn-tmpdir.js';
import { agentCapabilityUndelivered } from '../../telemetry/metrics.js';
import { scrubBootInternalSecrets } from '../../utils/child-process-environment.js';
import { INTERNAL_API_TOKEN_ENV } from '../../utils/internal-api-token.js';
import { ProviderTurnEndedError } from '../adapter-shape.js';
import {
  ClaudeAdapter,
  parseClaudeCodeVersion,
  readBundledClaudeCodeVersion,
  resolveSpawnableClaudeExecutable,
} from '../adapters/claude-adapter.js';

function createMockQuery(
  messages: any[],
  models: Array<{
    value: string;
    displayName: string;
    description?: string;
    resolvedModel?: string;
    supportsEffort?: unknown;
    supportedEffortLevels?: unknown;
    supportsAdaptiveThinking?: unknown;
    supportsFastMode?: unknown;
    supportsAutoMode?: unknown;
  }> = [],
) {
  let closed = false;
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        if (closed) return;
        yield message;
      }
    },
    interrupt: vi.fn().mockResolvedValue(undefined),
    supportedModels: vi.fn().mockResolvedValue(models),
    close: vi.fn().mockImplementation(() => {
      closed = true;
    }),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * archive#1182: a push-driven mock query, for tests that need to interleave
 * specific SDK messages with specific `sendTurn` calls in a deterministic
 * order — `createMockQuery`'s static array replays immediately and
 * independently of turn boundaries, which can't exercise per-turn reset
 * behavior.
 */
function createControlledMockQuery() {
  const pending: any[] = [];
  let wake: (() => void) | null = null;
  return {
    push(message: any) {
      pending.push(message);
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (pending.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        yield pending.shift();
      }
    },
    interrupt: vi.fn().mockResolvedValue(undefined),
    supportedModels: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ClaudeAdapter', () => {
  test('does not overstate local recovery events as provider acceptance', () => {
    expect(new ClaudeAdapter().metadata.recovery).not.toHaveProperty(
      'dispatchSettlement',
    );
  });

  beforeEach(() => {
    mockFindCliBinaryAsync.mockReset();
    mockFindCliBinaryAsync.mockResolvedValue(null);
    mockRunCliCommand.mockReset();
    mockRunCliCommand.mockResolvedValue(null);
  });

  afterEach(() => {
    mockDeleteSession.mockReset();
    mockForkSession.mockReset();
    mockListSessions.mockReset();
    mockQuery.mockReset();
    mockBuildCliRuntimePrerequisites.mockReset();
    mockAugmentedSpawnEnv.mockReset();
  });

  test('adopts an external session by forking it and persists only the distinct child cursor', async () => {
    mockForkSession.mockResolvedValue({ sessionId: 'vendor-child' });
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();
    const onProviderChildCreated = vi.fn();

    const session = await adapter.adoptSession?.(
      {
        provider: 'claude',
        threadId: 'station-child',
        sourceSessionId: 'vendor-source',
        sourceKind: 'claude-transcript',
        cwd: '/workspace/project',
        modelId: 'claude-sonnet-4-6',
        metadata: { adoptedFromThreadId: 'station-source' },
      },
      { onProviderChildCreated },
    );

    expect(mockForkSession).toHaveBeenCalledWith('vendor-source', {
      dir: '/workspace/project',
      title: 'Station continuation station-child',
    });
    expect(mockQuery).toHaveBeenCalledWith({
      prompt: expect.anything(),
      options: expect.objectContaining({
        cwd: '/workspace/project',
        model: 'claude-sonnet-4-6',
        resume: 'vendor-child',
        persistSession: true,
      }),
    });
    expect(onProviderChildCreated).toHaveBeenCalledWith('vendor-child');
    expect(session).toMatchObject({
      threadId: 'station-child',
      provider: 'claude',
      resumeCursor: 'vendor-child',
      cwd: '/workspace/project',
      controlMode: 'station-owned',
    });
  });

  test('refuses a fork result that reuses the external source cursor without starting a child query', async () => {
    mockForkSession.mockResolvedValue({ sessionId: 'vendor-source' });
    const adapter = new ClaudeAdapter();

    await expect(
      adapter.adoptSession?.({
        provider: 'claude',
        threadId: 'station-child',
        sourceSessionId: 'vendor-source',
        sourceKind: 'claude-transcript',
        cwd: '/workspace/project',
      }),
    ).rejects.toThrow('distinct child session');
    expect(mockQuery).not.toHaveBeenCalled();
    await expect(adapter.hasSession('station-child')).resolves.toBe(false);
  });

  test('deletes the provider transcript when an adopted session is discarded', async () => {
    mockForkSession.mockResolvedValue({ sessionId: 'vendor-child' });
    mockQuery.mockReturnValue(createMockQuery([]));
    mockDeleteSession.mockResolvedValue(undefined);
    const adapter = new ClaudeAdapter();
    await adapter.adoptSession({
      provider: 'claude',
      threadId: 'station-child',
      sourceSessionId: 'vendor-source',
      sourceKind: 'claude-transcript',
      cwd: '/workspace/project',
    });

    await adapter.discardSession('station-child');

    expect(mockDeleteSession).toHaveBeenCalledWith('vendor-child', {
      dir: '/workspace/project',
    });
    await expect(adapter.hasSession('station-child')).resolves.toBe(false);
  });

  test('deletes a persisted provider cursor during restart reconciliation', async () => {
    mockDeleteSession.mockResolvedValue(undefined);
    const adapter = new ClaudeAdapter();

    await adapter.discardSession('station-child', {
      cwd: '/workspace/project',
      resumeCursor: 'vendor-child',
    });

    expect(mockDeleteSession).toHaveBeenCalledWith('vendor-child', {
      dir: '/workspace/project',
    });
  });

  test('recovers a crash-before-cursor fork by exact title and recent modification time', async () => {
    mockListSessions.mockResolvedValue([
      {
        sessionId: 'wrong-title',
        customTitle: 'Station continuation another-child',
        createdAt: Date.parse('2020-01-01T00:00:00.000Z'),
        lastModified: Date.parse('2026-07-22T00:00:01.000Z'),
      },
      {
        sessionId: 'vendor-child',
        customTitle: 'Station continuation station-child',
        createdAt: Date.parse('2020-01-01T00:00:00.000Z'),
        lastModified: Date.parse('2026-07-22T00:00:01.000Z'),
      },
    ]);
    mockDeleteSession.mockResolvedValue(undefined);
    const adapter = new ClaudeAdapter();

    await adapter.discardSession('station-child', {
      adoptionKey: 'station-child',
      createdAt: '2026-07-22T00:00:00.000Z',
      cwd: '/workspace/project',
    });

    expect(mockListSessions).toHaveBeenCalledWith({
      dir: '/workspace/project',
    });
    expect(mockDeleteSession).toHaveBeenCalledWith('vendor-child', {
      dir: '/workspace/project',
    });
  });

  test('deletes a fork when starting its query throws', async () => {
    mockForkSession.mockResolvedValue({ sessionId: 'vendor-child' });
    mockQuery.mockImplementation(() => {
      throw new Error('query failed');
    });
    mockDeleteSession.mockResolvedValue(undefined);
    const adapter = new ClaudeAdapter();

    await expect(
      adapter.adoptSession({
        provider: 'claude',
        threadId: 'station-child',
        sourceSessionId: 'vendor-source',
        sourceKind: 'claude-transcript',
        cwd: '/workspace/project',
      }),
    ).rejects.toThrow('query failed');
    expect(mockDeleteSession).toHaveBeenCalledWith('vendor-child', {
      dir: '/workspace/project',
    });
  });

  test('maps Claude SDK stream events to canonical runtime events', async () => {
    mockQuery.mockReturnValue(
      createMockQuery([
        {
          type: 'system',
          subtype: 'session_state_changed',
          state: 'running',
          uuid: 'm1',
          session_id: 'thread-1',
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'hello' },
          },
          uuid: 'm2',
          session_id: 'thread-1',
        },
        {
          type: 'tool_progress',
          tool_use_id: 'tool-1',
          tool_name: 'Read',
          parent_tool_use_id: null,
          elapsed_time_seconds: 1,
          uuid: 'm3',
          session_id: 'thread-1',
        },
        {
          type: 'result',
          subtype: 'success',
          result: 'done',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
          uuid: 'm4',
          session_id: 'thread-1',
        },
      ]),
    );

    const adapter = new ClaudeAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-1',
      cwd: '/tmp/project',
      modelId: 'claude-sonnet-4-6',
    });
    await adapter.sendTurn({
      threadId: 'thread-1',
      input: 'Inspect this codebase',
    });

    const methods = [
      (await iterator.next()).value.method,
      (await iterator.next()).value.method,
      (await iterator.next()).value.method,
      (await iterator.next()).value.method,
      (await iterator.next()).value.method,
      (await iterator.next()).value.method,
    ];

    expectCanonicalSessionLifecycle(methods);
    expect(methods).toEqual([
      'session.started',
      'session.configured',
      'turn.started',
      'session.state-changed',
      'content.text-delta',
      'tool.progress',
    ]);
  });

  test('sendTurn keeps the typed displayInput in turn.started while the SDK prompt queue receives the composed model input (#685)', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-ambient',
      modelId: 'claude-sonnet-4-6',
    });
    await iterator.next(); // session.started
    await iterator.next(); // session.configured

    await adapter.sendTurn({
      threadId: 'thread-ambient',
      input: '[Timezone: Iceland]\nwhat time is it?',
      displayInput: 'what time is it?',
    });

    // Transcript-facing event carries the typed text only.
    const turnStarted = await iterator.next();
    expect(turnStarted.value).toMatchObject({
      method: 'turn.started',
      prompt: 'what time is it?',
    });

    // Model boundary: the SDK prompt queue receives the composed input.
    const promptQueue = mockQuery.mock.calls[0][0].prompt;
    const queued = await promptQueue[Symbol.asyncIterator]().next();
    expect(queued.value.message).toMatchObject({
      role: 'user',
      content: '[Timezone: Iceland]\nwhat time is it?',
    });

    await adapter.stopSession('thread-ambient');
  });

  test('steerTurn binds to the live SDK streaming-input queue', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();
    const events = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-steer',
      modelId: 'claude-sonnet-4-6',
    });
    const turn = await adapter.sendTurn({
      threadId: 'thread-steer',
      input: 'initial',
    });
    const promptQueue = mockQuery.mock.calls[0][0].prompt;
    const iterator = promptQueue[Symbol.asyncIterator]();
    await iterator.next();
    await events.next();
    await events.next();
    await events.next();

    await adapter.steerTurn('thread-steer', 'course correct', turn.turnId);

    const steered = await iterator.next();
    expect(steered.value).toMatchObject({
      type: 'user',
      session_id: 'thread-steer',
      message: { role: 'user', content: 'course correct' },
    });
    await expect(events.next()).resolves.toMatchObject({
      value: {
        method: 'turn.started',
        turnId: turn.turnId,
        prompt: 'course correct',
        inputKind: 'steer',
      },
    });
    await adapter.stopSession('thread-steer');
  });

  test('steerTurn reports a typed turn-ended race when the input queue closed', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();
    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-steer-closed',
      modelId: 'claude-sonnet-4-6',
    });
    const turn = await adapter.sendTurn({
      threadId: 'thread-steer-closed',
      input: 'initial',
    });
    const promptQueue = mockQuery.mock.calls[0][0].prompt;
    promptQueue.close();

    await expect(
      adapter.steerTurn('thread-steer-closed', 'too late', turn.turnId),
    ).rejects.toBeInstanceOf(ProviderTurnEndedError);
    await adapter.stopSession('thread-steer-closed');
  });

  test('serializes an image attachment as a native Claude image block', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-image',
      modelId: 'claude-sonnet-4-6',
    });
    await adapter.sendTurn({
      threadId: 'thread-image',
      input: '',
      attachments: [
        {
          kind: 'image',
          name: 'pasted.png',
          mimeType: 'image/png',
          size: 3,
          dataUrl: 'data:image/png;base64,YWJj',
        },
      ],
    });

    const promptQueue = mockQuery.mock.calls[0][0].prompt;
    const queued = await promptQueue[Symbol.asyncIterator]().next();
    expect(queued.value.message.content).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'YWJj',
        },
      },
    ]);

    await adapter.stopSession('thread-image');
  });

  test('applies and records a supported model change without restarting the Claude session', async () => {
    const sdkQuery = createMockQuery([]);
    mockQuery.mockReturnValue(sdkQuery);
    const adapter = new ClaudeAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-model-change',
      modelId: 'claude-sonnet-4-6',
      modelOptions: { effort: 'medium', approvalMode: 'ask' },
    });
    await iterator.next(); // session.started
    const configured = await iterator.next();
    expect(configured.value).toMatchObject({
      method: 'session.configured',
      metadata: {
        effectiveModel: 'claude-sonnet-4-6',
        effectiveModelOptions: { effort: 'medium' },
      },
    });

    await adapter.sendTurn({
      threadId: 'thread-model-change',
      input: 'Use the stronger model',
      modelId: 'claude-opus-4-6',
      modelOptions: {
        effort: 'high',
        thinking: false,
        fastMode: true,
        autoMode: false,
        approvalMode: 'ask',
        systemPrompt: 'must not be persisted',
      },
    });

    expect(sdkQuery.setModel).toHaveBeenCalledWith('claude-opus-4-6');
    expect(sdkQuery.applyFlagSettings).toHaveBeenCalledWith({
      effortLevel: 'high',
      alwaysThinkingEnabled: false,
      fastMode: true,
      disableAutoMode: 'disable',
    });
    const turnStarted = await iterator.next();
    expect(turnStarted.value).toMatchObject({
      method: 'turn.started',
      metadata: {
        effectiveModel: 'claude-opus-4-6',
        effectiveModelOptions: {
          effort: 'high',
          thinking: false,
          fastMode: true,
          autoMode: false,
        },
      },
    });
    expect(
      turnStarted.value.metadata.effectiveModelOptions.systemPrompt,
    ).toBeUndefined();

    await adapter.sendTurn({
      threadId: 'thread-model-change',
      input: 'Use model defaults',
      modelId: 'claude-opus-4-6',
      modelOptions: { approvalMode: 'ask' },
    });
    expect(sdkQuery.applyFlagSettings).toHaveBeenLastCalledWith({
      effortLevel: null,
      alwaysThinkingEnabled: null,
      fastMode: null,
      disableAutoMode: null,
    });
    const resetTurn = await iterator.next();
    expect(resetTurn.value).toMatchObject({
      method: 'turn.started',
      metadata: { effectiveModel: 'claude-opus-4-6' },
    });
    expect(resetTurn.value.metadata.effectiveModelOptions).toEqual({});

    await adapter.stopSession('thread-model-change');
  });

  test('maps validated images and text files to Claude native content blocks', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-attachments',
    });
    await adapter.sendTurn({
      threadId: 'thread-attachments',
      input: 'Review these',
      attachments: [
        {
          kind: 'image',
          name: 'screen.png',
          mimeType: 'image/png',
          size: 3,
          dataUrl: 'data:image/png;base64,YWJj',
        },
        {
          kind: 'file',
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: 5,
          dataUrl: 'data:text/plain;base64,aGVsbG8=',
        },
      ],
    });

    const promptQueue = mockQuery.mock.calls[0][0].prompt;
    const queued = await promptQueue[Symbol.asyncIterator]().next();
    expect(queued.value.message).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Review these' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'YWJj',
          },
        },
        {
          type: 'document',
          title: 'notes.txt',
          source: {
            type: 'text',
            media_type: 'text/plain',
            data: 'hello',
          },
        },
      ],
    });

    await adapter.stopSession('thread-attachments');
  });

  test('rejects invalid UTF-8 documents before queuing a Claude prompt', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();
    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-invalid-utf8',
    });

    await expect(
      adapter.sendTurn({
        threadId: 'thread-invalid-utf8',
        input: 'Review this',
        attachments: [
          {
            kind: 'file',
            name: 'invalid.txt',
            mimeType: 'text/plain',
            size: 2,
            dataUrl: 'data:text/plain;base64,wyg=',
          },
        ],
      }),
    ).rejects.toThrow('is not valid UTF-8 text');

    const promptQueue = mockQuery.mock.calls[0][0].prompt;
    const nextPrompt = promptQueue[Symbol.asyncIterator]().next();
    await expect(
      Promise.race([
        nextPrompt,
        new Promise((resolve) => setTimeout(() => resolve('empty'), 20)),
      ]),
    ).resolves.toBe('empty');
    await adapter.stopSession('thread-invalid-utf8');
  });

  describe("#1545: a session loads the engine's own settings cascade (accepted gap)", () => {
    // The option is UNSET on purpose, which means the SDK loads all sources —
    // including a workspace's checked-in `.claude/settings.json`, whose
    // `permissions.allow` rules can then run a tool with no Station approval
    // request. That gap is accepted (same-user threat model; narrowing to
    // `['user']` would cost the workspace's CLAUDE.md and its `.mcp.json`
    // servers — see the comment at the call site). These assert ABSENCE rather
    // than a value so that setting it later is a deliberate, visible change
    // rather than something that lands unnoticed: `toBeUndefined()` alone would
    // pass for a key explicitly present as `undefined`, so pin the key too.
    const cases: Array<[string, Record<string, unknown> | undefined]> = [
      ['a plain session', undefined],
      ['an Ask-mode session', { approvalMode: 'ask' }],
      ['a full-access session', { approvalMode: 'never' }],
      ['a plan-mode session', { permissionMode: 'plan' }],
    ];
    for (const [label, modelOptions] of cases) {
      test(`sets no settingSources for ${label}`, async () => {
        mockQuery.mockReturnValue(createMockQuery([]));
        const adapter = new ClaudeAdapter();

        await adapter.startSession({
          provider: 'claude',
          threadId: 'thread-setting-sources',
          cwd: '/workspace/project',
          ...(modelOptions ? { modelOptions } : {}),
        });

        const options = mockQuery.mock.calls[0][0].options as Record<
          string,
          unknown
        >;
        expect('settingSources' in options).toBe(false);
      });
    }

    test('the model-catalog probe still pins settingSources to none at all', async () => {
      // The one Station-owned Claude spawn that DOES narrow: it runs no tools,
      // so its isolation is not the same decision as a session's.
      mockQuery.mockReturnValue(createMockQuery([], []));
      await new ClaudeAdapter().listModelCatalog?.();

      expect(mockQuery.mock.calls[0][0].options.settingSources).toEqual([]);
    });
  });

  test('carries the SDK subagent id on approval requests raised from a child agent', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-subagent',
    });
    await iterator.next();
    await iterator.next();

    const queryArgs = mockQuery.mock.calls[0][0];
    const permissionPromise = queryArgs.options.canUseTool(
      'Bash',
      { command: 'echo hi > out.txt' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-use-child',
        agentID: 'a40e65cb620cd452b',
        suggestions: [],
      },
    );

    const opened = await iterator.next();
    expect(opened.value).toMatchObject({
      method: 'request.opened',
      payload: { toolName: 'Bash', agentId: 'a40e65cb620cd452b' },
    });
    await adapter.respondToRequest(
      'thread-subagent',
      opened.value.requestId,
      'decline',
    );
    await expect(permissionPromise).resolves.toMatchObject({
      behavior: 'deny',
    });
    await adapter.stopSession('thread-subagent');
  });

  test('opens and resolves permission requests through canUseTool', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-2',
    });
    await iterator.next();
    await iterator.next();

    const queryArgs = mockQuery.mock.calls[0][0];
    const permissionPromise = queryArgs.options.canUseTool(
      'Read',
      { path: 'a.ts' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-use-1',
        title: 'Allow read',
        description: 'Claude wants to read a.ts',
        suggestions: [],
      },
    );

    const opened = await iterator.next();
    expect(opened.value).toMatchObject({
      method: 'request.opened',
      requestType: 'approval',
    });

    await adapter.respondToRequest(
      'thread-2',
      opened.value.requestId,
      'accept',
    );
    const result = await permissionPromise;
    const resolved = await iterator.next();

    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { path: 'a.ts' },
      updatedPermissions: undefined,
    });
    expect(resolved.value).toMatchObject({
      method: 'request.resolved',
      status: 'approved',
    });
  });

  describe('canUseTool honors the session agent tools.autoApprove (external autoApprove parity)', () => {
    function withTimeout<T>(
      promise: Promise<T>,
      ms: number,
    ): Promise<T | 'TIMED_OUT'> {
      return Promise.race([
        promise,
        new Promise<'TIMED_OUT'>((resolve) =>
          setTimeout(() => resolve('TIMED_OUT'), ms),
        ),
      ]);
    }

    test('auto-approves an mcp__server__tool call matching the agent server_* pattern, with no approval request surfaced', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-auto-approve',
        agent: {
          slug: 'engine-lab',
          // station-voice's actual pattern (agent-hooks.ts), authored
          // against the Station-engine <server>_<tool> tool-name shape.
          autoApprove: ['station-control_*'],
          toolServers: [GENUINE_STATION_CONTROL_TOOLSERVER],
        },
      });
      await iterator.next(); // session.started
      await iterator.next(); // session.configured

      const queryArgs = mockQuery.mock.calls[0][0];
      // The Claude SDK's actual MCP tool-name format for a station-control
      // tool call.
      const result = await withTimeout(
        queryArgs.options.canUseTool(
          'mcp__station-control__list_agents',
          { foo: 'bar' },
          {
            signal: new AbortController().signal,
            toolUseID: 'tool-use-auto',
            suggestions: [],
          },
        ),
        200,
      );

      expect(result).toEqual({
        behavior: 'allow',
        updatedInput: { foo: 'bar' },
      });

      // No request.opened ever reaches the stream for this call — pumping
      // the iterator again must time out rather than yield an event.
      const nextEvent = await withTimeout(iterator.next(), 200);
      expect(nextEvent).toBe('TIMED_OUT');
    });

    test('still requests approval through the ApprovalRegistry for a tool NOT matching the pattern', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-no-match',
        agent: {
          slug: 'engine-lab',
          autoApprove: ['station-control_*'],
        },
      });
      await iterator.next();
      await iterator.next();

      const queryArgs = mockQuery.mock.calls[0][0];
      const permissionPromise = queryArgs.options.canUseTool(
        'mcp__other-server__do_thing',
        { path: 'a.ts' },
        {
          signal: new AbortController().signal,
          toolUseID: 'tool-use-no-match',
          suggestions: [],
        },
      );

      const opened = await iterator.next();
      expect(opened.value).toMatchObject({
        method: 'request.opened',
        requestType: 'approval',
      });

      await adapter.respondToRequest(
        'thread-no-match',
        opened.value.requestId,
        'accept',
      );
      const result = await permissionPromise;
      expect(result).toEqual({
        behavior: 'allow',
        updatedInput: { path: 'a.ts' },
        updatedPermissions: undefined,
      });
    });

    test('an empty autoApprove list leaves approval behavior unchanged (always requests)', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-empty-autoapprove',
        agent: {
          slug: 'engine-lab',
          autoApprove: [],
        },
      });
      await iterator.next();
      await iterator.next();

      const queryArgs = mockQuery.mock.calls[0][0];
      const permissionPromise = queryArgs.options.canUseTool(
        'mcp__station-control__list_agents',
        {},
        {
          signal: new AbortController().signal,
          toolUseID: 'tool-use-empty',
          suggestions: [],
        },
      );

      const opened = await iterator.next();
      expect(opened.value).toMatchObject({
        method: 'request.opened',
        requestType: 'approval',
      });

      await adapter.respondToRequest(
        'thread-empty-autoapprove',
        opened.value.requestId,
        'decline',
      );
      const result = await permissionPromise;
      expect(result).toEqual({
        behavior: 'deny',
        message: 'User declined the permission request.',
      });
    });
  });

  describe('PreToolUse applies Station staged policy before Claude dispatch', () => {
    function preToolUse(queryArgs: any) {
      return queryArgs.options.hooks.PreToolUse[0].hooks[0] as (
        input: {
          tool_name: string;
          tool_input: unknown;
          tool_use_id: string;
        },
        toolUseId: string,
        options: { signal: AbortSignal },
      ) => Promise<unknown>;
    }

    const preToolInput = {
      tool_name: 'mcp__station-control__list_agents',
      tool_input: { scope: 'current' },
      tool_use_id: 'pre-tool-1',
    };

    test('denies before execution and never delegates the denial to canUseTool', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const evaluator = vi.fn().mockResolvedValue({
        behavior: 'deny',
        denial: { allowed: false, reason: 'blocked by Station policy' },
      });
      const adapter = new ClaudeAdapter({
        resolvePreToolPolicy: async () => evaluator,
      });

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-pre-tool-denied',
        agent: { slug: 'engine-lab' },
      });

      const queryArgs = mockQuery.mock.calls[0][0];
      queryArgs.options.canUseTool = vi.fn();
      const result = await preToolUse(queryArgs)(
        preToolInput,
        preToolInput.tool_use_id,
        { signal: new AbortController().signal },
      );

      expect(result).toEqual({
        continue: false,
        stopReason: 'blocked by Station policy',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'blocked by Station policy',
        },
      });
      expect(evaluator).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: preToolInput.tool_name,
          toolArgs: preToolInput.tool_input,
          toolCallId: preToolInput.tool_use_id,
        }),
        { agentSlug: 'engine-lab', conversationId: 'thread-pre-tool-denied' },
        {
          interaction: 'external',
          identity: {
            delegationToolName: 'station-control_list_agents',
            configProtectionToolName: 'list_agents',
          },
        },
      );
      expect(queryArgs.options.canUseTool).not.toHaveBeenCalled();
    });

    test.each([
      ['timeout', async () => await new Promise<never>(() => {})],
      [
        'error',
        async () => {
          throw new Error('policy backend unavailable');
        },
      ],
    ])(
      'fails closed when the pre-tool evaluator reports a %s',
      async (_name, evaluate) => {
        mockQuery.mockReturnValue(createMockQuery([]));
        const adapter = new ClaudeAdapter({
          preToolPolicyTimeoutMs: 5,
          resolvePreToolPolicy: async () => evaluate as any,
        });

        await adapter.startSession({
          provider: 'claude',
          threadId: `thread-pre-tool-${_name}`,
          agent: { slug: 'engine-lab' },
        });
        const queryArgs = mockQuery.mock.calls[0][0];
        expect(queryArgs.options.hooks.PreToolUse[0].timeout).toBe(1);
        const result = await preToolUse(queryArgs)(
          preToolInput,
          preToolInput.tool_use_id,
          { signal: new AbortController().signal },
        );

        expect(result).toMatchObject({
          continue: false,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: expect.stringContaining(
              _name === 'timeout' ? 'timed out' : 'policy backend unavailable',
            ),
          },
        });
      },
    );

    test('passes server-owned delegation into the staged evaluator', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const evaluator = vi.fn(async (_tool, invocation) =>
        invocation.delegation?.denyApprovals
          ? {
              behavior: 'deny' as const,
              denial: { allowed: false as const, reason: 'delegation denied' },
            }
          : { behavior: 'defer' as const },
      );
      const adapter = new ClaudeAdapter({
        resolvePreToolPolicy: async () => evaluator,
      });

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-pre-tool-delegation',
        agent: { slug: 'engine-lab' },
        metadata: { delegation: { denyApprovals: true } },
      });
      const queryArgs = mockQuery.mock.calls[0][0];

      await expect(
        preToolUse(queryArgs)(preToolInput, preToolInput.tool_use_id, {
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        continue: false,
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
      expect(evaluator).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ delegation: { denyApprovals: true } }),
        expect.anything(),
      );
    });

    test('sets the SDK matcher strictly beyond the in-process denial bound', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter({
        preToolPolicyTimeoutMs: 1_000,
        resolvePreToolPolicy: async () => async () =>
          await new Promise<never>(() => {}),
      });

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-pre-tool-timeout-order',
        agent: { slug: 'engine-lab' },
      });
      const queryArgs = mockQuery.mock.calls[0][0];
      expect(queryArgs.options.hooks.PreToolUse[0].timeout).toBe(2);
    });

    // #1536 finding B1 / #765 A4. This hook's return value is the whole
    // enforcement seam for a call Station's own policy is not deciding, and
    // the value matters more than `continue: true`:
    // `permissionDecision: 'defer'` means "host, you execute this call", so
    // the engine ends the turn immediately (`stop_reason: 'tool_deferred'`)
    // and NEVER consults `canUseTool`. Station has no deferred-call executor,
    // so the hook must state NO permission opinion and let the engine's own
    // flow — which is what `approvalMode` selects — decide and ask.
    //
    // Parameterised over every mode ON PURPOSE, even though the expectation is
    // identical: a `permissionDecision: 'ask'` floor for `default`/Ask mode
    // was built and reverted (it overrides the engine's read-only-command
    // classifier, so a Read/Grep sweep becomes one approval per call), and a
    // future attempt to land one must fail a test rather than pass unnoticed.
    async function preToolOutputForMode(
      approvalMode: 'ask' | 'auto' | 'never',
      behavior: 'defer' | 'ask',
    ) {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter({
        resolvePreToolPolicy: async () =>
          vi.fn().mockResolvedValue({ behavior }),
      });
      await adapter.startSession({
        provider: 'claude',
        threadId: `thread-pre-tool-${approvalMode}-${behavior}`,
        agent: { slug: 'engine-lab' },
        modelOptions: { approvalMode },
      });
      const queryArgs = mockQuery.mock.calls.at(-1)?.[0];
      return (await preToolUse(queryArgs)(
        preToolInput,
        preToolInput.tool_use_id,
        { signal: new AbortController().signal },
      )) as Record<string, unknown>;
    }

    test.each([
      ['ask' as const, 'defer' as const],
      ['ask' as const, 'ask' as const],
      ['auto' as const, 'defer' as const],
      ['auto' as const, 'ask' as const],
      ['never' as const, 'defer' as const],
      ['never' as const, 'ask' as const],
    ])(
      '%s mode states NO permissionDecision for a %s decision, leaving the engine its own flow',
      async (approvalMode, behavior) => {
        const output = await preToolOutputForMode(approvalMode, behavior);
        expect(output).toEqual({ continue: true });
        // Asserted on the wire shape too, so a decision reintroduced under a
        // new key still fails here rather than changing consent silently.
        expect(JSON.stringify(output)).not.toContain('permissionDecision');
      },
    );

    test('a mid-session downgrade to ask does not start forcing approvals', async () => {
      // `sendTurn` moves a live session between modes via `setPermissionMode`.
      // Whatever the mode becomes, the hook's answer for an undecided call is
      // the same — this pins that the transition itself introduces no floor.
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter({
        resolvePreToolPolicy: async () =>
          vi.fn().mockResolvedValue({ behavior: 'defer' }),
      });
      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-pre-tool-mode-change',
        agent: { slug: 'engine-lab' },
        modelOptions: { approvalMode: 'auto' },
      });
      const queryArgs = mockQuery.mock.calls.at(-1)?.[0];
      const call = async () =>
        (await preToolUse(queryArgs)(preToolInput, preToolInput.tool_use_id, {
          signal: new AbortController().signal,
        })) as Record<string, unknown>;

      expect(await call()).toEqual({ continue: true });

      await adapter.sendTurn({
        threadId: 'thread-pre-tool-mode-change',
        input: 'downgrade to ask',
        modelOptions: { approvalMode: 'ask' },
      });

      const after = await call();
      expect(after).toEqual({ continue: true });
      expect(JSON.stringify(after)).not.toContain('permissionDecision');
    });

    test('routes the interactive approval to canUseTool without a duplicate request', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const evaluator = vi.fn().mockResolvedValue({ behavior: 'defer' });
      const adapter = new ClaudeAdapter({
        resolvePreToolPolicy: async () => evaluator,
      });
      const events = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-pre-tool-deferred',
        agent: { slug: 'engine-lab' },
      });
      await events.next();
      await events.next();
      const queryArgs = mockQuery.mock.calls[0][0];

      await preToolUse(queryArgs)(preToolInput, preToolInput.tool_use_id, {
        signal: new AbortController().signal,
      });
      // The engine, not Station, sequences these two: the hook states no
      // opinion (asserted above), and the engine then asks through
      // `canUseTool`. This covers only the second half — that Station's
      // approval request is opened exactly once when it is asked.
      const permission = queryArgs.options.canUseTool(
        preToolInput.tool_name,
        preToolInput.tool_input,
        {
          signal: new AbortController().signal,
          toolUseID: preToolInput.tool_use_id,
          suggestions: [],
        },
      );
      const opened = await events.next();
      expect(opened.value).toMatchObject({
        method: 'request.opened',
        requestType: 'approval',
      });
      await adapter.respondToRequest(
        'thread-pre-tool-deferred',
        opened.value.requestId,
        'accept',
      );
      await expect(permission).resolves.toMatchObject({ behavior: 'allow' });
      expect(evaluator).toHaveBeenCalledTimes(1);
    });
  });

  test('resolves all four canUseTool decisions against the documented SDK PermissionResult contract', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-decisions',
    });
    await iterator.next();
    await iterator.next();

    const queryArgs = mockQuery.mock.calls[0][0];

    function assertSdkPermissionResultContract(result: any) {
      if (result.behavior === 'allow') {
        expect(typeof result.updatedInput).toBe('object');
        expect(result.updatedInput).not.toBeNull();
      } else if (result.behavior === 'deny') {
        expect(typeof result.message).toBe('string');
        expect(result.message.length).toBeGreaterThan(0);
      } else {
        throw new Error(`Unexpected behavior: ${result.behavior}`);
      }
    }

    async function driveDecision(
      decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
      toolInput: Record<string, unknown>,
    ) {
      const permissionPromise = queryArgs.options.canUseTool(
        'Bash',
        toolInput,
        {
          signal: new AbortController().signal,
          toolUseID: `tool-use-${decision}`,
          title: `Allow ${decision}`,
          suggestions: [],
        },
      );
      const opened = await iterator.next();
      await adapter.respondToRequest(
        'thread-decisions',
        opened.value.requestId,
        decision,
      );
      const result = await permissionPromise;
      await iterator.next();
      return result;
    }

    const acceptResult = await driveDecision('accept', {
      command: 'npm --version',
    });
    assertSdkPermissionResultContract(acceptResult);
    expect(acceptResult).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'npm --version' },
      updatedPermissions: undefined,
    });

    const acceptForSessionResult = await driveDecision('acceptForSession', {
      command: 'npm run build',
    });
    assertSdkPermissionResultContract(acceptForSessionResult);
    expect(acceptForSessionResult).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'npm run build' },
      updatedPermissions: [],
    });

    const declineResult = await driveDecision('decline', {
      command: 'rm -rf /',
    });
    assertSdkPermissionResultContract(declineResult);
    expect(declineResult).toEqual({
      behavior: 'deny',
      message: 'User declined the permission request.',
    });

    const cancelResult = await driveDecision('cancel', {
      command: 'shutdown now',
    });
    assertSdkPermissionResultContract(cancelResult);
    expect(cancelResult).toEqual({
      behavior: 'deny',
      message: 'User cancelled the permission request.',
      interrupt: true,
    });
  });

  test('acceptForSession forces every suggested PermissionUpdate destination to session', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-session-scope',
    });
    await iterator.next();
    await iterator.next();

    const queryArgs = mockQuery.mock.calls[0][0];
    const permissionPromise = queryArgs.options.canUseTool(
      'Bash',
      { command: 'npm run *' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-use-session-scope',
        title: 'Allow Bash',
        suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'npm run *' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
      },
    );

    const opened = await iterator.next();
    await adapter.respondToRequest(
      'thread-session-scope',
      opened.value.requestId,
      'acceptForSession',
    );
    const result = await permissionPromise;

    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'npm run *' },
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'npm run *' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    });
  });

  test('stopSession settles pending canUseTool promises with deny and emits request.resolved before session.exited', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-stop',
    });
    await iterator.next(); // session.started
    await iterator.next(); // session.configured

    const queryArgs = mockQuery.mock.calls[0][0];
    const permissionPromise = queryArgs.options.canUseTool(
      'Bash',
      { command: 'npm test' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-use-stop',
        title: 'Allow Bash',
        suggestions: [],
      },
    );

    const opened = await iterator.next();
    expect(opened.value.method).toBe('request.opened');

    await adapter.stopSession('thread-stop');

    // The SDK callback promise must settle (deny) — not hang forever.
    const result = await permissionPromise;
    expect(result).toEqual({
      behavior: 'deny',
      message: 'User cancelled the permission request.',
      interrupt: true,
    });

    // request.resolved for the pending request must precede session.exited.
    const resolved = await iterator.next();
    expect(resolved.value).toMatchObject({
      method: 'request.resolved',
      requestId: opened.value.requestId,
      status: 'cancelled',
    });
    const exited = await iterator.next();
    expect(exited.value).toMatchObject({
      method: 'session.exited',
      sessionId: 'thread-stop',
      reason: 'stopped',
    });

    await expect(adapter.hasSession('thread-stop')).resolves.toBe(false);
  });

  test('stopAll settles pending canUseTool promises across sessions via stopSession', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-stopall',
    });
    await iterator.next(); // session.started
    await iterator.next(); // session.configured

    const queryArgs = mockQuery.mock.calls[0][0];
    const permissionPromise = queryArgs.options.canUseTool(
      'Read',
      { path: 'b.ts' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tool-use-stopall',
        title: 'Allow read',
        suggestions: [],
      },
    );

    const opened = await iterator.next();
    expect(opened.value.method).toBe('request.opened');

    await adapter.stopAll();

    const result = await permissionPromise;
    expect(result).toMatchObject({ behavior: 'deny' });

    const resolved = await iterator.next();
    expect(resolved.value).toMatchObject({
      method: 'request.resolved',
      requestId: opened.value.requestId,
      status: 'cancelled',
    });
    const exited = await iterator.next();
    expect(exited.value).toMatchObject({ method: 'session.exited' });

    await expect(adapter.listSessions()).resolves.toEqual([]);
  });

  test('reports missing Claude CLI login when the CLI is unauthenticated', async () => {
    mockBuildCliRuntimePrerequisites.mockResolvedValue([
      {
        id: 'claude-cli',
        name: 'Claude CLI',
        status: 'installed',
        category: 'required',
      },
      {
        id: 'claude-auth',
        name: 'Claude login',
        status: 'missing',
        category: 'required',
      },
    ]);
    const adapter = new ClaudeAdapter();

    await expect(adapter.getPrerequisites?.()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Claude CLI',
          category: 'required',
        }),
        expect.objectContaining({
          name: 'Claude login',
          status: 'missing',
          category: 'required',
        }),
      ]),
    );
  });

  test('lists models reported by the authenticated Claude CLI', async () => {
    const query = createMockQuery(
      [],
      [
        {
          value: 'claude-sonnet-4-6',
          displayName: 'Claude Sonnet 4.6',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high'],
          supportsAdaptiveThinking: true,
          supportsFastMode: false,
        },
        {
          value: 'claude-opus-4-6',
          displayName: 'Claude Opus 4.6',
        },
      ],
    );
    mockQuery.mockReturnValue(query);

    const adapter = new ClaudeAdapter();
    const controller = new AbortController();

    await expect(
      adapter.listModels?.({ signal: controller.signal }),
    ).resolves.toEqual([
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        originalId: 'claude-sonnet-4-6',
        capabilities: {
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high'],
          supportsAdaptiveThinking: true,
          supportsFastMode: false,
        },
      },
      {
        id: 'claude-opus-4-6',
        name: 'Claude Opus 4.6',
        originalId: 'claude-opus-4-6',
      },
    ]);
    expect(mockQuery).toHaveBeenCalledWith({
      prompt: expect.anything(),
      options: expect.objectContaining({
        tools: [],
        mcpServers: {},
        persistSession: false,
        plugins: [],
        settingSources: [],
        skills: [],
        strictMcpConfig: true,
      }),
    });
    expect(query.supportedModels).toHaveBeenCalledTimes(1);
    expect(query.close).toHaveBeenCalledTimes(1);
  });

  test('reports a bounded Claude CLI model catalog as truncated', async () => {
    mockQuery.mockReturnValue(
      createMockQuery(
        [],
        [
          { value: 'claude-1', displayName: 'Claude 1' },
          { value: 'claude-2', displayName: 'Claude 2' },
        ],
      ),
    );

    await expect(
      new ClaudeAdapter().listModelCatalog?.({ maxEntries: 1 }),
    ).resolves.toEqual({
      models: [{ id: 'claude-1', name: 'Claude 1', originalId: 'claude-1' }],
      truncated: true,
    });
  });

  test('sanitizes and deduplicates Claude CLI model metadata', async () => {
    mockQuery.mockReturnValue(
      createMockQuery(
        [],
        [
          { value: ' sonnet ', displayName: ' Sonnet ' },
          { value: 'sonnet', displayName: 'Duplicate' },
          { value: '', displayName: 'Missing id' },
          null as unknown as { value: string; displayName: string },
          { value: 'x'.repeat(257), displayName: 'Oversized id' },
          { value: 'opus', displayName: 'x'.repeat(257) },
          {
            value: 42 as unknown as string,
            displayName: 'Non-string id',
          },
          {
            value: 'haiku',
            displayName: 42 as unknown as string,
          },
          {
            value: 'claude-fable-5[1m]',
            displayName: ' Fable\u001b[0m ',
            resolvedModel: 'claude-fable-5\u001b[1m',
          },
          {
            value: 'effort',
            displayName: 'Effort',
            supportsEffort: 'yes',
            supportedEffortLevels: ['low', 'invalid', 'low', 42, 'max'],
            supportsFastMode: true,
            supportsAutoMode: true,
          },
        ],
      ),
    );

    await expect(new ClaudeAdapter().listModels?.()).resolves.toEqual([
      { id: 'sonnet', name: 'Sonnet', originalId: 'sonnet' },
      { id: 'haiku', name: 'haiku', originalId: 'haiku' },
      {
        id: 'claude-fable-5',
        name: 'Fable',
        originalId: 'claude-fable-5',
      },
      {
        id: 'effort',
        name: 'Effort',
        originalId: 'effort',
        capabilities: {
          supportedEffortLevels: ['low', 'max'],
          supportsFastMode: true,
          supportsAutoMode: true,
        },
      },
    ]);
  });

  test('propagates abort to and closes the Claude CLI model probe', async () => {
    const controller = new AbortController();
    const query = createMockQuery([]);
    let childSignal: AbortSignal | undefined;
    // #1551: the probe resolves the installed executable before spawning, so
    // the spawn is no longer synchronous with the call. Abort once the probe
    // actually exists -- an abort landing before it is the separate case
    // covered by 'never spawns a probe when the abort lands first'.
    let markSpawned: () => void = () => {};
    const spawned = new Promise<void>((resolve) => {
      markSpawned = resolve;
    });
    mockQuery.mockImplementation(({ options }) => {
      childSignal = options.abortController.signal;
      query.supportedModels.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            childSignal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      );
      markSpawned();
      return query;
    });

    const pending = new ClaudeAdapter().listModels?.({
      signal: controller.signal,
    });
    await spawned;
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
    expect(childSignal?.aborted).toBe(true);
    expect(query.close).toHaveBeenCalledTimes(1);
  });

  test('never spawns a model probe when the abort lands before the executable resolves', async () => {
    const controller = new AbortController();
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter({
      findBinary: async () => {
        controller.abort();
        return null;
      },
    });

    await expect(
      adapter.listModels?.({ signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('rejects approval responses for unknown requests', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-3',
    });

    await expect(
      adapter.respondToRequest('thread-3', 'missing-request', 'accept'),
    ).rejects.toThrow(/unknown claude permission request/i);
  });

  test('publishes runtime.error when the Claude SDK stream fails', async () => {
    mockQuery.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield* [] as never[];
        throw new Error('Claude stream failed');
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    });
    const adapter = new ClaudeAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-4',
      modelId: 'claude-sonnet-4-6',
    });

    expect((await iterator.next()).value.method).toBe('session.started');
    expect((await iterator.next()).value.method).toBe('session.configured');
    expect((await iterator.next()).value).toMatchObject({
      method: 'runtime.error',
      message: 'Claude model "claude-sonnet-4-6" failed: Claude stream failed',
    });
  });

  /**
   * archive#1827. Reproduces the ticket's exact live shape: the SDK
   * delivers a `result` message with `is_error: true` (the STRUCTURED
   * sighting, "No conversation found with session ID: ...") through the
   * normal message stream, and only THEN the underlying `claude` CLI
   * process exits and the SDK's own query iterator re-throws the SAME
   * failure text wrapped as a generic Error (`Query`'s `lastErrorResultText`
   * mechanism in `@anthropic-ai/claude-agent-sdk`'s `sdk.mjs`, cited in
   * `claude-result-outcome.ts`'s doc comment). Before this fix, that shape
   * published the raw text as `turn.completed` (folding an error into what
   * looked like a completed reply) and then published it a SECOND time,
   * unclassified, from the generic catch — exactly the "shown twice, then
   * retried" defect.
   */
  test('a dead --resume session publishes exactly one terminal runtime.error, never turn.completed, and marks the session dead', async () => {
    const failureText =
      'No conversation found with session ID: d434e194-cc2e-4edc-8733-d8645c512fab';
    mockQuery.mockReturnValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: failureText,
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
          uuid: 'result-dead',
          session_id: 'thread-dead',
        };
        throw new Error(`Claude Code returned an error result: ${failureText}`);
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    });
    const adapter = new ClaudeAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-dead',
      resumeCursor: 'd434e194-cc2e-4edc-8733-d8645c512fab',
    });

    // Exactly 4 events: 'session.started' and 'session.configured' publish
    // synchronously from `startTrackedSession` (see the sibling test above),
    // then the message stream's one `result` message produces
    // 'token-usage.updated' followed by the terminal 'runtime.error' — never
    // a fifth event, which is the whole point: the generic catch that fires
    // once the SDK re-throws the same failure must NOT publish a second one.
    const events: any[] = [];
    for (let i = 0; i < 4; i++) {
      events.push((await iterator.next()).value);
    }

    expect(events.map((event) => event.method)).toEqual([
      'session.started',
      'session.configured',
      'token-usage.updated',
      'runtime.error',
    ]);
    expect(events[3]).toMatchObject({
      code: 'engine-session-binding-dead',
      retriable: false,
      message: failureText,
    });
    expect(events.some((event) => event?.method === 'turn.completed')).toBe(
      false,
    );

    // Directly proves no duplicate event was published (rather than only
    // the status side-effect below): race a 5th `iterator.next()` against a
    // short timer. `AsyncEventQueue` never closes this stream on its own, so
    // a 5th call hangs forever when nothing more was queued — exactly the
    // "no duplicate" case — and resolves immediately when the suppression
    // guard regresses and the generic catch publishes a second event.
    const NO_FIFTH_EVENT = Symbol('no fifth event');
    const fifth = await Promise.race([
      iterator.next().then((result) => result.value),
      new Promise((resolve) => setTimeout(() => resolve(NO_FIFTH_EVENT), 50)),
    ]);
    expect(fifth).toBe(NO_FIFTH_EVENT);

    const [session] = await adapter.listSessions();
    expect(session).toMatchObject({ status: 'dead' });
  });

  test('a requested Stop suppresses both the structured error result and its iterator rethrow (#898)', async () => {
    let releaseResult!: () => void;
    const resultRequested = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    const query = {
      async *[Symbol.asyncIterator]() {
        await resultRequested;
        yield {
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'interrupted',
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
          uuid: 'result-stopped',
          session_id: 'thread-stopped',
        };
        throw new Error('User cancelled');
      },
      interrupt: vi.fn().mockImplementation(async () => releaseResult()),
      close: vi.fn(),
      setModel: vi.fn().mockResolvedValue(undefined),
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
      applyFlagSettings: vi.fn().mockResolvedValue(undefined),
    };
    mockQuery.mockReturnValue(query);
    const adapter = new ClaudeAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-stopped',
    });
    await iterator.next(); // session.started
    await iterator.next(); // session.configured
    const turn = await adapter.sendTurn({
      threadId: 'thread-stopped',
      input: 'long running work',
    });
    await iterator.next(); // turn.started

    await expect(
      adapter.interruptTurn('thread-stopped', turn.turnId),
    ).resolves.toMatchObject({ outcome: 'cancelled', turnId: turn.turnId });

    const terminalEvents = [
      (await iterator.next()).value,
      (await iterator.next()).value,
    ];
    expect(terminalEvents.map((event) => event.method).sort()).toEqual([
      'token-usage.updated',
      'turn.aborted',
    ]);
    const NO_EXTRA_EVENT = Symbol('no-extra-event');
    const extra = await Promise.race([
      iterator.next().then((result) => result.value),
      new Promise((resolve) => setTimeout(() => resolve(NO_EXTRA_EVENT), 50)),
    ]);
    expect(extra).toBe(NO_EXTRA_EVENT);
    expect(terminalEvents).not.toContainEqual(
      expect.objectContaining({ method: 'runtime.error' }),
    );
    await expect(adapter.listSessions()).resolves.toEqual([
      expect.objectContaining({ status: 'ready' }),
    ]);
  });

  test('an interrupt rejection leaves the stopped-result drop armed (#921)', async () => {
    const controlled = createControlledMockQuery();
    controlled.interrupt.mockRejectedValueOnce(
      new Error('interrupt acknowledgement failed'),
    );
    mockQuery.mockReturnValue(controlled);
    const adapter = new ClaudeAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-rejected-interrupt',
    });
    await iterator.next();
    await iterator.next();
    const turn = await adapter.sendTurn({
      threadId: 'thread-rejected-interrupt',
      input: 'work',
    });
    await iterator.next();

    await expect(
      adapter.interruptTurn('thread-rejected-interrupt', turn.turnId),
    ).rejects.toThrow('interrupt acknowledgement failed');
    controlled.push({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'interrupted despite rejected acknowledgement',
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 0 },
      uuid: 'result-rejected-interrupt',
      session_id: 'thread-rejected-interrupt',
    });

    expect((await iterator.next()).value).toMatchObject({
      method: 'token-usage.updated',
    });
    const NO_ERROR = Symbol('no-error');
    expect(
      await Promise.race([
        iterator.next().then((result) => result.value),
        new Promise((resolve) => setTimeout(() => resolve(NO_ERROR), 50)),
      ]),
    ).toBe(NO_ERROR);
  });

  test('a rejected second Stop cannot disarm the first Stop result (#921)', async () => {
    const controlled = createControlledMockQuery();
    controlled.interrupt
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('already interrupted'));
    mockQuery.mockReturnValue(controlled);
    const adapter = new ClaudeAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-double-stop',
    });
    await iterator.next();
    await iterator.next();
    const turn = await adapter.sendTurn({
      threadId: 'thread-double-stop',
      input: 'work',
    });
    await iterator.next();

    await expect(
      adapter.interruptTurn('thread-double-stop', turn.turnId),
    ).resolves.toMatchObject({ outcome: 'cancelled' });
    expect((await iterator.next()).value).toMatchObject({
      method: 'turn.aborted',
      turnId: turn.turnId,
    });
    await expect(
      adapter.interruptTurn('thread-double-stop', turn.turnId),
    ).rejects.toThrow('already interrupted');
    controlled.push({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'interrupted',
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 0 },
      uuid: 'result-double-stop',
      session_id: 'thread-double-stop',
    });

    expect((await iterator.next()).value).toMatchObject({
      method: 'token-usage.updated',
    });
    const NO_ERROR = Symbol('no-error');
    expect(
      await Promise.race([
        iterator.next().then((result) => result.value),
        new Promise((resolve) => setTimeout(() => resolve(NO_ERROR), 50)),
      ]),
    ).toBe(NO_ERROR);
  });

  test('maps a session-level approvalMode to Claude permissionMode at session start (#727)', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-approval',
      modelOptions: { approvalMode: 'auto' },
    });

    expect(mockQuery).toHaveBeenCalledWith({
      prompt: expect.anything(),
      options: expect.objectContaining({ permissionMode: 'acceptEdits' }),
    });
  });

  test('session.configured carries the resolved approvalMode alongside permissionMode (#727 review round 3, item 1)', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-applied-mode',
      modelOptions: { approvalMode: 'auto' },
    });

    await iterator.next(); // session.started
    const configured = await iterator.next();
    expect(configured.value).toMatchObject({
      method: 'session.configured',
      metadata: { approvalMode: 'auto', permissionMode: 'acceptEdits' },
    });
  });

  test('an absent approvalMode keeps the pre-existing default permission mode (#727)', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-approval-default',
    });

    expect(mockQuery).toHaveBeenCalledWith({
      prompt: expect.anything(),
      options: expect.objectContaining({ permissionMode: 'default' }),
    });
  });

  test('a raw permissionMode: "plan" escape hatch still wins over approvalMode (#727)', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-plan',
      modelOptions: { approvalMode: 'never', permissionMode: 'plan' },
    });

    expect(mockQuery).toHaveBeenCalledWith({
      prompt: expect.anything(),
      options: expect.objectContaining({ permissionMode: 'plan' }),
    });
  });

  test('starting a session in never grants allowDangerouslySkipPermissions at spawn (#727 review item 1a)', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-never-start',
      modelOptions: { approvalMode: 'never' },
    });

    expect(mockQuery).toHaveBeenCalledWith({
      prompt: expect.anything(),
      options: expect.objectContaining({
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      }),
    });
  });

  test('a session NOT started in never omits allowDangerouslySkipPermissions (#727 review item 1a)', async () => {
    mockQuery.mockReturnValue(createMockQuery([]));
    const adapter = new ClaudeAdapter();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-never-not-start',
      modelOptions: { approvalMode: 'ask' },
    });

    expect(mockQuery).toHaveBeenCalledWith({
      prompt: expect.anything(),
      options: expect.objectContaining({
        permissionMode: 'default',
        allowDangerouslySkipPermissions: undefined,
      }),
    });
  });

  test('a per-turn approvalMode downgrade (auto -> ask) calls setPermissionMode and reaches Claude from the next turn (#727)', async () => {
    const mockedQuery = createMockQuery([]);
    mockQuery.mockReturnValue(mockedQuery);
    const adapter = new ClaudeAdapter();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-turn-override',
      modelOptions: { approvalMode: 'auto' },
    });
    expect(mockedQuery.setPermissionMode).not.toHaveBeenCalled();

    // Same mode as session start — no redundant SDK call.
    await adapter.sendTurn({
      threadId: 'thread-turn-override',
      input: 'first turn',
      modelOptions: { approvalMode: 'auto' },
    });
    expect(mockedQuery.setPermissionMode).not.toHaveBeenCalled();

    // A changed override calls the live SDK control to apply it starting
    // with this turn, without restarting the session.
    await adapter.sendTurn({
      threadId: 'thread-turn-override',
      input: 'second turn',
      modelOptions: { approvalMode: 'ask' },
    });
    expect(mockedQuery.setPermissionMode).toHaveBeenCalledTimes(1);
    expect(mockedQuery.setPermissionMode).toHaveBeenCalledWith('default');

    // Same mode again — idempotent, no second call.
    await adapter.sendTurn({
      threadId: 'thread-turn-override',
      input: 'third turn',
      modelOptions: { approvalMode: 'ask' },
    });
    expect(mockedQuery.setPermissionMode).toHaveBeenCalledTimes(1);
  });

  test('mid-session escalation to never WITHOUT the spawn-time flag is rejected: no setPermissionMode call, a runtime.warning is published, and the turn still proceeds (#727 review item 1b, CRITICAL)', async () => {
    const mockedQuery = createMockQuery([]);
    mockQuery.mockReturnValue(mockedQuery);
    const adapter = new ClaudeAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-escalate-rejected',
      modelOptions: { approvalMode: 'ask' },
    });
    await iterator.next(); // session.started
    await iterator.next(); // session.configured

    await adapter.sendTurn({
      threadId: 'thread-escalate-rejected',
      input: 'try to go full access mid-session',
      modelOptions: { approvalMode: 'never' },
      recoveryCorrelationId: 'recovery-correlation-claude',
    });

    // The SDK call that would actually switch to bypassPermissions must
    // never happen — the process was not spawned with
    // allowDangerouslySkipPermissions, and the SDK forbids granting that
    // mid-session.
    expect(mockedQuery.setPermissionMode).not.toHaveBeenCalled();

    const warning = await iterator.next();
    expect(warning.value).toMatchObject({
      method: 'runtime.warning',
      severity: 'warning',
      code: 'approval-escalation-requires-restart',
      details: {
        requestedApprovalMode: 'never',
        revertToApprovalMode: 'ask',
      },
    });

    // The turn still proceeds (it is not blocked outright) — but its
    // durable record reflects the mode that ACTUALLY applied, not the
    // rejected request, and flags the rejection explicitly.
    const turnStarted = await iterator.next();
    expect(turnStarted.value).toMatchObject({
      method: 'turn.started',
      metadata: {
        permissionMode: 'default',
        approvalMode: 'ask',
        approvalEscalationRejected: true,
        recoveryCorrelationId: 'recovery-correlation-claude',
      },
    });
  });

  test('an escalation to never WITH the spawn-time flag already granted still applies via setPermissionMode (#727 review item 1b)', async () => {
    const mockedQuery = createMockQuery([]);
    mockQuery.mockReturnValue(mockedQuery);
    const adapter = new ClaudeAdapter();

    // Started in 'never' — allowDangerouslySkipPermissions was granted once
    // at spawn and stays valid for the life of the process even after a
    // mid-session downgrade.
    await adapter.startSession({
      provider: 'claude',
      threadId: 'thread-escalate-allowed',
      modelOptions: { approvalMode: 'never' },
    });

    await adapter.sendTurn({
      threadId: 'thread-escalate-allowed',
      input: 'downgrade',
      modelOptions: { approvalMode: 'ask' },
    });
    expect(mockedQuery.setPermissionMode).toHaveBeenLastCalledWith('default');

    await adapter.sendTurn({
      threadId: 'thread-escalate-allowed',
      input: 'escalate back to full access',
      modelOptions: { approvalMode: 'never' },
    });
    expect(mockedQuery.setPermissionMode).toHaveBeenLastCalledWith(
      'bypassPermissions',
    );
    expect(mockedQuery.setPermissionMode).toHaveBeenCalledTimes(2);
  });

  describe('#895 wave A: skills materialization channel delivery', () => {
    let scratch: string;

    function writeSkillSource(
      id: string,
      files: Record<string, string>,
    ): string {
      const dir = join(scratch, 'source', id);
      mkdirSync(dir, { recursive: true });
      for (const [relativePath, fileContent] of Object.entries(files)) {
        const filePath = join(dir, relativePath);
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, fileContent);
      }
      return dir;
    }

    beforeEach(() => {
      scratch = join(
        tmpdir(),
        `station-claude-adapter-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(scratch, { recursive: true });
    });

    afterEach(() => {
      rmSync(scratch, { recursive: true, force: true });
    });

    test("input.agent.skills materializes exactly the agent's skills and ignores getProvideSkills", async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const writingDir = writeSkillSource('writing', {
        'SKILL.md': '# Writing\n',
      });
      const getProvideSkills = vi.fn();
      const adapter = new ClaudeAdapter({
        getProvideSkills,
        resolveSkillDir: async () => {
          throw new Error('must not be called: agent.skills wins');
        },
      });

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-agent-skills',
        cwd: scratch,
        agent: {
          slug: 'my-agent',
          skills: [{ id: 'writing', dir: writingDir }],
        },
      });

      expect(getProvideSkills).not.toHaveBeenCalled();
      expect(
        existsSync(join(scratch, '.claude', 'skills', 'writing', 'SKILL.md')),
      ).toBe(true);
    });

    test('an authored empty input.agent.skills materializes nothing even when the connection opts skills in', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const resolveSkillDir = vi.fn();
      const adapter = new ClaudeAdapter({
        getProvideSkills: async () => ['writing'],
        resolveSkillDir,
      });

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-agent-empty-skills',
        cwd: scratch,
        agent: { slug: 'my-agent', skills: [] },
      });

      expect(resolveSkillDir).not.toHaveBeenCalled();
      expect(existsSync(join(scratch, '.claude', 'skills'))).toBe(false);
    });

    test("an absent input.agent falls back to the connection's getProvideSkills", async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const writingDir = writeSkillSource('writing', {
        'SKILL.md': '# Writing\n',
      });
      const adapter = new ClaudeAdapter({
        getProvideSkills: async () => ['writing'],
        resolveSkillDir: async (id) => (id === 'writing' ? writingDir : null),
      });

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-connection-default-skills',
        cwd: scratch,
      });

      expect(
        existsSync(join(scratch, '.claude', 'skills', 'writing', 'SKILL.md')),
      ).toBe(true);
    });

    test('session.configured carries a capabilityDelivery receipt with materialized and skipped skills (one unknown id \u2192 not-found)', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const writingDir = writeSkillSource('writing', {
        'SKILL.md': '# Writing\n',
      });
      const adapter = new ClaudeAdapter({
        getProvideSkills: async () => ['writing', 'missing-skill'],
        resolveSkillDir: async (id) => (id === 'writing' ? writingDir : null),
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-connection-default-skills-receipt',
        cwd: scratch,
      });

      await iterator.next(); // session.started
      const configured = await iterator.next();
      expect(configured.value.metadata.capabilityDelivery).toEqual({
        skills: {
          source: 'connection-default',
          requested: ['writing', 'missing-skill'],
          delivered: ['writing'],
          undelivered: [
            {
              capability: 'skills',
              id: 'missing-skill',
              reason: 'not-found',
            },
          ],
        },
      });
    });

    test('#895 review MEDIUM: authored agent.skills with no session cwd receipts every requested id as materialization-skipped/no-session-cwd, and the session still starts', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      const session = await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-agent-skills-no-cwd',
        // No cwd: materialization cannot begin, but the requested ids must
        // still be receipted, not silently dropped.
        agent: {
          slug: 'my-agent',
          skills: [
            { id: 'writing', dir: '/skills/writing' },
            { id: 'reviewing', dir: '/skills/reviewing' },
          ],
        },
      });

      expect(session.status).toBe('connecting');
      await iterator.next(); // session.started
      const configured = await iterator.next();
      expect(configured.value.metadata.capabilityDelivery).toEqual({
        skills: {
          source: 'agent',
          requested: ['writing', 'reviewing'],
          delivered: [],
          undelivered: [
            {
              capability: 'skills',
              id: 'writing',
              reason: 'materialization-skipped',
              detail: 'no-session-cwd',
            },
            {
              capability: 'skills',
              id: 'reviewing',
              reason: 'materialization-skipped',
              detail: 'no-session-cwd',
            },
          ],
        },
      });
    });

    test('receipts a global-config-target skip as global-config-target-refused in session.configured metadata', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      // `scratch` itself stands in for the user's global Claude config home
      // — a dirless/home-defaulted session cwd is the live hazard the guard
      // exists for (agent-engine-unification.md §6.1).
      const adapter = new ClaudeAdapter({
        getProvideSkills: async () => ['writing'],
        resolveSkillDir: async () => {
          throw new Error('must not be called: refused before resolution');
        },
      });
      // Point CLAUDE_CONFIG_DIR at `scratch` itself so the adapter's own
      // `defaultClaudeGlobalConfigDirs()` call site resolves the global
      // config dir to exactly the session cwd.
      const previous = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = scratch;
      try {
        const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

        await adapter.startSession({
          provider: 'claude',
          threadId: 'thread-global-config-refused',
          cwd: scratch,
        });

        await iterator.next(); // session.started
        const configured = await iterator.next();
        expect(configured.value.metadata.capabilityDelivery).toEqual({
          skills: {
            source: 'connection-default',
            requested: ['writing'],
            delivered: [],
            undelivered: [
              {
                capability: 'skills',
                id: 'writing',
                reason: 'global-config-target-refused',
              },
            ],
          },
        });
        expect(existsSync(join(scratch, '.claude', 'skills'))).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
    });

    test('counts global-config-target-refused on the undelivered counter', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter({
        getProvideSkills: async () => ['writing'],
        resolveSkillDir: async () => {
          throw new Error('must not be called: refused before resolution');
        },
      });
      const previous = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = scratch;
      try {
        const addSpy = vi.spyOn(agentCapabilityUndelivered, 'add');
        await adapter.startSession({
          provider: 'claude',
          threadId: 'thread-global-config-refused-counter',
          cwd: scratch,
        });
        expect(addSpy).toHaveBeenCalledWith(1, {
          provider: 'claude',
          capability: 'skills',
          reason: 'global-config-target-refused',
        });
        addSpy.mockRestore();
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
    });
  });

  describe('station#1174: cwd-less skills overlay', () => {
    let stationHome: string;
    let previousStationHome: string | undefined;

    function writeOverlaySkillSource(
      id: string,
      files: Record<string, string>,
    ): string {
      const dir = join(stationHome, 'source', id);
      mkdirSync(dir, { recursive: true });
      for (const [relativePath, fileContent] of Object.entries(files)) {
        const filePath = join(dir, relativePath);
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, fileContent);
      }
      return dir;
    }

    beforeEach(() => {
      stationHome = join(
        tmpdir(),
        `station-claude-adapter-overlay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(stationHome, { recursive: true });
      previousStationHome = process.env.STATION_HOME;
      process.env.STATION_HOME = stationHome;
    });

    afterEach(() => {
      if (previousStationHome === undefined) delete process.env.STATION_HOME;
      else process.env.STATION_HOME = previousStationHome;
      rmSync(stationHome, { recursive: true, force: true });
    });

    test('a cwd-less session (cwdDefaulted) materializes an authored skill into the Station-owned overlay -- delivered, not refused', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const writingDir = writeOverlaySkillSource('writing', {
        'SKILL.md': '# Writing\n',
      });
      const adapter = new ClaudeAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
      const homeDefaultedCwd = join(stationHome, 'fake-home-cwd');

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-cwdless-overlay',
        cwd: homeDefaultedCwd,
        cwdDefaulted: true,
        agent: {
          slug: 'my-agent',
          skills: [{ id: 'writing', dir: writingDir }],
        },
      });

      const overlayDir = join(
        stationHome,
        'claude-skill-overlays',
        'thread-cwdless-overlay',
      );
      expect(
        existsSync(
          join(overlayDir, '.claude', 'skills', 'writing', 'SKILL.md'),
        ),
      ).toBe(true);
      // Never materialized into the real (home-defaulted) cwd -- the
      // section 6.1 workspace-overlay channel would have refused that.
      expect(
        existsSync(join(homeDefaultedCwd, '.claude', 'skills', 'writing')),
      ).toBe(false);

      const lastCall = mockQuery.mock.calls.at(-1)?.[0];
      expect(lastCall.options.cwd).toBe(homeDefaultedCwd);
      expect(lastCall.options.additionalDirectories).toEqual([overlayDir]);

      await iterator.next(); // session.started
      const configured = await iterator.next();
      expect(configured.value.metadata.capabilityDelivery).toEqual({
        skills: {
          source: 'agent',
          requested: ['writing'],
          delivered: ['writing'],
          undelivered: [],
        },
      });
    });

    test('a session WITH a real cwd (cwdDefaulted absent) is unaffected -- no additionalDirectories, skills still land under <cwd>/.claude/skills', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const projectCwd = join(stationHome, 'project');
      mkdirSync(projectCwd, { recursive: true });
      const writingDir = writeOverlaySkillSource('writing', {
        'SKILL.md': '# Writing\n',
      });
      const adapter = new ClaudeAdapter();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-real-cwd-unaffected',
        cwd: projectCwd,
        agent: {
          slug: 'my-agent',
          skills: [{ id: 'writing', dir: writingDir }],
        },
      });

      expect(
        existsSync(
          join(projectCwd, '.claude', 'skills', 'writing', 'SKILL.md'),
        ),
      ).toBe(true);
      expect(existsSync(join(stationHome, 'claude-skill-overlays'))).toBe(
        false,
      );
      const lastCall = mockQuery.mock.calls.at(-1)?.[0];
      expect(lastCall.options.additionalDirectories).toBeUndefined();
    });

    test('stopSession cleans up and fully removes the Station-owned overlay directory', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const writingDir = writeOverlaySkillSource('writing', {
        'SKILL.md': '# Writing\n',
      });
      const adapter = new ClaudeAdapter();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-overlay-stop',
        cwd: join(stationHome, 'fake-home-cwd-stop'),
        cwdDefaulted: true,
        agent: {
          slug: 'my-agent',
          skills: [{ id: 'writing', dir: writingDir }],
        },
      });
      const overlayDir = join(
        stationHome,
        'claude-skill-overlays',
        'thread-overlay-stop',
      );
      expect(existsSync(overlayDir)).toBe(true);

      await adapter.stopSession('thread-overlay-stop');

      expect(existsSync(overlayDir)).toBe(false);
    });

    test('isGlobalConfigTarget guard is untouched: a non-overlay session with cwd pointed at the global config dir is still refused', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter({
        getProvideSkills: async () => ['writing'],
        resolveSkillDir: async () => {
          throw new Error('must not be called: refused before resolution');
        },
      });
      const previous = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = stationHome;
      try {
        const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
        await adapter.startSession({
          provider: 'claude',
          threadId: 'thread-guard-unchanged',
          cwd: stationHome,
        });
        await iterator.next(); // session.started
        const configured = await iterator.next();
        expect(
          configured.value.metadata.capabilityDelivery.skills.undelivered,
        ).toEqual([
          {
            capability: 'skills',
            id: 'writing',
            reason: 'global-config-target-refused',
          },
        ]);
        expect(existsSync(join(stationHome, '.claude', 'skills'))).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
    });
  });

  describe('#895 wave B: agent-authored system prompt', () => {
    test("startSession passes systemPrompt { type: 'preset', preset: 'claude_code', append } to query() when input.agent.systemPrompt is set, and merges a systemPrompt delivery report into session.configured", async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-system-prompt',
        agent: {
          slug: 'my-agent',
          systemPrompt: 'You are a specialized writing assistant.',
        },
      });

      expect(mockQuery).toHaveBeenCalledWith({
        prompt: expect.anything(),
        options: expect.objectContaining({
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: 'You are a specialized writing assistant.',
          },
        }),
      });

      await iterator.next(); // session.started
      const configured = await iterator.next();
      expect(configured.value.metadata.capabilityDelivery.systemPrompt).toEqual(
        {
          source: 'agent',
          requested: ['agent-prompt'],
          delivered: ['agent-prompt'],
          undelivered: [],
        },
      );
    });

    test('startSession leaves options.systemPrompt entirely unset when no agent prompt is resolved (byte-identical SDK options)', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-no-system-prompt',
      });

      const queryArgs = mockQuery.mock.calls[0][0] as { options: unknown };
      expect(
        'systemPrompt' in (queryArgs.options as Record<string, unknown>),
      ).toBe(false);
    });

    test('startSession keeps the promptless SDK options shape apart from the required engine-spawn TMPDIR', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-no-system-prompt-baseline',
      });

      const queryArgs = mockQuery.mock.calls[0][0] as {
        options: Record<string, unknown>;
      };
      expect(queryArgs.options).toEqual({
        cwd: undefined,
        model: undefined,
        resume: undefined,
        includePartialMessages: true,
        persistSession: false,
        env: scrubBootInternalSecrets({
          ...process.env,
          TMPDIR: engineSpawnTmpDirPath(),
        }),
        canUseTool: expect.any(Function),
        permissionMode: 'default',
        allowDangerouslySkipPermissions: undefined,
        thinking: undefined,
        effort: undefined,
        settings: undefined,
      });
    });
  });

  describe('#1157: agent-authored MCP tool servers (Claude Agent SDK mcpServers channel)', () => {
    test('startSession maps input.agent.toolServers into Options.mcpServers/strictMcpConfig, with a matching capabilityDelivery.toolServers receipt', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-tool-servers',
        agent: {
          slug: 'my-agent',
          toolServers: [
            {
              id: 'weather',
              transport: 'stdio',
              command: process.execPath,
              args: ['--version'],
            },
          ],
        },
      });

      expect(mockQuery).toHaveBeenCalledWith({
        prompt: expect.anything(),
        options: expect.objectContaining({
          mcpServers: {
            weather: {
              type: 'stdio',
              command: process.execPath,
              args: ['--version'],
            },
          },
          strictMcpConfig: true,
        }),
      });

      await iterator.next(); // session.started
      const configured = await iterator.next();
      expect(configured.value.metadata.capabilityDelivery.toolServers).toEqual({
        source: 'agent',
        requested: ['weather'],
        delivered: ['weather'],
        undelivered: [],
      });
    });

    test('leaves Options.mcpServers/strictMcpConfig entirely unset when the agent has no authored toolServers (byte-identical to before #1157)', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-no-tool-servers',
      });

      const queryArgs = mockQuery.mock.calls[0][0] as {
        options: Record<string, unknown>;
      };
      expect('mcpServers' in queryArgs.options).toBe(false);
      expect('strictMcpConfig' in queryArgs.options).toBe(false);
    });

    test('an authored empty input.agent.toolServers disables every tool server (mcpServers: {}, strictMcpConfig: true — an authored empty array is the agent explicitly opting out)', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-empty-tool-servers',
        agent: { slug: 'my-agent', toolServers: [] },
      });

      expect(mockQuery).toHaveBeenCalledWith({
        prompt: expect.anything(),
        options: expect.objectContaining({
          mcpServers: {},
          strictMcpConfig: true,
        }),
      });
    });

    test('injects the Station internal API token into the built-in station-control server only, never a third-party env-less server', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-station-control-token',
        agent: {
          slug: 'my-agent',
          toolServers: [
            {
              id: 'station-control',
              transport: 'stdio',
              command: 'node',
              args: [builtinStationControlServerPath()],
            },
            {
              id: 'third-party',
              transport: 'stdio',
              command: process.execPath,
              args: ['--version'],
            },
          ],
        },
      });

      const queryArgs = mockQuery.mock.calls[0][0] as {
        options: { mcpServers: Record<string, Record<string, unknown>> };
      };
      expect(queryArgs.options.mcpServers['station-control']).toEqual({
        type: 'stdio',
        command: 'node',
        args: [builtinStationControlServerPath()],
        env: { [INTERNAL_API_TOKEN_ENV]: expect.any(String) },
      });
      expect(queryArgs.options.mcpServers['third-party']).toEqual({
        type: 'stdio',
        command: process.execPath,
        args: ['--version'],
      });
      expect('env' in queryArgs.options.mcpServers['third-party']).toBe(false);

      await iterator.next(); // session.started
      const configured = await iterator.next();
      expect(
        configured.value.metadata.capabilityDelivery.toolServers.delivered,
      ).toEqual(['station-control', 'third-party']);
    });

    test('reports an invalid HTTP tool server and still starts the session', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      const session = await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-unsupported-transport',
        agent: {
          slug: 'my-agent',
          toolServers: [
            {
              id: 'remote-http',
              transport: 'streamable-http',
            },
          ],
        },
      });

      expect(session.status).toBe('connecting');
      await iterator.next(); // session.started
      const configured = await iterator.next();
      expect(configured.value.metadata.capabilityDelivery.toolServers).toEqual({
        source: 'agent',
        requested: ['remote-http'],
        delivered: [],
        undelivered: [
          {
            capability: 'toolServers',
            id: 'remote-http',
            reason: 'delivery-failed',
            detail: 'no endpoint configured',
          },
        ],
      });
    });

    test('counts an undelivered tool server on the shared agentCapabilityUndelivered metric', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();
      const addSpy = vi.spyOn(agentCapabilityUndelivered, 'add');

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-tool-servers-undelivered-counter',
        agent: {
          slug: 'my-agent',
          toolServers: [{ id: 'no-command', transport: 'stdio' }],
        },
      });

      expect(addSpy).toHaveBeenCalledWith(1, {
        provider: 'claude',
        capability: 'toolServers',
        reason: 'binary-not-found',
      });
      addSpy.mockRestore();
    });
  });

  describe('#896: app-home profile env layering', () => {
    test('startSession passes the app-home env to the SDK query and preserves the process env', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter({
        getAppHomeEnv: async () => ({
          CLAUDE_CONFIG_DIR: '/station/app-homes/claude',
        }),
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-app-home',
        cwd: '/workspace/project',
      });

      expect(mockQuery).toHaveBeenCalledWith({
        prompt: expect.anything(),
        options: expect.objectContaining({
          env: expect.objectContaining({
            CLAUDE_CONFIG_DIR: '/station/app-homes/claude',
            PATH: process.env.PATH,
          }),
        }),
      });
      await iterator.next(); // session.started
      const configured = await iterator.next();
      expect(configured.value.metadata.appHome).toBe('profile');
    });

    test('startSession still forces the Station-owned SDK TMPDIR when the connection has not opted in to an app home', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter({
        getAppHomeEnv: async () => undefined,
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-no-app-home',
        cwd: '/workspace/project',
      });

      const call = mockQuery.mock.calls.at(-1)?.[0];
      expect(call.options.env.TMPDIR).toBe(engineSpawnTmpDirPath());
      await iterator.next(); // session.started
      const configured = await iterator.next();
      expect(configured.value.metadata.appHome).toBe('global');
    });

    test('uses a server-only profile ref for one spawn without publishing the ref', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const getAppHomeEnv = vi.fn().mockResolvedValue({
        CLAUDE_CONFIG_DIR: '/station/app-homes/opaque',
      });
      const adapter = new ClaudeAdapter({ getAppHomeEnv });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-profile-canary',
        credentialProfileRef: 'canary-profile-ref',
      });

      expect(getAppHomeEnv).toHaveBeenCalledWith('canary-profile-ref');
      const started = await iterator.next();
      const configured = await iterator.next();
      expect(JSON.stringify([started.value, configured.value])).not.toContain(
        'canary-profile-ref',
      );
    });

    test('fails closed without logging a profile resolver error', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const warn = vi.fn();
      const adapter = new ClaudeAdapter({
        getAppHomeEnv: async () => {
          throw new Error('canary-profile-ref /private/path');
        },
        logger: { warn },
      });

      await expect(
        adapter.startSession({
          provider: 'claude',
          threadId: 'thread-profile-failure',
          credentialProfileRef: 'canary-profile-ref',
        }),
      ).rejects.toThrow(
        'Credential profile environment could not be prepared.',
      );
      expect(warn).not.toHaveBeenCalled();
    });

    test('startSession forces the Station-owned SDK TMPDIR when getAppHomeEnv is absent entirely', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-no-app-home-option',
        cwd: '/workspace/project',
      });

      const call = mockQuery.mock.calls.at(-1)?.[0];
      expect(call.options.env.TMPDIR).toBe(engineSpawnTmpDirPath());
    });

    test('adoptSession never applies the app-home env but keeps the Station-owned TMPDIR', async () => {
      mockForkSession.mockResolvedValue({ sessionId: 'vendor-child' });
      mockQuery.mockReturnValue(createMockQuery([]));
      const getAppHomeEnv = vi.fn().mockResolvedValue({
        CLAUDE_CONFIG_DIR: '/station/app-homes/claude',
      });
      const adapter = new ClaudeAdapter({ getAppHomeEnv });

      await adapter.adoptSession?.({
        provider: 'claude',
        threadId: 'station-child-app-home',
        sourceSessionId: 'vendor-source',
        sourceKind: 'claude-transcript',
        cwd: '/workspace/project',
      });

      expect(getAppHomeEnv).not.toHaveBeenCalled();
      const call = mockQuery.mock.calls.at(-1)?.[0];
      expect(call.options.env.TMPDIR).toBe(engineSpawnTmpDirPath());
    });

    test('an app-home lookup failure degrades to global with appHome: global receipted', async () => {
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter({
        getAppHomeEnv: async () => {
          throw new Error('lookup exploded');
        },
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-app-home-failure',
        cwd: '/workspace/project',
      });

      const call = mockQuery.mock.calls.at(-1)?.[0];
      expect(call.options.env.TMPDIR).toBe(engineSpawnTmpDirPath());
      await iterator.next(); // session.started
      const configured = await iterator.next();
      expect(configured.value.metadata.appHome).toBe('global');
    });
  });

  describe('#1156: Claude Agent SDK subprocess PATH augmentation', () => {
    test("startSession layers the augmented PATH into Options.env even when no app-home profile is active (station#1150 fixed Station's own CLI resolution; this closes the MCP-subprocess gap one layer down)", async () => {
      const augmentedEnv = {
        ...process.env,
        PATH: `${process.env.PATH ?? ''}:/opt/nix/bin`,
      };
      mockAugmentedSpawnEnv.mockResolvedValue(augmentedEnv);
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-path-augmented',
      });

      expect(mockAugmentedSpawnEnv).toHaveBeenCalledTimes(1);
      const call = mockQuery.mock.calls.at(-1)?.[0];
      expect(call.options.env).toEqual(
        scrubBootInternalSecrets({
          ...augmentedEnv,
          TMPDIR: engineSpawnTmpDirPath(),
        }),
      );
      expect(call.options.env.PATH).toBe(augmentedEnv.PATH);
    });

    test('content-identical to today when login-PATH resolution is disabled (augmentedSpawnEnv degrades to {...process.env} with PATH unchanged — see cli-auth-login-path.test.ts "the opt-out flag disables the login-PATH search entirely")', async () => {
      const unaugmentedEnv = { ...process.env };
      mockAugmentedSpawnEnv.mockResolvedValue(unaugmentedEnv);
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-path-disabled',
      });

      const call = mockQuery.mock.calls.at(-1)?.[0];
      expect(call.options.env).toEqual(
        scrubBootInternalSecrets({
          ...process.env,
          TMPDIR: engineSpawnTmpDirPath(),
        }),
      );
      expect(call.options.env.PATH).toBe(process.env.PATH);
    });

    test('an app-home profile env still wins on conflicting keys, layered on top of the augmented PATH env (not the other way around)', async () => {
      const augmentedEnv = {
        ...process.env,
        PATH: `${process.env.PATH ?? ''}:/opt/nix/bin`,
      };
      mockAugmentedSpawnEnv.mockResolvedValue(augmentedEnv);
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter({
        getAppHomeEnv: async () => ({
          CLAUDE_CONFIG_DIR: '/station/app-homes/claude',
        }),
      });

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-path-augmented-app-home',
        cwd: '/workspace/project',
      });

      const call = mockQuery.mock.calls.at(-1)?.[0];
      expect(call.options.env).toEqual(
        scrubBootInternalSecrets({
          ...augmentedEnv,
          CLAUDE_CONFIG_DIR: '/station/app-homes/claude',
          TMPDIR: engineSpawnTmpDirPath(),
        }),
      );
      expect(call.options.env.PATH).toBe(augmentedEnv.PATH);
    });

    test('adoptSession also layers the augmented PATH into Options.env (an adopted session spawns MCP servers exactly like a fresh one, unlike the app-home env which adoption deliberately skips)', async () => {
      const augmentedEnv = {
        ...process.env,
        PATH: `${process.env.PATH ?? ''}:/opt/nix/bin`,
      };
      mockAugmentedSpawnEnv.mockResolvedValue(augmentedEnv);
      mockForkSession.mockResolvedValue({ sessionId: 'vendor-child' });
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();

      await adapter.adoptSession?.({
        provider: 'claude',
        threadId: 'thread-path-augmented-adopt',
        sourceSessionId: 'vendor-source',
        sourceKind: 'claude-transcript',
        cwd: '/workspace/project',
      });

      const call = mockQuery.mock.calls.at(-1)?.[0];
      expect(call.options.env).toEqual(
        scrubBootInternalSecrets({
          ...augmentedEnv,
          TMPDIR: engineSpawnTmpDirPath(),
        }),
      );
    });

    test('fault injection: a rejecting augmentedSpawnEnv falls back to process env with the Station-owned TMPDIR, never blocking session start', async () => {
      mockAugmentedSpawnEnv.mockRejectedValueOnce(
        new Error('mock: augmented PATH resolution exploded'),
      );
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();

      const session = await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-path-augmentation-failure',
      });

      expect(session.status).toBe('connecting');
      const call = mockQuery.mock.calls.at(-1)?.[0];
      expect(call.options.env.TMPDIR).toBe(engineSpawnTmpDirPath());
    });
  });

  describe('station#1908: Claude SDK spawn TMPDIR', () => {
    test('forces the Station-owned TMPDIR for both session and catalog spawns across every session env branch', async () => {
      const stationHome = join(
        tmpdir(),
        `station-claude-spawn-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const previousStationHome = process.env.STATION_HOME;
      process.env.STATION_HOME = stationHome;

      try {
        const expectedTmpDir = engineSpawnTmpDirPath(stationHome);
        const cases = [
          {
            name: 'augmented env',
            augmentedEnv: {
              ...process.env,
              PATH: '/augmented/bin',
              TMPDIR: '/ambient/augmented-tmp',
            },
          },
          {
            name: 'app-home env only',
            appHomeEnv: {
              CLAUDE_CONFIG_DIR: '/station/app-homes/claude',
              TMPDIR: '/ambient/app-home-tmp',
            },
          },
          { name: 'bare env' },
        ];

        for (const scenario of cases) {
          mockQuery.mockClear();
          mockAugmentedSpawnEnv.mockReset();
          if (scenario.augmentedEnv) {
            mockAugmentedSpawnEnv.mockResolvedValue(scenario.augmentedEnv);
          }
          mockQuery.mockReturnValue(createMockQuery([]));
          const adapter = new ClaudeAdapter({
            getAppHomeEnv: scenario.appHomeEnv
              ? async () => scenario.appHomeEnv!
              : undefined,
          });

          await adapter.startSession({
            provider: 'claude',
            threadId: `thread-spawn-tmp-${scenario.name}`,
          });
          await adapter.listModelCatalog?.();

          const [sessionCall, catalogCall] = mockQuery.mock.calls.map(
            ([call]) => call,
          );
          expect(sessionCall.options.env.TMPDIR, scenario.name).toBe(
            expectedTmpDir,
          );
          expect(catalogCall.options.env.TMPDIR, scenario.name).toBe(
            expectedTmpDir,
          );
        }
      } finally {
        if (previousStationHome === undefined) delete process.env.STATION_HOME;
        else process.env.STATION_HOME = previousStationHome;
        rmSync(stationHome, { recursive: true, force: true });
      }
    });
  });

  describe('station#1182: runtime-reported model, end to end', () => {
    test("a second turn that reports nothing does not inherit the first turn's reportedModel", async () => {
      const controlled = createControlledMockQuery();
      mockQuery.mockReturnValue(controlled);
      const adapter = new ClaudeAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-reset',
        modelId: 'claude-fable-5',
      });
      await iterator.next(); // session.started
      const configured = await iterator.next(); // session.configured
      expect((configured.value as any).model).toBe('claude-fable-5');

      await adapter.sendTurn({ threadId: 'thread-reset', input: 'first' });
      await iterator.next(); // turn.started

      controlled.push({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          model: 'claude-opus-4-5-20260101',
          content: [{ type: 'text', text: "I'm Claude Opus 4.5" }],
        },
        uuid: 'first-assistant',
        session_id: 'thread-reset',
      });
      controlled.push({
        type: 'result',
        result: 'hi',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        uuid: 'first-result',
        session_id: 'thread-reset',
      });
      await iterator.next(); // token-usage.updated
      const firstCompleted = await iterator.next(); // turn.completed
      expect((firstCompleted.value as any).metadata).toEqual({
        reportedModel: 'claude-opus-4-5-20260101',
      });

      // Second turn reports nothing (e.g. no assistant message before an
      // early result) — must not surface the first turn's stale value.
      await adapter.sendTurn({ threadId: 'thread-reset', input: 'second' });
      await iterator.next(); // turn.started

      controlled.push({
        type: 'result',
        result: 'bye',
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        uuid: 'second-result',
        session_id: 'thread-reset',
      });
      await iterator.next(); // token-usage.updated
      const secondCompleted = await iterator.next(); // turn.completed
      expect((secondCompleted.value as any).metadata).toBeUndefined();
    });
  });
  // #1551: Station detected the user's installed Claude Code, reported it
  // ready, and then spawned the older CLI bundled inside the Agent SDK,
  // because `pathToClaudeCodeExecutable` was never passed. Every test here
  // stubs the resolver in BOTH directions, so none of them can pass merely
  // because the host running them has `claude` installed.
  describe('#1551 installed Claude Code executable', () => {
    const INSTALLED = '/Users/example/.local/bin/claude';

    /** A `claude --version` result, exactly as the CLI prints it. */
    function versionResult(version: string) {
      return { stdout: `${version} (Claude Code)\n`, stderr: '', code: 0 };
    }

    beforeEach(() => {
      // Most cases here are about the executable REACHING `query()`, not about
      // the version rule (which has its own block below and injects both
      // versions). Give them an installed CLI that reports cleanly and that no
      // bundle will outrank, so an SDK bump in node_modules cannot silently
      // flip them -- and so none of them depends on this machine's `claude`.
      mockRunCliCommand.mockResolvedValue(versionResult('9999.0.0'));
    });

    test('passes the resolved executable to the session spawn', async () => {
      mockFindCliBinaryAsync.mockResolvedValue(INSTALLED);
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-1551',
        cwd: '/workspace/project',
        modelId: 'claude-sonnet-4-6',
      });

      expect(mockFindCliBinaryAsync).toHaveBeenCalledWith('claude');
      expect(mockQuery.mock.calls[0][0].options).toMatchObject({
        pathToClaudeCodeExecutable: INSTALLED,
      });
    });

    test('passes the resolved executable to the adopted-session spawn', async () => {
      mockFindCliBinaryAsync.mockResolvedValue(INSTALLED);
      mockForkSession.mockResolvedValue({ sessionId: 'vendor-child' });
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();

      await adapter.adoptSession?.({
        provider: 'claude',
        threadId: 'station-child',
        sourceSessionId: 'vendor-source',
        sourceKind: 'claude-transcript',
        cwd: '/workspace/project',
        modelId: 'claude-sonnet-4-6',
      });

      expect(mockQuery.mock.calls[0][0].options).toMatchObject({
        pathToClaudeCodeExecutable: INSTALLED,
      });
    });

    test('passes the resolved executable to the model-discovery spawn', async () => {
      mockFindCliBinaryAsync.mockResolvedValue(INSTALLED);
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();

      await adapter.listModelCatalog();

      expect(mockQuery.mock.calls[0][0].options).toMatchObject({
        pathToClaudeCodeExecutable: INSTALLED,
      });
    });

    test('omits the option at both spawn sites when no claude is installed', async () => {
      mockFindCliBinaryAsync.mockResolvedValue(null);
      mockQuery.mockReturnValue(createMockQuery([]));
      const adapter = new ClaudeAdapter();

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-1551-absent',
        cwd: '/workspace/project',
        modelId: 'claude-sonnet-4-6',
      });
      await adapter.listModelCatalog();

      expect(mockQuery.mock.calls[0][0].options).not.toHaveProperty(
        'pathToClaudeCodeExecutable',
      );
      expect(mockQuery.mock.calls[1][0].options).not.toHaveProperty(
        'pathToClaudeCodeExecutable',
      );
    });

    test('prefers the injected resolver over the module default', async () => {
      mockFindCliBinaryAsync.mockResolvedValue(null);
      mockQuery.mockReturnValue(createMockQuery([]));
      const findBinary = vi.fn().mockResolvedValue('/opt/claude/bin/claude');
      const adapter = new ClaudeAdapter({ findBinary });

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-1551-injected',
        cwd: '/workspace/project',
        modelId: 'claude-sonnet-4-6',
      });

      expect(findBinary).toHaveBeenCalledWith('claude');
      expect(mockFindCliBinaryAsync).not.toHaveBeenCalled();
      expect(mockQuery.mock.calls[0][0].options).toMatchObject({
        pathToClaudeCodeExecutable: '/opt/claude/bin/claude',
      });
    });

    test('falls back to the bundled CLI when the resolver throws', async () => {
      mockFindCliBinaryAsync.mockRejectedValue(new Error('resolver exploded'));
      mockQuery.mockReturnValue(createMockQuery([]));
      const warn = vi.fn();
      const adapter = new ClaudeAdapter({ logger: { warn } });

      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-1551-throws',
        cwd: '/workspace/project',
        modelId: 'claude-sonnet-4-6',
      });

      expect(mockQuery.mock.calls[0][0].options).not.toHaveProperty(
        'pathToClaudeCodeExecutable',
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('bundled with the Agent SDK'),
      );

      // And readiness must say the lookup FAILED, not that nothing is
      // installed — the derivation never observed that.
      mockBuildCliRuntimePrerequisites.mockResolvedValue([
        {
          id: 'claude-cli',
          name: 'Claude CLI',
          description: 'Required to launch the Claude runtime.',
          status: 'missing',
          category: 'required',
        },
      ]);
      const readiness = await new ClaudeAdapter({
        logger: { warn },
        readBundledVersion: () => '2.1.224',
      }).getPrerequisites?.();
      expect(readiness?.[0]?.description).toBe(
        'Required to launch the Claude runtime. Station launches the Claude Code 2.1.224 bundled with the Agent SDK; resolving the installed `claude` failed.',
      );
    });

    test('readiness names the installed executable it will launch', async () => {
      mockFindCliBinaryAsync.mockResolvedValue(INSTALLED);
      mockRunCliCommand.mockResolvedValue(versionResult('2.1.261'));
      mockBuildCliRuntimePrerequisites.mockResolvedValue([
        {
          id: 'claude-cli',
          name: 'Claude CLI',
          description: 'Required to launch the Claude runtime.',
          status: 'installed',
          category: 'required',
        },
        {
          id: 'claude-auth',
          name: 'Claude login',
          description:
            'Claude CLI authentication is managed by the local CLI session.',
          status: 'installed',
          category: 'required',
        },
      ]);
      const adapter = new ClaudeAdapter({
        readBundledVersion: () => '2.1.224',
      });

      const prerequisites = await adapter.getPrerequisites?.();

      const cli = prerequisites?.find(
        (prerequisite) => prerequisite.id === 'claude-cli',
      );
      expect(cli?.description).toBe(
        `Required to launch the Claude runtime. Station launches the installed Claude Code 2.1.261 at ${INSTALLED} (the Agent SDK bundles 2.1.224).`,
      );
      // The install status and the sentence come from ONE resolution: the
      // findBinary handed to the shared builder must answer with the same
      // path the sentence names.
      expect(
        mockBuildCliRuntimePrerequisites.mock.calls[0][0].findBinary('claude'),
      ).toBe(INSTALLED);
      // Only the CLI prerequisite carries it — the auth line is untouched.
      expect(
        prerequisites?.find((prerequisite) => prerequisite.id === 'claude-auth')
          ?.description,
      ).toBe('Claude CLI authentication is managed by the local CLI session.');
    });

    test('readiness names the bundled CLI when nothing is installed', async () => {
      mockFindCliBinaryAsync.mockResolvedValue(null);
      mockBuildCliRuntimePrerequisites.mockResolvedValue([
        {
          id: 'claude-cli',
          name: 'Claude CLI',
          description: 'Required to launch the Claude runtime.',
          status: 'missing',
          category: 'required',
        },
      ]);
      const adapter = new ClaudeAdapter({
        readBundledVersion: () => '2.1.224',
      });

      const prerequisites = await adapter.getPrerequisites?.();

      expect(prerequisites?.[0]?.description).toBe(
        'Required to launch the Claude runtime. Station launches the Claude Code 2.1.224 bundled with the Agent SDK; no installed `claude` was found.',
      );
      expect(
        mockBuildCliRuntimePrerequisites.mock.calls[0][0].findBinary('claude'),
      ).toBeNull();
    });

    // #1551 risk 1: adopting the installed CLI is only safe when it is not
    // OLDER than the Claude Code bundled with the Agent SDK -- the SDK's
    // control protocol is versioned with the CLI, so a stale installed CLI
    // would be a regression introduced by the very fix that reaches for it.
    // Both versions are injected in every test here: nothing depends on what
    // this machine has installed or on which SDK is in node_modules.
    describe('version comparison against the bundled Claude Code', () => {
      function adapterWith(options: {
        installedVersionOutput?: string | null;
        bundled: string | null;
      }) {
        const runCommand = vi.fn().mockResolvedValue(
          options.installedVersionOutput === null
            ? null
            : {
                stdout: options.installedVersionOutput,
                stderr: '',
                code: 0,
              },
        );
        const adapter = new ClaudeAdapter({
          findBinary: async () => INSTALLED,
          runCommand,
          readBundledVersion: () => options.bundled,
        });
        return { adapter, runCommand };
      }

      async function startAndReadOptions(adapter: ClaudeAdapter) {
        mockQuery.mockReturnValue(createMockQuery([]));
        await adapter.startSession({
          provider: 'claude',
          threadId: `thread-${crypto.randomUUID()}`,
          cwd: '/workspace/project',
          modelId: 'claude-sonnet-4-6',
        });
        return mockQuery.mock.calls[0][0].options;
      }

      async function readCliDescription(adapter: ClaudeAdapter) {
        mockBuildCliRuntimePrerequisites.mockResolvedValue([
          {
            id: 'claude-cli',
            name: 'Claude CLI',
            description: 'Required to launch the Claude runtime.',
            status: 'installed',
            category: 'required',
          },
        ]);
        const prerequisites = await adapter.getPrerequisites?.();
        return prerequisites?.[0]?.description;
      }

      test('launches the installed CLI when it is newer than the bundle', async () => {
        const { adapter } = adapterWith({
          installedVersionOutput: '2.1.261 (Claude Code)\n',
          bundled: '2.1.224',
        });

        expect(await startAndReadOptions(adapter)).toMatchObject({
          pathToClaudeCodeExecutable: INSTALLED,
        });
        expect(await readCliDescription(adapter)).toBe(
          `Required to launch the Claude runtime. Station launches the installed Claude Code 2.1.261 at ${INSTALLED} (the Agent SDK bundles 2.1.224).`,
        );
      });

      test('launches the installed CLI when the versions are equal', async () => {
        const { adapter } = adapterWith({
          installedVersionOutput: '2.1.224 (Claude Code)\n',
          bundled: '2.1.224',
        });

        expect(await startAndReadOptions(adapter)).toMatchObject({
          pathToClaudeCodeExecutable: INSTALLED,
        });
        expect(await readCliDescription(adapter)).toBe(
          `Required to launch the Claude runtime. Station launches the installed Claude Code 2.1.224 at ${INSTALLED} (the Agent SDK bundles 2.1.224).`,
        );
      });

      test('falls back to the bundled CLI when the installed one is older', async () => {
        const { adapter } = adapterWith({
          installedVersionOutput: '2.1.200 (Claude Code)\n',
          bundled: '2.1.224',
        });

        expect(await startAndReadOptions(adapter)).not.toHaveProperty(
          'pathToClaudeCodeExecutable',
        );
        expect(await readCliDescription(adapter)).toBe(
          `Required to launch the Claude runtime. Station launches the Claude Code 2.1.224 bundled with the Agent SDK; the installed \`claude\` at ${INSTALLED} is 2.1.200, older than the bundle.`,
        );
      });

      test.each([
        ['a lower major', '1.9.999', '2.1.224'],
        ['a lower minor', '2.0.999', '2.1.224'],
      ])(
        'falls back to the bundled CLI for %s',
        async (_label, installed, bundled) => {
          const { adapter } = adapterWith({
            installedVersionOutput: `${installed} (Claude Code)\n`,
            bundled,
          });

          expect(await startAndReadOptions(adapter)).not.toHaveProperty(
            'pathToClaudeCodeExecutable',
          );
        },
      );

      test.each([
        ['a higher major', '3.0.0', '2.1.224'],
        ['a higher minor', '2.2.0', '2.1.224'],
      ])(
        'launches the installed CLI for %s',
        async (_label, installed, bundled) => {
          const { adapter } = adapterWith({
            installedVersionOutput: `${installed} (Claude Code)\n`,
            bundled,
          });

          expect(await startAndReadOptions(adapter)).toMatchObject({
            pathToClaudeCodeExecutable: INSTALLED,
          });
        },
      );

      test('keeps the installed CLI when the bundled version cannot be read', async () => {
        const { adapter } = adapterWith({
          installedVersionOutput: '2.1.100 (Claude Code)\n',
          bundled: null,
        });

        // Older than the SDK that is actually installed here -- yet still
        // launched, because an unreadable MANIFEST must not silently become a
        // downgrade of a CLI that demonstrably runs.
        expect(await startAndReadOptions(adapter)).toMatchObject({
          pathToClaudeCodeExecutable: INSTALLED,
        });
        expect(await readCliDescription(adapter)).toBe(
          `Required to launch the Claude runtime. Station launches the installed executable at ${INSTALLED}; the Claude Code version bundled with the Agent SDK could not be read, so no comparison was made (installed 2.1.100).`,
        );
      });

      test('falls back to the bundled CLI when the installed one runs cleanly but reports no version', async () => {
        const { adapter } = adapterWith({
          installedVersionOutput: 'claude: command output with no version\n',
          bundled: '2.1.224',
        });

        // Exit 0 proves the binary can be spawned, but the guard's rule is
        // "never launch an OLDER Claude Code" and nothing established that
        // this one is not (a wrapper exiting 0 without running Claude Code
        // lands here too) -- review D1.
        expect(await startAndReadOptions(adapter)).not.toHaveProperty(
          'pathToClaudeCodeExecutable',
        );
        expect(await readCliDescription(adapter)).toBe(
          `Required to launch the Claude runtime. Station launches the Claude Code 2.1.224 bundled with the Agent SDK; the installed \`claude\` at ${INSTALLED} ran but reported no version, so Station cannot confirm it is not older than the bundle.`,
        );
      });

      // #1551 review H1: an unreadable PROBE is not an unreadable version --
      // the SDK spawns the executable with the same no-shell mechanics the
      // probe uses, so a probe that never completed cleanly is the only
      // evidence Station has that the binary cannot be run. Handing it to the
      // SDK anyway would launch a binary Station just watched fail.
      test('falls back to the bundled CLI when the version probe produces nothing', async () => {
        const { adapter } = adapterWith({
          installedVersionOutput: null,
          bundled: '2.1.224',
        });

        expect(await startAndReadOptions(adapter)).not.toHaveProperty(
          'pathToClaudeCodeExecutable',
        );
        expect(await readCliDescription(adapter)).toBe(
          `Required to launch the Claude runtime. Station launches the Claude Code 2.1.224 bundled with the Agent SDK; the installed \`claude\` at ${INSTALLED} did not report a version, so Station cannot confirm it runs or that it is not older than the bundle.`,
        );
      });

      test('falls back to the bundled CLI when the version probe exits non-zero', async () => {
        const runCommand = vi
          .fn()
          .mockResolvedValue({ stdout: '9.9.9', stderr: '', code: 1 });
        const adapter = new ClaudeAdapter({
          findBinary: async () => INSTALLED,
          runCommand,
          readBundledVersion: () => '2.1.224',
        });

        // A non-zero exit is not an observation of the version, even when the
        // output happens to contain a version-shaped string -- and it is a
        // positive observation that the binary did not run cleanly.
        expect(await startAndReadOptions(adapter)).not.toHaveProperty(
          'pathToClaudeCodeExecutable',
        );
        expect(await readCliDescription(adapter)).toContain(
          'did not report a version',
        );
      });

      // #1551 review M1: `runCliCommand` never rejects -- it catches
      // everything and answers `{ code }` or `null` -- so memoizing by promise
      // identity alone pins a transient failure for the life of the process.
      test('re-probes after a failed probe instead of caching the failure', async () => {
        const runCommand = vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue({
            stdout: '2.1.261 (Claude Code)\n',
            stderr: '',
            code: 0,
          });
        const adapter = new ClaudeAdapter({
          findBinary: async () => INSTALLED,
          runCommand,
          readBundledVersion: () => '2.1.224',
        });

        // First inspection: the probe failed, so the bundled copy wins.
        expect(await readCliDescription(adapter)).toContain(
          'did not report a version',
        );
        // Second inspection re-probes rather than inheriting that failure.
        expect(await readCliDescription(adapter)).toBe(
          `Required to launch the Claude runtime. Station launches the installed Claude Code 2.1.261 at ${INSTALLED} (the Agent SDK bundles 2.1.224).`,
        );
        expect(runCommand).toHaveBeenCalledTimes(2);
        // ...and the successful observation IS durable.
        await readCliDescription(adapter);
        expect(runCommand).toHaveBeenCalledTimes(2);
      });

      test('probes the launcher once per process and shares it with readiness', async () => {
        const { adapter, runCommand } = adapterWith({
          installedVersionOutput: '2.1.261 (Claude Code)\n',
          bundled: '2.1.224',
        });

        await startAndReadOptions(adapter);
        await readCliDescription(adapter);
        // The probe the shared readiness builder was handed must reuse the
        // same observation rather than spawn the user's launcher again.
        const sharedProbe =
          mockBuildCliRuntimePrerequisites.mock.calls[0][0].runCommand;
        await sharedProbe(INSTALLED, ['--version']);

        expect(runCommand).toHaveBeenCalledTimes(1);
        expect(runCommand).toHaveBeenCalledWith(INSTALLED, ['--version']);
      });

      test('never probes a launcher shim it has already refused to spawn', async () => {
        const runCommand = vi.fn().mockResolvedValue(null);
        const adapter = new ClaudeAdapter({
          findBinary: async () =>
            'C:\\Users\\example\\AppData\\Roaming\\npm\\claude.cmd',
          executablePlatform: 'win32',
          executableFileExists: () => false,
          runCommand,
          readBundledVersion: () => '2.1.224',
        });

        await startAndReadOptions(adapter);

        expect(runCommand).not.toHaveBeenCalled();
      });
    });

    describe('reading the bundled Claude Code version', () => {
      test('reads `version` from the SDK package manifest', () => {
        expect(
          readBundledClaudeCodeVersion({
            resolveManifestPath: () => '/sdk/manifest.json',
            readFile: (path) =>
              path === '/sdk/manifest.json'
                ? JSON.stringify({
                    version: '2.1.224',
                    commit: '8a2a469b68f918917492973f3b16bd1682b9f82c',
                    buildDate: '2026-08-06T01:47:12Z',
                    platforms: { 'darwin-arm64': { binary: 'claude' } },
                    sdkCompat: {
                      testedWrapperVersions: ['0.3.224'],
                      harnessSchema: 1,
                    },
                  })
                : (() => {
                    throw new Error(`unexpected read: ${path}`);
                  })(),
          }),
        ).toBe('2.1.224');
      });

      test.each([
        [
          'an unreadable manifest',
          () => {
            throw new Error('ENOENT');
          },
        ],
        ['a non-JSON manifest', () => 'not json at all'],
        ['a manifest with no version', () => JSON.stringify({ commit: 'abc' })],
        ['a non-object manifest', () => JSON.stringify('2.1.224')],
        [
          'a version that is not version-shaped',
          () => JSON.stringify({ version: 'nightly' }),
        ],
      ])('returns null for %s', (_label, readFile) => {
        expect(
          readBundledClaudeCodeVersion({
            resolveManifestPath: () => '/sdk/manifest.json',
            readFile: readFile as (path: string) => string,
          }),
        ).toBeNull();
      });

      test('returns null rather than throwing when resolution itself fails', () => {
        expect(
          readBundledClaudeCodeVersion({
            resolveManifestPath: () => {
              throw new Error('ERR_PACKAGE_PATH_NOT_EXPORTED');
            },
          }),
        ).toBeNull();
      });

      test('the default reader answers from the real SDK manifest', () => {
        // #1551 review M3: the previous assertion (`null` OR version-shaped)
        // was true for every possible return value, so a broken manifest read
        // -- which routes every user to installed-always-wins -- would have
        // passed it. Compare against an independent read of the same file
        // instead: not pinned to a number, but it cannot pass on `null`.
        const manifestPath = join(
          dirname(
            createRequire(import.meta.url).resolve(
              '@anthropic-ai/claude-agent-sdk',
            ),
          ),
          'manifest.json',
        );
        const declared = JSON.parse(
          readFileSync(manifestPath, 'utf-8'),
        ).version;

        expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
        expect(readBundledClaudeCodeVersion()).toBe(declared);
      });
    });

    describe('parsing a Claude Code version', () => {
      test.each([
        ['2.1.261 (Claude Code)\n', '2.1.261'],
        ['2.1.224', '2.1.224'],
        ['v2.1.224-beta.3', '2.1.224'],
      ])('parses %j', (input, expected) => {
        expect(parseClaudeCodeVersion(input)).toBe(expected);
      });

      // #1551 review L1: an update notice must never be read as the version
      // the binary reports for ITSELF -- that error runs in the unsafe
      // direction, since a too-high reading defeats the not-older guard.
      test('ignores an update notice that follows the version line', () => {
        expect(
          parseClaudeCodeVersion(
            '2.1.261 (Claude Code)\nA newer version 2.1.300 is available\n',
          ),
        ).toBe('2.1.261');
      });

      test('ignores an update notice that precedes the version line', () => {
        expect(
          parseClaudeCodeVersion(
            'Update available: 2.1.300\n2.1.261 (Claude Code)\n',
          ),
        ).toBe('2.1.261');
      });

      test('prefers the Claude Code line over another line-leading version', () => {
        expect(
          parseClaudeCodeVersion(
            '2.1.300 is available\n2.1.261 (Claude Code)\n',
          ),
        ).toBe('2.1.261');
      });

      test('does not read a version out of the middle of a line', () => {
        expect(
          parseClaudeCodeVersion('a newer version 2.1.300 is available\n'),
        ).toBeNull();
      });

      test.each([[''], ['Claude Code'], ['2.1'], [null], [undefined]])(
        'returns null for %j',
        (input) => {
          expect(parseClaudeCodeVersion(input)).toBeNull();
        },
      );
    });

    // The Agent SDK spawns pathToClaudeCodeExecutable with no shell and no
    // PATHEXT resolution, so a Windows npm launcher shim fails with `spawn
    // EINVAL`. These run the win32 branch on any host via the injected
    // platform/file-exists seams.
    describe('windows launcher shims', () => {
      const SHIM = 'C:\\Users\\example\\AppData\\Roaming\\npm\\claude.cmd';
      const NATIVE =
        'C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
      const CLI_JS =
        'C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';

      test('follows a .cmd shim to the native package entry', () => {
        expect(
          resolveSpawnableClaudeExecutable(SHIM, {
            platform: 'win32',
            fileExists: (candidate) => candidate === NATIVE,
          }),
        ).toEqual({ executable: NATIVE, refusal: null });
      });

      test('follows a .cmd shim to cli.js when no native entry exists', () => {
        expect(
          resolveSpawnableClaudeExecutable(SHIM, {
            platform: 'win32',
            fileExists: (candidate) => candidate === CLI_JS,
          }),
        ).toEqual({ executable: CLI_JS, refusal: null });
      });

      test.each(['.cmd', '.bat', '.ps1', '.CMD'])(
        'refuses an unfollowable %s shim rather than handing it to the SDK',
        (extension) => {
          expect(
            resolveSpawnableClaudeExecutable(
              `C:\\Users\\example\\AppData\\Roaming\\npm\\claude${extension}`,
              { platform: 'win32', fileExists: () => false },
            ),
          ).toEqual({ executable: null, refusal: 'unfollowable-launcher' });
        },
      );

      test('passes a real windows executable through untouched', () => {
        const exe = 'C:\\Program Files\\claude\\claude.exe';
        expect(
          resolveSpawnableClaudeExecutable(exe, {
            platform: 'win32',
            fileExists: () => false,
          }),
        ).toEqual({ executable: exe, refusal: null });
      });

      // #1551 review L2: a bare command name and an unfollowable shim are
      // different refusals and must not share a sentence.
      test('refuses a bare command name on every platform, as not-absolute', () => {
        expect(
          resolveSpawnableClaudeExecutable('claude', {
            platform: 'win32',
            fileExists: () => true,
          }),
        ).toEqual({ executable: null, refusal: 'not-absolute' });
        expect(
          resolveSpawnableClaudeExecutable('claude', { platform: 'darwin' }),
        ).toEqual({ executable: null, refusal: 'not-absolute' });
      });

      test('readiness names a non-absolute answer as such, not as a launcher', async () => {
        mockBuildCliRuntimePrerequisites.mockResolvedValue([
          {
            id: 'claude-cli',
            name: 'Claude CLI',
            description: 'Required to launch the Claude runtime.',
            status: 'installed',
            category: 'required',
          },
        ]);
        const runCommand = vi.fn().mockResolvedValue(null);
        const adapter = new ClaudeAdapter({
          findBinary: async () => 'claude',
          runCommand,
          readBundledVersion: () => '2.1.224',
        });

        const prerequisites = await adapter.getPrerequisites?.();

        expect(prerequisites?.[0]?.description).toBe(
          'Required to launch the Claude runtime. Station launches the Claude Code 2.1.224 bundled with the Agent SDK: the `claude` at claude is not an absolute path, and the Agent SDK spawns the executable without PATH resolution.',
        );
        expect(runCommand).not.toHaveBeenCalled();
      });

      test('leaves posix paths alone, shim-looking extension or not', () => {
        expect(
          resolveSpawnableClaudeExecutable('/usr/local/bin/claude.cmd', {
            platform: 'darwin',
            fileExists: () => false,
          }),
        ).toEqual({ executable: '/usr/local/bin/claude.cmd', refusal: null });
      });

      test('the session spawn omits the option for an unfollowable shim', async () => {
        mockFindCliBinaryAsync.mockResolvedValue(SHIM);
        mockQuery.mockReturnValue(createMockQuery([]));
        const adapter = new ClaudeAdapter({
          executablePlatform: 'win32',
          executableFileExists: () => false,
        });

        await adapter.startSession({
          provider: 'claude',
          threadId: 'thread-1551-shim',
          cwd: 'C:\\workspace\\project',
          modelId: 'claude-sonnet-4-6',
        });

        expect(mockQuery.mock.calls[0][0].options).not.toHaveProperty(
          'pathToClaudeCodeExecutable',
        );
      });

      test('the session spawn uses the followed package entry', async () => {
        mockFindCliBinaryAsync.mockResolvedValue(SHIM);
        mockQuery.mockReturnValue(createMockQuery([]));
        const adapter = new ClaudeAdapter({
          executablePlatform: 'win32',
          executableFileExists: (candidate) => candidate === NATIVE,
        });

        await adapter.startSession({
          provider: 'claude',
          threadId: 'thread-1551-shim-ok',
          cwd: 'C:\\workspace\\project',
          modelId: 'claude-sonnet-4-6',
        });

        expect(mockQuery.mock.calls[0][0].options).toMatchObject({
          pathToClaudeCodeExecutable: NATIVE,
        });
      });

      // #1551 review M2: readiness used to probe `resolved` (the .cmd shim)
      // while the decision probed `spawnable` (the followed .exe) -- two
      // spawns, and the shim's failure was then reported as this
      // prerequisite's status while the .exe was what Station launched.
      test('readiness probes the followed entry, not the shim, and shares the memo', async () => {
        const runCommand = vi.fn().mockResolvedValue({
          stdout: '2.1.261 (Claude Code)\n',
          stderr: '',
          code: 0,
        });
        mockBuildCliRuntimePrerequisites.mockResolvedValue([
          {
            id: 'claude-cli',
            name: 'Claude CLI',
            description: 'Required to launch the Claude runtime.',
            status: 'installed',
            category: 'required',
          },
        ]);
        const adapter = new ClaudeAdapter({
          findBinary: async () => SHIM,
          executablePlatform: 'win32',
          executableFileExists: (candidate) => candidate === NATIVE,
          runCommand,
          readBundledVersion: () => '2.1.224',
        });

        const prerequisites = await adapter.getPrerequisites?.();
        // The shared builder hands its probe the RESOLVED command (the shim);
        // the adapter must redirect it onto the executable it will launch.
        const sharedProbe =
          mockBuildCliRuntimePrerequisites.mock.calls[0][0].runCommand;
        await sharedProbe(SHIM, ['--version']);

        expect(runCommand).toHaveBeenCalledTimes(1);
        expect(runCommand).toHaveBeenCalledWith(NATIVE, ['--version']);
        expect(runCommand).not.toHaveBeenCalledWith(SHIM, ['--version']);
        expect(prerequisites?.[0]?.description).toBe(
          `Required to launch the Claude runtime. Station launches the installed Claude Code 2.1.261 at ${NATIVE} (the Agent SDK bundles 2.1.224).`,
        );
      });

      // #1551 review D3: the SDK spawns a `.js` entry as `node <entry>`, so the
      // probe must too; probing `cli.js` directly can never exit 0, which
      // would have routed every older-package install to the bundled CLI.
      test('probes a followed cli.js entry through node and launches it', async () => {
        const CLIJS =
          'C:\\Users\\example\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
        const runCommand = vi.fn().mockResolvedValue({
          stdout: '2.1.261 (Claude Code)\n',
          stderr: '',
          code: 0,
        });
        mockBuildCliRuntimePrerequisites.mockResolvedValue([
          {
            id: 'claude-cli',
            name: 'Claude CLI',
            description: 'Required to launch the Claude runtime.',
            status: 'installed',
            category: 'required',
          },
        ]);
        mockQuery.mockReturnValue(createMockQuery([]));
        const adapter = new ClaudeAdapter({
          findBinary: async () => SHIM,
          executablePlatform: 'win32',
          executableFileExists: (candidate) => candidate === CLIJS,
          runCommand,
          readBundledVersion: () => '2.1.224',
        });

        const prerequisites = await adapter.getPrerequisites?.();
        const sharedProbe =
          mockBuildCliRuntimePrerequisites.mock.calls[0][0].runCommand;
        await sharedProbe(SHIM, ['--version']);
        await adapter.startSession({
          provider: 'claude',
          threadId: 'thread-1551-clijs',
          cwd: 'C:\\workspace\\project',
          modelId: 'claude-sonnet-4-6',
        });

        expect(runCommand).toHaveBeenCalledTimes(1);
        expect(runCommand).toHaveBeenCalledWith(process.execPath, [
          CLIJS,
          '--version',
        ]);
        expect(mockQuery.mock.calls[0][0].options).toMatchObject({
          pathToClaudeCodeExecutable: CLIJS,
        });
        expect(prerequisites?.[0]?.description).toBe(
          `Required to launch the Claude runtime. Station launches the installed Claude Code 2.1.261 at ${CLIJS} (the Agent SDK bundles 2.1.224).`,
        );
      });

      test('readiness distinguishes an unfollowable shim from nothing installed', async () => {
        mockFindCliBinaryAsync.mockResolvedValue(SHIM);
        mockBuildCliRuntimePrerequisites.mockResolvedValue([
          {
            id: 'claude-cli',
            name: 'Claude CLI',
            description: 'Required to launch the Claude runtime.',
            status: 'installed',
            category: 'required',
          },
        ]);
        const adapter = new ClaudeAdapter({
          executablePlatform: 'win32',
          executableFileExists: () => false,
          readBundledVersion: () => '2.1.224',
        });

        const prerequisites = await adapter.getPrerequisites?.();

        expect(prerequisites?.[0]?.description).toBe(
          `Required to launch the Claude runtime. Station launches the Claude Code CLI bundled with the Agent SDK: the \`claude\` at ${SHIM} is a launcher the Agent SDK cannot spawn directly.`,
        );
        // Install status still reflects the resolver's own answer: a `claude`
        // IS on PATH, Station just cannot hand that entry to the SDK.
        expect(
          mockBuildCliRuntimePrerequisites.mock.calls[0][0].findBinary(
            'claude',
          ),
        ).toBe(SHIM);
      });
    });
  });
});

/**
 * station#1558: a `tool_use` still open when the SESSION ends can never
 * receive a result. Both session-end paths must settle it, on the turn that
 * issued it, and neither may settle at a mere turn boundary (a backgrounded
 * `Task` legitimately outlives its turn).
 */
describe('ClaudeAdapter — unresolved tool calls at session end (station#1558)', () => {
  afterEach(() => {
    mockQuery.mockReset();
  });

  /** A push-driven query whose iterator can also FINISH, modelling the
   * `claude` process exiting on its own.
   *
   * `endOnClose: false` models the engine `CLAUDE_STREAM_STOP_GRACE_MS`
   * exists for (station#1569 item 1): one whose iterator does NOT end when
   * `query.close()` lands, so `stopSession` reaches its grace instead of the
   * consumer's own settle. */
  function createEndableMockQuery({ endOnClose = true } = {}) {
    const pending: any[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    return {
      push(message: any) {
        pending.push(message);
        wake?.();
        wake = null;
      },
      end() {
        ended = true;
        wake?.();
        wake = null;
      },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (pending.length === 0) {
            if (ended) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          yield pending.shift();
        }
      },
      interrupt: vi.fn().mockResolvedValue(undefined),
      supportedModels: vi.fn().mockResolvedValue([]),
      // The real SDK ends its iterator when the query closes — and it drains
      // whatever it had already queued first. Modelling that is what makes
      // the stopSession ordering below a real test rather than a mock's
      // convenience (station#1558 fix round, M8).
      close: vi.fn().mockImplementation(() => {
        if (!endOnClose) return;
        ended = true;
        wake?.();
        wake = null;
      }),
      setModel: vi.fn().mockResolvedValue(undefined),
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
      applyFlagSettings: vi.fn().mockResolvedValue(undefined),
    };
  }

  /** Drains the stream until `method` arrives, so a test never has to encode
   * the exact number of lifecycle events between two facts. */
  async function nextOf(
    iterator: AsyncIterator<any>,
    method: string,
    limit = 12,
  ) {
    for (let step = 0; step < limit; step += 1) {
      const next = await iterator.next();
      if (next.done) throw new Error(`stream ended before ${method}`);
      if (next.value.method === method) return next.value;
    }
    throw new Error(`no ${method} within ${limit} events`);
  }

  /** Drains everything the stream produces until it goes quiet, so a test can
   * assert what was NOT published (an absence a `nextOf` scan cannot see). */
  async function drainUntilQuiet(iterator: AsyncIterator<any>, quietMs = 40) {
    const seen: any[] = [];
    const NOTHING = Symbol('nothing-else');
    for (;;) {
      const next = await Promise.race([
        iterator.next().then((result) => result.value),
        new Promise((resolve) => setTimeout(() => resolve(NOTHING), quietMs)),
      ]);
      if (next === NOTHING) return seen;
      seen.push(next);
    }
  }

  async function openCallOn(
    threadId: string,
    query: ReturnType<typeof createEndableMockQuery>,
    options?: ConstructorParameters<typeof ClaudeAdapter>[0],
  ) {
    mockQuery.mockReturnValue(query);
    const adapter = new ClaudeAdapter(options);
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({ provider: 'claude', threadId });
    const turn = await adapter.sendTurn({ threadId, input: 'work' });
    await nextOf(iterator, 'turn.started');
    query.push({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_use', id: 'toolu-open', name: 'Bash', input: {} },
        ],
      },
      uuid: 'assistant-1',
      session_id: threadId,
    });
    await nextOf(iterator, 'tool.started');
    return { adapter, iterator, turnId: turn.turnId };
  }

  test('stopSession settles the open call as unresolved, on its own turn, before session.exited', async () => {
    const query = createEndableMockQuery();
    const { adapter, iterator, turnId } = await openCallOn(
      'thread-unresolved-stop',
      query,
    );

    await adapter.stopSession('thread-unresolved-stop');

    const settled = await nextOf(iterator, 'tool.completed');
    expect(settled).toMatchObject({
      toolCallId: 'toolu-open',
      toolName: 'Bash',
      status: 'unresolved',
      turnId,
      output:
        'No result was reported before the session ended; whether the tool ran is unknown.',
    });
    // The exit event follows it, so a reader replaying the stream sees the
    // call settle while the session is still the subject.
    await nextOf(iterator, 'session.exited');
  });

  // station#1558 fix round (M8): closing the query does not discard messages
  // the SDK already queued. Settling synchronously inside stopSession
  // published `unresolved` for a call that DID report, and the replay guard
  // then dropped the real result because its entry was gone.
  test('a tool_result queued before the close still reports success, and no unresolved is published for it', async () => {
    const query = createEndableMockQuery();
    const { adapter, iterator, turnId } = await openCallOn(
      'thread-unresolved-race',
      query,
    );

    // Queued, not yet consumed, at the moment the stop lands.
    query.push({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'toolu-open', content: 'ok' },
        ],
      },
      uuid: 'user-1',
      session_id: 'thread-unresolved-race',
    });
    await adapter.stopSession('thread-unresolved-race');

    const settled = await nextOf(iterator, 'tool.completed');
    expect(settled).toMatchObject({
      toolCallId: 'toolu-open',
      status: 'success',
      turnId,
    });
    // …and only that one: the exit follows with no unresolved terminal
    // between them.
    const after: string[] = [];
    for (let step = 0; step < 8; step += 1) {
      const next = await iterator.next();
      after.push(next.value.method);
      if (next.value.method === 'session.exited') break;
    }
    expect(after).toContain('session.exited');
    expect(after).not.toContain('tool.completed');
  });

  test('the SDK iterator ending (the process exiting) settles the open call too', async () => {
    const query = createEndableMockQuery();
    const { iterator, turnId } = await openCallOn(
      'thread-unresolved-exit',
      query,
    );

    // Nobody called stopSession: the engine process simply went away.
    query.end();

    const settled = await nextOf(iterator, 'tool.completed');
    expect(settled).toMatchObject({
      toolCallId: 'toolu-open',
      status: 'unresolved',
      turnId,
    });
  });

  test('a completed TURN leaves the open call alone — only the session settles it', async () => {
    const query = createEndableMockQuery();
    const { iterator } = await openCallOn('thread-unresolved-turn', query);

    query.push({
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      stop_reason: 'end_turn',
      result: 'done',
      usage: { input_tokens: 1, output_tokens: 1 },
      uuid: 'result-1',
      session_id: 'thread-unresolved-turn',
    });

    // A backgrounded Task's result legitimately arrives after its turn ends,
    // so the turn boundary must publish no terminal for the call. Collected
    // rather than scanned-past: a settle emitted BEFORE `turn.completed`
    // would be invisible to a search that only looks for the terminal.
    const seen: string[] = [];
    for (let step = 0; step < 12; step += 1) {
      const next = await iterator.next();
      seen.push(next.value.method);
      if (next.value.method === 'turn.completed') break;
    }
    expect(seen).toContain('turn.completed');
    expect(seen).not.toContain('tool.completed');
    const NOTHING = Symbol('nothing-else');
    expect(
      await Promise.race([
        iterator.next().then((result) => result.value),
        new Promise((resolve) => setTimeout(() => resolve(NOTHING), 50)),
      ]),
    ).toBe(NOTHING);
  });

  /**
   * station#1569 (item 1): the branch `CLAUDE_STREAM_STOP_GRACE_MS` exists
   * for — an engine whose iterator does NOT end when `query.close()` lands,
   * so `consumeMessages`' own settle never runs and `stopSession` has to do
   * it. Every case above is served by a query that ends on close, which is
   * exactly why this branch had no test.
   */
  describe('the stop grace elapsing (station#1569 item 1)', () => {
    test('settles the open call as unresolved, on its own turn, before session.exited', async () => {
      const query = createEndableMockQuery({ endOnClose: false });
      const { adapter, iterator, turnId } = await openCallOn(
        'thread-grace-elapsed',
        query,
        { streamStopGraceMs: 5 },
      );

      await adapter.stopSession('thread-grace-elapsed');

      expect(await nextOf(iterator, 'tool.completed')).toMatchObject({
        toolCallId: 'toolu-open',
        toolName: 'Bash',
        status: 'unresolved',
        turnId,
        output:
          'No result was reported before the session ended; whether the tool ran is unknown.',
      });
      await nextOf(iterator, 'session.exited');
      // The stop returned rather than hanging on an iterator that never ends:
      // the bound is the whole point of the grace.
      expect(query.close).toHaveBeenCalled();
    });

    test('a tool_result that drains AFTER that settle still publishes the real terminal on its issuing turn', async () => {
      const query = createEndableMockQuery({ endOnClose: false });
      const { adapter, iterator, turnId } = await openCallOn(
        'thread-grace-late-result',
        query,
        { streamStopGraceMs: 5 },
      );

      await adapter.stopSession('thread-grace-late-result');
      expect(await nextOf(iterator, 'tool.completed')).toMatchObject({
        status: 'unresolved',
      });
      await nextOf(iterator, 'session.exited');

      // The SDK was holding this the whole time. Before station#1569 the
      // replay guard dropped it because the settle had cleared its entry,
      // leaving `unresolved` standing over an outcome Station did receive.
      query.push({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu-open', content: 'ok' },
          ],
        },
        uuid: 'user-late',
        session_id: 'thread-grace-late-result',
      });

      // Drained rather than scanned: when this regresses the result is
      // DROPPED, and a scan for an event that never arrives can only fail by
      // timing out. This says "nothing was published" in 40ms instead.
      const seen = await drainUntilQuiet(iterator);
      expect(seen.filter((event) => event.method === 'tool.completed')).toEqual(
        [
          expect.objectContaining({
            toolCallId: 'toolu-open',
            toolName: 'Bash',
            status: 'success',
            // The turn that ISSUED the call, read back from the settle record —
            // there is no active turn left to fall back on.
            turnId,
            output: 'ok',
          }),
        ],
      );
    });

    test('a second result for an id already superseded is dropped like any other replay', async () => {
      const query = createEndableMockQuery({ endOnClose: false });
      const { adapter, iterator } = await openCallOn(
        'thread-grace-double-result',
        query,
        { streamStopGraceMs: 5 },
      );

      await adapter.stopSession('thread-grace-double-result');
      await nextOf(iterator, 'tool.completed');
      await nextOf(iterator, 'session.exited');

      const result = {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu-open', content: 'ok' },
          ],
        },
        uuid: 'user-late',
        session_id: 'thread-grace-double-result',
      };
      query.push(result);
      query.push({ ...result, uuid: 'user-late-2' });

      // The settle record is consumed by the first result, so the second is
      // an untracked id again — one late correction, not a repeatable one.
      const seen = await drainUntilQuiet(iterator);
      expect(seen.filter((event) => event.method === 'tool.completed')).toEqual(
        [expect.objectContaining({ status: 'success' })],
      );
    });
  });

  /**
   * station#1569 (item 6): `stopSession` removes the record BEFORE awaiting
   * the settle, so a `startSession` for the same thread during that await
   * makes the thread live again — and `session.exited` is keyed by threadId,
   * not by record.
   */
  describe('a restart during the stop drain (station#1569 item 6)', () => {
    test('publishes no session.exited for a thread that is live again, and still settles the stopped session own calls', async () => {
      // The stopped session's stream is ended explicitly below rather than by
      // `close()`, so the restart is guaranteed to land inside the window
      // instead of racing a timer.
      const query = createEndableMockQuery({ endOnClose: false });
      const { adapter, iterator, turnId } = await openCallOn(
        'thread-stop-restart',
        query,
      );

      const stop = adapter.stopSession('thread-stop-restart');
      const restarted = createEndableMockQuery();
      mockQuery.mockReturnValue(restarted);
      await adapter.startSession({
        provider: 'claude',
        threadId: 'thread-stop-restart',
      });
      // Only now does the stopped session's stream end, so the stop resolves
      // with the new record already installed.
      query.end();
      await stop;

      const seen = await drainUntilQuiet(iterator);
      const methods = seen.map((event) => event.method);
      // The restart happened…
      expect(methods).toContain('session.started');
      // …the stopped session's open call still got its honest terminal…
      expect(seen).toContainEqual(
        expect.objectContaining({
          method: 'tool.completed',
          toolCallId: 'toolu-open',
          status: 'unresolved',
          turnId,
        }),
      );
      // …and nothing told the client this thread's session had ended.
      expect(methods).not.toContain('session.exited');
      expect(await adapter.hasSession('thread-stop-restart')).toBe(true);
    });

    test('with no restart, the same stop still publishes session.exited', async () => {
      // The discriminating control for the assertion above: the suppression
      // is conditional on the thread being retaken, not unconditional.
      const query = createEndableMockQuery({ endOnClose: false });
      const { adapter, iterator } = await openCallOn(
        'thread-stop-no-restart',
        query,
      );

      const stop = adapter.stopSession('thread-stop-no-restart');
      query.end();
      await stop;

      const methods = (await drainUntilQuiet(iterator)).map(
        (event) => event.method,
      );
      expect(methods).toContain('session.exited');
      expect(await adapter.hasSession('thread-stop-no-restart')).toBe(false);
    });

    /**
     * station#1573 (station#1569 M1): the same window, and the part of it
     * that destroys data. Both cleanup leaves are keyed by threadId —
     * `skillOverlayDirFor(sessionId)` is `<root>/<sessionId>` and the
     * manifest is written under that same `sessionId` — so a restarted
     * session materializes into exactly the paths the old stop is about to
     * remove.
     *
     * Driven through the real `stopSession` with the two leaves injected
     * (`skillsCleanup`), because the decision under test is whether
     * stopSession CALLS them; the adapter test harness cannot materialize
     * real skills, and a test of a pure predicate would not prove the caller
     * consults it.
     */
    describe('skills cleanup (station#1573)', () => {
      function cleanupSpies() {
        return {
          cleanupMaterializedSkills: vi.fn().mockResolvedValue(undefined),
          removeSkillOverlayDir: vi.fn().mockResolvedValue(undefined),
        };
      }

      test('is skipped for a thread the restart now owns', async () => {
        const skillsCleanup = cleanupSpies();
        const query = createEndableMockQuery({ endOnClose: false });
        const { adapter } = await openCallOn('thread-cleanup-restart', query, {
          skillsCleanup,
        });
        // The overlay branch is the destructive one (an unconditional
        // recursive remove), so make this session own an overlay.
        (
          adapter as unknown as {
            sessions: Map<string, { skillsOverlayDir?: string }>;
          }
        ).sessions.get('thread-cleanup-restart')!.skillsOverlayDir =
          '/tmp/station-overlay/thread-cleanup-restart';

        const stop = adapter.stopSession('thread-cleanup-restart');
        mockQuery.mockReturnValue(createEndableMockQuery());
        await adapter.startSession({
          provider: 'claude',
          threadId: 'thread-cleanup-restart',
        });
        query.end();
        await stop;

        expect(skillsCleanup.removeSkillOverlayDir).not.toHaveBeenCalled();
        expect(skillsCleanup.cleanupMaterializedSkills).not.toHaveBeenCalled();
      });

      test('runs for an ordinary stop — the skip is conditional, not the new default', async () => {
        const skillsCleanup = cleanupSpies();
        const query = createEndableMockQuery({ endOnClose: false });
        const { adapter } = await openCallOn(
          'thread-cleanup-no-restart',
          query,
          { skillsCleanup },
        );
        (
          adapter as unknown as {
            sessions: Map<string, { skillsOverlayDir?: string }>;
          }
        ).sessions.get('thread-cleanup-no-restart')!.skillsOverlayDir =
          '/tmp/station-overlay/thread-cleanup-no-restart';

        const stop = adapter.stopSession('thread-cleanup-no-restart');
        query.end();
        await stop;

        expect(skillsCleanup.cleanupMaterializedSkills).toHaveBeenCalledWith(
          expect.objectContaining({
            cwd: '/tmp/station-overlay/thread-cleanup-no-restart',
            sessionId: 'thread-cleanup-no-restart',
          }),
        );
        expect(skillsCleanup.removeSkillOverlayDir).toHaveBeenCalledWith(
          'thread-cleanup-no-restart',
          expect.anything(),
        );
      });

      test('the real-cwd manifest path is skipped by the same guard', async () => {
        // The other branch: no overlay, so cleanup is scoped to the session's
        // own manifest inside the user's real workspace — written under the
        // same threadId, and therefore the restarted session's manifest too.
        const skillsCleanup = cleanupSpies();
        const query = createEndableMockQuery({ endOnClose: false });
        const { adapter } = await openCallOn('thread-cleanup-cwd', query, {
          skillsCleanup,
        });
        (
          adapter as unknown as {
            sessions: Map<string, { session: { cwd?: string } }>;
          }
        ).sessions.get('thread-cleanup-cwd')!.session.cwd = '/repo/project';

        const stop = adapter.stopSession('thread-cleanup-cwd');
        mockQuery.mockReturnValue(createEndableMockQuery());
        await adapter.startSession({
          provider: 'claude',
          threadId: 'thread-cleanup-cwd',
        });
        query.end();
        await stop;

        expect(skillsCleanup.cleanupMaterializedSkills).not.toHaveBeenCalled();
      });
    });
  });
});
