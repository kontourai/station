import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  Client,
  ContentBlock,
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  StopReason,
} from '@agentclientprotocol/sdk';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import {
  ACP_MODEL_OVERRIDE_PER_TURN,
  ENGINE_CAPABILITY_MATRICES,
  engineControlPlaneCapability,
} from '@kontourai/station-contracts/engine-capability-matrix';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import type { SessionLifecycleState } from '../../../packages/contracts/src/session-lifecycle.js';
import { createStagedPreToolPolicyEvaluator } from '../../runtime/agents/pre-tool-policy.js';
import {
  builtinStationControlServerPath,
  builtinStationDocsServerPath,
} from '../../runtime/bootstrap/station-control-runtime-env.js';
import { isAutoApprovedExternalTool } from '../../runtime/tools/tool-executor.js';

// The genuine built-in station-control server as it appears in a resolved
// agent's toolServers — required for `station-control_*` auto-approval to be
// honored (the reserved-name identity guard rejects a same-id impostor).
const GENUINE_STATION_CONTROL_TOOLSERVER = {
  id: 'station-control',
  command: 'node',
  args: [builtinStationControlServerPath()],
};

import { validateSessionLifecycleTransition } from '../../../packages/contracts/src/session-lifecycle.js';
import {
  ACPProcess,
  type ACPProcessOptions,
} from '../../services/acp/acp-process.js';
import { normalizeCanonicalRuntimeEventLifecycle } from '../../services/orchestration/session-lifecycle-service.js';
import type { CanonicalRuntimeEvent } from '../adapter-shape.js';
import {
  AcpAdapter,
  type AcpAdapterOptions,
  acpConnectionFingerprint,
  acpExecutionIdentity,
} from '../adapters/acp-adapter.js';
import { expectCanonicalSessionLifecycle } from './adapter-contract-test-utils.js';

const managedWorkspaceHome = mkdtempSync(
  join(tmpdir(), 'station-acp-adapter-test-'),
);
afterAll(() => rmSync(managedWorkspaceHome, { recursive: true, force: true }));

/**
 * Stub ACPProcess substrate (injected via AcpAdapterOptions.processFactory —
 * the same constructor-level testing seam codex-adapter.test.ts uses). No
 * real process is spawned; `createClient` is invoked synchronously during
 * `start()` exactly as the real ACPProcess does, handing the test the live
 * `Client` object the adapter built (fs/terminal/ext handlers plus the
 * adapter's own canonical `requestPermission` override).
 */
class FakeAcpProcess {
  client!: Client;
  /**
   * station#1684: OPTIONAL, and mutable. The adapter's station-control gate
   * distinguishes "the engine answered no" from "there was no initialize
   * result to read", so the fake has to be able to represent the second —
   * `initResult` used to be a non-optional readonly field, which made that
   * case untestable and therefore unwritten.
   */
  initResult:
    | {
        protocolVersion: number;
        agentCapabilities: {
          promptCapabilities: { image: boolean };
          loadSession?: boolean;
          mcpCapabilities?: { http?: boolean; sse?: boolean };
        };
      }
    | undefined = {
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: { image: true } },
  };
  destroyed = false;
  destroyCalls = 0;
  cancelCalls = 0;
  cancelPromise?: Promise<void>;
  startError?: Error;
  destroyError?: Error;
  destroyPromise?: Promise<void>;
  private readonly pendingPrompts: Array<{
    resolve: (response: PromptResponse) => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(readonly opts: ACPProcessOptions) {}

  async start() {
    if (this.startError) throw this.startError;
    this.client = this.opts.createClient(undefined as any);
    return this.initResult;
  }

  newSessionMcpServers: unknown[] | undefined;
  /** station#1684: proves the fail-closed path does NOT retry session/new. */
  newSessionCalls = 0;
  /** station#1182: overridable per-test to simulate an agent's own reported model config option. */
  newSessionConfigOptions: unknown[] = [];

  /**
   * station#1684: makes `session/new` REJECT, so the no-retry claim has
   * something to be true of. Without it `newSessionCalls === 1` only ever
   * observed the success path, and a `.catch(...)` retry was invisible.
   */
  newSessionError?: unknown;

  async newSession(_cwd: string, mcpServers?: unknown[]) {
    this.newSessionCalls += 1;
    this.newSessionMcpServers = mcpServers;
    if (this.newSessionError) throw this.newSessionError;
    return {
      sessionId: `native-${this.opts.command}`,
      modes: { availableModes: [], currentModeId: 'default' },
      configOptions: this.newSessionConfigOptions,
    };
  }

  loadSessionArgs?: { sessionId: string; cwd: string; mcpServers?: unknown[] };
  loadSessionCalls = 0;
  loadSessionPromise?: Promise<void>;
  /** station#1684 delta review (LOW-2): the resume branch needs the same
   * no-retry proof `newSessionError` gives `session/new`. */
  loadSessionError?: unknown;

  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers?: unknown[],
  ): Promise<void> {
    this.loadSessionCalls += 1;
    this.loadSessionArgs = { sessionId, cwd, mcpServers };
    if (this.loadSessionError) throw this.loadSessionError;
    await this.loadSessionPromise;
  }

  readonly setConfigOptionCalls: Array<{ configId: string; value: string }> =
    [];
  setConfigOptionResponse?: unknown;
  setConfigOptionError?: unknown;

  async setConfigOption(configId: string, value: string): Promise<unknown> {
    this.setConfigOptionCalls.push({ configId, value });
    if (this.setConfigOptionError) throw this.setConfigOptionError;
    if (this.setConfigOptionResponse !== undefined) {
      return this.setConfigOptionResponse;
    }
    return {
      configOptions: this.newSessionConfigOptions.map((option) =>
        option &&
        typeof option === 'object' &&
        (option as { id?: unknown }).id === configId
          ? { ...option, currentValue: value }
          : option,
      ),
    };
  }

  readonly promptContents: ContentBlock[][] = [];

  prompt(content: ContentBlock[]): Promise<PromptResponse> {
    this.promptContents.push(content);
    return new Promise((resolve, reject) => {
      this.pendingPrompts.push({ resolve, reject });
    });
  }

  resolvePrompt(stopReason: StopReason): void {
    this.pendingPrompts.shift()?.resolve({ stopReason });
  }

  rejectPrompt(error: unknown): void {
    this.pendingPrompts.shift()?.reject(error);
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
    await this.cancelPromise;
  }

  async destroy(): Promise<void> {
    this.destroyCalls += 1;
    if (this.destroyError) throw this.destroyError;
    await this.destroyPromise;
    this.destroyed = true;
  }
}

function createConnections(
  overrides: Partial<ACPConnectionConfig>[] = [],
): ACPConnectionConfig[] {
  const base: ACPConnectionConfig[] = [
    { id: 'kiro', name: 'Kiro', command: 'kiro-cli', args: [], enabled: true },
    {
      id: 'other',
      name: 'Other',
      command: 'other-cli',
      args: [],
      enabled: true,
    },
  ];
  for (const override of overrides) {
    const idx = base.findIndex((conn) => conn.id === override.id);
    if (idx >= 0) base[idx] = { ...base[idx], ...override };
  }
  return base;
}

function createAdapter(
  options: {
    imageCapability?: boolean;
    loadSessionCapability?: boolean;
    connectionOverrides?: Partial<ACPConnectionConfig>[];
    resolveToolServer?: (id: string) => Promise<any>;
    logger?: any;
    /** station#1182: `newSession`'s response configOptions, injected at process-construction time. */
    newSessionConfigOptions?: unknown[];
    /** station#1684: what the connected CLI advertises at `initialize`.
     * `undefined` leaves `mcpCapabilities` off the handshake entirely — the
     * ordinary shape for a CLI that does not support HTTP MCP. */
    mcpHttpCapability?: boolean;
    /** station#1684: no `initialize` result at all — a different fact from
     * an engine that answered no, and it must produce a different receipt. */
    noInitResult?: boolean;
    mintStationControlMcpAuth?: AcpAdapterOptions['mintStationControlMcpAuth'];
    revokeStationControlMcpAuth?: AcpAdapterOptions['revokeStationControlMcpAuth'];
    managedWorkspaceHomeDir?: string;
    /** station#1684: reject `session/new` with this, to prove no retry. */
    newSessionError?: unknown;
    /** station#1684 delta review (LOW-2): same, for the resume branch. */
    loadSessionError?: unknown;
    onProcess?: (process: FakeAcpProcess, index: number) => void;
    resolvePreToolPolicy?: AcpAdapterOptions['resolvePreToolPolicy'];
  } = {},
): {
  adapter: AcpAdapter;
  processes: FakeAcpProcess[];
} {
  const processes: FakeAcpProcess[] = [];
  const adapter = new AcpAdapter({
    getConnections: async () =>
      createConnections(options.connectionOverrides ?? []),
    logger: options.logger ?? {
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
    resolveToolServer: options.resolveToolServer,
    mintStationControlMcpAuth: options.mintStationControlMcpAuth,
    revokeStationControlMcpAuth: options.revokeStationControlMcpAuth,
    resolvePreToolPolicy: options.resolvePreToolPolicy,
    managedWorkspaceHomeDir:
      options.managedWorkspaceHomeDir ?? managedWorkspaceHome,
    processFactory: (opts) => {
      const proc = new FakeAcpProcess(opts);
      if (options.noInitResult) {
        proc.initResult = undefined;
      } else {
        const capabilities = proc.initResult!.agentCapabilities;
        capabilities.promptCapabilities.image = options.imageCapability ?? true;
        capabilities.loadSession = options.loadSessionCapability;
        if (options.mcpHttpCapability !== undefined) {
          capabilities.mcpCapabilities = { http: options.mcpHttpCapability };
        }
      }
      if (options.newSessionConfigOptions) {
        proc.newSessionConfigOptions = options.newSessionConfigOptions;
      }
      if (options.newSessionError !== undefined) {
        proc.newSessionError = options.newSessionError;
      }
      if (options.loadSessionError !== undefined) {
        proc.loadSessionError = options.loadSessionError;
      }
      processes.push(proc);
      options.onProcess?.(proc, processes.length - 1);
      return proc as unknown as ACPProcess;
    },
  });
  return { adapter, processes };
}

const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Reject always', kind: 'reject_always' },
];

