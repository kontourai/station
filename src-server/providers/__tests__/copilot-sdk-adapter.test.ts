/**
 * The Copilot SDK adapter driven through a fake of the SDK interface it uses
 * (`copilot-sdk-port.ts`). The fake calls the same `SessionConfig` callbacks
 * the real SDK calls (`onEvent`, and `onPermissionRequest` with its second
 * `invocation` argument), and every event and request below is typed as the
 * SDK's own `SessionEvent` / `PermissionRequest` from `@github/copilot-sdk`
 * 1.0.32 (`dist/generated/session-events.d.ts`; github/copilot-sdk
 * `nodejs/src/generated/session-events.ts`), so a fixture that drifts from the
 * SDK's wire shape fails the typecheck. No test here spawns a process or
 * reaches a Copilot service. The working directory is a real temporary
 * directory, so the symlink cases exercise real `realpath` resolution.
 */
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type {
  ModelInfo,
  PermissionRequest,
  SessionConfig,
  SessionEvent,
} from '@github/copilot-sdk';
import type { ProviderRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { foldUsageEvents } from '@kontourai/station-shared/usage-fold';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { startRecoveredOrchestrationSession } from '../../services/orchestration/orchestration-session-state.js';
import { SessionStartRefusedError } from '../adapter-shape.js';
import {
  CopilotSdkAdapter,
  resolveCopilotCliLaunchPath,
} from '../adapters/copilot-sdk-adapter.js';
import {
  type CopilotRealPathFs,
  copilotModeAllows,
  copilotRealPath,
} from '../adapters/copilot-sdk-approval.js';
import type {
  CopilotSdkClientPort,
  CopilotSdkLaunch,
} from '../adapters/copilot-sdk-port.js';
import {
  COPILOT_CONNECTION_CHECK_MS,
  COPILOT_PING_TIMEOUT_MS,
  copilotSdkClientPort,
} from '../adapters/copilot-sdk-port.js';
import { nativeResumeBindingKey } from '../adapters/native-resume-binding.js';
import {
  FakeCopilotClient,
  type FakeCopilotSession,
} from './copilot-sdk-fakes.js';

// Removed after the file's last test (#2421): every test shares this tree.
const makeFixtureDir = trackTempDirs({ lifetime: 'file' });
const ROOT = makeFixtureDir('copilot-sdk-adapter-');
const CWD = join(ROOT, 'repo');
const OUTSIDE = join(ROOT, 'outside');
mkdirSync(join(CWD, 'src'), { recursive: true });
mkdirSync(OUTSIDE, { recursive: true });
writeFileSync(join(OUTSIDE, 'secret'), 'secret');
// A directory link inside the working directory that leads outside it. A
// junction needs no extra privilege on Windows.
symlinkSync(OUTSIDE, join(CWD, 'link'), 'junction');
// A dangling link: it points outside, at a directory that does not exist yet.
symlinkSync(join(OUTSIDE, 'not-yet'), join(CWD, 'dangling'), 'junction');
// `up` leads to <root>/a/b, so up/../x.txt is <root>/a/x.txt to the kernel.
mkdirSync(join(ROOT, 'a', 'b'), { recursive: true });
symlinkSync(join(ROOT, 'a', 'b'), join(CWD, 'up'), 'junction');
// Relative symlinks need POSIX, or symlink privilege on Windows. Where they
// work: p/q/l -> s, and s/d -> ../../escaped.txt (dangling), which the kernel
// reads from the real s, so a write through p/q/l/d lands beside the repo.
const RELATIVE_LINKS = (() => {
  try {
    symlinkSync(`..${sep}probe-target`, join(ROOT, 'probe-link'), 'file');
    rmSync(join(ROOT, 'probe-link'));
    return true;
  } catch {
    return false;
  }
})();
if (RELATIVE_LINKS) {
  mkdirSync(join(CWD, 'p', 'q'), { recursive: true });
  mkdirSync(join(CWD, 's'), { recursive: true });
  symlinkSync(join(CWD, 's'), join(CWD, 'p', 'q', 'l'), 'junction');
  symlinkSync(`..${sep}..${sep}escaped.txt`, join(CWD, 's', 'd'), 'file');
}
const COPILOT_HOME = join(ROOT, 'copilot-home');
const BINDING = nativeResumeBindingKey('copilot-sdk', COPILOT_HOME, null);

function previewSwitch(initial: boolean) {
  const state = { enabled: initial };
  return {
    state,
    selector: {
      select: <T>(branches: { enabled: () => T; disabled: () => T }): T =>
        state.enabled ? branches.enabled() : branches.disabled(),
    },
  };
}

function harness(
  options: {
    enabled?: boolean;
    env?: NodeJS.ProcessEnv;
    clientFactory?: (launch: CopilotSdkLaunch) => Promise<CopilotSdkClientPort>;
  } = {},
) {
  const preview = previewSwitch(options.enabled ?? true);
  const client = new FakeCopilotClient();
  const launches: CopilotSdkLaunch[] = [];
  let id = 0;
  const adapter = new CopilotSdkAdapter({
    preview: preview.selector,
    clientFactory:
      options.clientFactory ??
      (async (launch) => {
        launches.push(launch);
        return client;
      }),
    resolveCliPath: () => '/opt/copilot/bin/copilot',
    env: options.env ?? {
      COPILOT_HOME,
      PATH: '/usr/bin',
      GH_TOKEN: 'gh-token-for-test',
    },
    newId: () => `id-${++id}`,
    interruptSettleMs: 20,
  });
  const events: ProviderRuntimeEvent[] = [];
  const pump = (async () => {
    for await (const event of adapter.streamEvents()) events.push(event);
  })();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { adapter, client, launches, events, preview, pump, settle };
}

function at(seconds: number): string {
  return new Date(Date.UTC(2026, 10, 13, 12, 0, seconds)).toISOString();
}

function userMessage(
  session: FakeCopilotSession,
  clientTurnId: string,
  content: string,
): SessionEvent {
  return {
    type: 'user.message',
    id: session.nextEventId(),
    parentId: null,
    timestamp: at(1),
    data: { content, clientTurnId, messageId: `m-${clientTurnId}` },
  };
}

function idle(session: FakeCopilotSession, aborted = false): SessionEvent {
  return {
    type: 'session.idle',
    id: session.nextEventId(),
    parentId: null,
    timestamp: at(9),
    ephemeral: true,
    data: aborted ? { aborted: true } : {},
  };
}

function sessionError(
  session: FakeCopilotSession,
  data: Partial<Extract<SessionEvent, { type: 'session.error' }>['data']> = {},
  agentId?: string,
): SessionEvent {
  return {
    type: 'session.error',
    id: session.nextEventId(),
    parentId: null,
    timestamp: at(3),
    ...(agentId ? { agentId } : {}),
    data: { errorType: 'model', message: 'Model call failed.', ...data },
  };
}

type Harness = ReturnType<typeof harness>;

async function start(
  h: Harness,
  extra: Partial<Parameters<CopilotSdkAdapter['startSession']>[0]> = {},
) {
  await h.adapter.startSession({
    threadId: 'thread-1',
    provider: 'copilot-sdk',
    cwd: CWD,
    ...extra,
  });
  return h.client.created.at(-1) ?? h.client.resumed.at(-1)!.session;
}

async function sendAndEcho(
  h: Harness,
  session: FakeCopilotSession,
  prompt = 'hello',
  extra: Partial<Parameters<CopilotSdkAdapter['sendTurn']>[0]> = {},
) {
  const turn = await h.adapter.sendTurn({
    threadId: 'thread-1',
    input: prompt,
    ...extra,
  });
  session.emit(userMessage(session, turn.turnId, prompt));
  return turn.turnId;
}

async function startedTurn(h: Harness, prompt = 'hello') {
  const session = await start(h);
  const turnId = await sendAndEcho(h, session, prompt);
  return { session, turnId };
}

const methods = (events: ProviderRuntimeEvent[]) =>
  events.map((event) => event.method);

const opened = (h: Harness) =>
  h.events.filter((e) => e.method === 'request.opened') as Array<
    ProviderRuntimeEvent & {
      requestId: string;
      payload: Record<string, unknown>;
    }
  >;

const shell: PermissionRequest = {
  kind: 'shell',
  canOfferSessionApproval: true,
  commands: [],
  fullCommandText: 'rm -rf /',
  hasWriteFileRedirection: false,
  intention: 'Remove everything',
  possiblePaths: [],
  possibleUrls: [],
  toolCallId: 'call-9',
};

function read(path: string, resolvedPath?: string): PermissionRequest {
  return {
    kind: 'read',
    intention: 'Read it',
    path,
    ...(resolvedPath ? { resolvedPath } : {}),
  };
}

function write(
  fileName: string,
  resolvedPath: string | undefined,
  editPaths: string[] = [],
): PermissionRequest {
  return {
    kind: 'write',
    canOfferSessionApproval: true,
    diff: '+x',
    fileName,
    intention: 'Edit',
    ...(resolvedPath ? { resolvedPath } : {}),
    ...(editPaths.length
      ? {
          fileEdits: editPaths.map((path) => ({
            after: { path, content: 'x' },
          })) as never,
        }
      : {}),
  };
}

describe('Copilot SDK adapter: Feature Preview gate', () => {
  test('refuses a start while the preview is off and launches nothing', async () => {
    const h = harness({ enabled: false });
    await expect(
      h.adapter.startSession({
        threadId: 't',
        provider: 'copilot-sdk',
        cwd: CWD,
      }),
    ).rejects.toMatchObject({
      name: 'SessionStartRefusedError',
      code: 'feature_preview_disabled',
    });
    expect(h.launches).toHaveLength(0);
    const prerequisites = await h.adapter.getPrerequisites();
    expect(prerequisites).toEqual([
      expect.objectContaining({ id: 'copilot-sdk-preview', status: 'missing' }),
    ]);
  });

  test('lists no models and launches no runtime while the preview is off', async () => {
    const h = harness({ enabled: false });
    h.client.models = [{ id: 'gpt-5', name: 'GPT-5' } as ModelInfo];
    expect(await h.adapter.listModels()).toEqual([]);
    expect(h.launches).toHaveLength(0);
    h.preview.state.enabled = true;
    expect(await h.adapter.listModels()).toEqual([
      { id: 'gpt-5', name: 'GPT-5', originalId: 'gpt-5' },
    ]);
    expect(h.launches).toHaveLength(1);
    expect(h.client.stopped).toBe(1);
  });

  test('a choice changed after composition applies to the next operation', async () => {
    const h = harness({ enabled: false });
    await expect(
      h.adapter.startSession({
        threadId: 'thread-1',
        provider: 'copilot-sdk',
        cwd: CWD,
      }),
    ).rejects.toBeInstanceOf(SessionStartRefusedError);
    h.preview.state.enabled = true;
    const session = await start(h);
    const turnId = await sendAndEcho(h, session);
    h.preview.state.enabled = false;
    await expect(
      h.adapter.steerTurn('thread-1', 'more', turnId),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(session.sends).toHaveLength(1);
    session.emit(idle(session));
    await expect(
      h.adapter.sendTurn({ threadId: 'thread-1', input: 'more' }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(h.adapter.rewindSession('thread-1', turnId)).resolves.toEqual({
      kind: 'refused',
      reason: 'unsupported',
    });
    await expect(
      h.adapter.reconnectMcpServer('thread-1', 'github', { startOAuth: false }),
    ).resolves.toMatchObject({ kind: 'failed' });
    expect(session.rewinds).toHaveLength(0);
    expect(session.restarted).toHaveLength(0);
    expect(h.adapter.sessionContinuity('thread-1').rewind).toBe('none');
    // Stopping stays available so nothing is stranded.
    await h.adapter.stopSession('thread-1');
    expect(h.client.stopped).toBe(1);
  });
});

describe('Copilot SDK adapter: session create and resume', () => {
  test('creates a manual-permission, file-tracking session on the given CLI', async () => {
    const h = harness();
    const session = await h.adapter.startSession({
      threadId: 'thread-1',
      provider: 'copilot-sdk',
      cwd: CWD,
      modelId: 'gpt-5',
    });
    expect(h.launches[0]).toMatchObject({
      cliPath: '/opt/copilot/bin/copilot',
      cwd: CWD,
      args: [],
    });
    // The runtime gets Station's child environment, the person's own
    // variables included, and a TMPDIR of Station's.
    expect(h.launches[0]!.env).toMatchObject({
      GH_TOKEN: 'gh-token-for-test',
      COPILOT_HOME,
    });
    expect(h.launches[0]!.env.TMPDIR).toBeTruthy();
    const config = h.client.created[0]!.config as SessionConfig;
    expect(config).toMatchObject({
      workingDirectory: CWD,
      permissionMode: 'manual',
      enableFileChangeTracking: true,
      streaming: true,
      includeSubAgentStreamingEvents: false,
      model: 'gpt-5',
    });
    expect(config.cloud).toBeUndefined();
    expect(session.resumeCursor).toEqual({
      copilotSessionId: 'copilot-session-1',
    });
    await h.settle();
    const configured = h.events.find((e) => e.method === 'session.configured');
    expect(configured).toMatchObject({
      sessionId: 'copilot-session-1',
      metadata: { approvalMode: 'ask', nativeResumeBindingKey: BINDING },
    });
  });

  test('session.started carries the start metadata and the binding key recovery reads back', async () => {
    const h = harness();
    await start(h, {
      metadata: { connectionId: 'copilot-sdk', agentSlug: 'a' },
    });
    await h.settle();
    expect(h.events.find((e) => e.method === 'session.started')).toMatchObject({
      metadata: {
        connectionId: 'copilot-sdk',
        agentSlug: 'a',
        nativeResumeBindingKey: BINDING,
      },
    });
  });

  test('a restart recovery resumes the session through the generic recovery path', async () => {
    const h = harness();
    const recover = (readKey?: (threadId: string) => string | undefined) =>
      startRecoveredOrchestrationSession({
        session: {
          provider: 'copilot-sdk',
          threadId: 'thread-1',
          status: 'ready',
          cwd: CWD,
          resumeCursor: { copilotSessionId: 'earlier-session' },
          createdAt: at(0),
          updatedAt: at(0),
        },
        adapter: h.adapter,
        options: {
          assertAdapterReady: async () => {},
          trackStartedSession: () => {},
          logger: { warn: vi.fn() },
          readSessionStartMetadata: () => ({ connectionId: 'copilot-sdk' }),
          ...(readKey ? { readNativeResumeBindingKey: readKey } : {}),
        },
      });
    // Without the recorded key the adapter cannot show the session is its.
    await expect(recover()).rejects.toThrow(/configuration home/);
    await expect(recover(() => BINDING)).resolves.toMatchObject({
      threadId: 'thread-1',
      resumeCursor: { copilotSessionId: 'earlier-session' },
    });
    expect(h.client.resumed.map((entry) => entry.id)).toEqual([
      'earlier-session',
    ]);
  });

  test('binds a resume to the runtime configuration home in COPILOT_HOME', async () => {
    const other = harness({
      env: { COPILOT_HOME: join(ROOT, 'another-home'), PATH: '/usr/bin' },
    });
    await expect(
      other.adapter.startSession({
        threadId: 'thread-1',
        provider: 'copilot-sdk',
        cwd: CWD,
        resumeCursor: { copilotSessionId: 'earlier-session' },
        nativeResumeBindingKey: BINDING,
      }),
    ).rejects.toMatchObject({ code: 'session_recovery_failed' });
    expect(other.launches).toHaveLength(0);
  });

  test('resumes the session its cursor names under the same home', async () => {
    const h = harness();
    await start(h, {
      resumeCursor: { copilotSessionId: 'earlier-session' },
      nativeResumeBindingKey: BINDING,
    });
    expect(h.client.created).toHaveLength(0);
    expect(h.client.resumed.map((entry) => entry.id)).toEqual([
      'earlier-session',
    ]);
  });

  test('refuses a resume whose cursor has no recorded binding key', async () => {
    const h = harness();
    await expect(
      start(h, { resumeCursor: { copilotSessionId: 'earlier-session' } }),
    ).rejects.toMatchObject({ code: 'session_recovery_failed' });
    expect(h.launches).toHaveLength(0);
  });

  test('refuses a session whose runtime did not apply manual approvals', async () => {
    const h = harness();
    h.client.prepare = (session) => {
      session.permissionModeResult = { success: true, mode: 'allow-all' };
    };
    await expect(
      start(h, {
        resumeCursor: { copilotSessionId: 'earlier-session' },
        nativeResumeBindingKey: BINDING,
      }),
    ).rejects.toMatchObject({
      name: 'SessionStartRefusedError',
      message: expect.stringContaining('allow-all'),
    });
    expect(h.client.stopped).toBe(1);
    expect(await h.adapter.hasSession('thread-1')).toBe(false);
    h.client.prepare = (session) => {
      session.permissionModeResult = undefined;
    };
    await expect(start(h)).rejects.toBeInstanceOf(SessionStartRefusedError);
  });

  test('a second start for the same thread while one runs launches nothing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new FakeCopilotClient();
    let launched = 0;
    const h = harness({
      clientFactory: async () => {
        launched += 1;
        await gate;
        return client;
      },
    });
    const first = h.adapter.startSession({
      threadId: 'thread-1',
      provider: 'copilot-sdk',
      cwd: CWD,
    });
    await expect(
      h.adapter.startSession({
        threadId: 'thread-1',
        provider: 'copilot-sdk',
        cwd: CWD,
      }),
    ).rejects.toMatchObject({ code: 'session_start_in_flight' });
    release();
    await first;
    expect(launched).toBe(1);
  });

  test('replays events the runtime sent while a resume was still connecting', async () => {
    const h = harness();
    h.client.duringStart = [
      {
        type: 'session.mcp_servers_loaded',
        id: 'evt-start-1',
        parentId: null,
        timestamp: at(0),
        ephemeral: true,
        data: {
          servers: [
            { name: 'github', status: 'connected' },
            { name: 'docs', status: 'needs-auth' },
          ],
        },
      },
    ];
    await start(h, {
      resumeCursor: { copilotSessionId: 'earlier-session' },
      nativeResumeBindingKey: BINDING,
    });
    await h.settle();
    expect(methods(h.events)).toEqual([
      'session.started',
      'session.configured',
      'engine-mcp.status',
    ]);
    expect(h.events[2]).toMatchObject({
      complete: true,
      servers: [
        { name: 'github', state: 'ready', scope: 'session' },
        { name: 'docs', state: 'needs-auth', scope: 'session' },
      ],
    });
  });
});

describe('Copilot SDK adapter: turns', () => {
  test.each([
    {
      toolName: 'bash',
      arguments: { command: 'ls' },
      shellToolInfo: { hasWriteFileRedirection: false, possiblePaths: [] },
      expectedKind: 'execute',
    },
    {
      toolName: 'search_code',
      arguments: { query: 'main' },
      readOnly: true,
      expectedKind: 'other',
    },
  ])(
    'streams $toolName, text and usage, and completes on session.idle',
    async ({ expectedKind, ...tool }) => {
      const h = harness();
      const { session, turnId } = await startedTurn(h, 'list the files');
      expect(session.sends).toEqual([
        { prompt: 'list the files', mode: 'enqueue', clientTurnId: turnId },
      ]);
      session.emit({
        type: 'assistant.message_delta',
        id: session.nextEventId(),
        parentId: null,
        timestamp: at(2),
        ephemeral: true,
        data: { messageId: 'm1', deltaContent: 'Looking' },
      });
      session.emit({
        type: 'tool.execution_start',
        id: session.nextEventId(),
        parentId: null,
        timestamp: at(3),
        data: {
          toolCallId: 'call-1',
          ...tool,
        },
      });
      session.emit({
        type: 'tool.execution_complete',
        id: session.nextEventId(),
        parentId: null,
        timestamp: at(4),
        data: {
          toolCallId: 'call-1',
          success: true,
          result: { content: 'a.txt\nb.txt' },
        },
      });
      session.emit({
        type: 'assistant.message',
        id: session.nextEventId(),
        parentId: null,
        timestamp: at(5),
        data: { messageId: 'm1', content: 'Looking' },
      });
      session.emit({
        type: 'assistant.usage',
        id: session.nextEventId(),
        parentId: null,
        timestamp: at(6),
        ephemeral: true,
        data: { model: 'gpt-5', inputTokens: 100, outputTokens: 20 },
      });
      session.emit(idle(session));
      await h.settle();
      const turnEvents = h.events.filter((e) => e.turnId === turnId);
      expect(methods(turnEvents)).toEqual([
        'turn.started',
        'content.text-delta',
        'tool.started',
        'tool.completed',
        'token-usage.updated',
        'turn.completed',
      ]);
      expect(turnEvents[2]).toMatchObject({
        toolName: tool.toolName,
        toolKind: expectedKind,
      });
      expect(turnEvents[3]).toMatchObject({
        toolKind: expectedKind,
        status: 'success',
        output: 'a.txt\nb.txt',
      });
    },
  );

  test('folds each model call, a subagent call included, into the turn total', async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    for (const [input, output, agentId] of [
      [100, 20, undefined],
      [40, 10, 'sub-1'],
    ] as const) {
      session.emit({
        type: 'assistant.usage',
        id: session.nextEventId(),
        parentId: null,
        timestamp: at(6),
        ephemeral: true,
        ...(agentId ? { agentId } : {}),
        data: { model: 'gpt-5', inputTokens: input, outputTokens: output },
      });
    }
    session.emit(idle(session));
    await h.settle();
    const usage = h.events.filter(
      (e) => e.turnId === turnId && e.method === 'token-usage.updated',
    );
    expect(usage).toHaveLength(2);
    const folded = foldUsageEvents(
      h.events.filter((e) => e.method === 'token-usage.updated'),
    );
    expect(folded).toMatchObject({
      inputTokens: 140,
      outputTokens: 30,
      totalTokens: 170,
    });
  });

  test("a root session.error for the turn's message ends that turn", async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    session.emit(
      sessionError(session, {
        errorType: 'authentication',
        message: 'Not signed in.',
        originatingMessageId: `m-${turnId}`,
      }),
    );
    await h.settle();
    const turnEvents = h.events.filter((e) => e.turnId === turnId);
    expect(methods(turnEvents)).toEqual([
      'turn.started',
      'runtime.error',
      'turn.aborted',
    ]);
    expect(turnEvents[1]).toMatchObject({ message: 'Not signed in.' });
  });

  test("a subagent's error neither ends the turn nor lets a later idle complete the next one", async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    session.emit(sessionError(session, {}, 'sub-1'));
    await h.settle();
    expect(h.adapter.hasOpenEngineWork('thread-1')).toBe(true);
    session.emit(idle(session));
    await h.settle();
    expect(methods(h.events.filter((e) => e.turnId === turnId))).toEqual([
      'turn.started',
      'turn.completed',
    ]);
    // A stale idle that arrives before the next turn's own message does not
    // complete the next turn.
    const next = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'again',
    });
    session.emit(idle(session));
    await h.settle();
    expect(h.adapter.hasOpenEngineWork('thread-1')).toBe(true);
    session.emit(userMessage(session, next.turnId, 'again'));
    session.emit(idle(session));
    await h.settle();
    expect(methods(h.events.filter((e) => e.turnId === next.turnId))).toEqual([
      'turn.started',
      'turn.completed',
    ]);
  });

  test("a root error for the turn's message ends it even before the echo", async () => {
    const h = harness();
    const session = await start(h);
    const turn = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'go',
    });
    // `send()` returned msg-1; no user.message has been echoed yet.
    session.emit(sessionError(session, { originatingMessageId: 'msg-1' }));
    await h.settle();
    expect(h.events.at(-1)).toMatchObject({
      method: 'turn.aborted',
      turnId: turn.turnId,
    });
  });

  test('a root error that arrives before send() returns still ends its turn', async () => {
    const h = harness();
    const session = await start(h);
    session.onSend = (messageId) =>
      session.emit(sessionError(session, { originatingMessageId: messageId }));
    const turn = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'go',
    });
    await h.settle();
    expect(h.events.at(-1)).toMatchObject({
      method: 'turn.aborted',
      turnId: turn.turnId,
    });
  });

  test('an error for another message does not end this turn', async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    session.emit(sessionError(session, { originatingMessageId: 'msg-old' }));
    await h.settle();
    expect(methods(h.events.filter((e) => e.turnId === turnId))).toEqual([
      'turn.started',
      'runtime.error',
    ]);
    expect(h.adapter.hasOpenEngineWork('thread-1')).toBe(true);
  });

  test('a prompt a policy hook blocked ends its turn and frees the session', async () => {
    const h = harness();
    const session = await start(h);
    const turn = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'go',
    });
    session.emit({
      type: 'session.warning',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(2),
      data: {
        warningType: 'policy_blocked',
        message: 'A prompt hook blocked this message.',
        originatingMessageId: 'msg-1',
      },
    } as SessionEvent);
    session.emit(idle(session));
    await h.settle();
    expect(methods(h.events.filter((e) => e.turnId === turn.turnId))).toEqual([
      'turn.started',
      'runtime.warning',
      'turn.aborted',
    ]);
    await expect(
      h.adapter.sendTurn({ threadId: 'thread-1', input: 'next' }),
    ).resolves.toMatchObject({ threadId: 'thread-1' });
  });

  test('an interrupted turn the runtime never echoed ends on its aborted idle', async () => {
    const h = harness();
    const session = await start(h);
    const turn = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'go',
    });
    const result = h.adapter.interruptTurn('thread-1', turn.turnId);
    await h.settle();
    session.emit(idle(session, true));
    await expect(result).resolves.toEqual({
      outcome: 'cancelled',
      turnId: turn.turnId,
    });
    expect(h.adapter.hasOpenEngineWork('thread-1')).toBe(false);
  });

  test("a subagent's policy block that names the root message leaves the root turn running", async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    session.emit({
      type: 'session.warning',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(2),
      agentId: 'sub-1',
      data: {
        warningType: 'policy_blocked',
        message: 'A prompt hook blocked the subagent.',
        originatingMessageId: `m-${turnId}`,
      },
    } as SessionEvent);
    await h.settle();
    expect(
      h.events.some((e) => e.method === 'turn.aborted' && e.turnId === turnId),
    ).toBe(false);
    expect(h.adapter.hasOpenEngineWork('thread-1')).toBe(true);
  });

  test('a held signal for another message does not carry into the next turn', async () => {
    const h = harness();
    const session = await start(h);
    // Before turn one's send() returns, an error names msg-2: a message this
    // turn never sends, which the next turn's send() will return.
    session.onSend = (messageId) => {
      if (messageId === 'msg-1')
        session.emit(sessionError(session, { originatingMessageId: 'msg-2' }));
    };
    const first = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'one',
    });
    session.onSend = undefined;
    session.emit(userMessage(session, first.turnId, 'one'));
    session.emit(idle(session));
    const second = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'two',
    });
    await h.settle();
    expect(
      h.events.some(
        (e) => e.method === 'turn.aborted' && e.turnId === second.turnId,
      ),
    ).toBe(false);
    expect(h.adapter.hasOpenEngineWork('thread-1')).toBe(true);
  });

  test('a recoverable root error is a warning and the turn runs on', async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    session.emit(
      sessionError(session, {
        errorType: 'rate_limit',
        message: 'Rate limited.',
        eligibleForAutoSwitch: true,
        originatingMessageId: `m-${turnId}`,
      }),
    );
    await h.settle();
    expect(methods(h.events.filter((e) => e.turnId === turnId))).toEqual([
      'turn.started',
      'runtime.warning',
    ]);
    expect(h.adapter.hasOpenEngineWork('thread-1')).toBe(true);
  });

  test('steers into the running turn and refuses a turn that ended', async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    await h.adapter.steerTurn('thread-1', ' also check tests ', turnId);
    expect(session.sends[1]).toEqual({
      prompt: 'also check tests',
      mode: 'immediate',
    });
    await h.settle();
    expect(h.events.at(-1)).toMatchObject({
      method: 'turn.started',
      turnId,
      inputKind: 'steer',
    });
    session.emit(idle(session));
    await expect(
      h.adapter.steerTurn('thread-1', 'late', turnId),
    ).rejects.toMatchObject({ name: 'ProviderTurnEndedError' });
  });

  test('an interrupt aborts and is confirmed by the aborted idle', async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    const result = h.adapter.interruptTurn('thread-1', turnId);
    await h.settle();
    expect(session.aborts).toBe(1);
    session.emit(idle(session, true));
    await expect(result).resolves.toEqual({ outcome: 'cancelled', turnId });
    await h.settle();
    expect(h.events.at(-1)).toMatchObject({ method: 'turn.aborted', turnId });
  });

  test('an interrupt the runtime never confirms reads as unconfirmed', async () => {
    const h = harness();
    const { turnId } = await startedTurn(h);
    await expect(h.adapter.interruptTurn('thread-1', turnId)).resolves.toEqual({
      outcome: 'termination-unconfirmed',
      turnId,
    });
  });
});