async function nextEvent(
  iterator: AsyncIterator<CanonicalRuntimeEvent>,
  label: string,
): Promise<CanonicalRuntimeEvent> {
  const result = await Promise.race([
    iterator.next(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out waiting for ${label}`)),
        750,
      ),
    ),
  ]);
  if (result.done || !result.value) {
    throw new Error(`Iterator closed while waiting for ${label}`);
  }
  return result.value;
}

async function requestPermission(
  client: Client,
  toolCallId: string,
  toolName?: string,
): Promise<RequestPermissionResponse> {
  const params: RequestPermissionRequest = {
    sessionId: 'ignored-by-adapter',
    toolCall: {
      toolCallId,
      title: 'Write file',
      rawInput: { path: 'a.txt' },
      ...(toolName ? { name: toolName } : {}),
    },
    options: PERMISSION_OPTIONS,
  };
  return client.requestPermission(params);
}

/** Rejects after `ms` instead of hanging, for asserting an event never arrives. */
function nextEventOrTimeout(
  iterator: AsyncIterator<CanonicalRuntimeEvent>,
  ms: number,
): Promise<CanonicalRuntimeEvent | 'TIMED_OUT'> {
  return Promise.race([
    iterator.next().then((result) => result.value as CanonicalRuntimeEvent),
    new Promise<'TIMED_OUT'>((resolve) =>
      setTimeout(() => resolve('TIMED_OUT'), ms),
    ),
  ]);
}

/**
 * R4: feed the captured event sequence through
 * normalizeCanonicalRuntimeEventLifecycle/validateSessionLifecycleTransition
 * pairwise and assert every non-same-state hop is legal (plan Wave 3 T9).
 */
function assertLegalLifecycleSequence(events: CanonicalRuntimeEvent[]): void {
  let state: SessionLifecycleState | undefined;
  for (const event of events) {
    const normalized = normalizeCanonicalRuntimeEventLifecycle(event, state);
    const to = normalized.sessionState;
    if (!to) continue;
    const from = normalized.previousState ?? state ?? 'queued';
    if (from !== to) {
      const validation = validateSessionLifecycleTransition(from, to);
      expect(
        validation.ok,
        `illegal transition for ${event.method}: ${from} -> ${to} (${validation.message ?? validation.code})`,
      ).toBe(true);
    }
    state = to;
  }
}

describe('AcpAdapter', () => {
  test('ACPProcess keeps a failed termination retryable', async () => {
    const terminateProcess = vi
      .fn()
      .mockRejectedValueOnce(new Error('termination not confirmed'))
      .mockResolvedValueOnce(undefined);
    const process = new ACPProcess({
      command: 'unused',
      cwd: '/tmp/project',
      createClient: () => ({}) as Client,
      logger: { debug: vi.fn() },
      terminateProcess,
    });
    (process as any).proc = { pid: 1234 };

    await expect(process.destroy()).rejects.toThrow(
      'termination not confirmed',
    );
    expect(process.isAlive).toBe(true);
    await expect(process.destroy()).resolves.toBeUndefined();
    expect(process.isAlive).toBe(false);
    expect(terminateProcess).toHaveBeenCalledTimes(2);
  });

  test('ACPProcess retains detached process ownership after the parent exits', async () => {
    const terminateProcess = vi.fn().mockResolvedValue(undefined);
    const process = new ACPProcess({
      command: 'unused',
      cwd: '/tmp/project',
      createClient: () => ({}) as Client,
      logger: { debug: vi.fn() },
      terminateProcess,
    });
    const child = { pid: 1234, exitCode: 0, signalCode: null };
    (process as any).proc = child;

    (process as any).handleProcessExit(child, 0);
    await process.destroy();

    expect(terminateProcess).toHaveBeenCalledWith(child);
    expect(process.isAlive).toBe(false);
  });

  afterEach(() => {
    // Nothing persistent between tests — each test builds its own adapter.
  });

  test('scopes prerequisites to the selected ACP connection while preserving aggregate discovery', async () => {
    const { adapter } = createAdapter({
      connectionOverrides: [
        {
          id: 'kiro',
          name: 'OpenCode',
          command: 'node',
        },
        {
          id: 'other',
          name: 'Cursor',
          command: 'station-definitely-missing-cursor-cli',
        },
      ],
    });

    const selected = await adapter.getPrerequisites({
      connectionId: 'kiro',
    });
    expect(selected).not.toHaveLength(0);
    expect(selected.every((item) => item.status === 'installed')).toBe(true);
    expect(selected.every((item) => item.name.includes('OpenCode'))).toBe(true);

    const aggregate = await adapter.getPrerequisites();
    expect(
      aggregate.some(
        (item) => item.name.includes('Cursor') && item.status !== 'installed',
      ),
    ).toBe(true);
  });

  test('rejects a duplicate session while the first start owns the thread', async () => {
    const { adapter, processes } = createAdapter();
    const input = {
      provider: 'acp' as const,
      threadId: 'duplicate-thread',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    };

    const first = adapter.startSession(input);
    await expect(adapter.startSession(input)).rejects.toThrow('already exists');
    await expect(first).resolves.toMatchObject({
      threadId: 'duplicate-thread',
    });
    expect(processes).toHaveLength(1);
    await adapter.stopAll();
  });

  test('starts a session, streams the canonical lifecycle (AC1), and round-trips a turn/approval/interrupt against a stubbed ACP process (AC2)', async () => {
    const { adapter, processes } = createAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const session = await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-1',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });
    expect(session).toMatchObject({ threadId: 'thread-1', status: 'ready' });

    const started = await nextEvent(iterator, 'session.started');
    const configured = await nextEvent(iterator, 'session.configured');
    expect(started.method).toBe('session.started');
    expect(configured.method).toBe('session.configured');

    const proc = processes[0];
    expect(proc).toBeDefined();
    expect(proc.opts.command).toBe('kiro-cli');

    const turnResult = await adapter.sendTurn({
      threadId: 'thread-1',
      input: 'Inspect the repo',
    });
    expect(turnResult.threadId).toBe('thread-1');
    const turnStarted = await nextEvent(iterator, 'turn.started');
    expect(turnStarted).toMatchObject({
      method: 'turn.started',
      turnId: turnResult.turnId,
      prompt: 'Inspect the repo',
    });

    // Mid-turn, agent-initiated permission request (row 4).
    const requestPromise = requestPermission(proc.client, 'tool-1');
    const opened = await nextEvent(iterator, 'request.opened');
    expect(opened).toMatchObject({
      method: 'request.opened',
      requestType: 'approval',
    });
    expect((opened as any).payload).toMatchObject({ toolCallId: 'tool-1' });

    await adapter.respondToRequest(
      'thread-1',
      String(opened.requestId),
      'accept',
    );
    const response = await requestPromise;
    expect(response).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });

    const resolved = await nextEvent(iterator, 'request.resolved');
    expect(resolved).toMatchObject({
      method: 'request.resolved',
      requestId: opened.requestId,
      status: 'approved',
    });

    // Turn completion (row 13).
    proc.resolvePrompt('end_turn');
    const turnCompleted = await nextEvent(iterator, 'turn.completed');
    expect(turnCompleted).toMatchObject({
      method: 'turn.completed',
      turnId: turnResult.turnId,
      finishReason: 'stop',
    });

    // H1 fix, wired end-to-end: an `available_commands_update` session
    // update sent through the live Client mutates the real
    // AcpSessionRecord (via `ctx.state = record`) and getCommands()
    // reflects it — not just unit-testable against the mapper in isolation.
    await proc.client.sessionUpdate({
      sessionId: 'native-kiro-cli',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          {
            name: 'deploy',
            description: 'Deploy the app',
            input: { hint: '<env>' },
          },
        ],
      },
    } as any);
    expect(await adapter.getCommands()).toEqual([
      {
        name: 'deploy',
        description: 'Deploy the app',
        argumentHint: '<env>',
        passthrough: true,
      },
    ]);

    // A second turn, interrupted mid-flight (row 14).
    const secondTurn = await adapter.sendTurn({
      threadId: 'thread-1',
      input: 'Keep going',
    });
    await nextEvent(iterator, 'turn.started');
    await adapter.interruptTurn('thread-1');
    expect(proc.cancelCalls).toBe(1);
    const aborted = await nextEvent(iterator, 'turn.aborted');
    expect(aborted).toMatchObject({
      method: 'turn.aborted',
      turnId: secondTurn.turnId,
      reason: 'interrupted',
    });
    expect((await adapter.listSessions())[0]?.status).toBe('ready');

    await adapter.stopSession('thread-1');
    expect(proc.destroyed).toBe(true);
    const exited = await nextEvent(iterator, 'session.exited');
    expect(exited.method).toBe('session.exited');

    const methods = [
      started,
      configured,
      turnStarted,
      opened,
      resolved,
      turnCompleted,
    ].map((event) => event.method);
    expectCanonicalSessionLifecycle(methods);
    expect(methods).toContain('request.opened');
    expect(methods).toContain('request.resolved');
    expect(methods).toContain('turn.completed');

    // R4: every non-same-state hop across the single-turn lifecycle sequence
    // is legal. The second turn's `turn.aborted`/session `exited` events are
    // intentionally excluded here: `turn.completed` always projects to the
    // terminal `completed` state (SESSION_LIFECYCLE_TRANSITIONS.completed =
    // []), so a *second* turn on the same thread would look like an illegal
    // `completed -> canceled` hop if fed through this pairwise check — a
    // shared, pre-existing quirk of the automatic per-event path (which never
    // calls validateSessionLifecycleTransition itself), identical on
    // Claude/Codex today and explicitly called out as a non-regression in the
    // plan's Risks section, not something to assert against here.
    assertLegalLifecycleSequence([
      started,
      configured,
      turnStarted,
      opened,
      resolved,
      turnCompleted,
    ]);
    expect(aborted.method).toBe('turn.aborted');
    expect(exited.method).toBe('session.exited');
  });

  test('#1850: re-establishes a credential-refusal session exactly once from its validated cursor, without forwarding a credential', async () => {
    const revokeStationControlMcpAuth = vi.fn();
    const { adapter, processes } = createAdapter({
      loadSessionCapability: true,
      revokeStationControlMcpAuth,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const initialSession = await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-credential-recovery',
      metadata: { connectionId: 'kiro' },
    });
    const managedCwd = initialSession.cwd;
    expect(managedCwd).toContain('/runtime/acp-workspaces/session/');
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');

    // The turn already has a canonical start receipt. Replacing the child
    // must terminate that turn rather than silently leaving it in flight.
    const turn = await adapter.sendTurn({
      threadId: 'thread-credential-recovery',
      input: 'Continue safely',
    });
    await nextEvent(iterator, 'turn.started');

    await expect(
      processes[0]!.client.extMethod!('_kiro/auth/getAccessToken', {}),
    ).rejects.toMatchObject({ code: -32601 });

    await vi.waitFor(() => expect(processes).toHaveLength(2));
    expect(processes[0]!.destroyed).toBe(true);
    expect(processes[0]!.cancelCalls).toBe(1);
    expect(revokeStationControlMcpAuth).toHaveBeenCalledTimes(1);
    // A restart is never a fresh session/new: the child receives only the
    // previous server-validated native cursor, cwd, and MCP server list.
    expect(processes[1]!.newSessionCalls).toBe(0);
    expect(processes[1]!.loadSessionArgs).toEqual({
      sessionId: 'native-kiro-cli',
      cwd: managedCwd,
      mcpServers: [],
    });
    expect(processes[1]!.opts.cwd).toBe(managedCwd);
    expect(JSON.stringify(processes[1]!.loadSessionArgs)).not.toMatch(
      /credential|secret|token/i,
    );

    await expect(nextEvent(iterator, 'turn.aborted')).resolves.toMatchObject({
      turnId: turn.turnId,
      reason: 'engine-restarted',
    });
    await expect(nextEvent(iterator, 'session.exited')).resolves.toMatchObject({
      reason: 'credential-refusal-recovery',
    });
    await expect(nextEvent(iterator, 'session.started')).resolves.toMatchObject(
      {
        sessionId: 'thread-credential-recovery',
      },
    );
    await expect(
      nextEvent(iterator, 'session.configured'),
    ).resolves.toMatchObject({
      sessionId: 'thread-credential-recovery',
    });

    // The replacement record retains the recovery bound. A second refusal
    // gets the existing actionable diagnostic and cannot start a third child.
    await expect(
      processes[1]!.client.extMethod!('_kiro/auth/getAccessToken', {}),
    ).rejects.toMatchObject({ code: -32601 });
    expect(processes).toHaveLength(2);
    await expect(nextEvent(iterator, 'runtime.warning')).resolves.toMatchObject(
      {
        code: 'acp.credential-request-refused',
      },
    );

    await adapter.stopAll();
  });

  test('#1850: concurrent credential refusals reserve one recovery before either process teardown await resolves', async () => {
    const { adapter, processes } = createAdapter({
      loadSessionCapability: true,
    });
    let releaseDestroy: (() => void) | undefined;
    const destroyBlocked = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-concurrent-credential-recovery',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });
    processes[0]!.destroyPromise = destroyBlocked;

    const first = processes[0]!.client.extMethod!(
      '_kiro/auth/getAccessToken',
      {},
    );
    const second = processes[0]!.client.extMethod!(
      '_kiro/auth/getAccessToken',
      {},
    );
    await expect(Promise.all([first, second])).rejects.toMatchObject({
      code: -32601,
    });
    await vi.waitFor(() => expect(processes[0]!.destroyCalls).toBe(1));
    expect(processes).toHaveLength(1);

    releaseDestroy?.();
    await vi.waitFor(() => expect(processes).toHaveLength(2));
    expect(processes[0]!.destroyed).toBe(true);
    await adapter.stopAll();
  });

  test('#1850: a failed re-establishment ends with the credential diagnostic instead of a fresh session', async () => {
    const { adapter, processes } = createAdapter({
      loadSessionCapability: true,
      loadSessionError: new Error('native session cannot load'),
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-failed-credential-recovery',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');

    await expect(
      processes[0]!.client.extMethod!('_kiro/auth/getAccessToken', {}),
    ).rejects.toMatchObject({ code: -32601 });
    await vi.waitFor(() => expect(processes).toHaveLength(2));
    await vi.waitFor(async () => {
      await expect(
        adapter.hasSession('thread-failed-credential-recovery'),
      ).resolves.toBe(false);
    });
    expect(processes[1]!.newSessionCalls).toBe(0);
    expect(processes[1]!.destroyed).toBe(true);
    await expect(nextEvent(iterator, 'session.exited')).resolves.toMatchObject({
      reason: 'credential-refusal-recovery',
    });
    await expect(nextEvent(iterator, 'session.started')).resolves.toMatchObject(
      {
        sessionId: 'thread-failed-credential-recovery',
      },
    );
    await expect(nextEvent(iterator, 'runtime.error')).resolves.toMatchObject({
      message:
        'The engine session could not be re-established after its credential request was refused.',
    });
    await expect(nextEvent(iterator, 'runtime.warning')).resolves.toMatchObject(
      {
        code: 'acp.credential-request-refused',
      },
    );

    await adapter.stopAll();
  });

  test('#1850: stopping while replacement session/load is pending emits a stopped lifecycle without a recovery diagnostic', async () => {
    let releaseLoad!: () => void;
    const loadBlocked = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const { adapter, processes } = createAdapter({
      loadSessionCapability: true,
      onProcess: (process, index) => {
        if (index === 1) process.loadSessionPromise = loadBlocked;
      },
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-stop-during-replacement-load',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');

    await expect(
      processes[0]!.client.extMethod!('_kiro/auth/getAccessToken', {}),
    ).rejects.toMatchObject({ code: -32601 });
    await vi.waitFor(() => expect(processes).toHaveLength(2));
    await vi.waitFor(() => expect(processes[1]!.loadSessionCalls).toBe(1));
    await expect(nextEvent(iterator, 'session.exited')).resolves.toMatchObject({
      reason: 'credential-refusal-recovery',
    });
    await expect(nextEvent(iterator, 'session.started')).resolves.toMatchObject(
      {
        sessionId: 'thread-stop-during-replacement-load',
      },
    );

    const stopped = adapter.stopSession('thread-stop-during-replacement-load');
    releaseLoad();
    await stopped;

    await expect(nextEvent(iterator, 'session.exited')).resolves.toMatchObject({
      sessionId: 'thread-stop-during-replacement-load',
      reason: 'stopped',
    });
    expect(await nextEventOrTimeout(iterator, 100)).toBe('TIMED_OUT');
    await expect(adapter.listSessions()).resolves.toEqual([]);
    await adapter.stopAll();
  });

  test('#1850: stopping during the old turn cancel never reports an engine restart', async () => {
    let releaseCancel!: () => void;
    const cancelBlocked = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    const { adapter, processes } = createAdapter({
      loadSessionCapability: true,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-stop-during-recovery-cancel',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');
    const turn = await adapter.sendTurn({
      threadId: 'thread-stop-during-recovery-cancel',
      input: 'work still in flight',
    });
    await nextEvent(iterator, 'turn.started');
    processes[0]!.cancelPromise = cancelBlocked;

    await expect(
      processes[0]!.client.extMethod!('_kiro/auth/getAccessToken', {}),
    ).rejects.toMatchObject({ code: -32601 });
    await vi.waitFor(() => expect(processes[0]!.cancelCalls).toBe(1));

    const stopped = adapter.stopSession('thread-stop-during-recovery-cancel');
    releaseCancel();
    await stopped;

    await expect(nextEvent(iterator, 'turn.aborted')).resolves.toMatchObject({
      turnId: turn.turnId,
      reason: 'stopped',
    });
    await expect(nextEvent(iterator, 'session.exited')).resolves.toMatchObject({
      reason: 'stopped',
    });
    expect(processes).toHaveLength(1);
    expect(processes[0]!.destroyed).toBe(true);
    await expect(adapter.listSessions()).resolves.toEqual([]);
    await adapter.stopAll();
  });

  test('#1850: completed stop generations are released after their session and lifecycle tasks settle', async () => {
    const { adapter } = createAdapter();
    for (const threadId of ['thread-generation-a', 'thread-generation-b']) {
      await adapter.startSession({
        provider: 'acp',
        threadId,
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
      });
      await adapter.stopSession(threadId);
    }

    expect(
      (adapter as unknown as { sessionStopGenerations: Map<string, number> })
        .sessionStopGenerations.size,
    ).toBe(0);
    await adapter.stopAll();
  });

  describe('requestPermission honors the session agent tools.autoApprove (external autoApprove parity)', () => {
    function sharedPolicy(
      autoApprove: string[],
      toolServers: (typeof GENUINE_STATION_CONTROL_TOOLSERVER)[] = [],
    ) {
      return createStagedPreToolPolicyEvaluator({
        spec: { name: 'Engine lab', prompt: '' },
        toolNameMapping: new Map(),
        isGranted: (tool) =>
          isAutoApprovedExternalTool(
            tool.toolName,
            autoApprove,
            toolServers,
            'self-reported',
          ),
        logger: { warn: vi.fn(), info: vi.fn() },
      });
    }

    test('maps shared staged-policy allow/deny/defer without opening a second approval path', async () => {
      const evaluator = vi
        .fn()
        .mockResolvedValueOnce({ behavior: 'allow' })
        .mockResolvedValueOnce({
          behavior: 'deny',
          denial: { allowed: false, reason: 'blocked by Station policy' },
        })
        .mockResolvedValueOnce({ behavior: 'defer' })
        .mockResolvedValueOnce({ behavior: 'ask' });
      const { adapter, processes } = createAdapter({
        resolvePreToolPolicy: async () => evaluator,
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-staged-policy',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        agent: { slug: 'engine-lab' },
      });
      await nextEvent(iterator, 'session.started');
      const configured = await nextEvent(iterator, 'session.configured');
      expect(configured.method).toBe('session.configured');
      if (configured.method !== 'session.configured') {
        throw new Error('expected session.configured');
      }
      expect(configured.metadata?.capabilityDelivery).toMatchObject({
        toolPolicy: {
          coverage: 'partial',
          permissionHook: 'requestPermission',
          evidence: 'sharedStagedPolicy',
          toolIdentity: 'self-reported',
        },
      });

      await expect(
        requestPermission(processes[0].client, 'allow', 'mcp__tools__read'),
      ).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      });
      await expect(
        requestPermission(processes[0].client, 'deny', 'mcp__tools__write'),
      ).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'reject-once' },
      });
      const deferred = requestPermission(
        processes[0].client,
        'defer',
        'mcp__tools__ask',
      );
      const opened = await nextEvent(iterator, 'request.opened');
      await adapter.respondToRequest(
        'thread-staged-policy',
        String(opened.requestId),
        'accept',
      );
      await expect(deferred).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      });
      await nextEvent(iterator, 'request.resolved');
      const asked = requestPermission(
        processes[0].client,
        'ask',
        'mcp__tools__ask-defensively',
      );
      const askOpened = await nextEvent(iterator, 'request.opened');
      await adapter.respondToRequest(
        'thread-staged-policy',
        String(askOpened.requestId),
        'decline',
      );
      await expect(asked).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'reject-once' },
      });
      expect(evaluator).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          toolName: 'mcp__tools__read',
          toolArgs: { path: 'a.txt' },
        }),
        expect.objectContaining({
          agentSlug: 'engine-lab',
          conversationId: 'thread-staged-policy',
        }),
        expect.objectContaining({ interaction: 'external' }),
      );
    });

    test('fails closed when staged-policy preparation rejects', async () => {
      const { adapter, processes } = createAdapter({
        resolvePreToolPolicy: async () => {
          throw new Error('policy store unavailable');
        },
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-policy-prepare-failed',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        agent: { slug: 'engine-lab' },
      });
      await nextEvent(iterator, 'session.started');
      await nextEvent(iterator, 'session.configured');
      await expect(
        requestPermission(
          processes[0].client,
          'prepare-failed',
          'mcp__tools__write',
        ),
      ).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'reject-once' },
      });
      expect(await nextEventOrTimeout(iterator, 100)).toBe('TIMED_OUT');
    });

    test('a missing self-reported tool name bypasses no policy claim and preserves ACP approval', async () => {
      const evaluator = vi.fn().mockResolvedValue({ behavior: 'allow' });
      const { adapter, processes } = createAdapter({
        resolvePreToolPolicy: async () => evaluator,
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-policy-no-tool-name',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        agent: { slug: 'engine-lab' },
      });
      await nextEvent(iterator, 'session.started');
      await nextEvent(iterator, 'session.configured');
      const pending = requestPermission(processes[0].client, 'missing-name');
      const opened = await nextEvent(iterator, 'request.opened');
      expect(evaluator).not.toHaveBeenCalled();
      await adapter.respondToRequest(
        'thread-policy-no-tool-name',
        String(opened.requestId),
        'decline',
      );
      await expect(pending).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'reject-once' },
      });
    });

    test('shared policy honors a non-reserved grant but fails closed for a self-reported reserved name', async () => {
      const nonReserved = sharedPolicy(['my-tools_*']);
      const reserved = sharedPolicy(
        ['station-control_*'],
        [GENUINE_STATION_CONTROL_TOOLSERVER],
      );
      const { adapter, processes } = createAdapter({
        resolvePreToolPolicy: async (input) =>
          input.threadId === 'thread-shared-nonreserved'
            ? nonReserved
            : reserved,
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-shared-nonreserved',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        agent: { slug: 'engine-lab', autoApprove: ['my-tools_*'] },
      });
      await nextEvent(iterator, 'session.started');
      await nextEvent(iterator, 'session.configured');
      await expect(
        requestPermission(
          processes[0].client,
          'nonreserved',
          'mcp__my-tools__read',
        ),
      ).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      });

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-shared-reserved',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        agent: {
          slug: 'engine-lab',
          autoApprove: ['station-control_*'],
          toolServers: [GENUINE_STATION_CONTROL_TOOLSERVER],
        },
      });
      await nextEvent(iterator, 'session.started');
      await nextEvent(iterator, 'session.configured');
      const pending = requestPermission(
        processes[1].client,
        'reserved',
        'mcp__station-control__list_agents',
      );
      const opened = await nextEvent(iterator, 'request.opened');
      await adapter.respondToRequest(
        'thread-shared-reserved',
        String(opened.requestId),
        'decline',
      );
      await expect(pending).resolves.toEqual({
        outcome: { outcome: 'selected', optionId: 'reject-once' },
      });
    });

    test('auto-approves an mcp__server__tool call matching the agent server_* pattern for a NON-reserved server, with no approval request surfaced', async () => {
      const { adapter, processes } = createAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-auto-approve',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        agent: {
          slug: 'engine-lab',
          // A user's own integration the author chose to auto-approve — a
          // non-reserved name, so ACP's self-reported tool name is honored
          // (the reserved-name provenance guard only gates privileged
          // built-ins like station-control).
          autoApprove: ['my-tools_*'],
        },
      });
      await nextEvent(iterator, 'session.started');
      await nextEvent(iterator, 'session.configured');

      const proc = processes[0];
      const response = await requestPermission(
        proc.client,
        'tool-auto',
        'mcp__my-tools__do_thing',
      );
      expect(response).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      });

      // No request.opened ever reaches the stream for this call.
      const nextOrTimeout = await nextEventOrTimeout(iterator, 200);
      expect(nextOrTimeout).toBe('TIMED_OUT');
    });

    test('SECURITY (#1049 Q1 Probe A): does NOT auto-approve a reserved station-control name over ACP, even with the genuine built-in in the session — the self-reported name is unverifiable', async () => {
      const { adapter, processes } = createAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-reserved-acp',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        agent: {
          slug: 'engine-lab',
          autoApprove: ['station-control_*'],
          // The genuine built-in is legitimately present — the common case —
          // yet a reserved-name match must STILL be surfaced for consent,
          // because ACP's toolCall.name is self-reported by the external agent.
          toolServers: [GENUINE_STATION_CONTROL_TOOLSERVER],
        },
      });
      await nextEvent(iterator, 'session.started');
      await nextEvent(iterator, 'session.configured');

      const proc = processes[0];
      const requestPromise = requestPermission(
        proc.client,
        'tool-reserved-acp',
        'mcp__station-control__list_agents',
      );
      // The approval IS surfaced (not silently auto-approved).
      const opened = await nextEvent(iterator, 'request.opened');
      expect(opened).toMatchObject({
        method: 'request.opened',
        requestType: 'approval',
      });
      await adapter.respondToRequest(
        'thread-reserved-acp',
        String(opened.requestId),
        'accept',
      );
      const response = await requestPromise;
      expect(response).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      });
    });

    test('still requests approval through the ApprovalRegistry for a tool NOT matching the pattern', async () => {
      const { adapter, processes } = createAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-no-match',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        agent: {
          slug: 'engine-lab',
          autoApprove: ['station-control_*'],
        },
      });
      await nextEvent(iterator, 'session.started');
      await nextEvent(iterator, 'session.configured');

      const proc = processes[0];
      const requestPromise = requestPermission(
        proc.client,
        'tool-no-match',
        'mcp__other-server__do_thing',
      );
      const opened = await nextEvent(iterator, 'request.opened');
      expect(opened).toMatchObject({
        method: 'request.opened',
        requestType: 'approval',
      });

      await adapter.respondToRequest(
        'thread-no-match',
        String(opened.requestId),
        'accept',
      );
      const response = await requestPromise;
      expect(response).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      });
    });

    test('an empty autoApprove list leaves approval behavior unchanged (always requests)', async () => {
      const { adapter, processes } = createAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-empty-autoapprove',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        agent: {
          slug: 'engine-lab',
          autoApprove: [],
        },
      });
      await nextEvent(iterator, 'session.started');
      await nextEvent(iterator, 'session.configured');

      const proc = processes[0];
      const requestPromise = requestPermission(
        proc.client,
        'tool-empty',
        'mcp__station-control__list_agents',
      );
      const opened = await nextEvent(iterator, 'request.opened');
      expect(opened).toMatchObject({
        method: 'request.opened',
        requestType: 'approval',
      });

      await adapter.respondToRequest(
        'thread-empty-autoapprove',
        String(opened.requestId),
        'decline',
      );
      const response = await requestPromise;
      expect(response).toEqual({
        outcome: { outcome: 'selected', optionId: 'reject-once' },
      });
    });
  });

  test("#1011: the session's cwd wins over the connection's configured default", async () => {
    // A connection-level cwd is a fallback for a connection used without a
    // workspace. Taking it first meant a chat bound to a project launched the
    // CLI in the connection's directory instead — silently the wrong files.
    const { adapter, processes } = createAdapter({
      connectionOverrides: [{ id: 'kiro', cwd: '/tmp/connection-default' }],
    });

    const session = await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-cwd-precedence',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });

    expect(processes[0].opts.cwd).toBe('/tmp/project');
    expect(session.cwd).toBe('/tmp/project');
  });

  test('#1011: a connection cwd still applies when the session supplies none', async () => {
    const { adapter, processes } = createAdapter({
      connectionOverrides: [{ id: 'kiro', cwd: '/tmp/connection-default' }],
    });

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-cwd-connection-default',
      metadata: { connectionId: 'kiro' },
    });

    expect(processes[0].opts.cwd).toBe('/tmp/connection-default');
  });

  test('#1403: an unbound CLI launches in a private Station-managed workspace', async () => {
    // The last fail-open path from #1011. The orchestration resolver
    // deliberately skips ACP (it must not shadow `config.cwd`, which only the
    // adapter can see), so #1042's explicit-$HOME default never reached this
    // engine family and the chain still ended at `process.cwd()` — Station's
    // own install root for a dev checkout or a service. Live repro on the
    // seeded `default` project (no workingDirectory): the spawned CLI's cwd
    // was the Station checkout while the UI promised "~ (defaults to home)".
    const { adapter, processes } = createAdapter();

    const session = await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-cwd-home-default',
      metadata: { connectionId: 'kiro' },
    });

    expect(processes[0].opts.cwd).toBe(session.cwd);
    expect(session.cwd).toContain('/runtime/acp-workspaces/session/');
    expect(processes[0].opts.cwd).not.toBe(homedir());
    expect(processes[0].opts.cwd).not.toBe(process.cwd());
  });

  test('#1403: an ordinary unbound resume reuses the same managed workspace', async () => {
    const { adapter, processes } = createAdapter({
      loadSessionCapability: true,
    });
    const started = await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-managed-resume',
      metadata: { connectionId: 'kiro' },
    });
    await adapter.stopSession('thread-managed-resume');

    const resumed = await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-managed-resume',
      metadata: { connectionId: 'kiro' },
      resumeCursor: started.resumeCursor,
    });

    expect(resumed.cwd).toBe(started.cwd);
    expect(processes[1]!.opts.cwd).toBe(started.cwd);
    expect(processes[1]!.loadSessionArgs?.cwd).toBe(started.cwd);
  });

  test("#1403: an EMPTY connection cwd falls through to the managed workspace — `spawn` treats `cwd: ''` as inherit", async () => {
    // The first version of the fix used `??`, which does not skip `''`. Node's
    // spawn reads an empty string as "inherit the parent's cwd", so an empty
    // value was an exact synonym for the bug being closed — and it is the
    // DEFAULT the UI produces: the Connections form initialises Working
    // Directory to `''` and always sends the field, and the route schema is
    // `cwd: z.string().optional()` with no `.min(1)`. A user who leaves that
    // box alone persisted `cwd: ""` and got the pre-fix behaviour.
    const { adapter, processes } = createAdapter({
      connectionOverrides: [{ id: 'kiro', cwd: '' }],
    });

    const session = await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-cwd-empty-connection',
      metadata: { connectionId: 'kiro' },
    });

    expect(processes[0].opts.cwd).toBe(session.cwd);
    expect(session.cwd).toContain('/runtime/acp-workspaces/session/');
    expect(processes[0].opts.cwd).not.toBe(homedir());
    expect(processes[0].opts.cwd).not.toBe(process.cwd());
  });

  test('#1023 review: an EMPTY session cwd falls through rather than winning the chain', async () => {
    // Same hazard from the other end — reachable through the authenticated
    // orchestration API, since `resolveStartSessionCwd` drops `''` as falsy and
    // (being ACP) returns the input unchanged, so the empty string arrives here
    // intact.
    const { adapter, processes } = createAdapter();

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-cwd-empty-session',
      cwd: '',
      metadata: { connectionId: 'kiro' },
    });

    expect(processes[0].opts.cwd).toContain('/runtime/acp-workspaces/session/');
  });

  test('#1023 review: a connection cwd with a literal ~ is expanded, not passed through raw', async () => {
    // The crash path. `~` is stored literally by Station and typed freely here;
    // unexpanded it reaches spawn as a RELATIVE path and ENOENTs.
    const { adapter, processes } = createAdapter({
      connectionOverrides: [{ id: 'kiro', cwd: '~' }],
    });

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-cwd-tilde-connection',
      metadata: { connectionId: 'kiro' },
    });

    expect(processes[0].opts.cwd).toBe(homedir());
  });

  test('MCP passthrough (docs/design/connections-onboarding.md §5): off by default, `newSession` gets an empty mcpServers array when the connection has no `provideToolServers`', async () => {
    // station#1547 AC5 narrowed what "never called" means here: the resolver
    // IS now consulted once per session for `station-docs`, whatever the
    // connection opted into. What must still never happen is a lookup for a
    // server the connection did not name — asserted by id rather than by
    // call count so the docs grant is distinguishable from a regression that
    // resurrects opt-out passthrough.
    const { adapter, processes } = createAdapter({
      resolveToolServer: async (id) => {
        if (id !== 'station-docs') {
          throw new Error(
            `must not be called for '${id}' when provideToolServers is unset`,
          );
        }
        return null;
      },
    });

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-passthrough-off',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });

    expect(processes[0].newSessionMcpServers).toEqual([]);
  });

  test("MCP passthrough: an opted-in connection resolves its tool servers into `newSession`'s mcpServers", async () => {
    // process.execPath is a real absolute binary on this machine — the
    // resolver's existsSync check (repo review, 2026-07-26) would otherwise
    // reject a fictional path like '/usr/local/bin/npx'.
    const { adapter, processes } = createAdapter({
      connectionOverrides: [{ id: 'kiro', provideToolServers: ['filesystem'] }],
      resolveToolServer: async (id) =>
        id === 'filesystem'
          ? {
              id: 'filesystem',
              kind: 'mcp',
              transport: 'stdio',
              command: process.execPath,
              args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
              env: {},
            }
          : null,
    });

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-passthrough-on',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });

    expect(processes[0].newSessionMcpServers).toEqual([
      {
        name: 'filesystem',
        command: process.execPath,
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        env: [],
      },
    ]);
  });

  test('SECURITY: an opted-in tool server that declares environment variables is never passed through to session/new', async () => {
    const { adapter, processes } = createAdapter({
      connectionOverrides: [{ id: 'kiro', provideToolServers: ['github'] }],
      resolveToolServer: async (id) =>
        id === 'github'
          ? {
              id: 'github',
              kind: 'mcp',
              transport: 'stdio',
              command: process.execPath,
              args: [],
              env: { GITHUB_TOKEN: 'ghp_super_secret' },
            }
          : null,
    });

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-passthrough-secret',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });

    expect(processes[0].newSessionMcpServers).toEqual([]);
  });

  test('a resolution failure (a throwing resolveToolServer) never rejects session start — it degrades to no passthrough servers', async () => {
    const logger = { debug: () => {}, warn: vi.fn(), error: () => {} };
    const { adapter, processes } = createAdapter({
      connectionOverrides: [{ id: 'kiro', provideToolServers: ['filesystem'] }],
      resolveToolServer: async () => {
        throw new Error('boom: unexpected resolver failure');
      },
      logger,
    });

    const session = await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-passthrough-resolver-throws',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });

    expect(session.status).toBe('ready');
    expect(processes[0].newSessionMcpServers).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  test("#895: input.agent.toolServers wins over the connection's provideToolServers", async () => {
    const { adapter, processes } = createAdapter({
      connectionOverrides: [{ id: 'kiro', provideToolServers: ['filesystem'] }],
      resolveToolServer: async (id) => {
        // station#1547 AC5: `station-docs` is the one id Station looks up on
        // its own account, so it is not evidence that the agent path
        // consulted the connection's resolver. Any other id here would be.
        if (id !== 'station-docs') {
          throw new Error(
            'must not be called: the agent path never consults resolveToolServer',
          );
        }
        return null;
      },
    });

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-agent-tool-servers',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
      agent: {
        slug: 'my-agent',
        toolServers: [
          {
            id: 'agent-tool',
            transport: 'stdio',
            command: process.execPath,
            args: ['--version'],
          },
        ],
      },
    });

    expect(processes[0].newSessionMcpServers).toEqual([
      {
        name: 'agent-tool',
        command: process.execPath,
        args: ['--version'],
        env: [],
      },
    ]);
  });

  /**
   * station#1547 AC5 — the runtime docs grant.
   *
   * The point of the credential-free docs server is the population that
   * cannot receive `station-control`. station#1684 NARROWED that population
   * from "every ACP engine" to "every ACP connection whose CLI does not
   * advertise `mcpCapabilities.http`" — it did not empty it. Such a
   * connection cannot run the built-in assistant, so it runs its own agent —
   * and that agent is exactly what `builtinStationAgentSpec` does not cover
   * (it grants the `station` slug only) and what `loadAgentSpec` returns null
   * for (a registry-default agent has no spec on disk). So the grant lives in
   * this adapter, below the resolver, where it reaches every ACP session
   * regardless of whether an agent resolved at all.
   *
   * The grant is deliberately UNCONDITIONAL — it does not consult the
   * station-control gate — so a capable connection gets both servers rather
   * than trading one for the other.
   *
   * The EnginePicker sentence "it still gets Station's documentation" is
   * true only while these pass.
   */
  describe('station#1547 AC5: the credential-free docs grant', () => {
    const genuineDocs = {
      id: 'station-docs',
      kind: 'mcp' as const,
      transport: 'stdio' as const,
      command: 'node',
      args: [builtinStationDocsServerPath()],
    };

    test('the premise, as station#1684 left it: ACP names a mechanism, but one that no ACP connection is entitled to WITHOUT a live observation', () => {
      // The original form of this test asserted the mechanism was absent.
      // That is what changed, and the honest successor pins what the grant
      // now depends on: the mechanism's basis is `runtime_observation`, so
      // `engineControlPlaneCapability` given the matrix ALONE — which is all
      // any statement about the engine class has — is not 'full'. A
      // connection that never advertises the capability therefore still
      // cannot run the built-in assistant, which is exactly the population
      // this grant and the EnginePicker copy are about. Someone flipping the
      // basis to 'declared' is prompted by a red test rather than by a user
      // reading a stale sentence.
      const acp = ENGINE_CAPABILITY_MATRICES.acp?.toolServers;
      expect(acp?.state).toBe('session');
      expect(
        acp?.state === 'session'
          ? acp.builtinStationControlDelivery?.basis
          : 'unreachable',
      ).toBe('runtime_observation');
      expect(engineControlPlaneCapability(ENGINE_CAPABILITY_MATRICES.acp)).toBe(
        'observation-required',
      );
    });

    test('reaches a session with NO resolved agent and NO connection opt-in — the case the empty state is about', async () => {
      const { adapter, processes } = createAdapter({
        resolveToolServer: async (id) =>
          id === 'station-docs' ? genuineDocs : null,
      });

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-docs-grant-bare',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
      });

      const delivered = processes[0]?.newSessionMcpServers as any[];
      expect(delivered.map((server) => server.name)).toEqual(['station-docs']);
      // Delivered with no environment, which is the ONLY reason it may cross
      // to an external agent app at all (§5 secret boundary).
      expect(delivered[0].env).toEqual([]);
    });

    test('never displaces what the connection opted into — it is added, not substituted', async () => {
      const { adapter, processes } = createAdapter({
        connectionOverrides: [
          { id: 'kiro', provideToolServers: ['filesystem'] },
        ],
        resolveToolServer: async (id) => {
          if (id === 'station-docs') return genuineDocs;
          if (id === 'filesystem') {
            return {
              id: 'filesystem',
              kind: 'mcp',
              transport: 'stdio',
              command: process.execPath,
              args: ['/tmp'],
              env: {},
            } as any;
          }
          return null;
        },
      });

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-docs-grant-with-optin',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
      });

      // The user's opted-in server is still there, and first: a grant that
      // silently dropped it would be a regression dressed as a feature.
      const delivered = processes[0]?.newSessionMcpServers as any[] | undefined;
      expect((delivered ?? []).map((server) => server.name)).toEqual([
        'filesystem',
        'station-docs',
      ]);
    });

    test('never displaces what the AGENT authored, and never reports itself as something the agent asked for', async () => {
      const { adapter, processes } = createAdapter({
        connectionOverrides: [
          { id: 'kiro', provideToolServers: ['filesystem'] },
        ],
        resolveToolServer: async (id) =>
          id === 'station-docs' ? genuineDocs : null,
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-docs-grant-with-agent',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        agent: {
          slug: 'my-agent',
          toolServers: [
            {
              id: 'agent-tool',
              transport: 'stdio',
              command: process.execPath,
              args: ['--version'],
            },
          ],
        },
      });

      const delivered = processes[0]?.newSessionMcpServers as any[] | undefined;
      expect((delivered ?? []).map((server) => server.name)).toEqual([
        'agent-tool',
        'station-docs',
      ]);

      await nextEvent(iterator, 'session.started');
      const configured = await nextEvent(iterator, 'session.configured');
      if (configured.method !== 'session.configured') {
        throw new Error(
          `Expected session.configured, got ${configured.method}`,
        );
      }
      const report = (configured.metadata as any).capabilityDelivery
        .toolServers;

      // The honesty rule this field exists for: `requested` is what the AGENT
      // asked for and must not silently absorb a Station grant, or the
      // authored-vs-connection-default distinction blurs on exactly the
      // sessions where a grant is present.
      expect(report.requested).toEqual(['agent-tool']);
      expect(report.delivered).toEqual(['agent-tool', 'station-docs']);
      expect(report.runtimeProvided).toEqual(['station-docs']);
      expect(report.source).toBe('agent');
    });

    test('IDENTITY, not id: an unrelated integration saved under the id `station-docs` is never spawned', async () => {
      // The grant delivers a server nobody asked for, so the thing it must
      // not do is deliver somebody ELSE'S server. An id string is not an
      // identity — same rule `isBuiltinStationControl` holds for the
      // opposite reason (there, an impostor must not receive a secret).
      const { adapter, processes } = createAdapter({
        resolveToolServer: async (id) =>
          id === 'station-docs'
            ? ({
                id: 'station-docs',
                kind: 'mcp',
                transport: 'stdio',
                command: process.execPath,
                args: ['/tmp/not-the-real-docs-server.js'],
              } as any)
            : null,
      });

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-docs-grant-impostor',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
      });

      expect(processes[0].newSessionMcpServers).toEqual([]);
    });

    test('a throwing resolver degrades to no documentation, never a failed session start', async () => {
      const logger = { debug: () => {}, warn: vi.fn(), error: () => {} };
      const { adapter, processes } = createAdapter({
        resolveToolServer: async () => {
          throw new Error('boom: docs lookup failed');
        },
        logger,
      });

      const session = await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-docs-grant-throws',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
      });

      expect(session.status).toBe('ready');
      expect(processes[0].newSessionMcpServers).toEqual([]);
      expect(logger.warn).toHaveBeenCalled();
    });

    test('an unresolvable docs server delivers nothing rather than a placeholder', async () => {
      const { adapter, processes } = createAdapter({
        resolveToolServer: async () => null,
      });

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-docs-grant-missing',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
      });

      expect(processes[0].newSessionMcpServers).toEqual([]);
    });
  });

  test('#895: an authored empty input.agent.toolServers disables connection-default passthrough', async () => {
    const resolveToolServer = vi.fn(async () => null);
    const { adapter, processes } = createAdapter({
      connectionOverrides: [{ id: 'kiro', provideToolServers: ['filesystem'] }],
      resolveToolServer,
    });

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-agent-empty-tool-servers',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
      agent: { slug: 'my-agent', toolServers: [] },
    });

    expect(processes[0].newSessionMcpServers).toEqual([]);
    // station#1547 AC5: the ONLY lookup an authored-empty session may make is
    // Station's own docs grant. `filesystem` — the connection default this
    // authored empty array exists to disable — must still never be resolved.
    expect(
      resolveToolServer.mock.calls.map((call) => (call as unknown[])[0]),
    ).toEqual(['station-docs']);
  });

  test("#895: an absent input.agent falls back to the connection's provideToolServers", async () => {
    const { adapter, processes } = createAdapter({
      connectionOverrides: [{ id: 'kiro', provideToolServers: ['filesystem'] }],
      resolveToolServer: async (id) =>
        id === 'filesystem'
          ? {
              id: 'filesystem',
              kind: 'mcp',
              transport: 'stdio',
              command: process.execPath,
              args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            }
          : null,
    });

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-agent-absent',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });

    expect(processes[0].newSessionMcpServers).toEqual([
      {
        name: 'filesystem',
        command: process.execPath,
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        env: [],
      },
    ]);
  });

  test('#895: session.configured carries a capabilityDelivery receipt with delivered and skipped tool servers (agent path)', async () => {
    const { adapter } = createAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-agent-receipt',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
      agent: {
        slug: 'my-agent',
        toolServers: [
          {
            id: 'agent-tool',
            transport: 'stdio',
            command: process.execPath,
            args: [],
          },
          // No command configured: resolveAcpPassthroughMcpServers skips it
          // as 'binary-not-found', proving the channel-stage skip mapping.
          { id: 'agent-tool-no-command', transport: 'stdio' },
        ],
      },
    });

    await nextEvent(iterator, 'session.started');
    const configured = await nextEvent(iterator, 'session.configured');
    if (configured.method !== 'session.configured') {
      throw new Error(`Expected session.configured, got ${configured.method}`);
    }
    expect((configured.metadata as any).capabilityDelivery).toEqual({
      toolServers: {
        source: 'agent',
        requested: ['agent-tool', 'agent-tool-no-command'],
        delivered: ['agent-tool'],
        undelivered: [
          {
            capability: 'toolServers',
            id: 'agent-tool-no-command',
            reason: 'binary-not-found',
          },
        ],
      },
    });
  });

  describe('#895 wave B: ACP resume (session/load)', () => {
    // Every 'kiro' connection in these tests leaves ACPConnectionConfig.cwd
    // unset, so the effective spawn cwd is always the startSession input's
    // cwd — '/tmp/project' unless a test explicitly varies it.
    const kiroFingerprint = (effectiveCwd = '/tmp/project') =>
      acpConnectionFingerprint(
        acpExecutionIdentity({ command: 'kiro-cli', args: [], effectiveCwd }),
      );

    test('captures an { acpSessionId, connectionId, connectionFingerprint } resume cursor after session/new', async () => {
      const { adapter, processes } = createAdapter();

      const session = await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-resume-cursor',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
      });

      expect(session.resumeCursor).toEqual({
        acpSessionId: `native-${processes[0].opts.command}`,
        connectionId: 'kiro',
        connectionFingerprint: kiroFingerprint(),
      });
    });

    test('resume fails closed with a named stale-connection error when the connection was recreated with different execution config', async () => {
      const { adapter, processes } = createAdapter({
        loadSessionCapability: true,
      });
      const staleFingerprint = acpConnectionFingerprint(
        acpExecutionIdentity({
          command: 'kiro-cli-old-binary',
          args: [],
          effectiveCwd: '/tmp/project',
        }),
      );

      await expect(
        adapter.startSession({
          provider: 'acp',
          threadId: 'thread-resume-stale-connection',
          cwd: '/tmp/project',
          metadata: { connectionId: 'kiro' },
          resumeCursor: {
            acpSessionId: 'native-kiro-cli',
            connectionId: 'kiro',
            connectionFingerprint: staleFingerprint,
          },
        }),
      ).rejects.toThrow(/different engine connection configuration/i);

      // Rejected before ever spawning a process for the stale cursor.
      expect(processes).toHaveLength(0);
    });

    test('resume proceeds when the recomputed fingerprint matches', async () => {
      const { adapter, processes } = createAdapter({
        loadSessionCapability: true,
      });

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-resume-fingerprint-match',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        resumeCursor: {
          acpSessionId: 'native-kiro-cli',
          connectionId: 'kiro',
          connectionFingerprint: kiroFingerprint(),
        },
      });

      expect(processes[0].loadSessionArgs).toEqual({
        sessionId: 'native-kiro-cli',
        cwd: '/tmp/project',
        mcpServers: [],
      });
    });

    test('a metadata/cursor connection-id mismatch is rejected', async () => {
      const { adapter, processes } = createAdapter({
        loadSessionCapability: true,
      });

      await expect(
        adapter.startSession({
          provider: 'acp',
          threadId: 'thread-resume-connection-mismatch',
          cwd: '/tmp/project',
          metadata: { connectionId: 'kiro' },
          resumeCursor: {
            acpSessionId: 'native-other-cli',
            connectionId: 'other',
          },
        }),
      ).rejects.toThrow(/connection mismatch/i);

      expect(processes).toHaveLength(0);
    });

    test('a malformed resume cursor is rejected before any process is created (never a silent fresh session)', async () => {
      const { adapter, processes } = createAdapter({
        loadSessionCapability: true,
      });

      // Caller-crafted / corrupted cursor: present, but shaped nothing like
      // AcpResumeCursor (isAcpResumeCursor would return false for this).
      await expect(
        adapter.startSession({
          provider: 'acp',
          threadId: 'thread-resume-malformed-cursor',
          cwd: '/tmp/project',
          metadata: { connectionId: 'kiro' },
          resumeCursor: {} as any,
        }),
      ).rejects.toThrow(/resume record is malformed/i);

      // Never silently degrades to a fresh session/new — no process is
      // created at all for a malformed cursor.
      expect(processes).toHaveLength(0);
    });

    test('a resume cursor with wrong-typed fields is rejected before any process is created', async () => {
      const { adapter, processes } = createAdapter({
        loadSessionCapability: true,
      });

      await expect(
        adapter.startSession({
          provider: 'acp',
          threadId: 'thread-resume-wrong-typed-cursor',
          cwd: '/tmp/project',
          metadata: { connectionId: 'kiro' },
          resumeCursor: { acpSessionId: 42, connectionId: null } as any,
        }),
      ).rejects.toThrow(/resume record is malformed/i);

      expect(processes).toHaveLength(0);
    });

    test('a cursor without a fingerprint is rejected (client-crafted cursors cannot bypass identity binding)', async () => {
      const { adapter, processes } = createAdapter({
        loadSessionCapability: true,
      });

      await expect(
        adapter.startSession({
          provider: 'acp',
          threadId: 'thread-resume-missing-fingerprint',
          cwd: '/tmp/project',
          metadata: { connectionId: 'kiro' },
          resumeCursor: {
            acpSessionId: 'native-kiro-cli',
            connectionId: 'kiro',
            // No connectionFingerprint — e.g. a client-crafted resumeCursor
            // posted straight through the authenticated orchestration API.
          },
        }),
      ).rejects.toThrow(/resume record is missing its connection identity/i);

      // Rejected before ever spawning a process.
      expect(processes).toHaveLength(0);
    });

    test('sessions with an unset connection cwd but different effective workspace cwds get different fingerprints', () => {
      const fingerprintA = kiroFingerprint('/workspace/one');
      const fingerprintB = kiroFingerprint('/workspace/two');

      expect(fingerprintA).not.toBe(fingerprintB);
    });

    test('resume fails closed when the effective cwd changed since capture', async () => {
      const { adapter, processes } = createAdapter({
        loadSessionCapability: true,
      });
      const capturedFingerprint = kiroFingerprint('/tmp/project-a');

      await expect(
        adapter.startSession({
          provider: 'acp',
          threadId: 'thread-resume-cwd-changed',
          // A different caller-supplied workspace cwd than the one the
          // cursor was captured under — same connection, unset config.cwd.
          cwd: '/tmp/project-b',
          metadata: { connectionId: 'kiro' },
          resumeCursor: {
            acpSessionId: 'native-kiro-cli',
            connectionId: 'kiro',
            connectionFingerprint: capturedFingerprint,
          },
        }),
      ).rejects.toThrow(/different engine connection configuration/i);

      expect(processes).toHaveLength(0);
    });

    test('resume proceeds when config cwd is unset and the same workspace cwd is used', async () => {
      const { adapter, processes } = createAdapter({
        loadSessionCapability: true,
      });

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-resume-cwd-unchanged',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        resumeCursor: {
          acpSessionId: 'native-kiro-cli',
          connectionId: 'kiro',
          connectionFingerprint: kiroFingerprint('/tmp/project'),
        },
      });

      expect(processes[0].loadSessionArgs).toEqual({
        sessionId: 'native-kiro-cli',
        cwd: '/tmp/project',
        mcpServers: [],
      });
    });

    test('startSession with an ACP resume cursor calls loadSession — not newSession — with the resolved passthrough mcpServers when the CLI advertises loadSession', async () => {
      const { adapter, processes } = createAdapter({
        loadSessionCapability: true,
        connectionOverrides: [
          { id: 'kiro', provideToolServers: ['filesystem'] },
        ],
        resolveToolServer: async (id) =>
          id === 'filesystem'
            ? {
                id: 'filesystem',
                kind: 'mcp',
                transport: 'stdio',
                command: process.execPath,
                args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
              }
            : null,
      });

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-resume-load',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        resumeCursor: {
          acpSessionId: 'native-kiro-cli',
          connectionId: 'kiro',
          connectionFingerprint: kiroFingerprint(),
        },
      });

      expect(processes[0].newSessionMcpServers).toBeUndefined();
      expect(processes[0].loadSessionArgs).toEqual({
        sessionId: 'native-kiro-cli',
        cwd: '/tmp/project',
        mcpServers: [
          {
            name: 'filesystem',
            command: process.execPath,
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            env: [],
          },
        ],
      });
    });

    test('startSession with an ACP resume cursor fails closed with a named error when the CLI does not advertise loadSession (no silent fresh session)', async () => {
      const { adapter, processes } = createAdapter({
        loadSessionCapability: false,
      });

      await expect(
        adapter.startSession({
          provider: 'acp',
          threadId: 'thread-resume-unsupported',
          cwd: '/tmp/project',
          metadata: { connectionId: 'kiro' },
          resumeCursor: {
            acpSessionId: 'native-kiro-cli',
            connectionId: 'kiro',
            connectionFingerprint: kiroFingerprint(),
          },
        }),
      ).rejects.toThrow(/does not advertise session loading/i);

      expect(processes[0].newSessionMcpServers).toBeUndefined();
      expect(processes[0].loadSessionArgs).toBeUndefined();
    });

    test('session.configured on the resume path merges the same toolServers delivery report as session/new (agent-authored source wins)', async () => {
      const { adapter } = createAdapter({ loadSessionCapability: true });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-resume-receipt',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        resumeCursor: {
          acpSessionId: 'native-kiro-cli',
          connectionId: 'kiro',
          connectionFingerprint: kiroFingerprint(),
        },
        agent: {
          slug: 'my-agent',
          toolServers: [
            {
              id: 'agent-tool',
              transport: 'stdio',
              command: process.execPath,
              args: [],
            },
          ],
        },
      });

      await nextEvent(iterator, 'session.started');
      const configured = await nextEvent(iterator, 'session.configured');
      if (configured.method !== 'session.configured') {
        throw new Error(
          `Expected session.configured, got ${configured.method}`,
        );
      }
      expect((configured.metadata as any).capabilityDelivery).toEqual({
        toolServers: {
          source: 'agent',
          requested: ['agent-tool'],
          delivered: ['agent-tool'],
          undelivered: [],
        },
      });
    });
  });

  test('persists only allowlisted effective model options in session metadata', async () => {
    const { adapter } = createAdapter({
      newSessionConfigOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'default-model',
          options: [{ value: 'claude-sonnet' }],
        },
      ],
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'acp',
      threadId: 'safe-model-metadata',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
      modelId: 'claude-sonnet',
      modelOptions: {
        effort: 'high',
        fastMode: true,
        prompt: 'private system prompt',
        credential: 'secret-token',
        providerPrivate: { internal: true },
      },
    });

    await nextEvent(iterator, 'session.started');
    const configured = await nextEvent(iterator, 'session.configured');
    if (configured.method !== 'session.configured') {
      throw new Error(`Expected session.configured, got ${configured.method}`);
    }
    expect(configured.metadata).toEqual({
      connectionId: 'kiro',
      effectiveModel: 'claude-sonnet',
      effectiveModelOptions: {
        effort: 'high',
        fastMode: true,
      },
      reportedModel: 'claude-sonnet',
      modelSelectionReceipt: {
        requestedModel: 'claude-sonnet',
        appliedModel: 'claude-sonnet',
      },
      // #895 wave A: an absent input.agent and no connection-level
      // provideToolServers still produce a fresh, empty connection-default
      // receipt — see acp-adapter.ts's capability-delivery merge.
      capabilityDelivery: {
        toolServers: {
          source: 'connection-default',
          requested: [],
          delivered: [],
          undelivered: [],
        },
      },
    });
    expect(configured.metadata).not.toHaveProperty('prompt');
    expect(configured.metadata).not.toHaveProperty('credential');
    expect(configured.metadata).not.toHaveProperty('providerPrivate');

    await adapter.stopAll();
  });

  test('sendTurn keeps the typed displayInput in turn.started while the ACP process receives the composed model input (#685)', async () => {
    const { adapter, processes } = createAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-ambient',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');

    await adapter.sendTurn({
      threadId: 'thread-ambient',
      input: '[Timezone: Iceland]\nwhat time is it?',
      displayInput: 'what time is it?',
    });

    const turnStarted = await nextEvent(iterator, 'turn.started');
    expect(turnStarted).toMatchObject({
      method: 'turn.started',
      prompt: 'what time is it?',
    });
    expect(processes[0].promptContents[0]).toEqual([
      { type: 'text', text: '[Timezone: Iceland]\nwhat time is it?' },
    ]);

    processes[0].resolvePrompt('end_turn');
    await nextEvent(iterator, 'turn.completed');
    await adapter.stopAll();
  });

  test('maps validated image attachments to ACP image content blocks', async () => {
    const { adapter, processes } = createAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-image',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');

    const result = await adapter.sendTurn({
      threadId: 'thread-image',
      input: 'Inspect this',
      attachments: [
        {
          kind: 'image',
          name: 'screen.png',
          mimeType: 'image/png',
          size: 3,
          dataUrl: 'data:image/png;base64,YWJj',
        },
      ],
    });

    expect(processes[0].promptContents).toEqual([
      [
        { type: 'text', text: 'Inspect this' },
        { type: 'image', data: 'YWJj', mimeType: 'image/png' },
      ],
    ]);
    await expect(nextEvent(iterator, 'turn.started')).resolves.toMatchObject({
      turnId: result.turnId,
      attachments: [
        expect.objectContaining({
          name: 'screen.png',
          mimeType: 'image/png',
        }),
      ],
    });
    processes[0].resolvePrompt('end_turn');
    await nextEvent(iterator, 'turn.completed');
    await adapter.stopAll();
  });

  test('rejects images when the live ACP handshake does not advertise them', async () => {
    const { adapter, processes } = createAdapter({ imageCapability: false });
    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-image-unsupported',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });

    await expect(
      adapter.sendTurn({
        threadId: 'thread-image-unsupported',
        input: 'Inspect this',
        attachments: [
          {
            kind: 'image',
            name: 'screen.png',
            mimeType: 'image/png',
            size: 3,
            dataUrl: 'data:image/png;base64,YWJj',
          },
        ],
      }),
    ).rejects.toThrow('did not advertise image attachment support');
    expect(processes[0].promptContents).toEqual([]);
    await adapter.stopAll();
  });

  test('resolves all four permission decisions against a stubbed process (AC2)', async () => {
    const decisions: Array<{
      decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
      outcome: RequestPermissionResponse['outcome'];
      status: string;
    }> = [
      {
        decision: 'accept',
        outcome: { outcome: 'selected', optionId: 'allow-once' },
        status: 'approved',
      },
      {
        decision: 'acceptForSession',
        outcome: { outcome: 'selected', optionId: 'allow-always' },
        status: 'approved',
      },
      {
        decision: 'decline',
        outcome: { outcome: 'selected', optionId: 'reject-once' },
        status: 'denied',
      },
      {
        decision: 'cancel',
        outcome: { outcome: 'cancelled' },
        status: 'cancelled',
      },
    ];

    for (const { decision, outcome, status } of decisions) {
      const { adapter, processes } = createAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-decision',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
      });
      await nextEvent(iterator, 'session.started');
      await nextEvent(iterator, 'session.configured');

      const proc = processes[0];
      const requestPromise = requestPermission(proc.client, 'tool-decision');
      const opened = await nextEvent(iterator, 'request.opened');

      await adapter.respondToRequest(
        'thread-decision',
        String(opened.requestId),
        decision,
      );
      await expect(requestPromise).resolves.toEqual({ outcome });

      const resolved = await nextEvent(iterator, 'request.resolved');
      expect(resolved).toMatchObject({
        method: 'request.resolved',
        status,
      });
    }
  });

  test('multiplexes two concurrent sessions against two different ACP connections', async () => {
    const { adapter, processes } = createAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-kiro',
      cwd: '/tmp/a',
      metadata: { connectionId: 'kiro' },
    });
    await nextEvent(iterator, 'session.started (kiro)');
    await nextEvent(iterator, 'session.configured (kiro)');

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-other',
      cwd: '/tmp/b',
      metadata: { connectionId: 'other' },
    });
    await nextEvent(iterator, 'session.started (other)');
    await nextEvent(iterator, 'session.configured (other)');

    expect(processes).toHaveLength(2);
    expect(processes[0].opts.command).toBe('kiro-cli');
    expect(processes[1].opts.command).toBe('other-cli');

    await adapter.sendTurn({ threadId: 'thread-kiro', input: 'hi kiro' });
    const kiroTurnStarted = await nextEvent(iterator, 'turn.started (kiro)');
    expect(kiroTurnStarted.threadId).toBe('thread-kiro');

    await adapter.sendTurn({ threadId: 'thread-other', input: 'hi other' });
    const otherTurnStarted = await nextEvent(iterator, 'turn.started (other)');
    expect(otherTurnStarted.threadId).toBe('thread-other');

    processes[0].resolvePrompt('end_turn');
    const kiroCompleted = await nextEvent(iterator, 'turn.completed (kiro)');
    expect(kiroCompleted.threadId).toBe('thread-kiro');
    expect(kiroCompleted).toMatchObject({ finishReason: 'stop' });

    processes[1].resolvePrompt('max_tokens');
    const otherCompleted = await nextEvent(iterator, 'turn.completed (other)');
    expect(otherCompleted.threadId).toBe('thread-other');
    expect(otherCompleted).toMatchObject({ finishReason: 'max-tokens' });

    const sessions = await adapter.listSessions();
    expect(sessions.map((s) => s.threadId).sort()).toEqual([
      'thread-kiro',
      'thread-other',
    ]);

    await adapter.stopAll();
    expect(processes[0].destroyed).toBe(true);
    expect(processes[1].destroyed).toBe(true);
    expect(await adapter.hasSession('thread-kiro')).toBe(false);
    expect(await adapter.hasSession('thread-other')).toBe(false);
  });

  test('publishes runtime.error and reflects error status when the ACP process rejects a prompt', async () => {
    const { adapter, processes } = createAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-error',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');

    await adapter.sendTurn({ threadId: 'thread-error', input: 'boom' });
    await nextEvent(iterator, 'turn.started');

    processes[0].rejectPrompt(new Error('agent crashed'));
    const errorEvent = await nextEvent(iterator, 'runtime.error');
    expect(errorEvent).toMatchObject({
      method: 'runtime.error',
      severity: 'error',
      message: 'agent crashed',
    });

    const sessions = await adapter.listSessions();
    expect(sessions[0].status).toBe('error');
  });

  // station#4084: reproduces the live #1860 kiro-cli evidence — a
  // notification bound to the `acp.turn-error-cause` consumer
  // (`_kiro.dev/error/rate_limit`, carrying the engine's own human-readable
  // message; see src-shared/extension-notification-bindings.ts for the
  // exact-tuple registry entry — review fix round F1) arrives milliseconds
  // before the same turn's `prompt()` rejects with a bare JSON-RPC -32603
  // ("Internal error", no detail). This is an integration probe through the
  // adapter's real event translation (`process.client.extNotification` is
  // the genuine `createACPBridgeClient`-built Client the SDK would call, not
  // a direct call into the pure mapper) — the mapper-level unit tests for
  // the retention/extraction rules live in acp-adapter-events.test.ts.
  describe('station#4084: turn-failure enrichment from a co-reported extension notification', () => {
    test('enriches a bare -32603 runtime.error with the rate-limit notification received earlier in the same turn', async () => {
      const { adapter, processes } = createAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-rate-limit',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
      });
      await nextEvent(iterator, 'session.started');
      await nextEvent(iterator, 'session.configured');

      await adapter.sendTurn({
        threadId: 'thread-rate-limit',
        input: 'do the thing',
      });
      await nextEvent(iterator, 'turn.started');

      // The engine's bound notification, received milliseconds before the
      // rejection (live #1860 shape).
      await processes[0].client.extNotification?.(
        '_kiro.dev/error/rate_limit',
        {
          message: 'The monthly usage limit has been reached',
        },
      );
      await nextEvent(iterator, 'extension.notification');

      // A bare JSON-RPC -32603 resolves to this literal, uninformative text.
      processes[0].rejectPrompt(new Error('Internal error'));
      const errorEvent = await nextEvent(iterator, 'runtime.error');
      // F5: correlation-honest wording — "also reported", not "the cause".
      expect(errorEvent).toMatchObject({
        method: 'runtime.error',
        severity: 'error',
        message:
          'Internal error — engine also reported during this turn: The monthly usage limit has been reached',
      });
    });

    // F4a (test power): with two notifications in one window, enrichment
    // must use the LAST one, not the first. Discriminating: fault-injecting
    // `.at(-1)` → `[0]` in acp-adapter.ts's sendTurn reds this specific test
    // (verified below via the commit-first injection protocol).
    test('last-wins: enrichment uses the most recently received notification when several arrive in one turn', async () => {
      const { adapter, processes } = createAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-last-wins',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
      });
      await nextEvent(iterator, 'session.started');
      await nextEvent(iterator, 'session.configured');

      await adapter.sendTurn({
        threadId: 'thread-last-wins',
        input: 'do the thing',
      });
      await nextEvent(iterator, 'turn.started');

      await processes[0].client.extNotification?.(
        '_kiro.dev/error/rate_limit',
        {
          message: 'first notification (should be superseded)',
        },
      );
      await nextEvent(iterator, 'extension.notification');
      await processes[0].client.extNotification?.(
        '_kiro.dev/error/rate_limit',
        {
          message: 'second notification (most recent)',
        },
      );
      await nextEvent(iterator, 'extension.notification');

      processes[0].rejectPrompt(new Error('Internal error'));
      const errorEvent = await nextEvent(iterator, 'runtime.error');
      expect(errorEvent).toMatchObject({
        method: 'runtime.error',
        message:
          'Internal error — engine also reported during this turn: second notification (most recent)',
      });
    });

    // F2 (required test): a notification tied to an interrupted, not-yet-
    // settled turn must not enrich a later turn's failure, even when it
    // arrives after that later turn has already started.
    test('quarantine: a prior turn notification delivered after interrupt AND after the next turn starts does not enrich the next turn', async () => {
      const { adapter, processes } = createAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-quarantine',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
      });
      await nextEvent(iterator, 'session.started');
      await nextEvent(iterator, 'session.configured');

      // Turn 1 starts, then is interrupted — its prompt() is cancelled but
      // (as in the real ACP process) does not settle synchronously with
      // cancel(); it remains pending in the fake's FIFO queue.
      await adapter.sendTurn({
        threadId: 'thread-quarantine',
        input: 'first',
      });
      await nextEvent(iterator, 'turn.started');
      await adapter.interruptTurn('thread-quarantine');
      await nextEvent(iterator, 'turn.aborted');

      // Turn 2 starts before turn 1's cancelled prompt() has settled.
      await adapter.sendTurn({
        threadId: 'thread-quarantine',
        input: 'second',
      });
      await nextEvent(iterator, 'turn.started');

      // A notification belonging to the CANCELLED turn 1 arrives now — after
      // both the interrupt and the start of turn 2. Provenance can't be
      // proven, so it must be quarantined (dropped for enrichment), even
      // though the ordinary transcript event still publishes.
      await processes[0].client.extNotification?.(
        '_kiro.dev/error/rate_limit',
        {
          message: 'This belongs to the cancelled turn 1, not turn 2',
        },
      );
      await nextEvent(iterator, 'extension.notification');

      // Turn 1's prompt() now settles (FIFO: it was queued before turn 2's).
      // Its handler must be a no-op on the canonical stream (turn 2 already
      // owns activeTurnId) and must clear the quarantine.
      processes[0].rejectPrompt(new Error('turn 1 cancelled internally'));

      // Turn 2 fails with no notification of its own.
      processes[0].rejectPrompt(new Error('Internal error'));
      const errorEvent = await nextEvent(iterator, 'runtime.error');
      expect(errorEvent).toMatchObject({
        method: 'runtime.error',
        severity: 'error',
        message: 'Internal error',
      });
    });

    // M1 (required discriminating test, reviewer's recipe): a LIVE
    // quarantinedTurnIds check reopens mid-turn once the cancelled prompt's
    // settlement handler deletes its (leak-cleanup) entry — a notification
    // delivered AFTER that deletion, but still within the replacement
    // turn's window, would then read as unquarantined even though its
    // provenance is exactly as ambiguous as one delivered before. The fix
    // is a per-turn snapshot taken once at turn start, immune to that later
    // deletion. This test settles turn 1's prompt BEFORE the late
    // notification arrives — the opposite order from the test above — so it
    // fails under the live-set check but passes under the snapshot.
    test(
      'quarantine (M1): a prior turn notification delivered AFTER that turn' +
        "'s settlement handler clears the live quarantine set still does not enrich the next turn",
      async () => {
        const { adapter, processes } = createAdapter();
        const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

        await adapter.startSession({
          provider: 'acp',
          threadId: 'thread-quarantine-m1',
          cwd: '/tmp/project',
          metadata: { connectionId: 'kiro' },
        });
        await nextEvent(iterator, 'session.started');
        await nextEvent(iterator, 'session.configured');

        // Turn 1 starts, then is interrupted.
        await adapter.sendTurn({
          threadId: 'thread-quarantine-m1',
          input: 'first',
        });
        await nextEvent(iterator, 'turn.started');
        await adapter.interruptTurn('thread-quarantine-m1');
        await nextEvent(iterator, 'turn.aborted');

        // Turn 2 starts before turn 1's cancelled prompt() has settled — its
        // suppression snapshot is taken now, while quarantinedTurnIds is
        // still non-empty (turn 1's entry hasn't been removed yet).
        await adapter.sendTurn({
          threadId: 'thread-quarantine-m1',
          input: 'second',
        });
        await nextEvent(iterator, 'turn.started');

        // Turn 1's prompt() settles NOW (FIFO: queued before turn 2's) — its
        // handler deletes turn 1's id from the live quarantinedTurnIds set
        // (leak cleanup), which is a no-op on the canonical stream since
        // turn 2 already owns activeTurnId.
        processes[0].rejectPrompt(new Error('turn 1 cancelled internally'));

        // ONLY NOW does the late notification for the cancelled turn 1
        // arrive — after the live set has already been cleared. Under a
        // live-set check this would read as unquarantined; the snapshot
        // taken at turn 2's start must still suppress it.
        await processes[0].client.extNotification?.(
          '_kiro.dev/error/rate_limit',
          {
            message: 'This still belongs to the cancelled turn 1, not turn 2',
          },
        );
        await nextEvent(iterator, 'extension.notification');

        // Turn 2 fails with no notification of its own.
        processes[0].rejectPrompt(new Error('Internal error'));
        const errorEvent = await nextEvent(iterator, 'runtime.error');
        expect(errorEvent).toMatchObject({
          method: 'runtime.error',
          severity: 'error',
          message: 'Internal error',
        });
      },
    );

    test('guard: a bare -32603 with no prior bound notification reports the generic error unchanged', async () => {
      const { adapter, processes } = createAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-no-notification',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
      });
      await nextEvent(iterator, 'session.started');
      await nextEvent(iterator, 'session.configured');

      await adapter.sendTurn({
        threadId: 'thread-no-notification',
        input: 'do the thing',
      });
      await nextEvent(iterator, 'turn.started');

      // No extension notification of any kind arrives this turn — the
      // adapter must never synthesize a cause it did not receive.
      processes[0].rejectPrompt(new Error('Internal error'));
      const errorEvent = await nextEvent(iterator, 'runtime.error');
      expect(errorEvent).toMatchObject({
        method: 'runtime.error',
        severity: 'error',
        message: 'Internal error',
      });
    });

    test('guard: a bound notification from a prior, already-settled turn does not enrich a later failure', async () => {
      const { adapter, processes } = createAdapter();
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-stale-notification',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
      });
      await nextEvent(iterator, 'session.started');
      await nextEvent(iterator, 'session.configured');

      // First turn: receives the notification but succeeds — the cause must
      // not linger to enrich a later, unrelated failure.
      await adapter.sendTurn({
        threadId: 'thread-stale-notification',
        input: 'first',
      });
      await nextEvent(iterator, 'turn.started');
      await processes[0].client.extNotification?.(
        '_kiro.dev/error/rate_limit',
        {
          message: 'The monthly usage limit has been reached',
        },
      );
      await nextEvent(iterator, 'extension.notification');
      processes[0].resolvePrompt('end_turn');
      await nextEvent(iterator, 'turn.completed');

      // Second turn: fails with no notification of its own.
      await adapter.sendTurn({
        threadId: 'thread-stale-notification',
        input: 'second',
      });
      await nextEvent(iterator, 'turn.started');
      processes[0].rejectPrompt(new Error('Internal error'));
      const errorEvent = await nextEvent(iterator, 'runtime.error');
      expect(errorEvent).toMatchObject({
        method: 'runtime.error',
        severity: 'error',
        message: 'Internal error',
      });
    });
  });

  test('throws for an unknown ACP connection id', async () => {
    const { adapter } = createAdapter();
    await expect(
      adapter.startSession({
        provider: 'acp',
        threadId: 'thread-unknown',
        cwd: '/tmp/project',
        metadata: { connectionId: 'does-not-exist' },
      }),
    ).rejects.toThrow(/unknown acp connection/i);
  });

  test('retains a failed startup process until cleanup can be retried', async () => {
    const processes: FakeAcpProcess[] = [];
    const adapter = new AcpAdapter({
      getConnections: async () => createConnections(),
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
      processFactory: (options) => {
        const process = new FakeAcpProcess(options);
        process.startError = new Error('startup failed');
        process.destroyError = new Error('cleanup failed');
        processes.push(process);
        return process as unknown as ACPProcess;
      },
    });

    await expect(
      adapter.startSession({
        provider: 'acp',
        threadId: 'startup-cleanup-failure',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
      }),
    ).rejects.toThrow(
      'ACP session startup failed and process cleanup was not confirmed',
    );
    await expect(adapter.hasSession('startup-cleanup-failure')).resolves.toBe(
      true,
    );

    processes[0].destroyError = undefined;
    await adapter.stopSession('startup-cleanup-failure');
    await expect(adapter.hasSession('startup-cleanup-failure')).resolves.toBe(
      false,
    );
  });

  test('L1: stopSession settles an outstanding pending permission request as cancelled', async () => {
    const { adapter, processes } = createAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-stop-pending',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');

    const proc = processes[0];
    // Open a mid-turn permission request but never call respondToRequest —
    // stopSession must settle it instead of leaking the promise.
    const requestPromise = requestPermission(proc.client, 'tool-pending');
    const opened = await nextEvent(iterator, 'request.opened');
    expect(opened.method).toBe('request.opened');

    await adapter.stopSession('thread-stop-pending');

    await expect(requestPromise).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });

    const resolved = await nextEvent(iterator, 'request.resolved');
    expect(resolved).toMatchObject({
      method: 'request.resolved',
      requestId: opened.requestId,
      status: 'cancelled',
    });

    const exited = await nextEvent(iterator, 'session.exited');
    expect(exited.method).toBe('session.exited');
  });

  test('retains process ownership and withholds session.exited when teardown fails', async () => {
    const { adapter, processes } = createAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-stop-failure',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');
    processes[0].destroyError = new Error('termination not confirmed');

    await expect(adapter.stopSession('thread-stop-failure')).rejects.toThrow(
      'termination not confirmed',
    );
    await expect(adapter.hasSession('thread-stop-failure')).resolves.toBe(true);

    processes[0].destroyError = undefined;
    await adapter.stopSession('thread-stop-failure');
    await expect(adapter.hasSession('thread-stop-failure')).resolves.toBe(
      false,
    );
    await expect(nextEvent(iterator, 'session.exited')).resolves.toMatchObject({
      method: 'session.exited',
      threadId: 'thread-stop-failure',
    });
  });

  test('rejects new work and ignores late prompt settlement while stopping', async () => {
    const { adapter, processes } = createAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-stopping',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');
    await adapter.sendTurn({ threadId: 'thread-stopping', input: 'first' });
    await nextEvent(iterator, 'turn.started');
    let finishDestroy!: () => void;
    processes[0].destroyPromise = new Promise<void>((resolve) => {
      finishDestroy = resolve;
    });

    const stopping = adapter.stopSession('thread-stopping');
    await expect(
      adapter.sendTurn({ threadId: 'thread-stopping', input: 'second' }),
    ).rejects.toThrow('Unknown ACP session');
    processes[0].resolvePrompt('end_turn');
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishDestroy();
    await stopping;

    expect((await iterator.next()).value.method).toBe('session.exited');
  });

  test('does not publish completion from a superseded ACP turn', async () => {
    const { adapter, processes } = createAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-stale-turn',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');

    const first = await adapter.sendTurn({
      threadId: 'thread-stale-turn',
      input: 'first',
    });
    await nextEvent(iterator, 'first turn.started');
    await adapter.interruptTurn('thread-stale-turn', first.turnId);
    await nextEvent(iterator, 'first turn.aborted');
    await adapter.sendTurn({ threadId: 'thread-stale-turn', input: 'second' });
    await nextEvent(iterator, 'second turn.started');

    processes[0].resolvePrompt('end_turn');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await adapter.listSessions())[0].status).toBe('running');
  });

  test('does not cancel the active ACP turn for a mismatched turn id', async () => {
    const { adapter, processes } = createAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-mismatched-interrupt',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');

    const active = await adapter.sendTurn({
      threadId: 'thread-mismatched-interrupt',
      input: 'first',
    });
    await nextEvent(iterator, 'turn.started');

    await expect(
      adapter.interruptTurn('thread-mismatched-interrupt', 'different-turn'),
    ).resolves.toEqual(
      expect.objectContaining({
        outcome: 'target-mismatch',
        activeTurnId: active.turnId,
      }),
    );
    expect(processes[0].cancelCalls).toBe(0);
    expect((await adapter.listSessions())[0].status).toBe('running');

    processes[0].resolvePrompt('end_turn');
    await expect(nextEvent(iterator, 'turn.completed')).resolves.toMatchObject({
      method: 'turn.completed',
      turnId: active.turnId,
    });
  });

  test('rejects a concurrent turn while the session already has an owner', async () => {
    const { adapter, processes } = createAdapter();
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-single-owner',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');

    const first = await adapter.sendTurn({
      threadId: 'thread-single-owner',
      input: 'first',
    });
    await nextEvent(iterator, 'first turn.started');

    await expect(
      adapter.sendTurn({
        threadId: 'thread-single-owner',
        input: 'second',
      }),
    ).rejects.toThrow('already has an active turn');

    processes[0].resolvePrompt('end_turn');
    await expect(
      nextEvent(iterator, 'first turn.completed'),
    ).resolves.toMatchObject({
      method: 'turn.completed',
      turnId: first.turnId,
    });
  });
});

describe('station#1182: runtime-reported model', () => {
  test("a fresh newSession's model-category config option currentValue is captured as reportedModel", async () => {
    const { adapter } = createAdapter({
      newSessionConfigOptions: [
        {
          id: 'reasoning-level',
          name: 'Reasoning',
          type: 'select',
          category: 'thought_level',
          currentValue: 'high',
          options: [],
        },
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          category: 'model',
          currentValue: 'kiro-native-opus-4-5',
          options: [
            { value: 'kiro-native-opus-4-5', name: 'Opus 4.5' },
            { value: 'kiro-native-sonnet-5', name: 'Sonnet 5' },
          ],
        },
      ],
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-reported-model',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });
    await nextEvent(iterator, 'session.started');
    const configured = await nextEvent(iterator, 'session.configured');

    expect(configured.method).toBe('session.configured');
    if (configured.method !== 'session.configured') return;
    expect(configured.model).toBeUndefined();
    expect(configured.metadata?.effectiveModel).toBeUndefined();
    expect(configured.metadata?.reportedModel).toBe('kiro-native-opus-4-5');

    await adapter.stopAll();
  });

  test('no model-category config option present leaves reportedModel absent — never inferred from other option categories', async () => {
    const { adapter } = createAdapter({
      newSessionConfigOptions: [
        {
          id: 'reasoning-level',
          name: 'Reasoning',
          type: 'select',
          category: 'thought_level',
          currentValue: 'high',
          options: [],
        },
      ],
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-no-model-option',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });
    await nextEvent(iterator, 'session.started');
    const configured = await nextEvent(iterator, 'session.configured');

    expect(configured.method).toBe('session.configured');
    if (configured.method !== 'session.configured') return;
    expect(configured.metadata?.reportedModel).toBeUndefined();

    await adapter.stopAll();
  });

  test('an agent with no configOptions at all (the common case today) leaves reportedModel absent, never zero/empty-string', async () => {
    const { adapter } = createAdapter({ newSessionConfigOptions: [] });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-no-options',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });
    await nextEvent(iterator, 'session.started');
    const configured = await nextEvent(iterator, 'session.configured');

    expect(configured.method).toBe('session.configured');
    if (configured.method !== 'session.configured') return;
    expect(configured.metadata?.reportedModel).toBeUndefined();
    expect('reportedModel' in (configured.metadata ?? {})).toBe(false);

    await adapter.stopAll();
  });

  test('applies an advertised start-time model and records only the engine-confirmed value', async () => {
    const { adapter, processes } = createAdapter({
      newSessionConfigOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'model-a',
          options: [{ value: 'model-a' }, { value: 'model-b' }],
        },
      ],
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-model-applied',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
      modelId: 'model-b',
    });
    await nextEvent(iterator, 'session.started');
    const configured = await nextEvent(iterator, 'session.configured');

    expect(processes[0].setConfigOptionCalls).toEqual([
      { configId: 'model', value: 'model-b' },
    ]);
    expect(configured).toMatchObject({
      method: 'session.configured',
      model: 'model-b',
      metadata: {
        reportedModel: 'model-b',
        modelSelectionReceipt: {
          requestedModel: 'model-b',
          appliedModel: 'model-b',
        },
      },
    });

    await adapter.stopAll();
  });

  test('refuses a requested model when the fresh session has no model option', async () => {
    const { adapter, processes } = createAdapter({
      newSessionConfigOptions: [],
    });

    await expect(
      adapter.startSession({
        provider: 'acp',
        threadId: 'thread-model-option-absent',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        modelId: 'model-b',
      }),
    ).rejects.toThrow('ACP model option unavailable');
    expect(processes[0].setConfigOptionCalls).toEqual([]);
  });

  test('refuses a value outside the fresh model option catalog without invoking the engine', async () => {
    const { adapter, processes } = createAdapter({
      newSessionConfigOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'model-a',
          options: [{ value: 'model-a' }],
        },
      ],
    });

    await expect(
      adapter.startSession({
        provider: 'acp',
        threadId: 'thread-model-value-absent',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        modelId: 'model-b',
      }),
    ).rejects.toThrow('ACP model value unsupported');
    expect(processes[0].setConfigOptionCalls).toEqual([]);
  });

  test('fails closed when the engine response does not confirm the requested currentValue', async () => {
    const { adapter, processes } = createAdapter({
      newSessionConfigOptions: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'model-a',
          options: [{ value: 'model-a' }, { value: 'model-b' }],
        },
      ],
      onProcess: (process) => {
        process.setConfigOptionResponse = {
          configOptions: [
            {
              id: 'model',
              category: 'model',
              currentValue: 'model-a',
              options: [{ value: 'model-a' }, { value: 'model-b' }],
            },
          ],
        };
      },
    });

    await expect(
      adapter.startSession({
        provider: 'acp',
        threadId: 'thread-model-unverified',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        modelId: 'model-b',
      }),
    ).rejects.toThrow('ACP model application unverified');
    expect(processes[0].setConfigOptionCalls).toHaveLength(1);
    expect(processes[0].destroyCalls).toBe(1);
  });

  test('keeps matrix and adapter lifecycle claims aligned', () => {
    const { adapter } = createAdapter();
    expect(ENGINE_CAPABILITY_MATRICES.acp.modelSelection).toEqual({
      state: 'session',
      channel: 'wire',
    });
    expect(adapter.metadata.modelLaunch.overridePerTurn).toBe(
      ACP_MODEL_OVERRIDE_PER_TURN,
    );
  });
});

/**
 * station#1684 — the LIVE gate for the built-in station-control server.
 *
 * The `acp` matrix cell names a delivery mechanism whose basis is
 * `runtime_observation`: the cell says a reviewed mechanism EXISTS, and this
 * gate is what makes the claim true (or not) for one connection. These tests
 * are the ones that would fail if the gate were removed, weakened into a
 * single boolean, or allowed to take the session down with it.
 */
describe('station#1684: station-control over ACP HTTP MCP', () => {
  const STATION_CONTROL_URL = 'http://127.0.0.1:3141/mcp/station-control';
  const TOKEN = 'tok_acp_gate_0123456789';

  /** A resolved agent authoring the genuine built-in station-control server. */
  const agentWithStationControl = {
    slug: 'my-agent',
    toolServers: [
      {
        id: 'station-control',
        transport: 'stdio' as const,
        command: 'node',
        args: [builtinStationControlServerPath()],
      },
    ],
  };

  function stationControlEntry(servers: unknown[] | undefined) {
    return (servers ?? []).find(
      (server) => (server as { name?: string }).name === 'station-control',
    ) as Record<string, unknown> | undefined;
  }

  async function configuredEvent(
    iterator: AsyncIterator<CanonicalRuntimeEvent>,
  ) {
    await nextEvent(iterator, 'session.started');
    const configured = await nextEvent(iterator, 'session.configured');
    if (configured.method !== 'session.configured') {
      throw new Error(`Expected session.configured, got ${configured.method}`);
    }
    return configured;
  }

  test('GATE ON: mcpCapabilities.http === true ⇒ newSession receives the http station-control entry with the Bearer header', async () => {
    const mintStationControlMcpAuth = vi.fn(() => ({
      url: STATION_CONTROL_URL,
      token: TOKEN,
    }));
    const { adapter, processes } = createAdapter({
      mcpHttpCapability: true,
      mintStationControlMcpAuth,
    });

    const session = await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-gate-on',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
      agent: agentWithStationControl,
    });

    expect(mintStationControlMcpAuth).toHaveBeenCalledWith('thread-gate-on');
    const entry = stationControlEntry(processes[0]?.newSessionMcpServers);
    expect(entry).toEqual({
      type: 'http',
      name: 'station-control',
      url: STATION_CONTROL_URL,
      headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }],
    });
    // The credential must not have leaked into the session record the
    // orchestration layer persists.
    expect(JSON.stringify(session)).not.toContain(TOKEN);

    await adapter.stopAll();
  });

  test('GATE ON: the tenant execution context is threaded into the mint, exactly as codex-adapter does', async () => {
    const mintStationControlMcpAuth = vi.fn(() => ({
      url: STATION_CONTROL_URL,
      token: TOKEN,
    }));
    const { adapter } = createAdapter({
      mcpHttpCapability: true,
      mintStationControlMcpAuth,
    });

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-gate-tenant',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
      agent: agentWithStationControl,
      tenantExecutionContext: { tenantId: 'tenant-a' } as any,
    });

    expect(mintStationControlMcpAuth).toHaveBeenCalledWith(
      'thread-gate-tenant',
      { tenantId: 'tenant-a' },
    );

    await adapter.stopAll();
  });

  test('GATE OFF (engine observed NO): no mint, no station-control entry, session still reaches ready and publishes session.configured with an engine-capability-absent receipt', async () => {
    const mintStationControlMcpAuth = vi.fn();
    const { adapter, processes } = createAdapter({
      mcpHttpCapability: false,
      mintStationControlMcpAuth,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const session = await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-gate-off',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
      agent: agentWithStationControl,
    });

    // Fail CLOSED, not fail LOUD: the user still gets a working chat session.
    expect(session.status).toBe('ready');
    expect(mintStationControlMcpAuth).not.toHaveBeenCalled();
    expect(
      stationControlEntry(processes[0]?.newSessionMcpServers),
    ).toBeUndefined();
    // ...and specifically not by some other route: nothing named
    // station-control reached the wire at all, in any transport.
    expect(
      JSON.stringify(processes[0]?.newSessionMcpServers ?? []),
    ).not.toContain(builtinStationControlServerPath());

    const configured = await configuredEvent(iterator);
    const report = (configured.metadata as any).capabilityDelivery.toolServers;
    expect(report.delivered).not.toContain('station-control');
    expect(report.undelivered).toEqual([
      {
        capability: 'toolServers',
        id: 'station-control',
        reason: 'engine-capability-absent',
        detail:
          'the connected engine did not advertise mcpCapabilities.http at initialize',
      },
    ]);

    await adapter.stopAll();
  });

  test('GATE OFF: newSession is called exactly ONCE — the refusal never retries the session start', async () => {
    const { adapter, processes } = createAdapter({
      mcpHttpCapability: false,
      mintStationControlMcpAuth: vi.fn(),
    });

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-gate-no-retry',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
      agent: agentWithStationControl,
    });

    expect(processes).toHaveLength(1);
    expect(processes[0]?.newSessionCalls).toBe(1);

    await adapter.stopAll();
  });

  test('NO initResult: same fail-closed outcome, but a receipt that says the capability could NOT BE OBSERVED — distinguishable from the engine saying no', async () => {
    const mintStationControlMcpAuth = vi.fn();
    const { adapter, processes } = createAdapter({
      noInitResult: true,
      mintStationControlMcpAuth,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const session = await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-gate-no-init',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
      agent: agentWithStationControl,
    });

    expect(session.status).toBe('ready');
    expect(mintStationControlMcpAuth).not.toHaveBeenCalled();
    expect(
      stationControlEntry(processes[0]?.newSessionMcpServers),
    ).toBeUndefined();

    const configured = await configuredEvent(iterator);
    const report = (configured.metadata as any).capabilityDelivery.toolServers;
    expect(report.undelivered).toEqual([
      {
        capability: 'toolServers',
        id: 'station-control',
        reason: 'engine-capability-absent',
        detail:
          "no initialize result was available for this session; the engine's MCP HTTP capability could not be observed",
      },
    ]);
    // The whole point of keeping the two cases apart.
    expect(report.undelivered[0].detail).toContain('could not be observed');
    expect(report.undelivered[0].detail).not.toContain('did not advertise');

    await adapter.stopAll();
  });

  test('the engine said yes but Station minted nothing: reported as delivery-failed, never blamed on the engine', async () => {
    // A Station-side wiring gap (no closure, or a closure returning
    // undefined) must not produce a receipt asserting the CLI refused.
    const { adapter } = createAdapter({
      mcpHttpCapability: true,
      mintStationControlMcpAuth: vi.fn(() => undefined),
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-gate-mint-null',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
      agent: agentWithStationControl,
    });

    const configured = await configuredEvent(iterator);
    const report = (configured.metadata as any).capabilityDelivery.toolServers;
    expect(report.undelivered).toEqual([
      {
        capability: 'toolServers',
        id: 'station-control',
        reason: 'delivery-failed',
        detail:
          'the engine advertised mcpCapabilities.http, but no station-control MCP auth could be minted for this session',
      },
    ]);

    await adapter.stopAll();
  });

  test('a session that never asked for station-control never mints, whatever the engine advertises', async () => {
    const mintStationControlMcpAuth = vi.fn(() => ({
      url: STATION_CONTROL_URL,
      token: TOKEN,
    }));
    const { adapter } = createAdapter({
      mcpHttpCapability: true,
      mintStationControlMcpAuth,
    });

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-gate-unrelated',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
      agent: { slug: 'my-agent', toolServers: [] },
    });

    expect(mintStationControlMcpAuth).not.toHaveBeenCalled();

    await adapter.stopAll();
  });

  test('the token is revoked on ordinary session stop', async () => {
    const revokeStationControlMcpAuth = vi.fn();
    const { adapter } = createAdapter({
      mcpHttpCapability: true,
      mintStationControlMcpAuth: () => ({
        url: STATION_CONTROL_URL,
        token: TOKEN,
      }),
      revokeStationControlMcpAuth,
    });

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-gate-revoke',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
      agent: agentWithStationControl,
    });
    expect(revokeStationControlMcpAuth).not.toHaveBeenCalled();

    await adapter.stopSession('thread-gate-revoke');

    expect(revokeStationControlMcpAuth).toHaveBeenCalledWith(
      'thread-gate-revoke',
    );
  });

  test('#1850: stopAll invalidates a blocked credential recovery before it can replace the child or token', async () => {
    const liveTokens = new Map<string, string>();
    const revokedTokens: string[] = [];
    let issued = 0;
    const { adapter, processes } = createAdapter({
      loadSessionCapability: true,
      mcpHttpCapability: true,
      mintStationControlMcpAuth: (threadId) => {
        const token = `station-control-${++issued}`;
        liveTokens.set(threadId, token);
        return { url: STATION_CONTROL_URL, token };
      },
      revokeStationControlMcpAuth: (threadId) => {
        const token = liveTokens.get(threadId);
        if (token) revokedTokens.push(token);
        liveTokens.delete(threadId);
      },
    });
    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-stop-wins-credential-recovery',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
      agent: agentWithStationControl,
    });
    let releaseDestroy!: () => void;
    processes[0]!.destroyPromise = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });

    await expect(
      processes[0]!.client.extMethod!('_kiro/auth/getAccessToken', {}),
    ).rejects.toMatchObject({ code: -32601 });
    await vi.waitFor(() => expect(processes[0]!.destroyCalls).toBe(1));

    const stopped = adapter.stopAll();
    expect(processes).toHaveLength(1);
    releaseDestroy();
    await stopped;

    expect(processes).toHaveLength(1);
    expect(processes.filter((process) => !process.destroyed)).toEqual([]);
    await expect(adapter.listSessions()).resolves.toEqual([]);
    expect(liveTokens).toEqual(new Map());
    expect(revokedTokens).toEqual(['station-control-1']);
  });

  test('#1850: stopSession also wins a recovery that is waiting for process teardown', async () => {
    const { adapter, processes } = createAdapter({
      loadSessionCapability: true,
    });
    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-stop-session-wins-credential-recovery',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
    });
    let releaseDestroy!: () => void;
    processes[0]!.destroyPromise = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });

    await expect(
      processes[0]!.client.extMethod!('_kiro/auth/getAccessToken', {}),
    ).rejects.toMatchObject({ code: -32601 });
    await vi.waitFor(() => expect(processes[0]!.destroyCalls).toBe(1));

    const stopped = adapter.stopSession(
      'thread-stop-session-wins-credential-recovery',
    );
    releaseDestroy();
    await stopped;

    expect(processes).toHaveLength(1);
    expect(processes[0]!.destroyed).toBe(true);
    await expect(adapter.listSessions()).resolves.toEqual([]);
    await adapter.stopAll();
  });

  test('#1850: destroy failure revokes the station-control token and quarantines the failed recovery', async () => {
    const liveTokens = new Map<string, string>();
    const { adapter, processes } = createAdapter({
      loadSessionCapability: true,
      mcpHttpCapability: true,
      mintStationControlMcpAuth: (threadId) => {
        const token = 'station-control-destroy-failure';
        liveTokens.set(threadId, token);
        return { url: STATION_CONTROL_URL, token };
      },
      revokeStationControlMcpAuth: (threadId) => {
        liveTokens.delete(threadId);
      },
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-destroy-failure-credential-recovery',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
      agent: agentWithStationControl,
    });
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');
    processes[0]!.destroyError = new Error('termination not confirmed');

    await expect(
      processes[0]!.client.extMethod!('_kiro/auth/getAccessToken', {}),
    ).rejects.toMatchObject({ code: -32601 });
    await vi.waitFor(() => expect(liveTokens).toEqual(new Map()));
    await expect(
      adapter.hasSession('thread-destroy-failure-credential-recovery'),
    ).resolves.toBe(true);
    await expect(nextEvent(iterator, 'runtime.error')).resolves.toMatchObject({
      message:
        'The engine process could not be terminated during credential-refusal recovery.',
    });

    processes[0]!.destroyError = undefined;
    await adapter.stopAll();
  });

  test('#1850: replacement station-control authority is rotated without forwarding the opaque credential profile reference', async () => {
    const liveTokens = new Map<string, string>();
    const revokedTokens: string[] = [];
    let issued = 0;
    const engineCredentialCanary = 'engine-credential-canary-not-for-station';
    const { adapter, processes } = createAdapter({
      loadSessionCapability: true,
      mcpHttpCapability: true,
      mintStationControlMcpAuth: (threadId) => {
        const token = `station-control-rotated-${++issued}`;
        liveTokens.set(threadId, token);
        return { url: STATION_CONTROL_URL, token };
      },
      revokeStationControlMcpAuth: (threadId) => {
        const token = liveTokens.get(threadId);
        if (token) revokedTokens.push(token);
        liveTokens.delete(threadId);
      },
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-rotated-station-control',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
      credentialProfileRef: engineCredentialCanary,
      agent: agentWithStationControl,
    });
    const initialStarted = await nextEvent(iterator, 'session.started');
    expect(
      JSON.stringify(
        (initialStarted as { metadata?: Record<string, unknown> }).metadata,
      ),
    ).not.toContain(engineCredentialCanary);
    await nextEvent(iterator, 'session.configured');
    const original = stationControlEntry(processes[0]!.newSessionMcpServers);
    expect(original?.headers).toEqual([
      { name: 'Authorization', value: 'Bearer station-control-rotated-1' },
    ]);

    await expect(
      processes[0]!.client.extMethod!('_kiro/auth/getAccessToken', {}),
    ).rejects.toMatchObject({ code: -32601 });
    await vi.waitFor(() => expect(processes).toHaveLength(2));
    await nextEvent(iterator, 'session.exited');
    const replacementStarted = await nextEvent(iterator, 'session.started');
    expect(
      JSON.stringify(
        (replacementStarted as { metadata?: Record<string, unknown> }).metadata,
      ),
    ).not.toContain(engineCredentialCanary);
    const replacementConfigured = await nextEvent(
      iterator,
      'session.configured',
    );
    expect(
      JSON.stringify(
        (replacementConfigured as { metadata?: Record<string, unknown> })
          .metadata,
      ),
    ).not.toContain(engineCredentialCanary);

    const replacement = stationControlEntry(
      processes[1]!.loadSessionArgs?.mcpServers,
    );
    expect(replacement?.headers).toEqual([
      { name: 'Authorization', value: 'Bearer station-control-rotated-2' },
    ]);
    expect(revokedTokens).toEqual(['station-control-rotated-1']);
    expect(liveTokens).toEqual(
      new Map([
        ['thread-rotated-station-control', 'station-control-rotated-2'],
      ]),
    );
    expect(
      JSON.stringify({
        launch: processes.map((process) => ({
          command: process.opts.command,
          args: process.opts.args,
          cwd: process.opts.cwd,
        })),
        load: processes[1]!.loadSessionArgs,
      }),
    ).not.toContain(engineCredentialCanary);

    await adapter.stopAll();
  });

  test('the token is revoked when the session start FAILS after minting', async () => {
    const revokeStationControlMcpAuth = vi.fn();
    const { adapter } = createAdapter({
      // A resume cursor against a CLI that does not advertise loadSession is
      // the adapter's existing fail-closed start path.
      mcpHttpCapability: true,
      loadSessionCapability: false,
      mintStationControlMcpAuth: () => ({
        url: STATION_CONTROL_URL,
        token: TOKEN,
      }),
      revokeStationControlMcpAuth,
    });

    await expect(
      adapter.startSession({
        provider: 'acp',
        threadId: 'thread-gate-failed-start',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        agent: agentWithStationControl,
        resumeCursor: {
          acpSessionId: 'native-kiro-cli',
          connectionId: 'kiro',
          connectionFingerprint: acpConnectionFingerprint(
            acpExecutionIdentity({
              command: 'kiro-cli',
              args: [],
              effectiveCwd: '/tmp/project',
            }),
          ),
        },
      }),
    ).rejects.toThrow(/session loading/i);

    expect(revokeStationControlMcpAuth).toHaveBeenCalledWith(
      'thread-gate-failed-start',
    );
  });

  /**
   * station#1684 review fix (uncaught injection #11).
   *
   * The `GATE OFF: newSession is called exactly ONCE` test above only ever
   * observed the SUCCESS path — nothing drove `session/new` to reject, so a
   * `.catch(e => e.code === -32602 ? acpProcess.newSession(cwd, []) : throw)`
   * retry could be added and the whole file stayed green. That retry is
   * exactly the scenario the issue names: gemini-cli 0.4.0 does not advertise
   * `mcpCapabilities.http`, and a CLI that rejects `session/new` with
   * `-32602` (invalid params) for an mcpServers payload it cannot accept must
   * fail the start, not be re-asked without its tool servers.
   */
  // Delta review (LOW-2): pinning ONE code was the same shape that let the
  // gap through originally — a retry keyed on a different code stays green.
  // ADR 0013 records that Kiro v3 answers `-32603` where v2 answers `-32601`,
  // so a code-specific guard is not hypothetically narrow, it is narrow now.
  // The rule is about the RETRY, not the code: any rejection, one ask.
  const SESSION_START_REJECTIONS: ReadonlyArray<[string, unknown]> = [
    [
      '-32602 invalid params (the gemini-cli 0.4.0 scenario the issue names)',
      Object.assign(new Error('invalid params: mcpServers[0].type'), {
        code: -32602,
      }),
    ],
    [
      '-32603 internal error (Kiro v3 answers this where v2 answers -32601)',
      Object.assign(new Error('internal error'), { code: -32603 }),
    ],
    [
      '-32601 method not found',
      Object.assign(new Error('method not found'), { code: -32601 }),
    ],
    ['a plain Error carrying no JSON-RPC code at all', new Error('boom')],
  ];

  test.each(SESSION_START_REJECTIONS)(
    'session/new rejecting with %s fails the start — NO retry-without-mcpServers',
    async (_label, rejection) => {
      const { adapter, processes } = createAdapter({
        mcpHttpCapability: true,
        mintStationControlMcpAuth: () => ({
          url: STATION_CONTROL_URL,
          token: TOKEN,
        }),
        newSessionError: rejection,
      });

      await expect(
        adapter.startSession({
          provider: 'acp',
          threadId: 'thread-gate-reject',
          cwd: '/tmp/project',
          metadata: { connectionId: 'kiro' },
          agent: agentWithStationControl,
        }),
      ).rejects.toThrow();

      // The whole claim: one ask, no second ask on a narrower payload. A
      // retry would silently hand the user a session missing the tool servers
      // they asked for, with nothing recorded about it.
      expect(processes).toHaveLength(1);
      expect(processes[0]?.newSessionCalls).toBe(1);
      // And the first (only) ask really did carry the http entry — otherwise
      // "no retry" would be true for an uninteresting reason.
      expect(
        stationControlEntry(processes[0]?.newSessionMcpServers),
      ).toBeTruthy();
    },
  );

  test.each(SESSION_START_REJECTIONS)(
    'session/load rejecting with %s fails the resume — NO retry-without-mcpServers',
    async (_label, rejection) => {
      // The resume branch delivers the IDENTICAL mcpServers payload, so it
      // carries the identical retry temptation and had no equivalent test.
      const { adapter, processes } = createAdapter({
        mcpHttpCapability: true,
        loadSessionCapability: true,
        mintStationControlMcpAuth: () => ({
          url: STATION_CONTROL_URL,
          token: TOKEN,
        }),
        loadSessionError: rejection,
      });

      await expect(
        adapter.startSession({
          provider: 'acp',
          threadId: 'thread-resume-reject',
          cwd: '/tmp/project',
          metadata: { connectionId: 'kiro' },
          agent: agentWithStationControl,
          resumeCursor: {
            acpSessionId: 'native-kiro-cli',
            connectionId: 'kiro',
            // Same derivation the resume suite uses; recomputed locally
            // because that helper is scoped to its own describe block.
            connectionFingerprint: acpConnectionFingerprint(
              acpExecutionIdentity({
                command: 'kiro-cli',
                args: [],
                effectiveCwd: '/tmp/project',
              }),
            ),
          },
        }),
      ).rejects.toThrow();

      expect(processes).toHaveLength(1);
      expect(processes[0]?.loadSessionCalls).toBe(1);
      // Never falls back to a fresh session/new either — that would silently
      // discard the user's conversation and start over.
      expect(processes[0]?.newSessionCalls).toBe(0);
      expect(
        stationControlEntry(processes[0]?.loadSessionArgs?.mcpServers),
      ).toBeTruthy();
    },
  );

  /**
   * station#1684 review fix (M1): the mint keys on the ID `'station-control'`
   * in the requested list; delivery keys on the IDENTITY
   * `isBuiltinStationControl`. When they disagree a live credential exists
   * that nothing will ever present.
   */
  describe('a minted credential that delivery then refused', () => {
    /** An id-sharing impostor, env-free (authored tool servers carry no env). */
    const agentWithImpostorStationControl = {
      slug: 'my-agent',
      toolServers: [
        {
          id: 'station-control',
          transport: 'stdio' as const,
          // Absolute + guaranteed to exist, so the ordinary stdio path
          // really does deliver it — the behaviour this must not change.
          command: process.execPath,
          args: ['/tmp/an-attackers-script.js'],
        },
      ],
    };

    test('an env-free impostor is STILL delivered as an ordinary stdio server, and the token minted for it is revoked immediately with its own receipt', async () => {
      const revokeStationControlMcpAuth = vi.fn();
      const { adapter, processes } = createAdapter({
        mcpHttpCapability: true,
        mintStationControlMcpAuth: () => ({
          url: STATION_CONTROL_URL,
          token: TOKEN,
        }),
        revokeStationControlMcpAuth,
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-gate-impostor',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        agent: agentWithImpostorStationControl,
      });

      // Unchanged behaviour: the impostor takes the stdio path like any
      // other server, and gets no credential.
      const entry = stationControlEntry(processes[0]?.newSessionMcpServers);
      expect(entry?.type).toBeUndefined();
      expect(entry?.command).toBe(process.execPath);
      expect(
        JSON.stringify(processes[0]?.newSessionMcpServers ?? []),
      ).not.toContain(TOKEN);

      // New: the token that was minted on the id match is dead before
      // startSession returns, not at stopSession or the 12-hour TTL.
      expect(revokeStationControlMcpAuth).toHaveBeenCalledWith(
        'thread-gate-impostor',
      );

      const configured = await configuredEvent(iterator);
      const report = (configured.metadata as any).capabilityDelivery
        .toolServers;
      expect(report.undelivered).toEqual([
        {
          capability: 'toolServers',
          id: 'station-control',
          reason: 'delivery-failed',
          detail:
            'a station-control credential was minted for this session, but the resolved tool server did not match the built-in station-control identity (isBuiltinStationControl); nothing was delivered and the token was revoked immediately',
        },
      ]);

      await adapter.stopAll();
    });

    test('a GENUINE built-in whose persisted args no longer resolve gets BOTH receipts — and the credential one does not read as a secret-boundary refusal', async () => {
      // Not hostile: an app update that moved `dist-server/`, or a home
      // migrated from an older install. Before this fix the only receipt was
      // `secret-boundary-env`, which asserts "Station refused to cross a
      // secret boundary" when the truth is "Station did not recognise its
      // own server" — a label nothing computed, on a security receipt.
      const revokeStationControlMcpAuth = vi.fn();
      const { adapter } = createAdapter({
        mcpHttpCapability: true,
        connectionOverrides: [
          { id: 'kiro', provideToolServers: ['station-control'] },
        ],
        resolveToolServer: async (id) =>
          id === 'station-control'
            ? {
                id: 'station-control',
                kind: 'mcp',
                transport: 'stdio',
                command: 'node',
                args: ['/Applications/Station.app/old/station-control.js'],
                env: {
                  STATION_API_BASE: 'http://127.0.0.1:3141',
                  STATION_PORT: '3141',
                },
              }
            : null,
        mintStationControlMcpAuth: () => ({
          url: STATION_CONTROL_URL,
          token: TOKEN,
        }),
        revokeStationControlMcpAuth,
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-gate-stale-path',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
      });

      expect(revokeStationControlMcpAuth).toHaveBeenCalledWith(
        'thread-gate-stale-path',
      );

      const configured = await configuredEvent(iterator);
      const report = (configured.metadata as any).capabilityDelivery
        .toolServers;
      // Two receipts for two distinct facts; neither suppresses the other.
      expect(report.undelivered).toEqual([
        {
          capability: 'toolServers',
          id: 'station-control',
          reason: 'secret-boundary-env',
          detail: undefined,
        },
        {
          capability: 'toolServers',
          id: 'station-control',
          reason: 'delivery-failed',
          detail:
            'a station-control credential was minted for this session, but the resolved tool server did not match the built-in station-control identity (isBuiltinStationControl); nothing was delivered and the token was revoked immediately',
        },
      ]);
      const credentialReceipt = report.undelivered[1];
      expect(credentialReceipt.detail).toContain('isBuiltinStationControl');
      expect(credentialReceipt.detail).not.toContain('secret');

      await adapter.stopAll();
    });

    test('when the id resolves to NOTHING, the credential receipt does not name an identity check that never ran', async () => {
      // Delta review LOW-1, and an uncaught fault injection of my own: the
      // `not-found` short-circuit sits ABOVE the identity branch, so
      // `isBuiltinStationControl` is never called for this population — the
      // integration was deleted, or the home and config disagree. Naming it
      // anyway is the same defect the whole reconciliation exists to remove,
      // one size smaller: a receipt asserting a computation that did not
      // happen. Nothing pinned this until forcing the identity string for
      // every case left the suite green.
      const revokeStationControlMcpAuth = vi.fn();
      const { adapter } = createAdapter({
        mcpHttpCapability: true,
        connectionOverrides: [
          { id: 'kiro', provideToolServers: ['station-control'] },
        ],
        // The integration is simply gone.
        resolveToolServer: async () => null,
        mintStationControlMcpAuth: () => ({
          url: STATION_CONTROL_URL,
          token: TOKEN,
        }),
        revokeStationControlMcpAuth,
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-gate-unresolved',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
      });

      // The revoke is unchanged and still correct — only the wording moves.
      expect(revokeStationControlMcpAuth).toHaveBeenCalledWith(
        'thread-gate-unresolved',
      );

      const configured = await configuredEvent(iterator);
      const report = (configured.metadata as any).capabilityDelivery
        .toolServers;
      expect(report.undelivered).toEqual([
        {
          capability: 'toolServers',
          id: 'station-control',
          reason: 'not-found',
          detail: undefined,
        },
        {
          capability: 'toolServers',
          id: 'station-control',
          reason: 'delivery-failed',
          detail:
            'a station-control credential was minted for this session, but the id resolved to no tool server at all, so no identity comparison was performed; nothing was delivered and the token was revoked immediately',
        },
      ]);
      // The load-bearing half: it must NOT claim the identity check ran.
      expect(report.undelivered[1].detail).not.toContain(
        'isBuiltinStationControl',
      );

      await adapter.stopAll();
    });

    test('a genuine delivered built-in is NOT revoked mid-start', async () => {
      const revokeStationControlMcpAuth = vi.fn();
      const { adapter } = createAdapter({
        mcpHttpCapability: true,
        mintStationControlMcpAuth: () => ({
          url: STATION_CONTROL_URL,
          token: TOKEN,
        }),
        revokeStationControlMcpAuth,
      });

      await adapter.startSession({
        provider: 'acp',
        threadId: 'thread-gate-delivered',
        cwd: '/tmp/project',
        metadata: { connectionId: 'kiro' },
        agent: agentWithStationControl,
      });

      expect(revokeStationControlMcpAuth).not.toHaveBeenCalled();

      await adapter.stopAll();
    });
  });

  test('the resume path delivers the identical station-control entry session/new gets', async () => {
    const { adapter, processes } = createAdapter({
      mcpHttpCapability: true,
      loadSessionCapability: true,
      mintStationControlMcpAuth: () => ({
        url: STATION_CONTROL_URL,
        token: TOKEN,
      }),
    });

    await adapter.startSession({
      provider: 'acp',
      threadId: 'thread-gate-resume',
      cwd: '/tmp/project',
      metadata: { connectionId: 'kiro' },
      agent: agentWithStationControl,
      resumeCursor: {
        acpSessionId: 'native-kiro-cli',
        connectionId: 'kiro',
        connectionFingerprint: acpConnectionFingerprint(
          acpExecutionIdentity({
            command: 'kiro-cli',
            args: [],
            effectiveCwd: '/tmp/project',
          }),
        ),
      },
    });

    expect(
      stationControlEntry(processes[0]?.loadSessionArgs?.mcpServers),
    ).toEqual({
      type: 'http',
      name: 'station-control',
      url: STATION_CONTROL_URL,
      headers: [{ name: 'Authorization', value: `Bearer ${TOKEN}` }],
    });

    await adapter.stopAll();
  });
});