describe('Copilot SDK adapter: runtime death', () => {
  test('a lost runtime aborts the running turn, answers requests and ends the session', async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    const answer = session.ask(shell);
    h.client.loseConnection();
    await expect(answer).resolves.toEqual({ kind: 'user-not-available' });
    await h.settle();
    expect(methods(h.events.filter((e) => e.turnId === turnId))).toEqual([
      'turn.started',
      'request.opened',
      'request.resolved',
      'turn.aborted',
    ]);
    expect(h.events.at(-1)).toMatchObject({ method: 'session.exited' });
    expect(await h.adapter.hasSession('thread-1')).toBe(false);
    expect(h.client.stopped).toBe(1);
    await expect(h.adapter.interruptTurn('thread-1', turnId)).resolves.toEqual({
      outcome: 'no-active-turn',
    });
  });

  test('an interrupt on a dead connection ends the turn instead of hanging', async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    session.abortFails = true;
    await expect(h.adapter.interruptTurn('thread-1', turnId)).resolves.toEqual({
      outcome: 'cancelled',
      turnId,
    });
    await h.settle();
    expect(h.events.some((e) => e.method === 'turn.aborted')).toBe(true);
    expect(h.events.at(-1)).toMatchObject({ method: 'session.exited' });
  });
});

describe('Copilot SDK adapter: approvals', () => {
  test('a person allows a command: request.opened, then approve-once', async () => {
    const h = harness();
    const { session } = await startedTurn(h);
    const answer = session.ask(shell);
    await h.settle();
    expect(opened(h)[0]).toMatchObject({
      requestType: 'approval',
      title: 'Run a command',
      payload: {
        toolName: 'shell',
        toolInput: { command: 'rm -rf /', intention: 'Remove everything' },
      },
    });
    await h.adapter.respondToRequest(
      'thread-1',
      opened(h)[0]!.requestId,
      'accept',
    );
    await expect(answer).resolves.toEqual({ kind: 'approve-once' });
    await h.settle();
    expect(h.events.at(-1)).toMatchObject({
      method: 'request.resolved',
      status: 'approved',
      acknowledgement: 'in-process',
    });
  });

  test('a person declines: the runtime is told reject', async () => {
    const h = harness();
    const { session } = await startedTurn(h);
    const answer = session.ask(shell);
    await h.settle();
    await h.adapter.respondToRequest(
      'thread-1',
      opened(h)[0]!.requestId,
      'decline',
    );
    await expect(answer).resolves.toEqual({ kind: 'reject' });
  });

  test('allow-for-session covers the same command without asking again', async () => {
    const h = harness();
    const { session } = await startedTurn(h);
    const first = session.ask(shell);
    await h.settle();
    await h.adapter.respondToRequest(
      'thread-1',
      opened(h)[0]!.requestId,
      'acceptForSession',
    );
    await expect(first).resolves.toEqual({ kind: 'approve-once' });
    await expect(session.ask(shell)).resolves.toEqual({ kind: 'approve-once' });
    // A different command is not covered by that grant.
    void session.ask({ ...shell, fullCommandText: 'git push' });
    await h.settle();
    expect(opened(h)).toHaveLength(2);
  });

  test('ask mode allows a resolved read inside the directory and asks for a write there', async () => {
    const h = harness();
    const session = await start(h);
    await expect(
      session.ask(read('src/a.ts', join(CWD, 'src', 'a.ts'))),
    ).resolves.toEqual({ kind: 'approve-once' });
    void session.ask(write('src/a.ts', join(CWD, 'src', 'a.ts')));
    await h.settle();
    expect(opened(h)).toHaveLength(1);
  });

  test('a read or write through a link that leads outside asks a person', async () => {
    const h = harness();
    const session = await start(h, {
      modelOptions: { approvalMode: 'auto' },
    });
    // The runtime's own path for the file, not yet resolved through the link.
    void session.ask(read('link/secret', join(CWD, 'link', 'secret')));
    void session.ask(write('link/evil.ts', join(CWD, 'link', 'evil.ts')));
    await h.settle();
    expect(opened(h)).toHaveLength(2);
  });

  test('a read or write without the runtime-resolved path asks a person', async () => {
    const h = harness();
    const session = await start(h, {
      modelOptions: { approvalMode: 'auto' },
    });
    void session.ask(read('src/a.ts'));
    void session.ask(write('src/a.ts', undefined));
    await h.settle();
    expect(opened(h)).toHaveLength(2);
  });

  test('a write through `..` after a link asks where the kernel would land', async () => {
    const h = harness();
    const session = await start(h, {
      modelOptions: { approvalMode: 'auto' },
    });
    void session.ask(write('up/../x.txt', `${CWD}${sep}up${sep}..${sep}x.txt`));
    await h.settle();
    expect(opened(h)).toHaveLength(1);
  });

  test.skipIf(!RELATIVE_LINKS)(
    'a write through a link chain whose dangling target escapes asks a person',
    async () => {
      const h = harness();
      const session = await start(h, {
        modelOptions: { approvalMode: 'auto' },
      });
      void session.ask(write('p/q/l/d', `${CWD}${sep}p${sep}q${sep}l${sep}d`));
      await h.settle();
      expect(opened(h)).toHaveLength(1);
    },
  );

  test('a write through `..` that stays inside the directory is allowed in auto', async () => {
    const h = harness();
    const session = await start(h, {
      modelOptions: { approvalMode: 'auto' },
    });
    await expect(
      session.ask(
        write('src/../new.txt', `${CWD}${sep}src${sep}..${sep}new.txt`),
      ),
    ).resolves.toEqual({ kind: 'approve-once' });
    await h.settle();
    expect(opened(h)).toHaveLength(0);
  });

  test('with an unresolvable working directory every read and write asks', () => {
    const scope = { realCwd: undefined, grants: new Set(['write']) };
    const inside = join(CWD, 'src', 'a.ts');
    expect(
      copilotModeAllows('auto', read('src/a.ts', inside), scope, false),
    ).toBe(false);
    expect(
      copilotModeAllows('auto', write('src/a.ts', inside), scope, false),
    ).toBe(false);
    // Full access in a host session still allows: it never compares paths.
    expect(
      copilotModeAllows('never', write('src/a.ts', inside), scope, false),
    ).toBe(true);
  });

  test('a write whose edits reach outside the directory asks a person', async () => {
    const h = harness();
    const session = await start(h, {
      modelOptions: { approvalMode: 'auto' },
    });
    await expect(
      session.ask(
        write('src/a.ts', join(CWD, 'src', 'a.ts'), [join(CWD, 'src', 'b.ts')]),
      ),
    ).resolves.toEqual({ kind: 'approve-once' });
    void session.ask(
      write('src/a.ts', join(CWD, 'src', 'a.ts'), [join(OUTSIDE, 'c.ts')]),
    );
    await h.settle();
    expect(opened(h)).toHaveLength(1);
  });

  test('a write granted for the session stays inside the working directory', async () => {
    const h = harness();
    const session = await start(h);
    const first = session.ask(write('src/a.ts', join(CWD, 'src', 'a.ts')));
    await h.settle();
    await h.adapter.respondToRequest(
      'thread-1',
      opened(h)[0]!.requestId,
      'acceptForSession',
    );
    await expect(first).resolves.toEqual({ kind: 'approve-once' });
    await expect(
      session.ask(write('src/b.ts', join(CWD, 'src', 'b.ts'))),
    ).resolves.toEqual({ kind: 'approve-once' });
    void session.ask(write('../outside/x.ts', join(OUTSIDE, 'x.ts')));
    await h.settle();
    expect(opened(h)).toHaveLength(2);
  });

  test('a read granted for the session covers that exact directory only', async () => {
    const h = harness();
    const session = await start(h);
    const first = session.ask(read('secret', join(OUTSIDE, 'secret')));
    await h.settle();
    await h.adapter.respondToRequest(
      'thread-1',
      opened(h)[0]!.requestId,
      'acceptForSession',
    );
    await expect(first).resolves.toEqual({ kind: 'approve-once' });
    await expect(
      session.ask(read('other', join(OUTSIDE, 'other'))),
    ).resolves.toEqual({ kind: 'approve-once' });
    // Not the directory's parent, a subdirectory, or a sibling that merely
    // shares its name as a prefix.
    void session.ask(read('elsewhere', join(ROOT, 'elsewhere')));
    void session.ask(read('deeper', join(OUTSIDE, 'sub', 'deeper')));
    void session.ask(read('prefix', join(`${OUTSIDE}-sibling`, 'file')));
    await h.settle();
    expect(opened(h)).toHaveLength(4);
  });

  test('a write through a dangling link that points outside asks a person', async () => {
    const h = harness();
    const session = await start(h, {
      modelOptions: { approvalMode: 'auto' },
    });
    // Both the link itself and a path below it resolve to where it points.
    void session.ask(write('dangling', join(CWD, 'dangling')));
    void session.ask(
      write('dangling/evil.ts', join(CWD, 'dangling', 'evil.ts')),
    );
    await h.settle();
    expect(opened(h)).toHaveLength(2);
  });

  test('a managed request goes to a person in every mode and never records a grant', async () => {
    const h = harness();
    const session = await start(h, {
      modelOptions: { approvalMode: 'never' },
      confinement: 'host',
    });
    const managedShell = { ...shell, managedApprovalRequired: true };
    const first = session.ask(managedShell);
    await h.settle();
    expect(opened(h)[0]!.payload).toMatchObject({
      managedApprovalRequired: true,
    });
    await h.adapter.respondToRequest(
      'thread-1',
      opened(h)[0]!.requestId,
      'acceptForSession',
    );
    await expect(first).resolves.toEqual({ kind: 'approve-once' });
    void session.ask(managedShell);
    // The derived prompt's marker counts too, for an otherwise-allowed read.
    void session.ask(read('src/a.ts', join(CWD, 'src', 'a.ts')), {
      promptRequest: { kind: 'read', managedApprovalRequired: true },
    });
    await h.settle();
    expect(opened(h)).toHaveLength(3);
  });

  test('stopping the session answers its open requests', async () => {
    const h = harness();
    const { session } = await startedTurn(h);
    const answer = session.ask(shell);
    await h.adapter.stopSession('thread-1');
    await expect(answer).resolves.toEqual({ kind: 'user-not-available' });
    expect(session.disconnected).toBe(true);
    expect(h.client.stopped).toBe(1);
  });
});

describe('Copilot SDK adapter: approval mode per turn', () => {
  test('a turn that revokes full access asks before the next command', async () => {
    const h = harness();
    const session = await start(h, {
      modelOptions: { approvalMode: 'never' },
      confinement: 'host',
    });
    // Orchestration sends the standing confinement on every turn.
    const first = await sendAndEcho(h, session, 'one', {
      confinement: 'host',
    });
    await expect(session.ask(shell)).resolves.toEqual({
      kind: 'approve-once',
    });
    session.emit(idle(session));
    // The orchestrator's revocation: the next turn runs as Ask, confined.
    const second = await sendAndEcho(h, session, 'two', {
      modelOptions: { approvalMode: 'ask' },
      confinement: 'workspace',
    });
    void session.ask(shell);
    await h.settle();
    expect(opened(h)).toHaveLength(1);
    const started = (turnId: string) =>
      h.events.find(
        (e) => e.method === 'turn.started' && e.turnId === turnId,
      ) as { metadata?: Record<string, unknown> };
    expect(started(first).metadata).toEqual({ approvalMode: 'never' });
    expect(started(second).metadata).toEqual({ approvalMode: 'ask' });
  });

  test('losing host confinement alone withdraws full access', async () => {
    const h = harness();
    const session = await start(h, {
      modelOptions: { approvalMode: 'never' },
      confinement: 'host',
    });
    await sendAndEcho(h, session, 'one', { confinement: 'workspace' });
    void session.ask(shell);
    await h.settle();
    expect(opened(h)).toHaveLength(1);
  });

  test('a stricter turn drops the session grants; a looser one keeps them', async () => {
    const h = harness();
    const session = await start(h);
    const grant = async (index: number) => {
      const answer = session.ask(shell);
      await h.settle();
      await h.adapter.respondToRequest(
        'thread-1',
        opened(h)[index]!.requestId,
        'acceptForSession',
      );
      await answer;
    };
    // Ask → Auto is looser: the grant made under Ask still applies.
    await grant(0);
    await sendAndEcho(h, session, 'one', {
      modelOptions: { approvalMode: 'auto' },
      confinement: 'workspace',
    });
    await expect(session.ask(shell)).resolves.toEqual({
      kind: 'approve-once',
    });
    session.emit(idle(session));
    // Auto → Ask is stricter: the same command asks again.
    await sendAndEcho(h, session, 'two', {
      modelOptions: { approvalMode: 'ask' },
      confinement: 'workspace',
    });
    void session.ask(shell);
    await h.settle();
    expect(opened(h)).toHaveLength(2);
  });

  test('a turn that grants full access in a host session stops asking', async () => {
    const h = harness();
    const session = await start(h);
    await sendAndEcho(h, session, 'one', {
      modelOptions: { approvalMode: 'never' },
      confinement: 'host',
    });
    await expect(session.ask(shell)).resolves.toEqual({
      kind: 'approve-once',
    });
    await h.settle();
    expect(opened(h)).toHaveLength(0);
  });
});

describe('Copilot SDK adapter: subagents', () => {
  test('a subagent is child work from started to completed, with its reply as the result', async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    session.emit({
      type: 'subagent.started',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(2),
      data: {
        toolCallId: 'task-1',
        agentName: 'explore',
        agentDisplayName: 'Explore',
        agentDescription: 'Find the tests',
      },
    });
    session.emit({
      type: 'subagent.completed',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(5),
      data: {
        toolCallId: 'task-1',
        agentName: 'explore',
        agentDisplayName: 'Explore',
        totalTokens: 900,
        totalToolCalls: 4,
        durationMs: 3000,
      },
    });
    // The subagent's task tool returns its reply to the parent.
    session.emit({
      type: 'tool.execution_complete',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(6),
      data: {
        toolCallId: 'task-1',
        success: true,
        result: { content: 'The tests are in src/__tests__.' },
      },
    });
    await h.settle();
    const deltas = h.events
      .filter((e) => e.method === 'child-work.updated')
      .map((e) => (e as { delta: Record<string, unknown> }).delta);
    expect(deltas).toEqual([
      expect.objectContaining({
        kind: 'snapshot',
        producer: 'engine-subagent',
        reporterThreadId: 'thread-1',
        running: [
          expect.objectContaining({
            childId: 'task-1',
            status: 'running',
            title: 'Find the tests',
            parent: expect.objectContaining({ turnId, toolCallId: 'task-1' }),
          }),
        ],
      }),
      expect.objectContaining({
        kind: 'settle',
        childId: 'task-1',
        status: 'completed',
        usage: { totalTokens: 900, toolUses: 4, durationMs: 3000 },
      }),
      expect.objectContaining({
        kind: 'settle',
        childId: 'task-1',
        status: 'completed',
        result: {
          summary: 'The tests are in src/__tests__.',
          source: 'tool-return',
        },
      }),
    ]);
    // Nothing computed a nesting depth, so none is claimed.
    expect(JSON.stringify(deltas)).not.toContain('depth');
  });

  test('a subagent still open when its turn ends is settled unresolved', async () => {
    const h = harness();
    const { session } = await startedTurn(h);
    session.emit({
      type: 'subagent.started',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(2),
      data: {
        toolCallId: 'task-2',
        agentName: 'task',
        agentDisplayName: 'Task',
        agentDescription: 'Background work',
      },
    });
    expect(h.adapter.hasOpenEngineWork('thread-1')).toBe(true);
    session.emit(idle(session));
    await h.settle();
    const settle = h.events.find(
      (e) =>
        e.method === 'child-work.updated' &&
        (e as { delta: { kind: string } }).delta.kind === 'settle',
    );
    expect(settle).toMatchObject({
      delta: { childId: 'task-2', status: 'unresolved' },
    });
    expect(h.adapter.hasOpenEngineWork('thread-1')).toBe(false);
  });

  test('subagent text and tool calls stay out of the parent transcript', async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    session.emit({
      type: 'tool.execution_start',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(3),
      data: {
        toolCallId: 'inner',
        toolName: 'view',
        parentToolCallId: 'task-1',
      },
    });
    session.emit({
      type: 'assistant.message',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(4),
      agentId: 'sub-1',
      data: { messageId: 'inner-m', content: 'child says hi' },
    });
    await h.settle();
    expect(methods(h.events.filter((e) => e.turnId === turnId))).toEqual([
      'turn.started',
    ]);
  });
});

describe('Copilot SDK adapter: rewind', () => {
  async function twoTurns(h: Harness) {
    const { session, turnId: first } = await startedTurn(h, 'one');
    session.emit(idle(session));
    const second = await sendAndEcho(h, session, 'two');
    session.emit(idle(session));
    return { session, first, second };
  }

  test('rewinds to before a turn at its user.message event and restores files', async () => {
    const h = harness();
    const { session, first, second } = await twoTurns(h);
    session.rewindResult = {
      outcome: 'success',
      eventsRemoved: 6,
      restoredFiles: [join(CWD, 'src', 'a.ts')],
      skippedFiles: [],
    };
    const outcome = await h.adapter.rewindSession('thread-1', first);
    // The user.message event of the first turn was the first event emitted.
    expect(session.rewinds).toEqual([
      { eventId: 'evt-1', mode: 'conversation-and-files' },
    ]);
    expect(outcome).toEqual({
      kind: 'rewound',
      beforeTurnId: first,
      hiddenTurnIds: [first, second],
      affectedFiles: { count: 1, paths: [join(CWD, 'src', 'a.ts')] },
    });
    await h.settle();
    expect(h.events.at(-1)).toMatchObject({
      method: 'runtime.warning',
      code: 'acp.session-rewound',
      details: { beforeTurnId: first, hiddenTurnIds: [first, second] },
    });
    // A hidden turn is no longer a rewind point.
    await expect(h.adapter.rewindSession('thread-1', second)).resolves.toEqual({
      kind: 'refused',
      reason: 'unknown-turn',
    });
  });

  test('refuses while a turn runs, and names files restored before a failure', async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    await expect(h.adapter.rewindSession('thread-1', turnId)).resolves.toEqual({
      kind: 'refused',
      reason: 'turn-running',
    });
    expect(session.rewinds).toHaveLength(0);
    session.emit(idle(session));
    session.rewindResult = {
      outcome: 'truncation-failed',
      restoredFiles: [join(CWD, 'src', 'a.ts')],
      skippedFiles: [],
      error: 'disk full',
    };
    await expect(h.adapter.rewindSession('thread-1', turnId)).resolves.toEqual({
      kind: 'failed',
      message: `Copilot could not rewind (truncation-failed): disk full. It had already restored 1 file(s): ${join(CWD, 'src', 'a.ts')}.`,
    });
  });

  test('a resumed session can rewind to a turn from before the resume', async () => {
    const h = harness();
    h.client.prepare = (session) => {
      session.persisted = [
        {
          type: 'user.message',
          id: 'persisted-evt',
          parentId: null,
          timestamp: at(1),
          data: { content: 'earlier', clientTurnId: 'earlier-turn' },
        },
      ];
    };
    const session = await start(h, {
      resumeCursor: { copilotSessionId: 'earlier-session' },
      nativeResumeBindingKey: BINDING,
    });
    await expect(
      h.adapter.rewindSession('thread-1', 'earlier-turn'),
    ).resolves.toMatchObject({ kind: 'rewound', beforeTurnId: 'earlier-turn' });
    expect(session.rewinds).toEqual([
      { eventId: 'persisted-evt', mode: 'conversation-and-files' },
    ]);
  });
});

describe('Copilot SDK approvals: real-path resolution', () => {
  const failure = (code: string) =>
    Object.assign(new Error(code), { code }) as NodeJS.ErrnoException;
  // A fake filesystem root, so these cases run alike on every platform.
  const FAKE = resolve('/copilot-fake-fs');
  const at_ = (...parts: string[]) => join(FAKE, ...parts);

  /**
   * Directories and files that exist, symlinks (some dangling) and errors to
   * raise. `realpath` succeeds only for an existing path with no symlink in
   * it, which is how the walk has to discover each link itself.
   */
  function fakeFs(spec: {
    exist: string[];
    links?: Record<string, string>;
    errors?: Record<string, string>;
  }): CopilotRealPathFs {
    const exist = new Set<string>();
    for (const path of spec.exist) {
      let current = path;
      while (!exist.has(current)) {
        exist.add(current);
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }
    const links = spec.links ?? {};
    const errors = spec.errors ?? {};
    return {
      realpath: (path) => {
        if (errors[path]) throw failure(errors[path]);
        if (exist.has(path)) return path;
        throw failure('ENOENT');
      },
      // Errors are realpath's alone: lstat answers "absent", so treating a
      // realpath error as absence would resolve the name.
      lstat: (path) => {
        if (path in links) return { isSymbolicLink: () => true };
        if (exist.has(path)) return { isSymbolicLink: () => false };
        throw failure('ENOENT');
      },
      readlink: (path) => links[path]!,
    };
  }

  test("a dangling link's relative target is read from the link's real directory", () => {
    // repo/p/q/l -> repo/s, and repo/s/d -> ../../escaped.txt (dangling): the
    // kernel reads d's target from repo/s, so a write lands beside repo.
    const fs = fakeFs({
      exist: [at_('repo', 'p', 'q'), at_('repo', 's')],
      links: {
        [at_('repo', 'p', 'q', 'l')]: at_('repo', 's'),
        [at_('repo', 's', 'd')]: `..${sep}..${sep}escaped.txt`,
      },
    });
    expect(
      copilotRealPath(at_('repo', 'p', 'q', 'l', 'd'), at_('repo'), fs),
    ).toBe(at_('escaped.txt'));
  });

  test('`..` leaves the real directory, not the lexical one', () => {
    // repo/up -> <root>/a/b: repo/up/../x.txt is <root>/a/x.txt.
    const fs = fakeFs({
      exist: [at_('repo'), at_('a', 'b')],
      links: { [at_('repo', 'up')]: at_('a', 'b') },
    });
    expect(
      copilotRealPath(
        `${at_('repo')}${sep}up${sep}..${sep}x.txt`,
        at_('repo'),
        fs,
      ),
    ).toBe(at_('a', 'x.txt'));
  });

  test('a name not created yet is kept as named under its real parent', () => {
    const fs = fakeFs({ exist: [at_('repo', 'src')] });
    expect(copilotRealPath(`src${sep}new.ts`, at_('repo'), fs)).toBe(
      at_('repo', 'src', 'new.ts'),
    );
  });

  test('a path that cannot be resolved for any reason but absence is unresolvable', () => {
    // Only the target is unreadable; its parent resolves. Read as "absent",
    // the error would let the target resolve through that parent.
    expect(
      copilotRealPath(
        'x',
        at_('repo'),
        fakeFs({
          exist: [at_('repo')],
          errors: { [at_('repo', 'x')]: 'EACCES' },
        }),
      ),
    ).toBeUndefined();
  });

  test('a chain of links longer than the bound is unresolvable', () => {
    const links: Record<string, string> = {};
    for (let hop = 0; hop < 40; hop += 1)
      links[at_('repo', `link-${hop}`)] = `link-${hop + 1}`;
    expect(
      copilotRealPath(
        'link-0',
        at_('repo'),
        fakeFs({ exist: [at_('repo')], links }),
      ),
    ).toBeUndefined();
  });
});

describe('Copilot SDK port: connection watch', () => {
  test('reports a lost runtime once: a failed ping, or one that never answers', async () => {
    vi.useFakeTimers();
    try {
      const pings: Array<'ok' | 'fail' | 'hang'> = ['ok', 'fail'];
      const fakeClient = {
        ping: () => {
          const next = pings.shift() ?? 'hang';
          if (next === 'ok')
            return Promise.resolve({ message: '', timestamp: '' });
          if (next === 'fail')
            return Promise.reject(new Error('Connection is closed.'));
          return new Promise<never>(() => undefined);
        },
      };
      const failed = vi.fn();
      const port = copilotSdkClientPort(fakeClient as never);
      port.watchConnection(failed);
      await vi.advanceTimersByTimeAsync(COPILOT_CONNECTION_CHECK_MS);
      expect(failed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(COPILOT_CONNECTION_CHECK_MS);
      expect(failed).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(COPILOT_CONNECTION_CHECK_MS * 3);
      expect(failed).toHaveBeenCalledTimes(1);

      // A runtime that never answers is lost after the ping timeout.
      const hung = vi.fn();
      const hungPort = copilotSdkClientPort({
        ping: () => new Promise<never>(() => undefined),
      } as never);
      hungPort.watchConnection(hung);
      await vi.advanceTimersByTimeAsync(COPILOT_CONNECTION_CHECK_MS);
      expect(hung).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(COPILOT_PING_TIMEOUT_MS);
      expect(hung).toHaveBeenCalledTimes(1);

      // A stopped watch reports nothing.
      const quiet = vi.fn();
      const stop = copilotSdkClientPort({
        ping: () => Promise.reject(new Error('gone')),
      } as never).watchConnection(quiet);
      stop();
      await vi.advanceTimersByTimeAsync(COPILOT_CONNECTION_CHECK_MS * 2);
      expect(quiet).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Copilot SDK port: stopping the watch', () => {
  test('stopping during an unanswered ping clears its deadline', async () => {
    vi.useFakeTimers();
    try {
      const lost = vi.fn();
      const stop = copilotSdkClientPort({
        ping: () => new Promise<never>(() => undefined),
      } as never).watchConnection(lost);
      await vi.advanceTimersByTimeAsync(COPILOT_CONNECTION_CHECK_MS);
      // The interval and the in-flight ping's deadline.
      expect(vi.getTimerCount()).toBe(2);
      stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(COPILOT_PING_TIMEOUT_MS);
      expect(lost).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Copilot SDK adapter: which CLI file the SDK is given', () => {
  test('maps an npm .cmd shim to the package loader beside it, or to nothing', () => {
    const prefix = makeFixtureDir('copilot-cli-shim-');
    {
      const shimFile = join(prefix, 'copilot.cmd');
      writeFileSync(shimFile, '@echo off\r\n');
      // No package beside the shim: nothing the SDK could spawn.
      expect(resolveCopilotCliLaunchPath(shimFile)).toBeNull();
      const pkg = join(prefix, 'node_modules', '@github', 'copilot');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'npm-loader.js'), '');
      expect(resolveCopilotCliLaunchPath(shimFile)).toBe(
        join(pkg, 'npm-loader.js'),
      );
      // An executable is handed over as found.
      const exe = join(prefix, 'copilot.exe');
      expect(resolveCopilotCliLaunchPath(exe)).toBe(exe);
    }
  });
});

describe('Copilot SDK adapter: MCP status and reroutes', () => {
  test('restarts one MCP server on request', async () => {
    const h = harness();
    const { session } = await startedTurn(h);
    await expect(
      h.adapter.reconnectMcpServer('thread-1', 'github', { startOAuth: false }),
    ).resolves.toEqual({ kind: 'answered', success: true });
    expect(session.restarted).toEqual(['github']);
  });

  test('an automatic model change is a reroute; a person’s is not', async () => {
    const h = harness();
    const { session } = await startedTurn(h);
    for (const source of ['automatic', 'model_picker'] as const) {
      session.emit({
        type: 'session.model_change',
        id: session.nextEventId(),
        parentId: null,
        timestamp: at(3),
        data: {
          previousModel: 'gpt-5',
          newModel: 'gpt-5-mini',
          source,
          cause: 'rate limit',
        },
      });
    }
    await h.settle();
    const reroutes = h.events.filter((e) => e.method === 'model.rerouted');
    expect(reroutes).toEqual([
      expect.objectContaining({
        fromModel: 'gpt-5',
        toModel: 'gpt-5-mini',
        trigger: 'availability',
        scope: 'session',
      }),
    ]);
  });
});

// Kept beside the runtime test below: the registration array is plain data,
// so an omission is silent except here.
describe('Copilot SDK adapter: registration', () => {
  test('the runtime registers the adapter', () => {
    const initialize = readFileSync(
      new URL('../../runtime/bootstrap/runtime-initialize.ts', import.meta.url),
      'utf8',
    );
    const registration = initialize.match(
      /registerProviderAdapters\(\s*\[([\s\S]*?)\]/,
    );
    expect(registration).not.toBeNull();
    expect(registration![1].split(',').map((entry) => entry.trim())).toContain(
      'copilotSdkAdapter',
    );
  });
});
