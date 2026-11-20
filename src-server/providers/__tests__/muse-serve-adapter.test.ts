import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
/**
 * #2452: the `muse serve` (MSP) path of the Muse adapter, driven by REAL
 * captures from Muse Code 1.3.0-R3401.1 (`fixtures/muse-serve-1.3.0-*.jsonl`)
 * replayed through the actual `MuseAdapter` with the host process replaced by
 * a stream double (see `muse-serve-replay.ts`). No test here spawns a
 * process.
 */
import {
  applyChildWorkDelta,
  type ChildWorkDelta,
  type ChildWorkRegistryState,
  childWorkForReporter,
  createEmptyChildWorkRegistry,
} from '@kontourai/station-contracts/child-work';
import {
  ENGINE_SESSION_BINDING_DEAD_CODE,
  MUSE_APPROVAL_DECIDE_FAILED_CODE,
  MUSE_APPROVAL_EXPIRED_CODE,
  MUSE_APPROVAL_MODE_NOT_APPLIED_CODE,
  MUSE_MODEL_RETRY_SCHEDULED_CODE,
  MUSE_MODEL_ROUTE_UNSERVED_CODE,
  MUSE_SANDBOX_UNAVAILABLE_CODE,
  MUSE_SERVE_HOST_EXITED_CODE,
  MUSE_SERVE_SCHEMA_UNVERIFIED_COMPATIBLE_CODE,
  MUSE_SERVE_STOP_UNCONFIRMED_CODE,
  MUSE_SERVE_UNAVAILABLE_CODE,
  PROVIDER_TURN_IN_PROGRESS_CODE,
  unsupportedModelOptionKeys,
} from '@kontourai/station-contracts/provider';
import {
  type CanonicalRuntimeEvent,
  PROVIDER_TURN_TRIGGER,
} from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { assembleTurnProvenanceEnvelopes } from '@kontourai/station-shared/turn-provenance-fold';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { GateTestAdapter } from '../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  installSessionTmpDirPolicy,
  sessionTmpDirPath,
} from '../../services/infra/session-tmpdir.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import { activeTurnIdForEvents } from '../../services/orchestration/session-lifecycle-service.js';
import {
  ProviderTurnEndedError,
  ProviderTurnInProgressError,
  SendTurnRefusedError,
  SessionStartRefusedError,
} from '../adapter-shape.js';
import {
  buildMuseServeArgs,
  MuseAdapter,
  type MuseAdapterOptions,
  museServeEnvOverrides,
} from '../adapters/muse-adapter.js';
import {
  MUSE_CHILD_ALL_TOOLS_FAILED_PREFIX,
  MUSE_EXEC_CHILD_WORK_NOT_REPORTED_REASON,
} from '../adapters/muse-serve-child-work.js';
import {
  MUSE_SERVE_REQUIRED_SURFACE,
  type MuseSchemaCommandRunner,
  museServeSchemaSurfaceGaps,
} from '../adapters/muse-serve-schema.js';
import {
  MUSE_APPROVAL_REVIEWING_MESSAGE,
  museServeApprovalPlan,
} from '../adapters/muse-serve-session.js';
import { CredentialProfileEnvironmentError } from '../app-home/app-home-profiles.js';
import museStableSchema from './fixtures/muse-msp-1.4.20-stable.schema.json' with {
  type: 'json',
};
import {
  FakeMuseServeHost,
  loadMuseServeCapture,
  type MuseServeCaptureFrame,
  type MuseServeCaptureName,
  replayMuseServeCapture,
  type SentFrame,
} from './muse-serve-replay.js';

const THREAD = 'thread-muse-serve';
const CHILD = '00000000-0000-7000-8000-000000000023';
const APPROVAL = '00000000-0000-7000-8000-000000000025';
const STATION_TURN = '00000000-0000-7000-8000-000000000005';
const WORKFLOW_CALL = 'call_00000000000000000000000000000001';

interface Harness {
  adapter: MuseAdapter;
  hosts: FakeMuseServeHost[];
  events: CanonicalRuntimeEvent[];
  execSpawns: string[][];
  hostTmpDirs: Array<string | undefined>;
  hostEnvs: Array<Record<string, string> | undefined>;
}

const adapters: MuseAdapter[] = [];
/** Every host any test in this file drove (see the surface check below). */
const everyHost: FakeMuseServeHost[] = [];
const makeCascadeHome = trackTempDirs();

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stopAll();
});

function harness(
  options: {
    collectEvents?: boolean;
    approvalTimeoutMs?: number;
    approvalEscalationMs?: number;
    spawnHost?: (args: string[], index: number) => FakeMuseServeHost;
    terminateHost?: (host: FakeMuseServeHost) => Promise<void>;
    onRelease?: (host: FakeMuseServeHost) => void;
    env?: NodeJS.ProcessEnv;
    getAppHomeEnv?: MuseAdapterOptions['getAppHomeEnv'];
    schemaCommandRunner?: MuseSchemaCommandRunner;
  } = {},
): Harness {
  const hosts: FakeMuseServeHost[] = [];
  const events: CanonicalRuntimeEvent[] = [];
  const execSpawns: string[][] = [];
  const hostTmpDirs: Array<string | undefined> = [];
  const hostEnvs: Array<Record<string, string> | undefined> = [];
  const adapter = new MuseAdapter({
    serve: {
      spawnHost: (posture, _cwd, tmpDir, envOverrides) => {
        hostTmpDirs.push(tmpDir);
        hostEnvs.push(envOverrides);
        const args = buildMuseServeArgs(posture);
        const host =
          options.spawnHost?.(args, hosts.length) ??
          new FakeMuseServeHost(args, 5151 + hosts.length);
        hosts.push(host);
        everyHost.push(host);
        return { process: host, release: () => options.onRelease?.(host) };
      },
      terminateHost: async (spawned) => {
        const host = spawned.process as FakeMuseServeHost;
        if (options.terminateHost) return options.terminateHost(host);
        host.exit(0);
      },
      ...(options.approvalTimeoutMs !== undefined
        ? { approvalTimeoutMs: options.approvalTimeoutMs }
        : {}),
      ...(options.approvalEscalationMs !== undefined
        ? { approvalEscalationMs: options.approvalEscalationMs }
        : {}),
      handshakeTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
      interruptSettleMs: 300,
      ...(options.schemaCommandRunner
        ? { schemaCommandRunner: options.schemaCommandRunner }
        : {}),
    },
    // The schema check resolves `muse` like the host launch; nothing runs it.
    findBinary: () => '/fake/bin/muse',
    processFactory: (args) => {
      execSpawns.push(args);
      throw new Error('this test drives serve; exec must not spawn');
    },
    ...(options.env ? { env: options.env } : {}),
    ...(options.getAppHomeEnv ? { getAppHomeEnv: options.getAppHomeEnv } : {}),
    logger: { warn: () => {}, info: () => {} },
  });
  adapters.push(adapter);
  if (options.collectEvents !== false)
    void (async () => {
      for await (const event of adapter.streamEvents()) events.push(event);
    })();
  return { adapter, hosts, events, execSpawns, hostTmpDirs, hostEnvs };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

function captureIndex(
  name: MuseServeCaptureName,
  predicate: (msg: Record<string, unknown>, dir: string) => boolean,
): number {
  const frames = loadMuseServeCapture(name);
  const index = frames.findIndex((frame) => predicate(frame.msg, frame.dir));
  if (index < 0) throw new Error(`no such frame in ${name}`);
  return index;
}

/** Replays a capture end to end with the standard Station actions. */
async function run(
  h: Harness,
  name: MuseServeCaptureName,
  actions: {
    approvalMode?: 'ask' | 'auto' | 'never';
    decide?: 'accept' | 'acceptForSession' | 'decline';
    stopChild?: boolean;
    stopAt?: number;
    invocationId?: string;
  } = {},
): Promise<SentFrame[]> {
  const driven = await replayMuseServeCapture(
    // The host is created by the adapter's first spawn, inside startSession.
    await firstHost(h, () =>
      h.adapter.startSession({
        provider: 'muse',
        threadId: THREAD,
        cwd: '/workspace/probe/repo',
        ...(actions.approvalMode
          ? { modelOptions: { approvalMode: actions.approvalMode } }
          : {}),
      }),
    ),
    loadMuseServeCapture(name),
    {
      ...(actions.stopAt !== undefined ? { stopAt: actions.stopAt } : {}),
      onDrivenRequest: (method, occurrence, captured) => {
        if (method === 'turn/start') {
          return h.adapter.sendTurn({
            threadId: THREAD,
            input: 'go',
            invocationId: actions.invocationId,
          });
        }
        if (
          method === 'approval/decide' &&
          occurrence === 0 &&
          actions.decide
        ) {
          return h.adapter.respondToRequest(
            THREAD,
            String(captured.approvalId),
            actions.decide,
          );
        }
        if (method === 'subagent/stop' && actions.stopChild) {
          return h.adapter.stopProviderTask(
            THREAD,
            String(captured.subagentId),
          );
        }
        return undefined;
      },
    },
  );
  await settle();
  return driven;
}

/** Starts `begin` and resolves with the host its first spawn created. */
async function firstHost(
  h: Harness,
  begin: () => Promise<unknown>,
): Promise<FakeMuseServeHost> {
  const started = begin();
  started.catch(() => {});
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (h.hosts[0]) return h.hosts[0];
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('no host was spawned');
}

function of<M extends CanonicalRuntimeEvent['method']>(
  events: CanonicalRuntimeEvent[],
  method: M,
): Extract<CanonicalRuntimeEvent, { method: M }>[] {
  return events.filter(
    (event): event is Extract<CanonicalRuntimeEvent, { method: M }> =>
      event.method === method,
  );
}

function childWorkDeltas(events: CanonicalRuntimeEvent[]): ChildWorkDelta[] {
  return of(events, 'child-work.updated').map((event) => event.delta);
}

function fold(events: CanonicalRuntimeEvent[]): ChildWorkRegistryState {
  return childWorkDeltas(events).reduce(
    applyChildWorkDelta,
    createEmptyChildWorkRegistry(),
  );
}

describe('chat-host-images: a serve host', () => {
  const makeHome = trackTempDirs();
  test('gets the session temp folder prepared at start as its TMPDIR', async () => {
    const home = makeHome('muse-serve-tmp-');
    const previous = process.env.STATION_HOME;
    process.env.STATION_HOME = home;
    const uninstall = installSessionTmpDirPolicy(() => true);
    try {
      const h = harness();
      await firstHost(h, () =>
        h.adapter.startSession({
          provider: 'muse',
          threadId: THREAD,
          cwd: '/workspace/probe/repo',
        }),
      );
      expect(h.hostTmpDirs).toEqual([sessionTmpDirPath(THREAD, home)]);
    } finally {
      uninstall();
      if (previous === undefined) delete process.env.STATION_HOME;
      else process.env.STATION_HOME = previous;
    }
  });
});

describe('#1942: a serve host runs under the credential profile', () => {
  test("the selected profile's XDG config root reaches the host", async () => {
    const getAppHomeEnv = vi.fn(async (ref?: string) => ({
      profileRef: ref ?? null,
      env: { XDG_CONFIG_HOME: '/station/app-homes/credential-profile-x' },
    }));
    const h = harness({ getAppHomeEnv });
    await firstHost(h, () =>
      h.adapter.startSession({
        provider: 'muse',
        threadId: THREAD,
        cwd: '/workspace/probe/repo',
        credentialProfileRef: 'work',
      }),
    );
    expect(getAppHomeEnv).toHaveBeenCalledWith('work');
    expect(h.hostEnvs).toEqual([
      { XDG_CONFIG_HOME: '/station/app-homes/credential-profile-x' },
    ]);
  });

  test('a profile that cannot be prepared refuses the start before any host', async () => {
    const h = harness({
      getAppHomeEnv: async () => {
        throw new Error('overlay invalid');
      },
    });
    await expect(
      h.adapter.startSession({
        provider: 'muse',
        threadId: THREAD,
        credentialProfileRef: 'work',
      }),
    ).rejects.toBeInstanceOf(CredentialProfileEnvironmentError);
    expect(h.hosts).toHaveLength(0);
    expect(h.execSpawns).toHaveLength(0);
  });

  test('no profile keeps the user’s own Muse config', async () => {
    const h = harness({ getAppHomeEnv: async () => ({ profileRef: null }) });
    await firstHost(h, () =>
      h.adapter.startSession({ provider: 'muse', threadId: THREAD }),
    );
    expect(h.hostEnvs).toEqual([undefined]);
  });
});

describe('#2452 muse serve: approval mode', () => {
  test('Station modes map onto the MSP mode and the host sandbox posture', () => {
    expect(museServeApprovalPlan('ask')).toEqual({
      museMode: 'promptUnmatched',
      disableSandbox: false,
      stationMode: 'ask',
    });
    expect(museServeApprovalPlan('auto')).toEqual({
      museMode: 'allowAll',
      disableSandbox: false,
      stationMode: 'auto',
    });
    expect(museServeApprovalPlan('never')).toEqual({
      museMode: 'allowAll',
      disableSandbox: true,
      stationMode: 'never',
    });
    // Never omitted: a durable host started without a mode is allowAll.
    expect(museServeApprovalPlan(undefined).museMode).toBe('onRequest');
    expect(museServeApprovalPlan('connection-default').museMode).toBe(
      'onRequest',
    );
    expect(buildMuseServeArgs({ disableSandbox: true })).toEqual([
      'serve',
      '--disable-sandbox',
    ]);
    expect(buildMuseServeArgs({ disableSandbox: false })).toEqual(['serve']);
  });

  test('approvalMode and effort are muse model options the dispatcher admits', () => {
    expect(
      unsupportedModelOptionKeys('muse', {
        approvalMode: 'ask',
        effort: 'high',
      }),
    ).toEqual([]);
    expect(unsupportedModelOptionKeys('muse', { serviceTier: 'fast' })).toEqual(
      ['serviceTier'],
    );
  });

  test('`ask` starts the MSP session in promptUnmatched on a sandboxed host, and reports it applied', async () => {
    const h = harness();
    const driven = await run(h, 'workflow-child-approve', {
      approvalMode: 'ask',
      decide: 'accept',
    });
    const start = driven.find((frame) => frame.method === 'session/start');
    expect(start?.params).toMatchObject({
      approvalMode: 'promptUnmatched',
      workspaceRoot: '/workspace/probe/repo',
    });
    expect(h.hosts[0].args).toEqual(['serve']);
    const configured = of(h.events, 'session.configured')[0];
    expect(configured.metadata).toMatchObject({
      museTransport: 'serve',
      museApprovalMode: 'promptUnmatched',
      approvalMode: 'ask',
    });
  });

  test('session/start itself carries the mode, before the host can default it', async () => {
    const h = harness();
    const started = h.adapter.startSession({
      provider: 'muse',
      threadId: THREAD,
      modelOptions: { approvalMode: 'ask' },
    });
    const host = await firstHost(h, () => started);
    const init = await host.nextRequest('initialize', new Set());
    host.writeFrame({
      jsonrpc: '2.0',
      id: init.id,
      result: (
        loadMuseServeCapture('workflow-child-approve')[2].msg as {
          result: unknown;
        }
      ).result,
    });
    const start = await host.nextRequest('session/start', new Set());
    expect(start.params?.approvalMode).toBe('promptUnmatched');
    host.writeFrame({
      jsonrpc: '2.0',
      id: start.id,
      result: {
        session: {
          sessionId: 'muse-session',
          approvalMode: { mode: 'promptUnmatched', source: 'startup' },
        },
        viewCursor: '',
      },
    });
    await started;
  });

  test('a host that applied a different mode than asked is not used: the session falls back, and says so', async () => {
    const h = harness();
    const started = h.adapter.startSession({
      provider: 'muse',
      threadId: THREAD,
      modelOptions: { approvalMode: 'ask' },
    });
    const host = await firstHost(h, () => started);
    const init = await host.nextRequest('initialize', new Set());
    host.writeFrame({
      jsonrpc: '2.0',
      id: init.id,
      result: (
        loadMuseServeCapture('workflow-child-approve')[2].msg as {
          result: unknown;
        }
      ).result,
    });
    const start = await host.nextRequest('session/start', new Set());
    host.writeFrame({
      jsonrpc: '2.0',
      id: start.id,
      result: {
        session: {
          sessionId: 'muse-session',
          approvalMode: { mode: 'allowAll', source: 'startup' },
        },
        viewCursor: '',
      },
    });
    await started;
    await settle();
    expect(of(h.events, 'session.configured')[0].metadata).toMatchObject({
      museTransport: 'exec',
      approvalMode: 'auto',
    });
    expect(
      of(h.events, 'runtime.warning').find(
        (event) => event.code === MUSE_SERVE_UNAVAILABLE_CODE,
      )?.details,
    ).toMatchObject({ reason: expect.stringContaining('allowAll') });
  });

  test("with no posture the session still names a mode: muse's own onRequest", async () => {
    const h = harness();
    const driven = await run(h, 'workflow-child-approve', { decide: 'accept' });
    const start = driven.find((frame) => frame.method === 'session/start');
    expect(start?.params?.approvalMode).toBe('onRequest');
  });
});

describe('Muse serve turn invocation provenance', () => {
  test('a dispatched turn retains its invocation while a provider turn does not', async () => {
    const h = harness();
    await run(h, 'workflow-child-approve', {
      decide: 'accept',
      invocationId: 'station-invocation',
    });
    const starts = of(h.events, 'turn.started');
    const station = starts.find((event) => event.turnId === STATION_TURN);
    expect(station).toMatchObject({ invocationId: 'station-invocation' });
    expect(
      of(h.events, 'turn.completed').find(
        (event) => event.turnId === STATION_TURN,
      ),
    ).toMatchObject({ invocationId: 'station-invocation' });
    const provider = starts.find(
      (event) => event.metadata?.trigger === PROVIDER_TURN_TRIGGER,
    );
    expect(provider).toBeDefined();
    expect(provider?.invocationId).toBeUndefined();
  });
});

describe('#2452 muse serve: a workflow subagent approval reaches Station', () => {
  test('approve: one request, walked stage by stage with allow_once, resolved approved, the turn continues', async () => {
    const h = harness();
    const driven = await run(h, 'workflow-child-approve', {
      approvalMode: 'ask',
      decide: 'accept',
    });
    const opened = of(h.events, 'request.opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      requestId: APPROVAL,
      requestType: 'approval',
      title: 'Allow bash',
      payload: {
        toolName: 'bash',
        command: 'date > stamp.txt && cat stamp.txt',
        stages: [['date'], ['cat', 'stamp.txt']],
        // Attributed to the workflow child, keyed as its child work is.
        agentId: CHILD,
        childWork: {
          producer: 'engine-subagent',
          reporterThreadId: THREAD,
          childId: CHILD,
        },
      },
    });
    expect(opened[0].turnId).toBeUndefined();
    expect(typeof opened[0].payload?.expiresAt).toBe('string');
    const decides = driven.filter(
      (frame) => frame.method === 'approval/decide',
    );
    // One Station answer, two stages: Station walked the second itself.
    expect(decides.map((frame) => frame.params?.choiceId)).toEqual([
      'allow_once',
      'allow_once',
    ]);
    expect(
      decides.map(
        (frame) =>
          (frame.params?.requirementId as { sourceIndex?: number } | undefined)
            ?.sourceIndex,
      ),
    ).toEqual([0, 1]);
    // #2880: the decision is recorded when Station answers; muse's
    // `approval/resolved` is its acknowledgement, carrying muse's outcome.
    const resolved = of(h.events, 'request.resolved');
    expect(resolved).toEqual([
      expect.objectContaining({
        requestId: APPROVAL,
        status: 'approved',
        acknowledgement: 'engine',
      }),
    ]);
    expect(of(h.events, 'request.delivery')).toEqual([
      expect.objectContaining({
        requestId: APPROVAL,
        outcome: 'acknowledged',
        engineStatus: 'approved',
      }),
    ]);
    // The Station turn ended at its own terminal; muse then replied on its own.
    expect(of(h.events, 'turn.completed')[0]).toMatchObject({
      turnId: STATION_TURN,
      finishReason: 'stop',
    });
    const providerStart = of(h.events, 'turn.started').find(
      (event) => event.metadata?.trigger === PROVIDER_TURN_TRIGGER,
    );
    expect(providerStart?.turnId).toBe('00000000-0000-7000-8000-000000000041');
    expect(providerStart?.prompt).toBeUndefined();
    expect(
      of(h.events, 'content.text-delta')
        .map((event) => event.delta)
        .join(''),
    ).toBe(
      'The subagent reported stamp.txt contains Thu Sep 24 04:40:45 UTC 2026.',
    );
  });

  test('the walk never picks allow_local_prefix, which persists a workspace rule', async () => {
    const h = harness();
    const driven = await run(h, 'workflow-child-approve', {
      approvalMode: 'ask',
      decide: 'accept',
    });
    // The capture offers allow_local_prefix on the second stage.
    const frames = loadMuseServeCapture('workflow-child-approve');
    expect(
      frames.some((frame) =>
        JSON.stringify(frame.msg).includes('"allow_local_prefix"'),
      ),
    ).toBe(true);
    expect(
      driven.some((frame) => frame.params?.choiceId === 'allow_local_prefix'),
    ).toBe(false);
  });

  test('deny: abort with feedback, resolved denied, and the turn continues with the denial', async () => {
    const h = harness();
    const driven = await run(h, 'workflow-child-deny', {
      approvalMode: 'ask',
      decide: 'decline',
    });
    const decide = driven.find((frame) => frame.method === 'approval/decide');
    expect(decide?.params).toMatchObject({
      choiceId: 'abort',
      feedback: 'The user declined this request in Station.',
    });
    expect(of(h.events, 'request.resolved')).toEqual([
      expect.objectContaining({ requestId: APPROVAL, status: 'denied' }),
    ]);
    const providerEnd = of(h.events, 'turn.completed').find(
      (event) => event.metadata?.trigger === PROVIDER_TURN_TRIGGER,
    );
    expect(providerEnd).toMatchObject({
      finishReason: 'stop',
      outputText:
        "The subagent reported it couldn't run the command because bash approval was denied.",
    });
  });

  test('a send while muse runs its own follow-up turn is refused, retryably, not queued into it', async () => {
    const h = harness();
    await run(h, 'workflow-child-approve', {
      approvalMode: 'ask',
      decide: 'accept',
    });

    // The capture ends with the host's own turn still running.
    const refusal = await h.adapter
      .sendTurn({ threadId: THREAD, input: 'next' })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ProviderTurnInProgressError);
    expect((refusal as ProviderTurnInProgressError).code).toBe(
      PROVIDER_TURN_IN_PROGRESS_CODE,
    );
    expect(
      h.hosts[0].sent.filter((frame) => frame.method === 'turn/start'),
    ).toHaveLength(1);
    // Stopping the session ends that turn as the provider's, not Station's.
    await h.adapter.stopSession(THREAD);
    const aborted = of(h.events, 'turn.aborted');
    expect(aborted).toEqual([
      expect.objectContaining({
        turnId: '00000000-0000-7000-8000-000000000041',
        reason: 'session-stopped',
        metadata: { trigger: PROVIDER_TURN_TRIGGER },
      }),
    ]);
  });

  test('acceptForSession trusts the tool: a later call of it is allowed without a new request', async () => {
    const h = harness();
    await run(h, 'workflow-child-approve', {
      approvalMode: 'ask',
      decide: 'acceptForSession',
    });
    const requested = loadMuseServeCapture('workflow-child-approve').find(
      (frame) => frame.msg.method === 'approval/requested',
    )?.msg as { params: Record<string, unknown> };
    const nextId = '00000000-0000-7000-8000-0000000000aa';
    const host = h.hosts[0];
    const before = host.sent.length;
    host.writeFrame({
      jsonrpc: '2.0',
      method: 'approval/requested',
      params: {
        ...requested.params,
        approvalId: nextId,
        currentRequirementId: { approvalId: nextId, sourceIndex: 0 },
        subject: {
          kind: 'shell',
          command: 'date',
          stages: [
            {
              requirementId: { approvalId: nextId, sourceIndex: 0 },
              argv: ['date'],
              resolution: { kind: 'unresolved' },
            },
          ],
        },
      },
    });
    await settle();
    expect(of(h.events, 'request.opened')).toHaveLength(1);
    const decide = host.sent
      .slice(before)
      .find((frame) => frame.method === 'approval/decide');
    expect(decide?.params).toMatchObject({
      approvalId: nextId,
      choiceId: 'allow_once',
    });
  });
});

describe('#2452 muse serve: no approval waits forever', () => {
  test("an unanswered approval is declined at Station's deadline, resolved expired, and announced", async () => {
    const h = harness({ approvalTimeoutMs: 60 });
    const stopAt = captureIndex(
      'approval-unanswered-workflow-cancel',
      (msg, dir) => dir === 'c2s' && msg.method === 'approval/listPending',
    );
    await run(h, 'approval-unanswered-workflow-cancel', {
      approvalMode: 'ask',
      stopAt,
    });
    const host = h.hosts[0];
    const decide = await host.nextRequest('approval/decide', new Set());
    expect(decide.params).toMatchObject({
      approvalId: '00000000-0000-7000-8000-000000000024',
      choiceId: 'abort',
    });
    expect(String(decide.params?.feedback)).toContain('Nobody answered');
    await settle();
    expect(of(h.events, 'request.resolved')).toEqual([
      expect.objectContaining({
        requestId: '00000000-0000-7000-8000-000000000024',
        status: 'expired',
      }),
    ]);
    const warning = of(h.events, 'runtime.warning').find(
      (event) => event.code === MUSE_APPROVAL_EXPIRED_CODE,
    );
    expect(warning?.message).toContain('the subagent continues');
    // Station's own outcome stands: a late answer is refused, and the host's
    // own resolution publishes nothing further.
    await expect(
      h.adapter.respondToRequest(
        THREAD,
        '00000000-0000-7000-8000-000000000024',
        'accept',
      ),
    ).rejects.toThrow('Unknown Muse approval request');
    const resolvedFrame = loadMuseServeCapture(
      'approval-unanswered-workflow-cancel',
    ).find((frame) => frame.msg.method === 'approval/resolved');
    host.writeFrame(resolvedFrame?.msg ?? {});
    await settle();
    expect(of(h.events, 'request.resolved')).toHaveLength(1);
  });
});

describe('#2452 muse serve: workflow children are child work', () => {
  test('approve: listed running under the workflow call, usage, a completed settle, and the workflow summary', async () => {
    const h = harness();
    await run(h, 'workflow-child-approve', {
      approvalMode: 'ask',
      decide: 'accept',
    });
    const envelopes = assembleTurnProvenanceEnvelopes(h.events);
    expect(
      envelopes.some(
        (envelope) =>
          envelope.usage.state === 'observed' &&
          envelope.usage.value.inputTokens === 28465 &&
          envelope.usage.value.outputTokens === 911 &&
          envelope.usage.value.cacheReadTokens === 5105,
      ),
    ).toBe(true);
    const deltas = childWorkDeltas(h.events);
    const firstSnapshot = deltas.find((delta) => delta.kind === 'snapshot');
    expect(firstSnapshot).toMatchObject({
      producer: 'engine-subagent',
      reporterThreadId: THREAD,
      running: [
        expect.objectContaining({
          childId: CHILD,
          status: 'running',
          kindLabel: 'workflow',
          parent: { turnId: STATION_TURN, toolCallId: WORKFLOW_CALL },
          // The launching turn had already ended; the child still takes a
          // steer, its token that turn.
          backgrounded: true,
          controls: {
            stop: 'provider-task-stop',
            steer: { turnId: STATION_TURN },
          },
        }),
      ],
    });
    expect(
      deltas.some(
        (delta) =>
          delta.kind === 'upsert' &&
          delta.item.usage?.totalTokens === 30972 + 627,
      ),
    ).toBe(true);
    const [child] = childWorkForReporter(fold(h.events), THREAD);
    expect(child).toMatchObject({
      childId: CHILD,
      status: 'completed',
      usage: { totalTokens: 30972 + 627, durationMs: 8170 },
      result: {
        summary:
          'Ran `date > stamp.txt` in workspace root. File stamp.txt content: "Thu Sep 24 04:40:45 UTC 2026".',
        source: 'provider-summary',
      },
    });
    // #3337: the terminal revision carries only a duration; the settle still
    // reports the whole accumulated figure, so nothing is left provisional.
    expect(child.usage).toEqual({ totalTokens: 30972 + 627, durationMs: 8170 });
    expect(child.usageProvisional).toBeUndefined();
    expect(child.usageRunningFields).toBeUndefined();
  });

  test("deny: a child whose every tool was denied stays completed (muse's verdict) but never reads as a clean success", async () => {
    const h = harness();
    await run(h, 'workflow-child-deny', {
      approvalMode: 'ask',
      decide: 'decline',
    });
    const [child] = childWorkForReporter(fold(h.events), THREAD);
    expect(child.status).toBe('completed');
    expect(child.usage).toEqual({ totalTokens: 20216 + 312, durationMs: 3728 });
    expect(child.usageProvisional).toBeUndefined();
    expect(
      child.result?.summary?.startsWith(MUSE_CHILD_ALL_TOOLS_FAILED_PREFIX),
    ).toBe(true);
    expect(child.result?.summary).toContain('bash tool denied');
  });

  test("stop: subagent/stop, stopped-unconfirmed until the child's own cancelled terminal", async () => {
    const h = harness();
    const driven = await run(h, 'workflow-child-stop', {
      approvalMode: 'ask',
      stopChild: true,
    });
    const stop = driven.find((frame) => frame.method === 'subagent/stop');
    expect(stop?.params).toMatchObject({ subagentId: CHILD });
    const settles = childWorkDeltas(h.events).filter(
      (delta) => delta.kind === 'settle' && delta.childId === CHILD,
    );
    expect(
      settles.map((delta) => delta.kind === 'settle' && delta.status),
    ).toEqual(['stopped-unconfirmed', 'cancelled']);
    const [child] = childWorkForReporter(fold(h.events), THREAD);
    expect(child.status).toBe('cancelled');
    // #3337: the usage revision muse sent after the stop still counts.
    expect(child.usage).toEqual({ totalTokens: 0, durationMs: 3104 });
    expect(child.usageProvisional).toBeUndefined();
    // No summary was reported (final_summary.summary is null): none invented.
    expect(child.result).toBeUndefined();
  });

  test('a child still running when its workflow completes is unresolved, never completed', async () => {
    const h = harness();
    const stopAt = captureIndex(
      'workflow-child-approve',
      (msg) =>
        msg.method === 'item/updated' &&
        JSON.stringify(msg).includes('"status":"usage"'),
    );
    await run(h, 'workflow-child-approve', {
      approvalMode: 'ask',
      decide: 'accept',
      stopAt,
    });
    const completedFrame = loadMuseServeCapture('workflow-child-approve').find(
      (frame) =>
        frame.msg.method === 'item/completed' &&
        JSON.stringify(frame.msg).includes('"kind":"workflow"'),
    )?.msg as { params: { item: Record<string, unknown> } };
    h.hosts[0].writeFrame({
      ...completedFrame,
      params: {
        ...completedFrame.params,
        item: {
          ...completedFrame.params.item,
          children: [{ childId: CHILD, attempt: 1, status: 'started' }],
        },
      },
    });
    await settle();
    const [child] = childWorkForReporter(fold(h.events), THREAD);
    expect(child.status).toBe('unresolved');
  });
});

describe('#2452 muse serve: turn terminals', () => {
  async function stationTurnOpen(h: Harness) {
    const stopAt = captureIndex(
      'workflow-child-approve',
      (msg) => msg.method === 'turn/completed',
    );
    await run(h, 'workflow-child-approve', { approvalMode: 'ask', stopAt });
  }

  test('a cancelled terminal nobody in Station asked for is a cancellation, not a success', async () => {
    const h = harness();
    await stationTurnOpen(h);
    h.hosts[0].writeFrame({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        sessionId: '00000000-0000-7000-8000-000000000002',
        turnId: STATION_TURN,
        terminal: 'cancelled',
      },
    });
    await settle();
    expect(of(h.events, 'turn.completed')).toEqual([
      expect.objectContaining({
        turnId: STATION_TURN,
        finishReason: 'cancelled',
      }),
    ]);
  });

  test('Stop interrupts the exact turn and ends it aborted at its cancelled terminal', async () => {
    const h = harness();
    await stationTurnOpen(h);
    const host = h.hosts[0];
    const interrupted = h.adapter.interruptTurn(THREAD, STATION_TURN);
    const request = await host.nextRequest('turn/interrupt', new Set());
    expect(request.params).toMatchObject({ turnId: STATION_TURN });
    host.writeFrame({
      jsonrpc: '2.0',
      id: request.id,
      result: { commandId: 'x', status: 'accepted', turnId: STATION_TURN },
    });
    host.writeFrame({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        sessionId: '00000000-0000-7000-8000-000000000002',
        turnId: STATION_TURN,
        terminal: 'cancelled',
      },
    });
    await expect(interrupted).resolves.toEqual({
      outcome: 'cancelled',
      turnId: STATION_TURN,
    });
    expect(of(h.events, 'turn.aborted')).toEqual([
      expect.objectContaining({ turnId: STATION_TURN, reason: 'interrupted' }),
    ]);
    expect(of(h.events, 'turn.completed')).toEqual([]);
  });

  test('a host that exits mid-turn fails the turn visibly, and the next send re-hosts and resumes the session', async () => {
    const h = harness();
    await stationTurnOpen(h);
    h.hosts[0].stderr.write('boom\n');
    h.hosts[0].exit(3);
    await settle();
    expect(of(h.events, 'runtime.error')).toEqual([
      expect.objectContaining({
        turnId: STATION_TURN,
        code: MUSE_SERVE_HOST_EXITED_CODE,
      }),
    ]);
    const sending = h.adapter.sendTurn({ threadId: THREAD, input: 'again' });
    for (let attempt = 0; attempt < 100 && !h.hosts[1]; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const host = h.hosts[1];
    const answer = async (method: string, result: unknown) => {
      const request = await host.nextRequest(method, new Set());
      host.writeFrame({ jsonrpc: '2.0', id: request.id, result });
      return request;
    };
    const init = loadMuseServeCapture('workflow-child-approve')[2].msg;
    await answer('initialize', (init as { result: unknown }).result);
    const resume = await answer('session/resume', {
      session: {
        sessionId: '00000000-0000-7000-8000-000000000002',
        approvalMode: { mode: 'promptUnmatched' },
      },
      viewCursor: '',
      history: {},
      pendingRequests: [],
    });
    expect(resume.params).toMatchObject({
      sessionId: '00000000-0000-7000-8000-000000000002',
    });
    await answer('approval/listPending', { approvals: [], userInputs: [] });
    const start = await answer('turn/start', {
      status: 'accepted',
      disposition: 'started',
      turnId: 'turn-after-rehost',
    });
    expect(start.params?.input).toEqual([{ type: 'text', text: 'again' }]);
    await expect(sending).resolves.toMatchObject({
      turnId: 'turn-after-rehost',
    });
  });
});

describe('#2452 muse serve: a posture change of sandbox re-hosts the session', () => {
  test('`never` mid-session: an idle session moves to a --disable-sandbox host, resumed, in allowAll', async () => {
    const h = harness();
    await run(h, 'workflow-child-deny', {
      approvalMode: 'ask',
      decide: 'decline',
    });
    const sending = h.adapter.sendTurn({
      threadId: THREAD,
      input: 'again',
      modelOptions: { approvalMode: 'never' },
    });
    for (let attempt = 0; attempt < 100 && !h.hosts[1]; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const host = h.hosts[1];
    expect(host.args).toEqual(['serve', '--disable-sandbox']);
    expect(h.hosts[0].stdinEnded).toBe(true);
    const answer = async (method: string, result: unknown) => {
      const request = await host.nextRequest(method, new Set());
      host.writeFrame({ jsonrpc: '2.0', id: request.id, result });
      return request;
    };
    await answer(
      'initialize',
      (
        loadMuseServeCapture('workflow-child-deny')[2].msg as {
          result: unknown;
        }
      ).result,
    );
    await answer('session/resume', {
      session: {
        sessionId: '00000000-0000-7000-8000-000000000002',
        approvalMode: { mode: 'promptUnmatched' },
      },
      viewCursor: '',
      history: {},
      pendingRequests: [],
    });
    await answer('approval/listPending', { approvals: [], userInputs: [] });
    const setMode = await answer('session/setApprovalMode', {
      status: 'accepted',
      applyOutcome: 'completed',
      effectiveMode: { mode: 'allowAll', source: 'approvalReconfigure' },
    });
    expect(setMode.params?.mode).toBe('allowAll');
    await answer('turn/start', {
      status: 'accepted',
      disposition: 'started',
      turnId: 'turn-never',
    });
    await sending;
    await settle();
    expect(
      of(h.events, 'turn.started').find(
        (event) => event.turnId === 'turn-never',
      )?.metadata,
    ).toMatchObject({
      approvalMode: 'never',
      museApprovalMode: 'allowAll',
      museSandbox: 'disabled',
    });
  });

  test('a sandbox change is refused, not forced, while a workflow child still runs', async () => {
    const h = harness();
    const stopAt = captureIndex(
      'workflow-child-approve',
      (msg) =>
        msg.method === 'item/updated' &&
        JSON.stringify(msg).includes('"status":"started"'),
    );
    await run(h, 'workflow-child-approve', {
      approvalMode: 'ask',
      stopAt: stopAt + 1,
    });
    await expect(
      h.adapter.sendTurn({
        threadId: THREAD,
        input: 'again',
        modelOptions: { approvalMode: 'never' },
      }),
    ).rejects.toThrow('cannot change its sandbox');
    expect(h.hosts).toHaveLength(1);
    expect(h.hosts[0].stdinEnded).toBe(false);
  });
});

describe('#2452 muse serve: exec stays the fallback', () => {
  test('a host that fails the handshake falls back to exec, says why, and reports no child work', async () => {
    const execSpawned: string[][] = [];
    const h = harness({
      spawnHost: (args) => {
        const host = new FakeMuseServeHost(args);
        setImmediate(() => {
          host.stderr.write("error: unrecognized subcommand 'serve'\n");
          host.exit(2);
        });
        return host;
      },
    });
    await h.adapter.startSession({ provider: 'muse', threadId: THREAD });
    await settle();
    const warning = of(h.events, 'runtime.warning').find(
      (event) => event.code === MUSE_SERVE_UNAVAILABLE_CODE,
    );
    expect(warning?.message).toContain('`muse exec`');
    expect(of(h.events, 'session.configured')[0].metadata).toMatchObject({
      museTransport: 'exec',
    });
    expect(childWorkDeltas(h.events)).toEqual([
      {
        kind: 'not-reported',
        reporterThreadId: THREAD,
        reason: MUSE_EXEC_CHILD_WORK_NOT_REPORTED_REASON,
      },
    ]);
    // The turn goes to exec (whose factory this harness makes throw).
    await expect(
      h.adapter.sendTurn({ threadId: THREAD, input: 'hi' }),
    ).rejects.toThrow('exec must not spawn');
    expect(execSpawned).toEqual([]);
    expect(h.execSpawns).toHaveLength(1);
    expect(h.execSpawns[0].slice(0, 2)).toEqual(['exec', '--json']);
  });

  test('an unverified MSP schema fingerprint falls back to exec rather than guessing', async () => {
    const h = harness();
    const started = h.adapter.startSession({
      provider: 'muse',
      threadId: THREAD,
    });
    for (let attempt = 0; attempt < 100 && !h.hosts[0]; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const host = h.hosts[0];
    const init = await host.nextRequest('initialize', new Set());
    host.writeFrame({
      jsonrpc: '2.0',
      id: init.id,
      result: {
        serverInfo: { name: 'muse', version: '9.9.9' },
        schema: { version: 1, fingerprint: 'sha256:unverified' },
        sessionDurability: 'durable',
      },
    });
    await started;
    await settle();
    expect(
      of(h.events, 'runtime.warning').find(
        (event) => event.code === MUSE_SERVE_UNAVAILABLE_CODE,
      )?.details,
    ).toMatchObject({ reason: expect.stringContaining('sha256:unverified') });
    expect(host.stdinEnded).toBe(true);
  });

  test('the echo e2e override always runs exec: serve does not honour --provider echo', async () => {
    const h = harness({
      env: {
        STATION_E2E_MUSE_PROVIDER: 'echo',
        STATION_HOME_SOURCE: '--temp-home',
        STATION_INSTANCE_ID: 'e2e-smoke-live-1-abc',
      },
    });
    await h.adapter.startSession({ provider: 'muse', threadId: THREAD });
    await settle();
    expect(h.hosts).toEqual([]);
    expect(of(h.events, 'session.configured')[0].metadata).toMatchObject({
      museTransport: 'exec',
    });
    // Serve was never wanted here, so there is no fallback to announce.
    expect(
      of(h.events, 'runtime.warning').filter(
        (event) => event.code === MUSE_SERVE_UNAVAILABLE_CODE,
      ),
    ).toEqual([]);
  });
});

// ------------------------------------------------------------ fix round

const APPROVE_REQUESTED = () =>
  loadMuseServeCapture('workflow-child-approve').find(
    (frame) => frame.msg.method === 'approval/requested',
  )?.msg as { params: Record<string, unknown> };

/** Replays the approve capture up to (not including) its first decide. */
async function upToFirstDecide(h: Harness) {
  const stopAt = captureIndex(
    'workflow-child-approve',
    (msg, dir) => dir === 'c2s' && msg.method === 'approval/decide',
  );
  await run(h, 'workflow-child-approve', { approvalMode: 'ask', stopAt });
  return h.hosts[0];
}

function reply(host: FakeMuseServeHost, request: SentFrame, result: unknown) {
  host.writeFrame({ jsonrpc: '2.0', id: request.id, result });
}

function reject(host: FakeMuseServeHost, request: SentFrame, code = -32053) {
  host.writeFrame({
    jsonrpc: '2.0',
    id: request.id,
    error: { code, message: 'stale requirement' },
  });
}

describe('#2452 fix round: no approval stays stuck', () => {
  test('R1: a deadline decline muse rejects escalates: retried once, then the subagent is stopped, then the host is ended', async () => {
    const h = harness({ approvalTimeoutMs: 60, approvalEscalationMs: 60 });
    const stopAt = captureIndex(
      'approval-unanswered-workflow-cancel',
      (msg, dir) => dir === 'c2s' && msg.method === 'approval/listPending',
    );
    await run(h, 'approval-unanswered-workflow-cancel', {
      approvalMode: 'ask',
      stopAt,
    });
    const host = h.hosts[0];
    const consumed = new Set<SentFrame>();
    const first = await host.nextRequest('approval/decide', consumed);
    consumed.add(first);
    expect(first.params?.choiceId).toBe('abort');
    reject(host, first);
    // The retry re-reads the approval, then declines it again.
    const listed = await host.nextRequest('approval/listPending', consumed);
    consumed.add(listed);
    const pendingFrame = loadMuseServeCapture(
      'approval-unanswered-workflow-cancel',
    ).find(
      (frame) =>
        frame.dir === 's2c' &&
        JSON.stringify(frame.msg).includes('"approvals":[{'),
    )?.msg as { result: unknown };
    reply(host, listed, pendingFrame.result);
    const second = await host.nextRequest('approval/decide', consumed);
    consumed.add(second);
    expect(second.params?.choiceId).toBe('abort');
    reject(host, second);
    // Rejected twice: stop the subagent that asked.
    const stop = await host.nextRequest('subagent/stop', consumed);
    expect(stop.params?.subagentId).toBe(
      '00000000-0000-7000-8000-000000000022',
    );
    reply(host, stop, { status: 'accepted' });
    // Still no approval/resolved within the bound: the host is ended.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(host.stdinEnded).toBe(true);
    const steps = of(h.events, 'runtime.warning')
      .filter((event) => event.code === MUSE_APPROVAL_EXPIRED_CODE)
      .map((event) => event.details?.step);
    expect(steps).toEqual([undefined, 1, 2]);
    expect(of(h.events, 'request.resolved')).toEqual([
      expect.objectContaining({ status: 'expired' }),
    ]);
  });

  test('R1: a rejected decide is retried once, on the requirement listPending names now', async () => {
    const h = harness();
    const host = await upToFirstDecide(h);
    await h.adapter.respondToRequest(THREAD, APPROVAL, 'accept');
    const consumed = new Set<SentFrame>();
    const first = await host.nextRequest('approval/decide', consumed);
    consumed.add(first);
    expect(first.params?.requirementId).toMatchObject({ sourceIndex: 0 });
    reject(host, first);
    const listed = await host.nextRequest('approval/listPending', consumed);
    const requested = APPROVE_REQUESTED().params;
    const subject = requested.subject as { stages: Record<string, unknown>[] };
    reply(host, listed, {
      approvals: [
        {
          ...requested,
          currentRequirementId: { approvalId: APPROVAL, sourceIndex: 1 },
          subject: {
            ...subject,
            stages: [
              { ...subject.stages[0], resolution: { kind: 'allowOnce' } },
              subject.stages[1],
            ],
          },
        },
      ],
      userInputs: [],
    });
    const retried = await host.nextRequest('approval/decide', consumed);
    expect(retried.params).toMatchObject({
      choiceId: 'allow_once',
      requirementId: { approvalId: APPROVAL, sourceIndex: 1 },
    });
  });

  test('R1: an approval the user accepted is never expired by the deadline mid-walk', async () => {
    const h = harness({ approvalTimeoutMs: 60 });
    const host = await upToFirstDecide(h);
    await h.adapter.respondToRequest(THREAD, APPROVAL, 'accept');
    await host.nextRequest('approval/decide', new Set());
    // Muse is slow to answer; the deadline passes.
    await new Promise((resolve) => setTimeout(resolve, 150));
    // #2880: the accepted decision is recorded as such, never as expired.
    expect(of(h.events, 'request.resolved')).toEqual([
      expect.objectContaining({ requestId: APPROVAL, status: 'approved' }),
    ]);
    expect(
      of(h.events, 'runtime.warning').filter(
        (event) => event.code === MUSE_APPROVAL_EXPIRED_CODE,
      ),
    ).toEqual([]);
    expect(
      host.sent.filter((frame) => frame.method === 'approval/decide'),
    ).toHaveLength(1);
  });
});

describe('#2452 fix round 2: an answer muse will not take is still bounded', () => {
  test('accept, decide rejected twice: the user is told, and escalation follows', async () => {
    const h = harness({ approvalEscalationMs: 60 });
    const host = await upToFirstDecide(h);
    await h.adapter.respondToRequest(THREAD, APPROVAL, 'accept');
    const consumed = new Set<SentFrame>();
    const first = await host.nextRequest('approval/decide', consumed);
    consumed.add(first);
    reject(host, first);
    const listed = await host.nextRequest('approval/listPending', consumed);
    consumed.add(listed);
    reply(host, listed, {
      approvals: [APPROVE_REQUESTED().params],
      userInputs: [],
    });
    const second = await host.nextRequest('approval/decide', consumed);
    consumed.add(second);
    expect(second.params?.choiceId).toBe('allow_once');
    reject(host, second);
    await settle();
    expect(
      of(h.events, 'runtime.warning').filter(
        (event) => event.code === MUSE_APPROVAL_DECIDE_FAILED_CODE,
      ),
    ).toHaveLength(1);
    // Muse still settles nothing: the subagent that asked is stopped.
    const stop = await host.nextRequest('subagent/stop', consumed);
    expect(stop.params?.subagentId).toBe(CHILD);
    reply(host, stop, { status: 'accepted' });
    // ...and then the host is ended; the request resolves, never left open.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(host.stdinEnded).toBe(true);
    // #2880: the decision stays recorded as the user made it, and is
    // reported never acknowledged — never left open, never cancelled over.
    expect(of(h.events, 'request.resolved')).toEqual([
      expect.objectContaining({ requestId: APPROVAL, status: 'approved' }),
    ]);
    expect(of(h.events, 'request.delivery')).toEqual([
      expect.objectContaining({
        requestId: APPROVAL,
        outcome: 'unacknowledged',
        reason: 'no-acknowledgement',
      }),
    ]);
  });
});

describe('#2452 fix round: the approval mode muse applied is checked', () => {
  test('R2: a setApprovalMode reply with another effective mode refuses the turn, visibly', async () => {
    const h = harness();
    await run(h, 'workflow-child-deny', {
      approvalMode: 'ask',
      decide: 'decline',
    });
    const host = h.hosts[0];
    const sending = h.adapter.sendTurn({
      threadId: THREAD,
      input: 'again',
      modelOptions: { approvalMode: 'auto' },
    });
    const setMode = await host.nextRequest(
      'session/setApprovalMode',
      new Set(),
    );
    expect(setMode.params?.mode).toBe('allowAll');
    reply(host, setMode, {
      status: 'accepted',
      applyOutcome: 'deferred',
      effectiveMode: { mode: 'promptUnmatched', source: 'startup' },
    });
    await expect(sending).rejects.toThrow('did not apply');
    await settle();
    expect(
      host.sent.filter((frame) => frame.method === 'turn/start'),
    ).toHaveLength(1);
    expect(
      of(h.events, 'runtime.warning').some(
        (event) => event.code === MUSE_APPROVAL_MODE_NOT_APPLIED_CODE,
      ),
    ).toBe(true);
  });
});

describe('#2452 fix round: the walk answers only what the user saw', () => {
  test('R4: an update that changes the command stops the walk and puts the new command to the user', async () => {
    const h = harness();
    const host = await upToFirstDecide(h);
    await h.adapter.respondToRequest(THREAD, APPROVAL, 'accept');
    const consumed = new Set<SentFrame>();
    const first = await host.nextRequest('approval/decide', consumed);
    consumed.add(first);
    reply(host, first, {
      status: 'accepted',
      approvalId: APPROVAL,
      terminal: false,
    });
    const updated = loadMuseServeCapture('workflow-child-approve').find(
      (frame) => frame.msg.method === 'approval/updated',
    )?.msg as { params: Record<string, unknown> };
    const subject = updated.params.subject as Record<string, unknown>;
    host.writeFrame({
      jsonrpc: '2.0',
      method: 'approval/updated',
      params: {
        ...updated.params,
        subject: { ...subject, command: 'rm -rf ./stamp.txt' },
      },
    });
    await settle();
    expect(
      host.sent.filter((frame) => frame.method === 'approval/decide'),
    ).toHaveLength(1);
    // #2880: the user's answer was recorded for the subject they saw; muse
    // changed the subject before closing it, so that decision is reported
    // never acknowledged, and the new subject is a new request.
    expect(of(h.events, 'request.resolved')).toEqual([
      expect.objectContaining({ requestId: APPROVAL, status: 'approved' }),
    ]);
    expect(of(h.events, 'request.delivery')).toEqual([
      expect.objectContaining({
        requestId: APPROVAL,
        outcome: 'unacknowledged',
        reason: 'no-acknowledgement',
      }),
    ]);
    const opened = of(h.events, 'request.opened');
    expect(opened).toHaveLength(2);
    expect(opened[1].requestId).not.toBe(APPROVAL);
    expect(opened[1].payload?.command).toBe('rm -rf ./stamp.txt');
  });
});

describe('#2452 fix round: host ownership and data home', () => {
  test('E4: unconfirmed host stop retains the session and retries the original live host', async () => {
    const released: FakeMuseServeHost[] = [];
    let unconfirmed = true;
    const h = harness({
      terminateHost: async (host) => {
        if (unconfirmed)
          throw new Error('Process tree did not confirm exit after SIGKILL.');
        host.exit(0);
      },
      onRelease: (host) => released.push(host),
      spawnHost: (args) => {
        const host = new FakeMuseServeHost(args);
        host.stdin.end = () => {
          host.stdinEnded = true;
        };
        return host;
      },
    });
    const host = await upToFirstDecide(h);
    try {
      await expect(h.adapter.stopSession(THREAD)).rejects.toThrow(
        'could not confirm host termination',
      );
      await expect(h.adapter.stopSession(THREAD)).rejects.toThrow(
        'could not confirm host termination',
      );
      await settle();
      expect(of(h.events, 'session.exited')).toEqual([]);
      expect(await h.adapter.hasSession(THREAD)).toBe(true);
      expect(released).toEqual([]);
      expect(
        of(h.events, 'runtime.warning').some(
          (event) => event.code === MUSE_SERVE_STOP_UNCONFIRMED_CODE,
        ),
      ).toBe(true);
      unconfirmed = false;
      await expect(h.adapter.stopSession(THREAD)).resolves.toBeUndefined();
      await expect(h.adapter.stopSession(THREAD)).resolves.toBeUndefined();
      await settle();
      expect(of(h.events, 'session.exited')).toHaveLength(1);
      expect(await h.adapter.hasSession(THREAD)).toBe(false);
      expect(released).toEqual([host]);
    } finally {
      unconfirmed = false;
      await h.adapter.stopAll();
    }
  });

  test('R5: an unconfirmed stop never treats leader exit as group settlement or signals that departed leader again', async () => {
    const released: FakeMuseServeHost[] = [];
    let attempts = 0;
    const h = harness({
      terminateHost: async () => {
        attempts++;
        throw new Error('Process tree did not confirm exit after SIGKILL.');
      },
      onRelease: (host) => released.push(host),
      spawnHost: (args) => {
        const host = new FakeMuseServeHost(args);
        host.stdin.end = () => {
          host.stdinEnded = true;
        };
        return host;
      },
    });
    const host = await upToFirstDecide(h);
    try {
      await expect(h.adapter.stopSession(THREAD)).rejects.toThrow(
        'could not confirm host termination',
      );
      host.exit(0);
      await settle();
      await expect(h.adapter.stopSession(THREAD)).rejects.toThrow(
        'could not confirm host termination',
      );
      expect(attempts).toBe(1);
      expect(await h.adapter.hasSession(THREAD)).toBe(true);
      expect(of(h.events, 'session.exited')).toEqual([]);
      expect(released).toEqual([]);
    } finally {
      // This stream double has no OS process; assert the unresolved cleanup and close its stream.
      if (await h.adapter.hasSession(THREAD)) {
        await expect(h.adapter.stopAll()).rejects.toThrow(
          'could not confirm host termination',
        );
      } else {
        await h.adapter.stopAll();
      }
      adapters.splice(adapters.indexOf(h.adapter), 1);
    }
  });

  test('R6: the serve host env moves XDG_DATA_HOME only for an explicit data home', () => {
    expect(museServeEnvOverrides()).toEqual({});
    expect(museServeEnvOverrides('/isolated/data')).toEqual({
      XDG_DATA_HOME: '/isolated/data',
    });
  });
});

describe('#2452 fix round: regressions from the verifier', () => {
  test('I2: acceptForSession on bash does not auto-allow a different tool', async () => {
    const h = harness();
    await run(h, 'workflow-child-approve', {
      approvalMode: 'ask',
      decide: 'acceptForSession',
    });
    const id = '00000000-0000-7000-8000-0000000000bb';
    const host = h.hosts[0];
    const before = host.sent.length;
    host.writeFrame({
      jsonrpc: '2.0',
      method: 'approval/requested',
      params: {
        ...APPROVE_REQUESTED().params,
        approvalId: id,
        toolName: 'write_file',
        currentRequirementId: { approvalId: id, sourceIndex: 0 },
        subject: {
          kind: 'shell',
          command: 'x',
          stages: [
            {
              requirementId: { approvalId: id, sourceIndex: 0 },
              argv: ['x'],
              resolution: { kind: 'unresolved' },
            },
          ],
        },
      },
    });
    await settle();
    expect(of(h.events, 'request.opened')).toHaveLength(2);
    expect(
      host.sent
        .slice(before)
        .filter((frame) => frame.method === 'approval/decide'),
    ).toEqual([]);
  });

  test('#3071: a request names its turn only when the turn itself asked; a subagent origin names none', async () => {
    const h = harness();
    const stopAt = captureIndex(
      'workflow-child-approve',
      (msg, dir) => dir === 's2c' && msg.method === 'approval/requested',
    );
    await run(h, 'workflow-child-approve', { approvalMode: 'ask', stopAt });
    const liveTurnId = of(h.events, 'turn.started').at(-1)?.turnId;
    expect(liveTurnId).toBeTruthy();
    const host = h.hosts[0];
    const requested = (approvalId: string, extra: Record<string, unknown>) => {
      const params: Record<string, unknown> = {
        ...APPROVE_REQUESTED().params,
        approvalId,
        currentRequirementId: { approvalId, sourceIndex: 0 },
        // The case the captured protocol never produces: a request that
        // reports the PARENT's live turn id.
        turnId: liveTurnId,
        ...extra,
      };
      if (extra.subagentOrigin === undefined) delete params.subagentOrigin;
      host.writeFrame({ jsonrpc: '2.0', method: 'approval/requested', params });
    };
    requested('00000000-0000-7000-8000-0000000000c1', {
      subagentOrigin: { subagentId: 'child-under-parent-turn' },
    });
    requested('00000000-0000-7000-8000-0000000000c2', {});
    await settle();
    const opened = of(h.events, 'request.opened');
    const bySubagent = opened.find(
      (event) => event.requestId === '00000000-0000-7000-8000-0000000000c1',
    );
    const byTurn = opened.find(
      (event) => event.requestId === '00000000-0000-7000-8000-0000000000c2',
    );
    expect(bySubagent).toBeDefined();
    expect(bySubagent?.turnId).toBeUndefined();
    expect(byTurn?.turnId).toBe(liveTurnId);
  });

  for (const target of ['ask', 'auto'] as const) {
    test(`I3: never → ${target} re-hosts onto a sandboxed host`, async () => {
      const h = harness();
      await run(h, 'workflow-child-deny', {
        approvalMode: 'never',
        decide: 'decline',
      });
      expect(h.hosts[0].args).toEqual(['serve', '--disable-sandbox']);
      const sending = h.adapter.sendTurn({
        threadId: THREAD,
        input: 'again',
        modelOptions: { approvalMode: target },
      });
      sending.catch(() => {});
      for (let attempt = 0; attempt < 200 && !h.hosts[1]; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(h.hosts[1]?.args).toEqual(['serve']);
      expect(h.hosts[0].stdinEnded).toBe(true);
    });
  }

  async function pendingUnanswered(h: Harness) {
    const stopAt = captureIndex(
      'approval-unanswered-workflow-cancel',
      (msg, dir) => dir === 'c2s' && msg.method === 'approval/listPending',
    );
    await run(h, 'approval-unanswered-workflow-cancel', {
      approvalMode: 'ask',
      stopAt,
    });
    expect(of(h.events, 'request.opened')).toHaveLength(1);
  }

  test('I5: a host exit resolves a pending approval cancelled', async () => {
    const h = harness();
    await pendingUnanswered(h);
    h.hosts[0].exit(3);
    await settle();
    expect(of(h.events, 'request.resolved')).toEqual([
      expect.objectContaining({ status: 'cancelled' }),
    ]);
  });

  test('I15: stopping the session resolves a pending approval cancelled', async () => {
    const h = harness();
    await pendingUnanswered(h);
    await h.adapter.stopSession(THREAD);
    await settle();
    expect(of(h.events, 'request.resolved')).toEqual([
      expect.objectContaining({ status: 'cancelled' }),
    ]);
  });
});

describe('#2452 delta review: escalation only acts on the question it belongs to', () => {
  const UNANSWERED_ID = '00000000-0000-7000-8000-000000000024';
  const UNANSWERED_CHILD = '00000000-0000-7000-8000-000000000022';
  const wait = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  async function unansweredOpen(h: Harness) {
    const stopAt = captureIndex(
      'approval-unanswered-workflow-cancel',
      (msg, dir) => dir === 'c2s' && msg.method === 'approval/listPending',
    );
    await run(h, 'approval-unanswered-workflow-cancel', {
      approvalMode: 'ask',
      stopAt,
    });
    return h.hosts[0];
  }

  const unansweredRequested = () =>
    loadMuseServeCapture('approval-unanswered-workflow-cancel').find(
      (frame) => frame.msg.method === 'approval/requested',
    )?.msg as { params: Record<string, unknown> };

  async function rehost(h: Harness, approvals: Record<string, unknown>[]) {
    const sending = h.adapter.sendTurn({ threadId: THREAD, input: 'again' });
    sending.catch(() => {});
    for (let attempt = 0; attempt < 200 && !h.hosts[1]; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const next = h.hosts[1];
    const seen = new Set<SentFrame>();
    const answer = async (method: string, result: unknown) => {
      const request = await next.nextRequest(method, seen);
      seen.add(request);
      reply(next, request, result);
      return request;
    };
    await answer(
      'initialize',
      (
        loadMuseServeCapture('workflow-child-approve')[2].msg as {
          result: unknown;
        }
      ).result,
    );
    await answer('session/resume', {
      session: {
        sessionId: '00000000-0000-7000-8000-000000000002',
        approvalMode: { mode: 'promptUnmatched' },
      },
      viewCursor: '',
      history: {},
      pendingRequests: [],
    });
    await answer('approval/listPending', { approvals, userInputs: [] });
    return { next, seen, sending };
  }

  test('E1: a subject change reopens the card and the old escalation never ends the host under it', async () => {
    const h = harness({ approvalTimeoutMs: 200, approvalEscalationMs: 60 });
    const host = await unansweredOpen(h);
    // The deadline declines the unanswered card (muse does not answer).
    await host.nextRequest('approval/decide', new Set());
    const requested = unansweredRequested().params;
    const subject = requested.subject as Record<string, unknown>;
    host.writeFrame({
      jsonrpc: '2.0',
      method: 'approval/updated',
      params: { ...requested, subject: { ...subject, command: 'ls' } },
    });
    await settle();
    expect(of(h.events, 'request.opened')).toHaveLength(2);
    // Past when the old escalation would have fired, before the new deadline.
    await wait(110);
    expect(
      host.sent.filter((frame) => frame.method === 'subagent/stop'),
    ).toEqual([]);
    expect(host.stdinEnded).toBe(false);
  });

  test('G3: an in-flight stop reply cannot arm escalation for a reopened card', async () => {
    const h = harness({ approvalTimeoutMs: 200, approvalEscalationMs: 40 });
    const host = await unansweredOpen(h);
    const stop = await host.nextRequest('subagent/stop', new Set());
    const requested = unansweredRequested().params;
    host.writeFrame({
      jsonrpc: '2.0',
      method: 'approval/updated',
      params: {
        ...requested,
        subject: {
          ...(requested.subject as Record<string, unknown>),
          command: 'ls',
        },
      },
    });
    await settle();
    expect(of(h.events, 'request.opened')).toHaveLength(2);
    reply(host, stop, { status: 'accepted' });
    await wait(110);
    expect(
      host.sent.filter((frame) => frame.method === 'subagent/stop'),
    ).toHaveLength(1);
    expect(host.stdinEnded).toBe(false);
  });

  test('H1: a stop reply for a resolved approval cannot escalate a new approval with the same id', async () => {
    const h = harness({ approvalTimeoutMs: 300, approvalEscalationMs: 40 });
    const host = await unansweredOpen(h);
    const stop = await host.nextRequest('subagent/stop', new Set());
    const requested = unansweredRequested().params;
    host.writeFrame({
      jsonrpc: '2.0',
      method: 'approval/resolved',
      params: { approvalId: UNANSWERED_ID, decision: 'abort' },
    });
    host.writeFrame({
      jsonrpc: '2.0',
      method: 'approval/requested',
      params: requested,
    });
    await settle();
    expect(of(h.events, 'request.opened')).toHaveLength(1);
    const childDeltasBefore = childWorkDeltas(h.events).length;
    reply(host, stop, { status: 'accepted' });
    await wait(100);
    expect(childWorkDeltas(h.events)).toHaveLength(childDeltasBefore);
    expect(
      host.sent.filter((frame) => frame.method === 'subagent/stop'),
    ).toHaveLength(1);
    expect(host.stdinEnded).toBe(false);
  });

  test('E2: a same-subject restatement after a deadline decline does not clear the escalation', async () => {
    const h = harness({ approvalTimeoutMs: 60, approvalEscalationMs: 80 });
    const host = await unansweredOpen(h);
    const consumed = new Set<SentFrame>();
    const decide = await host.nextRequest('approval/decide', consumed);
    consumed.add(decide);
    reply(host, decide, {
      status: 'accepted',
      approvalId: UNANSWERED_ID,
      terminal: false,
    });
    host.writeFrame({
      jsonrpc: '2.0',
      method: 'approval/requested',
      params: unansweredRequested().params,
    });
    // No approval/resolved ever arrives: the subagent is still stopped.
    const stop = await host.nextRequest('subagent/stop', consumed);
    expect(stop.params?.subagentId).toBe(UNANSWERED_CHILD);
  });

  test('E3: an approval escalated once and brought back by a re-host is declined without a second card, and cannot loop', async () => {
    const h = harness({ approvalTimeoutMs: 60, approvalEscalationMs: 40 });
    const host = await unansweredOpen(h);
    const consumed = new Set<SentFrame>();
    await host.nextRequest('approval/decide', consumed);
    const stop = await host.nextRequest('subagent/stop', consumed);
    reply(host, stop, { status: 'accepted' });
    await wait(150);
    expect(host.stdinEnded).toBe(true);
    // The next message re-hosts; muse's durable log still holds the approval.
    const sending = h.adapter.sendTurn({ threadId: THREAD, input: 'again' });
    sending.catch(() => {});
    for (let attempt = 0; attempt < 200 && !h.hosts[1]; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const next = h.hosts[1];
    const seen = new Set<SentFrame>();
    const answer = async (method: string, result: unknown) => {
      const request = await next.nextRequest(method, seen);
      seen.add(request);
      next.writeFrame({ jsonrpc: '2.0', id: request.id, result });
      return request;
    };
    await answer(
      'initialize',
      (
        loadMuseServeCapture('workflow-child-approve')[2].msg as {
          result: unknown;
        }
      ).result,
    );
    await answer('session/resume', {
      session: {
        sessionId: '00000000-0000-7000-8000-000000000002',
        approvalMode: { mode: 'promptUnmatched' },
      },
      viewCursor: '',
      history: {},
      pendingRequests: [],
    });
    const pendingList = {
      approvals: [unansweredRequested().params],
      userInputs: [],
    };
    await answer('approval/listPending', pendingList);
    const decline = await next.nextRequest('approval/decide', seen);
    seen.add(decline);
    expect(decline.params?.choiceId).toBe('abort');
    // Muse rejects it, and the retry too: Station stops the subagent once.
    reject(next, decline);
    await answer('approval/listPending', pendingList);
    const again = await next.nextRequest('approval/decide', seen);
    seen.add(again);
    reject(next, again);
    const repeatedStop = await next.nextRequest('subagent/stop', seen);
    expect(repeatedStop.params?.subagentId).toBe(UNANSWERED_CHILD);
    await wait(150);
    expect(of(h.events, 'request.opened')).toHaveLength(1);
    expect(
      next.sent.filter((frame) => frame.method === 'subagent/stop'),
    ).toHaveLength(1);
    expect(next.stdinEnded).toBe(false);
    expect(
      of(h.events, 'runtime.warning').some(
        (event) =>
          event.message.includes(
            'still waiting on a request Station could not decline',
          ) && event.message.includes('asked Muse to stop the subagent'),
      ),
    ).toBe(true);
    const turn = await next.nextRequest('turn/start', seen);
    reject(next, turn);
    await expect(sending).rejects.toThrow();
    const changing = h.adapter.sendTurn({
      threadId: THREAD,
      input: 'change posture',
      modelOptions: { approvalMode: 'never' },
    });
    changing.catch(() => {});
    for (let attempt = 0; attempt < 200 && !h.hosts[2]; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(h.hosts).toHaveLength(3);
    h.hosts[2].exit(1);
    await expect(changing).rejects.not.toThrow('cannot change its sandbox');
  });

  test('G2: an accepted repeat decline with no resolution releases the approval and permits a sandbox change', async () => {
    const h = harness({ approvalTimeoutMs: 80, approvalEscalationMs: 40 });
    const host = await unansweredOpen(h);
    const consumed = new Set<SentFrame>();
    await host.nextRequest('approval/decide', consumed);
    const stop = await host.nextRequest('subagent/stop', consumed);
    reply(host, stop, { status: 'accepted' });
    await wait(140);
    expect(host.stdinEnded).toBe(true);
    const { next, seen, sending } = await rehost(h, [
      unansweredRequested().params,
    ]);
    const turn = await next.nextRequest('turn/start', seen);
    seen.add(turn);
    reject(next, turn);
    await expect(sending).rejects.toThrow();
    const decline = await next.nextRequest('approval/decide', seen);
    seen.add(decline);
    reply(next, decline, {
      status: 'accepted',
      approvalId: UNANSWERED_ID,
      terminal: false,
    });
    await expect(
      h.adapter.sendTurn({
        threadId: THREAD,
        input: 'too early',
        modelOptions: { approvalMode: 'never' },
      }),
    ).rejects.toThrow('cannot change its sandbox');
    await wait(130);
    expect(
      of(h.events, 'runtime.warning').some((event) =>
        event.message.includes('stopped waiting for it'),
      ),
    ).toBe(true);
    const changing = h.adapter.sendTurn({
      threadId: THREAD,
      input: 'change posture',
      modelOptions: { approvalMode: 'never' },
    });
    changing.catch(() => {});
    for (let attempt = 0; attempt < 200 && !h.hosts[2]; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(h.hosts).toHaveLength(3);
    h.hosts[2].exit(1);
    await expect(changing).rejects.not.toThrow('cannot change its sandbox');
  });

  test('a returned parent approval with no known turn never interrupts the new live turn', async () => {
    const h = harness({ approvalTimeoutMs: 60, approvalEscalationMs: 40 });
    const stopAt = captureIndex(
      'approval-unanswered-workflow-cancel',
      (msg, dir) => dir === 's2c' && msg.method === 'approval/requested',
    );
    await run(h, 'approval-unanswered-workflow-cancel', {
      approvalMode: 'ask',
      stopAt,
    });
    const parentApproval = { ...unansweredRequested().params };
    delete parentApproval.turnId;
    delete parentApproval.subagentOrigin;
    const host = h.hosts[0];
    host.writeFrame({
      jsonrpc: '2.0',
      method: 'approval/requested',
      params: parentApproval,
    });
    await host.nextRequest('approval/decide', new Set());
    await wait(120);
    expect(host.stdinEnded).toBe(true);

    const { next, seen, sending } = await rehost(h, [parentApproval]);
    const turn = await next.nextRequest('turn/start', seen);
    seen.add(turn);
    reply(next, turn, {
      status: 'accepted',
      disposition: 'started',
      turnId: 'new-live-turn',
    });
    await expect(sending).resolves.toMatchObject({ turnId: 'new-live-turn' });

    const decline = await next.nextRequest('approval/decide', seen);
    seen.add(decline);
    reject(next, decline);
    const listed = await next.nextRequest('approval/listPending', seen);
    seen.add(listed);
    reply(next, listed, { approvals: [parentApproval], userInputs: [] });
    const retry = await next.nextRequest('approval/decide', seen);
    seen.add(retry);
    reject(next, retry);
    await settle();

    expect(
      next.sent.filter((frame) => frame.method === 'turn/interrupt'),
    ).toEqual([]);
    expect(
      next.sent.filter((frame) => frame.method === 'subagent/stop'),
    ).toEqual([]);
    expect(
      of(h.events, 'runtime.warning').filter(
        (event) => event.code === MUSE_APPROVAL_DECIDE_FAILED_CODE,
      ),
    ).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('could not identify the turn'),
      }),
    ]);
    expect(next.stdinEnded).toBe(false);
    await expect(
      h.adapter.sendTurn({ threadId: THREAD, input: 'another message' }),
    ).rejects.toThrow('already has an active turn');
  });

  test('G4: a changed subject is offered again after the host dies', async () => {
    const h = harness({ approvalTimeoutMs: 200, approvalEscalationMs: 40 });
    const host = await unansweredOpen(h);
    await host.nextRequest('subagent/stop', new Set());
    const requested = unansweredRequested().params;
    const changed = {
      ...requested,
      subject: {
        ...(requested.subject as Record<string, unknown>),
        command: 'ls',
      },
    };
    host.writeFrame({
      jsonrpc: '2.0',
      method: 'approval/updated',
      params: changed,
    });
    await settle();
    expect(of(h.events, 'request.opened')).toHaveLength(2);
    host.exit(1);
    const { next, seen } = await rehost(h, [changed]);
    await settle();
    expect(of(h.events, 'request.opened')).toHaveLength(3);
    expect(
      next.sent.filter((frame) => frame.method === 'approval/decide'),
    ).toEqual([]);
    expect(seen.size).toBe(3);
  });

  test('H2: a returned escalated approval that changes subject before publish gets a new card', async () => {
    const h = harness({ approvalTimeoutMs: 300, approvalEscalationMs: 40 });
    const host = await unansweredOpen(h);
    const stop = await host.nextRequest('subagent/stop', new Set());
    reply(host, stop, { status: 'accepted' });
    await wait(150);
    expect(host.stdinEnded).toBe(true);
    const requested = unansweredRequested().params;
    const { next, seen } = await rehost(h, [requested]);
    const decline = await next.nextRequest('approval/decide', seen);
    const changed = {
      ...requested,
      subject: {
        ...(requested.subject as Record<string, unknown>),
        command: 'ls',
      },
    };
    next.writeFrame({
      jsonrpc: '2.0',
      method: 'approval/updated',
      params: changed,
    });
    await settle();
    expect(of(h.events, 'request.opened')).toHaveLength(2);
    expect(of(h.events, 'request.opened')[1].description).toContain('ls');
    reply(next, decline, { status: 'accepted' });
    await settle();
    expect(
      next.sent.filter((frame) => frame.method === 'approval/decide'),
    ).toHaveLength(1);
  });

  test('E5: refining a stage muse marked argvComplete:false does not reopen the request', async () => {
    const h = harness();
    const host = await upToFirstDecide(h);
    await h.adapter.respondToRequest(THREAD, APPROVAL, 'accept');
    const consumed = new Set<SentFrame>();
    const first = await host.nextRequest('approval/decide', consumed);
    consumed.add(first);
    reply(host, first, {
      status: 'accepted',
      approvalId: APPROVAL,
      terminal: false,
    });
    const updated = loadMuseServeCapture('workflow-child-approve').find(
      (frame) => frame.msg.method === 'approval/updated',
    )?.msg as { params: Record<string, unknown> };
    const subject = updated.params.subject as {
      stages: Record<string, unknown>[];
    };
    expect(subject.stages[0].argvComplete).toBe(false);
    host.writeFrame({
      jsonrpc: '2.0',
      method: 'approval/updated',
      params: {
        ...updated.params,
        subject: {
          ...subject,
          stages: [
            { ...subject.stages[0], argv: ['date', '-u'] },
            subject.stages[1],
          ],
        },
      },
    });
    const second = await host.nextRequest('approval/decide', consumed);
    expect(second.params?.requirementId).toMatchObject({ sourceIndex: 1 });
    // #2880: only the decision the user made is recorded; the refinement
    // neither reopens the request nor closes it.
    expect(of(h.events, 'request.resolved')).toEqual([
      expect.objectContaining({ requestId: APPROVAL, status: 'approved' }),
    ]);
    expect(of(h.events, 'request.delivery')).toEqual([]);
    expect(of(h.events, 'request.opened')).toHaveLength(1);
  });
});

// Cascade owns the delivery debt; Muse must not turn an unconfirmed retry into settlement.
test.each(['live', 'departed'] as const)(
  'cascade keeps an unconfirmed Muse child pending across repeated delivery: %s leader',
  async (leader) => {
    let unconfirmed = true;
    let attempts = 0;
    const h = harness({
      collectEvents: false,
      terminateHost: async (host) => {
        attempts++;
        if (unconfirmed)
          throw new Error('Injected unconfirmed host termination');
        host.exit(0);
      },
      spawnHost: (args) => {
        const host = new FakeMuseServeHost(args);
        host.stdin.end = () => {
          host.stdinEnded = true;
        };
        return host;
      },
    });
    const host = await upToFirstDecide(h);
    const store = new EventStore(
      join(makeCascadeHome('cascade-muse-'), 'events.sqlite'),
    );
    const parent = new GateTestAdapter();
    const service = new OrchestrationService({
      eventStore: store,
      eventBus: new EventBus(),
      idleSessionParkAfterMs: 0,
      adapterRegistry: {
        register() {},
        list: () => [parent, h.adapter],
        get: (provider) =>
          provider === 'muse'
            ? h.adapter
            : provider === 'claude'
              ? parent
              : undefined,
      },
      logger: { debug() {}, warn() {} },
    });
    try {
      for (const id of ['parent', THREAD])
        store.appendEvent({
          eventId: `${id}:start`,
          threadId: id,
          sessionId: id,
          provider: id === THREAD ? 'muse' : 'claude',
          method: 'session.started',
          createdAt: '2026-01-01T00:00:00.000Z',
          metadata:
            id === THREAD
              ? {
                  stationDelegationProvenance: 'caller-derived',
                  delegation: {
                    parentSessionId: 'parent',
                    parentConversationId: 'parent',
                  },
                }
              : {},
        });
      service.initialize();
      await service.whenSessionRecoveryCompleted();
      service.seedSessionRecord({
        threadId: THREAD,
        provider: 'muse',
        status: 'running',
      });
      store.appendEvent({
        eventId: 'parent:end',
        threadId: 'parent',
        sessionId: 'parent',
        provider: 'claude',
        method: 'session.exited',
        reason: 'stopped',
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      await service.sweepIdleSessions();
      expect(store.pendingCascadeStops()).toEqual([
        expect.objectContaining({ childId: THREAD }),
      ]);
      const before = attempts;
      if (leader === 'departed') host.exit(0);
      await service.sweepIdleSessions();
      expect(store.pendingCascadeStops()).toEqual([
        expect.objectContaining({ childId: THREAD }),
      ]);
      expect(await h.adapter.hasSession(THREAD)).toBe(true);
      expect(
        store.latestEventByMethod(THREAD, 'session.exited'),
      ).toBeUndefined();
      if (leader === 'departed') expect(attempts).toBe(before);
      else {
        unconfirmed = false;
        await service.sweepIdleSessions();
        expect(store.pendingCascadeStops()).toEqual([]);
      }
    } finally {
      unconfirmed = false;
      if (leader === 'departed') {
        await expect(service.shutdown()).rejects.toThrow(
          'Provider adapter shutdown failed',
        );
        adapters.splice(adapters.indexOf(h.adapter), 1);
      } else await service.shutdown();
      store.close();
    }
  },
);

// ---------------------------------------------------------------------------
// Muse Code 1.4.18 (`fixtures/muse-serve-1.4.18-*.jsonl`, live captures).

const SESSION_1418 = '00000000-0000-7000-8000-000000000002';
const TURN_1418 = '00000000-0000-7000-8000-000000000005';
const USER_INPUT_1418 = '00000000-0000-7000-8000-000000000015';
const STEER_TEXT =
  'Change of plan: after the command finishes, reply with exactly the word BRAVO instead of ALPHA.';

function startServe(h: Harness) {
  return firstHost(h, () =>
    h.adapter.startSession({
      provider: 'muse',
      threadId: THREAD,
      cwd: '/workspace/probe/repo',
    }),
  );
}

/** The adapter's own replies to the host's server requests. */
function repliesTo(host: FakeMuseServeHost, id: number | string) {
  return host.sent.filter(
    (frame) => frame.method === undefined && frame.id === id,
  );
}

/**
 * Replays `user-input` with the adapter answering the question as
 * `answer` returns, read from the `request.opened` the adapter published.
 */
async function runUserInput(
  h: Harness,
  answer: (
    opened: Extract<CanonicalRuntimeEvent, { method: 'request.opened' }>,
  ) => Promise<unknown>,
  stopAt?: number,
): Promise<SentFrame[]> {
  const host = await startServe(h);
  const driven = await replayMuseServeCapture(
    host,
    loadMuseServeCapture('user-input'),
    {
      ...(stopAt !== undefined ? { stopAt } : {}),
      onDrivenRequest: (method) => {
        if (method === 'turn/start')
          return h.adapter.sendTurn({ threadId: THREAD, input: 'go' });
        if (method === 'userInput/answer' || method === 'userInput/cancel')
          return (async () => {
            await settle();
            return answer(of(h.events, 'request.opened')[0]);
          })();
        return undefined;
      },
    },
  );
  await settle();
  return driven;
}

describe('Muse Code 1.4.18 serve host', () => {
  test('its schema fingerprint is verified: the session runs on serve, not the exec fallback', async () => {
    const h = harness();
    const host = await startServe(h);
    await replayMuseServeCapture(host, loadMuseServeCapture('user-input'), {
      stopAt: captureIndex('user-input', (msg) => msg.method === 'turn/start'),
    });
    await settle();
    expect(
      (
        loadMuseServeCapture('user-input')[2].msg.result as {
          schema: { fingerprint: string };
        }
      ).schema.fingerprint,
    ).toBe(
      'sha256:77dda18550adef14e257b015fe4e6490b722723f7d526df5ba4867939fff68a3',
    );
    expect(
      of(h.events, 'runtime.warning').filter(
        (event) => event.code === MUSE_SERVE_UNAVAILABLE_CODE,
      ),
    ).toEqual([]);
    expect(of(h.events, 'session.configured')[0].metadata).toMatchObject({
      museTransport: 'serve',
      museSessionId: SESSION_1418,
    });
    expect(host.stdinEnded).toBe(false);
    expect(h.adapter.canSteerTurn(THREAD)).toBe(true);
  });
});

describe('#1952 Muse Code 1.4.18: steering a running serve turn', () => {
  test('turn/steer targets the running turn, publishes a steer turn.started, and the turn ends with the steered answer', async () => {
    const h = harness();
    const host = await startServe(h);
    let sent: Promise<{ turnId: string }> | undefined;
    const driven = await replayMuseServeCapture(
      host,
      loadMuseServeCapture('steer'),
      {
        onDrivenRequest: (method) => {
          if (method === 'turn/start') {
            sent = h.adapter.sendTurn({ threadId: THREAD, input: 'go' });
            return sent;
          }
          if (method === 'turn/steer')
            return (async () => {
              const { turnId } = await sent!;
              return h.adapter.steerTurn(THREAD, `  ${STEER_TEXT}\n`, turnId);
            })();
          return undefined;
        },
      },
    );
    await settle();
    await expect(sent).resolves.toMatchObject({ turnId: TURN_1418 });
    const steer = driven.find((frame) => frame.method === 'turn/steer');
    expect(steer?.params).toEqual({
      commandId: expect.any(String),
      sessionId: SESSION_1418,
      expectedTurnId: TURN_1418,
      input: [{ type: 'text', text: STEER_TEXT }],
    });
    const started = of(h.events, 'turn.started');
    expect(started).toHaveLength(2);
    expect(started[0]).toMatchObject({ turnId: TURN_1418, prompt: 'go' });
    expect(started[0]).not.toHaveProperty('inputKind');
    expect(started[1]).toMatchObject({
      turnId: TURN_1418,
      prompt: STEER_TEXT,
      inputKind: 'steer',
    });
    // One turn, ended once, with the answer the steer asked for.
    const completed = of(h.events, 'turn.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      turnId: TURN_1418,
      finishReason: 'stop',
      outputText: expect.stringMatching(/BRAVO$/),
    });
  });

  test('muse refusing the steer (no such run) is a no-active-turn refusal with nothing published', async () => {
    const h = harness();
    const host = await startServe(h);
    let sent: Promise<{ turnId: string }> | undefined;
    await replayMuseServeCapture(host, loadMuseServeCapture('steer'), {
      stopAt: captureIndex('steer', (msg) => msg.method === 'turn/steer'),
      onDrivenRequest: (method) => {
        if (method !== 'turn/start') return undefined;
        sent = h.adapter.sendTurn({ threadId: THREAD, input: 'go' });
        return sent;
      },
    });
    const { turnId } = await sent!;
    const steering = h.adapter.steerTurn(THREAD, STEER_TEXT, turnId);
    const request = await host.nextRequest('turn/steer', new Set());
    // Muse 1.4.18's own refusal, captured live against an idle session.
    host.writeFrame({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32030,
        message: `turn/steer command ${String(request.params?.commandId)} rejected: missing_run`,
        data: {
          kind: 'commandRejected',
          retryable: false,
          reason: 'missing_run',
        },
      },
    });
    await expect(steering).rejects.toBeInstanceOf(ProviderTurnEndedError);
    await settle();
    expect(
      of(h.events, 'turn.started').filter(
        (event) => event.inputKind === 'steer',
      ),
    ).toEqual([]);
  });

  test('a steer muse accepts after it already ended the turn publishes no steer turn.started and stays indeterminate', async () => {
    const h = harness();
    const host = await startServe(h);
    const frames = loadMuseServeCapture('steer');
    let sent: Promise<{ turnId: string }> | undefined;
    await replayMuseServeCapture(host, frames, {
      stopAt: captureIndex('steer', (msg) => msg.method === 'turn/steer'),
      onDrivenRequest: (method) => {
        if (method !== 'turn/start') return undefined;
        sent = h.adapter.sendTurn({ threadId: THREAD, input: 'go' });
        return sent;
      },
    });
    const { turnId } = await sent!;
    const steering = h.adapter.steerTurn(THREAD, STEER_TEXT, turnId);
    const request = await host.nextRequest('turn/steer', new Set());
    // Muse's own terminal lands first, then the steer's `accepted` reply.
    const completedIndex = captureIndex(
      'steer',
      (msg) => msg.method === 'turn/completed',
    );
    host.writeFrame(frames[completedIndex].msg);
    await settle();
    const reply = frames.find(
      (frame) =>
        frame.dir === 's2c' &&
        frame.msg.method === undefined &&
        (frame.msg.result as { status?: unknown } | undefined)?.status ===
          'accepted' &&
        (frame.msg.result as { turnId?: unknown }).turnId === TURN_1418,
    );
    host.writeFrame({ ...reply!.msg, id: request.id });
    // Muse accepted the input, so this is not a no-effect refusal.
    const outcome = await steering.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(ProviderTurnEndedError);
    await settle();
    const methods = h.events
      .filter((event) => event.turnId === TURN_1418)
      .map((event) => event.method)
      .filter((method) => method.startsWith('turn.'));
    expect(methods.at(-1)).toBe('turn.completed');
    expect(
      of(h.events, 'turn.started').filter(
        (event) => event.inputKind === 'steer',
      ),
    ).toEqual([]);
    expect(activeTurnIdForEvents(h.events)).toBeUndefined();
  });

  test('a steer muse confirms into the running turn is shown even when muse opened its own turn meanwhile', async () => {
    const h = harness();
    const host = await startServe(h);
    const frames = loadMuseServeCapture('steer');
    let sent: Promise<{ turnId: string }> | undefined;
    await replayMuseServeCapture(host, frames, {
      stopAt: captureIndex('steer', (msg) => msg.method === 'turn/steer'),
      onDrivenRequest: (method) => {
        if (method !== 'turn/start') return undefined;
        sent = h.adapter.sendTurn({ threadId: THREAD, input: 'go' });
        return sent;
      },
    });
    const { turnId } = await sent!;
    const steering = h.adapter.steerTurn(THREAD, STEER_TEXT, turnId);
    const request = await host.nextRequest('turn/steer', new Set());
    // Muse opens a turn of its own before it answers the steer.
    const started = frames[
      captureIndex('steer', (msg) => msg.method === 'turn/started')
    ].msg as { params: Record<string, unknown> };
    const MUSE_TURN = '00000000-0000-7000-8000-0000000000f1';
    host.writeFrame({
      ...started,
      params: { ...started.params, turnId: MUSE_TURN, commandId: undefined },
    });
    await settle();
    expect(
      of(h.events, 'turn.started').some((event) => event.turnId === MUSE_TURN),
    ).toBe(true);
    host.writeFrame({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        commandId: request.params?.commandId,
        status: 'accepted',
        turnId,
      },
    });
    await expect(steering).resolves.toBeUndefined();
    expect(
      of(h.events, 'turn.started').filter(
        (event) => event.inputKind === 'steer',
      ),
    ).toMatchObject([{ turnId, prompt: STEER_TEXT }]);
  });

  test.each([
    [
      'names no turn',
      (commandId: unknown) => ({ commandId, status: 'accepted' }),
    ],
    ['is not a result object', () => null],
  ])(
    'a steer reply that %s is indeterminate and shows nothing',
    async (_label, result) => {
      const h = harness();
      const host = await startServe(h);
      let sent: Promise<{ turnId: string }> | undefined;
      await replayMuseServeCapture(host, loadMuseServeCapture('steer'), {
        stopAt: captureIndex('steer', (msg) => msg.method === 'turn/steer'),
        onDrivenRequest: (method) => {
          if (method !== 'turn/start') return undefined;
          sent = h.adapter.sendTurn({ threadId: THREAD, input: 'go' });
          return sent;
        },
      });
      const { turnId } = await sent!;
      const steering = h.adapter.steerTurn(THREAD, STEER_TEXT, turnId);
      const request = await host.nextRequest('turn/steer', new Set());
      host.writeFrame({
        jsonrpc: '2.0',
        id: request.id,
        result: result(request.params?.commandId),
      });
      const outcome = await steering.then(
        () => 'resolved',
        (error: unknown) => error,
      );
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).not.toBeInstanceOf(ProviderTurnEndedError);
      expect(
        of(h.events, 'turn.started').filter(
          (event) => event.inputKind === 'steer',
        ),
      ).toEqual([]);
    },
  );

  test('a steer naming a turn that is not running is refused before anything reaches muse', async () => {
    const h = harness();
    const host = await startServe(h);
    await replayMuseServeCapture(host, loadMuseServeCapture('steer'), {
      stopAt: captureIndex('steer', (msg) => msg.method === 'turn/start'),
    });
    await expect(
      h.adapter.steerTurn(THREAD, STEER_TEXT, TURN_1418),
    ).rejects.toBeInstanceOf(ProviderTurnEndedError);
    expect(host.sent.filter((frame) => frame.method === 'turn/steer')).toEqual(
      [],
    );
  });

  test('a session on the muse exec fallback cannot steer: orchestration refuses it as unsupported, and the adapter never reaches a host', async () => {
    const h = harness({
      spawnHost: (args) => {
        const host = new FakeMuseServeHost(args);
        setImmediate(() => host.exit(2));
        return host;
      },
    });
    await h.adapter.startSession({ provider: 'muse', threadId: THREAD });
    await settle();
    expect(of(h.events, 'session.configured')[0].metadata).toMatchObject({
      museTransport: 'exec',
    });
    expect(h.adapter.canSteerTurn(THREAD)).toBe(false);
    await expect(
      h.adapter.steerTurn(THREAD, STEER_TEXT, 'turn-exec'),
    ).rejects.toBeInstanceOf(SendTurnRefusedError);

    const store = new EventStore(
      join(makeCascadeHome('muse-steer-exec-'), 'events.sqlite'),
    );
    const service = new OrchestrationService({
      eventStore: store,
      eventBus: new EventBus(),
      adapterRegistry: {
        register() {},
        list: () => [h.adapter],
        get: (provider) => (provider === 'muse' ? h.adapter : undefined),
      },
      logger: { debug() {}, warn() {} },
    });
    try {
      store.appendEvent({
        eventId: 'exec:start',
        threadId: THREAD,
        sessionId: THREAD,
        provider: 'muse',
        method: 'session.started',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      // A turn the exec session is running, so only the session's own
      // capability can refuse the steer.
      store.appendEvent({
        eventId: 'exec:turn',
        threadId: THREAD,
        provider: 'muse',
        method: 'turn.started',
        turnId: 'turn-exec',
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      service.initialize();
      await service.whenSessionRecoveryCompleted();
      service.seedSessionRecord({
        threadId: THREAD,
        provider: 'muse',
        status: 'running',
      });
      await expect(
        service.dispatch({
          type: 'steerTurn',
          threadId: THREAD,
          input: STEER_TEXT,
        }),
      ).resolves.toMatchObject({
        outcome: 'unsupported-engine',
        threadId: THREAD,
      });
      // The session's own summary says so, so a composer offers a queued
      // follow-up instead of a steer this refusal would meet. The engine's
      // profile still steers (a serve session can).
      expect(h.adapter.metadata.durability?.steerPlacement.state).toBe(
        'native',
      );
      const detail = await service.readSession(
        THREAD,
        INTERNAL_SESSION_READ_SCOPE,
      );
      expect(detail?.session.durability?.steerPlacement.state).toBe('none');
    } finally {
      await service.shutdown();
      adapters.splice(adapters.indexOf(h.adapter), 1);
      store.close();
    }
  });
});

describe('Muse Code 1.4.18: server requests are presented, once', () => {
  test('userInput/request gets the empty presentation receipt and its userInput/requested twin opens no second request', async () => {
    const h = harness();
    const stopAt = captureIndex(
      'user-input',
      (msg) => msg.method === 'userInput/answer',
    );
    await runUserInput(h, async () => undefined, stopAt);
    const host = h.hosts[0];
    expect(repliesTo(host, 1)).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
    const opened = of(h.events, 'request.opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      requestId: USER_INPUT_1418,
      turnId: TURN_1418,
      requestType: 'approval',
      payload: {
        toolName: 'request_user_input',
        inputRequest: {
          source: 'harness:muse',
          requester: 'Muse',
          body: {
            kind: 'form',
            fields: [
              {
                name: 'color',
                kind: 'choice',
                header: 'Color',
                title: 'Which color do you prefer?',
                options: [
                  { value: '0', label: 'Red' },
                  { value: '1', label: 'Blue' },
                ],
                allowCustom: true,
              },
            ],
          },
        },
      },
    });
    // Nothing answered it yet: the request is still open.
    expect(of(h.events, 'request.resolved')).toEqual([]);
  });

  test('approval/request is folded into the approval its notification opens, and any other server request is still refused', async () => {
    const h = harness();
    const stopAt = captureIndex(
      'workflow-child-approve',
      (msg) => msg.method === 'approval/requested',
    );
    await run(h, 'workflow-child-approve', { approvalMode: 'ask', stopAt });
    const host = h.hosts[0];
    const approval = loadMuseServeCapture('workflow-child-approve')[stopAt].msg
      .params as Record<string, unknown>;
    host.writeFrame({
      jsonrpc: '2.0',
      id: 'srv-approval',
      method: 'approval/request',
      params: approval,
    });
    host.writeFrame({
      jsonrpc: '2.0',
      method: 'approval/requested',
      params: approval,
    });
    host.writeFrame({
      jsonrpc: '2.0',
      id: 'srv-other',
      method: 'workspace/askSomething',
      params: {},
    });
    await settle();
    expect(repliesTo(host, 'srv-approval')).toEqual([
      { jsonrpc: '2.0', id: 'srv-approval', result: {} },
    ]);
    expect(repliesTo(host, 'srv-other')).toEqual([
      {
        jsonrpc: '2.0',
        id: 'srv-other',
        error: {
          code: -32601,
          message: 'Station does not serve workspace/askSomething.',
        },
      },
    ]);
    expect(of(h.events, 'request.opened')).toEqual([
      expect.objectContaining({
        requestId: APPROVAL,
        title: expect.any(String),
      }),
    ]);
  });
});

describe('Muse Code 1.4.18: request_user_input questions', () => {
  test('an accepted answer is sent as userInput/answer by option label, resolves on admission, and settled acknowledges it', async () => {
    const h = harness();
    const driven = await runUserInput(h, (opened) =>
      h.adapter.respondToRequest(THREAD, opened.requestId, 'accept', {
        expectedRequestEventId: opened.eventId,
        inputContent: { color: '1' },
      }),
    );
    const answer = driven.find((frame) => frame.method === 'userInput/answer');
    const captured = loadMuseServeCapture('user-input').find(
      (frame) => frame.msg.method === 'userInput/answer',
    )?.msg.params as Record<string, unknown>;
    // Exactly what the live probe sent and muse accepted.
    expect(answer?.params).toEqual({
      ...captured,
      commandId: expect.any(String),
    });
    expect(answer?.params?.answers).toEqual([
      { questionId: 'color', selectedLabel: 'Blue' },
    ]);
    expect(of(h.events, 'request.resolved')).toEqual([
      expect.objectContaining({
        requestId: USER_INPUT_1418,
        status: 'approved',
        acknowledgement: 'engine',
      }),
    ]);
    expect(of(h.events, 'request.delivery')).toEqual([
      expect.objectContaining({
        requestId: USER_INPUT_1418,
        outcome: 'acknowledged',
        engineStatus: 'approved',
      }),
    ]);
    expect(of(h.events, 'turn.completed')).toEqual([
      expect.objectContaining({
        turnId: TURN_1418,
        finishReason: 'stop',
        outputText: expect.stringMatching(/Blue$/),
      }),
    ]);
  });

  test('an answer is refused unless the question was inspected and the content fits the form; nothing reaches muse', async () => {
    const h = harness();
    const stopAt = captureIndex(
      'user-input',
      (msg) => msg.method === 'userInput/answer',
    );
    await runUserInput(h, async () => undefined, stopAt);
    const opened = of(h.events, 'request.opened')[0];
    await expect(
      h.adapter.respondToRequest(THREAD, opened.requestId, 'accept', {
        inputContent: { color: '1' },
      }),
    ).rejects.toThrow('Inspect this question before answering it.');
    await expect(
      h.adapter.respondToRequest(THREAD, opened.requestId, 'accept', {
        expectedRequestEventId: opened.eventId,
        inputContent: { color: '7' },
      }),
    ).rejects.toThrow();
    await expect(
      h.adapter.respondToRequest(THREAD, opened.requestId, 'acceptForSession', {
        expectedRequestEventId: opened.eventId,
        inputContent: { color: '1' },
      }),
    ).rejects.toThrow('Inspect this question before answering it.');
    expect(
      h.hosts[0].sent.filter((frame) =>
        String(frame.method).startsWith('userInput/'),
      ),
    ).toEqual([]);
    expect(of(h.events, 'request.resolved')).toEqual([]);
  });

  test('declining sends userInput/cancel and resolves denied', async () => {
    const h = harness();
    const stopAt = captureIndex(
      'user-input',
      (msg) => msg.method === 'userInput/answer',
    );
    await runUserInput(h, async () => undefined, stopAt);
    const host = h.hosts[0];
    const opened = of(h.events, 'request.opened')[0];
    const declining = h.adapter.respondToRequest(
      THREAD,
      opened.requestId,
      'decline',
      { expectedRequestEventId: opened.eventId },
    );
    const cancel = await host.nextRequest('userInput/cancel', new Set());
    expect(cancel.params).toEqual({
      commandId: expect.any(String),
      sessionId: SESSION_1418,
      userInputId: USER_INPUT_1418,
      reason: 'The user declined to answer in Station.',
    });
    host.writeFrame({
      jsonrpc: '2.0',
      id: cancel.id,
      result: {
        commandId: cancel.params?.commandId,
        status: 'accepted',
        userInputId: USER_INPUT_1418,
      },
    });
    await declining;
    await settle();
    expect(of(h.events, 'request.resolved')).toEqual([
      expect.objectContaining({
        requestId: USER_INPUT_1418,
        status: 'denied',
      }),
    ]);
  });

  test('several questions: a bounded multiple answers selectedLabels and a single answered in own words answers freeText', async () => {
    const h = harness();
    const stopAt = captureIndex(
      'user-input',
      (msg) => msg.method === 'userInput/request',
    );
    await runUserInput(h, async () => undefined, stopAt);
    const host = h.hosts[0];
    host.writeFrame({
      jsonrpc: '2.0',
      id: 9,
      method: 'userInput/request',
      params: {
        sessionId: SESSION_1418,
        userInputId: 'ui-multi',
        turnId: TURN_1418,
        itemId: 'ui-multi',
        toolCallId: 'call_multi',
        toolName: 'request_user_input',
        viewCursor: 'v',
        questions: [
          {
            id: 'langs',
            header: 'Languages',
            question: 'Which languages?',
            selection: { mode: 'multiple', minSelections: 2, maxSelections: 2 },
            options: [{ label: 'Rust' }, { label: 'Go' }, { label: 'Zig' }],
          },
          {
            id: 'name',
            header: 'Name',
            question: 'What name?',
            selection: { mode: 'single' },
            options: [{ label: 'Alpha' }, { label: 'Beta' }],
          },
        ],
      },
    });
    await settle();
    const opened = of(h.events, 'request.opened')[0];
    expect(opened.payload).toMatchObject({
      inputRequest: {
        body: {
          fields: [
            { name: 'langs', kind: 'multi-choice', minItems: 2, maxItems: 2 },
            { name: 'name', kind: 'choice', allowCustom: true },
          ],
        },
      },
    });
    expect(
      (opened.payload as { inputRequest: { body: { fields: object[] } } })
        .inputRequest.body.fields[0],
    ).not.toHaveProperty('allowCustom');
    // Muse's bound holds: one language is not enough.
    await expect(
      h.adapter.respondToRequest(THREAD, 'ui-multi', 'accept', {
        expectedRequestEventId: opened.eventId,
        inputContent: { langs: ['0'], name: '1' },
      }),
    ).rejects.toThrow();
    const answering = h.adapter.respondToRequest(THREAD, 'ui-multi', 'accept', {
      expectedRequestEventId: opened.eventId,
      inputContent: { langs: ['0', '2'], name: { custom: 'Gamma' } },
    });
    const answer = await host.nextRequest('userInput/answer', new Set());
    expect(answer.params?.answers).toEqual([
      { questionId: 'langs', selectedLabels: ['Rust', 'Zig'] },
      { questionId: 'name', freeText: 'Gamma' },
    ]);
    host.writeFrame({
      jsonrpc: '2.0',
      id: answer.id,
      result: { commandId: 'x', status: 'accepted', userInputId: 'ui-multi' },
    });
    await answering;
    await settle();
    expect(of(h.events, 'request.resolved')).toEqual([
      expect.objectContaining({ requestId: 'ui-multi', status: 'approved' }),
    ]);
  });

  test('a question muse settles on its own (timed out) resolves expired; one muse says is gone closes instead of hanging', async () => {
    const h = harness();
    const stopAt = captureIndex(
      'user-input',
      (msg) => msg.method === 'userInput/answer',
    );
    await runUserInput(h, async () => undefined, stopAt);
    const host = h.hosts[0];
    host.writeFrame({
      jsonrpc: '2.0',
      method: 'userInput/settled',
      params: {
        sessionId: SESSION_1418,
        userInputId: USER_INPUT_1418,
        outcome: 'timedOut',
        answers: [],
        clarification: null,
        reason: null,
        decidedByCommandId: null,
        decidedAt: null,
      },
    });
    await settle();
    expect(of(h.events, 'request.resolved')).toEqual([
      expect.objectContaining({
        requestId: USER_INPUT_1418,
        status: 'expired',
      }),
    ]);
    // A re-issue of a settled prompt is not put to the user again.
    host.writeFrame({
      jsonrpc: '2.0',
      method: 'userInput/requested',
      params: loadMuseServeCapture('user-input').find(
        (frame) => frame.msg.method === 'userInput/requested',
      )?.msg.params,
    });
    await settle();
    expect(of(h.events, 'request.opened')).toHaveLength(1);
  });

  test('a host that dies mid-question cancels it; the re-hosted session reopens it from listPending under a new request id, once', async () => {
    const h = harness();
    const stopAt = captureIndex(
      'user-input',
      (msg) => msg.method === 'userInput/answer',
    );
    await runUserInput(h, async () => undefined, stopAt);
    const params = loadMuseServeCapture('user-input').find(
      (frame) => frame.msg.method === 'userInput/requested',
    )?.msg.params as Record<string, unknown>;
    h.hosts[0].exit(3);
    await settle();
    expect(of(h.events, 'request.resolved')).toEqual([
      expect.objectContaining({
        requestId: USER_INPUT_1418,
        status: 'cancelled',
      }),
    ]);
    const sending = h.adapter.sendTurn({ threadId: THREAD, input: 'again' });
    for (let attempt = 0; attempt < 100 && !h.hosts[1]; attempt += 1)
      await new Promise((resolve) => setImmediate(resolve));
    const host = h.hosts[1];
    const answer = async (method: string, result: unknown) => {
      const request = await host.nextRequest(method, new Set());
      host.writeFrame({ jsonrpc: '2.0', id: request.id, result });
    };
    await answer(
      'initialize',
      (loadMuseServeCapture('user-input')[2].msg as { result: unknown }).result,
    );
    await answer('session/resume', {
      session: { sessionId: SESSION_1418, approvalMode: { mode: 'onRequest' } },
      viewCursor: '',
      history: {},
      pendingRequests: [{ kind: 'userInput', userInputId: USER_INPUT_1418 }],
    });
    // The host re-issues the prompt after the resume, and lists it too.
    host.writeFrame({
      jsonrpc: '2.0',
      id: 1,
      method: 'userInput/request',
      params,
    });
    await answer('approval/listPending', {
      approvals: [],
      userInputs: [params],
    });
    await answer('turn/start', {
      status: 'accepted',
      disposition: 'started',
      turnId: 'turn-after-rehost',
    });
    await sending;
    await settle();
    const opened = of(h.events, 'request.opened');
    expect(opened).toHaveLength(2);
    expect(opened[1].requestId).not.toBe(USER_INPUT_1418);
    expect(opened[1].requestId.startsWith(`${USER_INPUT_1418}:`)).toBe(true);
    expect(repliesTo(host, 1)).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
  });

  test('stopping the session resolves an open question cancelled', async () => {
    const h = harness();
    const stopAt = captureIndex(
      'user-input',
      (msg) => msg.method === 'userInput/answer',
    );
    await runUserInput(h, async () => undefined, stopAt);
    await h.adapter.stopSession(THREAD);
    await settle();
    expect(of(h.events, 'request.resolved')).toEqual([
      expect.objectContaining({
        requestId: USER_INPUT_1418,
        status: 'cancelled',
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Muse parity, slice 2. The session is the live 1.4.18 handshake (the steer
// capture up to its first turn); frames after that are hand-written in the
// MSP 1.4.18 schema shapes, from the live captures where one exists.

/** The live `turn/start` ack shape (steer capture). */
function turnAck(turnId: string) {
  return {
    commandId: turnId,
    status: 'accepted',
    turnId,
    startedNewTurn: true,
    disposition: 'started',
  };
}

/** A live 1.4.18 session, idle, on the steer capture's real handshake. */
async function liveSession(
  h: Harness,
  start: { modelOptions?: Record<string, unknown> } = {},
): Promise<FakeMuseServeHost> {
  const host = await firstHost(h, () =>
    h.adapter.startSession({
      provider: 'muse',
      threadId: THREAD,
      cwd: '/workspace/probe/repo',
      ...start,
    }),
  );
  await replayMuseServeCapture(host, loadMuseServeCapture('steer'), {
    stopAt: captureIndex('steer', (msg) => msg.method === 'turn/start'),
  });
  await settle();
  return host;
}

/** Sends a turn on `host` and acks it as the live host did. */
async function dispatchTurn(
  h: Harness,
  host: FakeMuseServeHost,
  turn: { modelOptions?: Record<string, unknown> } = {},
  consumed: Set<SentFrame> = new Set(),
): Promise<SentFrame> {
  const sending = h.adapter.sendTurn({
    threadId: THREAD,
    input: 'go',
    ...turn,
  });
  const request = await host.nextRequest('turn/start', consumed);
  consumed.add(request);
  reply(host, request, turnAck(TURN_1418));
  await sending;
  await settle();
  return request;
}

/** One MSP notification on the live session. */
function notify(
  host: FakeMuseServeHost,
  method: string,
  params: Record<string, unknown>,
) {
  host.writeFrame({
    jsonrpc: '2.0',
    method,
    params: { sessionId: SESSION_1418, ...params },
  });
}

describe('Muse parity: reasoning effort on serve', () => {
  test('a turn effort rides turn/start.reasoningEffort and is reported on that turn', async () => {
    const h = harness();
    const host = await liveSession(h);
    const request = await dispatchTurn(h, host, {
      modelOptions: { effort: 'high' },
    });
    expect(request.params).toMatchObject({
      sessionId: SESSION_1418,
      reasoningEffort: 'high',
    });
    const started = of(h.events, 'turn.started');
    expect(started).toHaveLength(1);
    expect(started[0].metadata).toMatchObject({
      museTransport: 'serve',
      museReasoningEffort: 'high',
    });
  });

  test('the session-start effort applies when a turn names none', async () => {
    const h = harness();
    const host = await liveSession(h, { modelOptions: { effort: 'minimal' } });
    const request = await dispatchTurn(h, host);
    expect(request.params?.reasoningEffort).toBe('minimal');
  });

  test('no effort: turn/start carries no tier and the turn claims none', async () => {
    const h = harness();
    const host = await liveSession(h);
    const request = await dispatchTurn(h, host);
    expect(request.params).not.toHaveProperty('reasoningEffort');
    expect(of(h.events, 'turn.started')[0].metadata).not.toHaveProperty(
      'museReasoningEffort',
    );
  });

  test('an effort muse has no tier for is refused before turn/start, and nothing is published', async () => {
    const h = harness();
    const host = await liveSession(h);
    await expect(
      h.adapter.sendTurn({
        threadId: THREAD,
        input: 'go',
        modelOptions: { effort: 'turbo' },
      }),
    ).rejects.toMatchObject({ kind: 'input_unsupported' });
    await settle();
    expect(host.sent.filter((frame) => frame.method === 'turn/start')).toEqual(
      [],
    );
    expect(of(h.events, 'turn.started')).toEqual([]);
  });

  test('a tier muse refuses at admission refuses the send and claims nothing', async () => {
    const h = harness();
    const host = await liveSession(h);
    const sending = h.adapter.sendTurn({
      threadId: THREAD,
      input: 'go',
      modelOptions: { effort: 'ultra' },
    });
    const request = await host.nextRequest('turn/start', new Set());
    host.writeFrame({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32602, message: 'reasoningEffort not offered' },
    });
    await expect(sending).rejects.toBeInstanceOf(SendTurnRefusedError);
    await settle();
    expect(of(h.events, 'turn.started')).toEqual([]);
  });
});

/** The capture's first live `session/tokenUsage` params (cost absent). */
function liveTokenUsage(): Record<string, unknown> {
  const frame = loadMuseServeCapture('steer').find(
    (entry) => entry.msg.method === 'session/tokenUsage',
  );
  return structuredClone(frame?.msg.params as Record<string, unknown>);
}

const LIVE_MODEL = 'muse-spark-1.3-contributor';

describe('Muse parity: usage, cost and context', () => {
  test('a live tokenUsage with no cost publishes token counts and no cost', async () => {
    const h = harness();
    const host = await liveSession(h);
    await dispatchTurn(h, host);
    notify(host, 'session/tokenUsage', liveTokenUsage());
    await settle();
    const usage = of(h.events, 'token-usage.updated');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      turnId: TURN_1418,
      promptTokens: 36194,
      completionTokens: 212,
    });
    expect(usage[0]).not.toHaveProperty('reportedCost');
    expect(usage[0]).not.toHaveProperty('reportedCostUsd');
  });

  test("a fully priced cumulative cost is the session's USD total; a partial one is never shown as exact", async () => {
    const h = harness();
    const host = await liveSession(h);
    await dispatchTurn(h, host);
    const priced = liveTokenUsage();
    (priced.cumulative as Record<string, unknown>).cost = {
      usd: 0.0425,
      partial: false,
    };
    notify(host, 'session/tokenUsage', priced);
    const partial = liveTokenUsage();
    (partial.cumulative as Record<string, unknown>).cost = {
      usd: 0.05,
      partial: true,
    };
    notify(host, 'session/tokenUsage', partial);
    await settle();
    const usage = of(h.events, 'token-usage.updated');
    expect(usage).toHaveLength(2);
    expect(usage[0].reportedCost).toEqual({
      amount: 0.0425,
      unit: 'USD',
      scope: 'session',
    });
    expect(usage[1]).not.toHaveProperty('reportedCost');
    expect(usage[1].promptTokens).toBe(36194);
  });

  test('contextUsage publishes occupancy with its window, or occupancy alone; never a derived percent', async () => {
    const h = harness();
    const host = await liveSession(h);
    await dispatchTurn(h, host);
    notify(host, 'session/contextUsage', {
      usedTokens: 36406,
      windowTokens: 262144,
      pressure: 'normal',
    });
    notify(host, 'session/contextUsage', {
      usedTokens: 40000,
      pressure: 'normal',
    });
    notify(host, 'session/contextUsage', { pressure: 'normal' });
    await settle();
    const usage = of(h.events, 'token-usage.updated');
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      turnId: TURN_1418,
      contextTokens: 36406,
      contextWindowTokens: 262144,
    });
    expect(usage[1].contextTokens).toBe(40000);
    expect(usage[1]).not.toHaveProperty('contextWindowTokens');
    for (const event of usage) {
      expect(event).not.toHaveProperty('contextPercent');
      expect(event).not.toHaveProperty('promptTokens');
    }
  });
});

describe('Muse parity: the todo list is the plan', () => {
  test('todoListChanged replaces the plan; cancelled and unknown items are left out', async () => {
    const h = harness();
    const host = await liveSession(h);
    await dispatchTurn(h, host);
    notify(host, 'session/todoListChanged', {
      revision: 3,
      sourceTool: 'todo_write',
      items: [
        { text: 'Read the failing test', status: 'completed' },
        {
          text: 'Fix the parser',
          status: 'inProgress',
          activeForm: 'Fixing the parser',
        },
        { text: 'Write the changelog', status: 'pending' },
        { text: 'Rewrite the lexer', status: 'cancelled' },
        { text: 'Mystery', status: 'blocked' },
      ],
    });
    notify(host, 'session/todoListChanged', {
      revision: 4,
      sourceTool: 'todo_write',
      items: [],
    });
    await settle();
    const plans = of(h.events, 'plan.updated');
    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({
      turnId: TURN_1418,
      entries: [
        { content: 'Read the failing test', status: 'completed' },
        { content: 'Fix the parser', status: 'in_progress' },
        { content: 'Write the changelog', status: 'pending' },
      ],
    });
    expect(plans[1].entries).toEqual([]);
  });
});

describe('Muse parity: model changes, unserved routes and retries', () => {
  test('a policy change is a session reroute from the model the session held', async () => {
    const h = harness();
    const host = await liveSession(h);
    notify(host, 'session/modelChanged', {
      modelId: 'muse-spark-1.2-contributor',
      providerId: 'meta',
      source: 'policy',
    });
    await settle();
    expect(of(h.events, 'model.rerouted')).toEqual([
      expect.objectContaining({
        fromModel: LIVE_MODEL,
        toModel: 'muse-spark-1.2-contributor',
        trigger: 'other',
        scope: 'session',
      }),
    ]);
    expect((await h.adapter.listSessions())[0].model).toBe(
      'muse-spark-1.2-contributor',
    );
  });

  test('a user or default change reconfigures the session model; the echo of the model held publishes nothing', async () => {
    const h = harness();
    const host = await liveSession(h);
    const configuredBefore = of(h.events, 'session.configured').length;
    notify(host, 'session/modelChanged', {
      modelId: LIVE_MODEL,
      providerId: 'meta',
      source: 'user',
    });
    notify(host, 'session/modelChanged', {
      modelId: 'muse-spark-1.2-contributor',
      providerId: 'meta',
      source: 'default',
    });
    notify(host, 'session/modelChanged', {
      modelId: 'not a model id; rm -rf',
      providerId: 'meta',
      source: 'user',
    });
    await settle();
    const configured = of(h.events, 'session.configured').slice(
      configuredBefore,
    );
    expect(configured).toEqual([
      expect.objectContaining({
        sessionId: THREAD,
        model: 'muse-spark-1.2-contributor',
      }),
    ]);
    expect(configured[0]).not.toHaveProperty('metadata');
    expect(of(h.events, 'model.rerouted')).toEqual([]);
  });

  test('an unserved standing route is a warning naming the model', async () => {
    const h = harness();
    const host = await liveSession(h);
    notify(host, 'session/modelRouteUnserved', {
      commandId: '00000000-0000-7000-8000-000000000031',
      installedProviderId: 'openrouter',
      modelId: LIVE_MODEL,
      providerId: 'meta',
    });
    await settle();
    const warnings = of(h.events, 'runtime.warning').filter(
      (event) => event.code === MUSE_MODEL_ROUTE_UNSERVED_CODE,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain(LIVE_MODEL);
    expect(warnings[0].details).toEqual({
      modelId: LIVE_MODEL,
      installedProviderId: 'openrouter',
    });
  });

  test('a scheduled retry is announced once per attempt, bounded, and the turn keeps running', async () => {
    const h = harness();
    const host = await liveSession(h);
    await dispatchTurn(h, host);
    const retry = {
      turnId: TURN_1418,
      attempt: 1,
      nextAttempt: 2,
      maxAttempts: 4,
      retryDelayMs: 2000,
      system: 'meta',
      errorKind: 'rate_limited',
      httpStatus: 429,
    };
    notify(host, 'turn/retryScheduled', {
      ...retry,
      reason: `upstream said ${'x'.repeat(400)}`,
    });
    notify(host, 'turn/modelRetryScheduled', retry);
    notify(host, 'turn/modelRetryScheduled', {
      ...retry,
      attempt: 2,
      nextAttempt: 3,
    });
    await settle();
    const warnings = of(h.events, 'runtime.warning').filter(
      (event) => event.code === MUSE_MODEL_RETRY_SCHEDULED_CODE,
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatchObject({
      turnId: TURN_1418,
      details: {
        nextAttempt: 2,
        maxAttempts: 4,
        retryDelayMs: 2000,
        httpStatus: 429,
      },
    });
    expect(warnings[0].message).toMatch(/attempt 2 of 4, in 2 seconds/);
    expect(warnings[0].message.length).toBeLessThan(260);
    expect(warnings[1].message).toContain('rate_limited');
    expect(of(h.events, 'turn.completed')).toEqual([]);
    expect(of(h.events, 'runtime.error')).toEqual([]);
  });
});

/** The steer capture with its host reporting no enforceable sandbox. */
function sandboxlessFrames() {
  const frames = structuredClone(loadMuseServeCapture('steer'));
  const init = frames.find(
    (frame) =>
      frame.dir === 's2c' &&
      (frame.msg.result as { schema?: unknown } | undefined)?.schema,
  );
  Object.assign(init!.msg.result as Record<string, unknown>, {
    sandboxAvailability: 'unavailable',
    sandboxUnavailableReason: 'userNamespacesDenied',
  });
  return frames;
}

describe('Muse parity: a host that cannot enforce its sandbox', () => {
  test('a session without a sandbox-reliant posture runs, says the sandbox is unavailable, and labels its turns so', async () => {
    const h = harness();
    const host = await firstHost(h, () =>
      h.adapter.startSession({
        provider: 'muse',
        threadId: THREAD,
        cwd: '/workspace/probe/repo',
        modelOptions: { approvalMode: 'ask' },
      }),
    );
    await replayMuseServeCapture(host, sandboxlessFrames(), {
      stopAt: captureIndex('steer', (msg) => msg.method === 'turn/start'),
    });
    await settle();
    expect(of(h.events, 'session.configured')[0].metadata).toMatchObject({
      museTransport: 'serve',
      museSandbox: 'unavailable',
    });
    const warnings = of(h.events, 'runtime.warning').filter(
      (event) => event.code === MUSE_SANDBOX_UNAVAILABLE_CODE,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].details).toEqual({ reason: 'userNamespacesDenied' });
    const consumed = new Set<SentFrame>();
    const sending = h.adapter.sendTurn({ threadId: THREAD, input: 'go' });
    const request = await host.nextRequest('turn/start', consumed);
    reply(host, request, turnAck(TURN_1418));
    await sending;
    await settle();
    expect(of(h.events, 'turn.started')[0].metadata).toMatchObject({
      museSandbox: 'unavailable',
    });
  });

  test('`auto` is refused at start as settled, with no session and no exec fallback; preflight then refuses it before the boundary', async () => {
    const h = harness();
    const starting = h.adapter.startSession({
      provider: 'muse',
      threadId: THREAD,
      cwd: '/workspace/probe/repo',
      modelOptions: { approvalMode: 'auto' },
    });
    starting.catch(() => {});
    const host = await firstHost(h, () => starting);
    await replayMuseServeCapture(host, sandboxlessFrames(), {
      stopAt: captureIndex(
        'steer',
        (msg, dir) => dir === 'c2s' && msg.method === 'session/start',
      ),
    });
    await expect(starting).rejects.toBeInstanceOf(SessionStartRefusedError);
    await expect(starting).rejects.toMatchObject({
      code: 'sandbox_unavailable',
    });
    await settle();
    expect(host.sent.some((frame) => frame.method === 'session/start')).toBe(
      false,
    );
    expect(host.stdinEnded).toBe(true);
    expect(h.execSpawns).toEqual([]);
    expect(await h.adapter.hasSession(THREAD)).toBe(false);
    expect(of(h.events, 'session.started')).toEqual([]);
    await expect(
      h.adapter.preflightStart({
        provider: 'muse',
        threadId: 'thread-next',
        modelOptions: { approvalMode: 'auto' },
      }),
    ).rejects.toMatchObject({ code: 'sandbox_unavailable' });
    await expect(
      h.adapter.preflightStart({
        provider: 'muse',
        threadId: 'thread-next',
        modelOptions: { approvalMode: 'ask' },
      }),
    ).resolves.toBeUndefined();
  });

  test('a turn asking for `auto` on such a host is refused before the mode or the turn reaches muse', async () => {
    const h = harness();
    const host = await firstHost(h, () =>
      h.adapter.startSession({
        provider: 'muse',
        threadId: THREAD,
        cwd: '/workspace/probe/repo',
      }),
    );
    await replayMuseServeCapture(host, sandboxlessFrames(), {
      stopAt: captureIndex('steer', (msg) => msg.method === 'turn/start'),
    });
    await settle();
    await expect(
      h.adapter.sendTurn({
        threadId: THREAD,
        input: 'go',
        modelOptions: { approvalMode: 'auto' },
      }),
    ).rejects.toMatchObject({ kind: 'permission_denied' });
    expect(
      host.sent.filter(
        (frame) =>
          frame.method === 'session/setApprovalMode' ||
          frame.method === 'turn/start',
      ),
    ).toEqual([]);
  });

  test('once a host said there is no sandbox, a failed serve start never falls back to exec unless the posture is `never`', async () => {
    const h = harness({
      // The first host answers (without a sandbox); every later one dies
      // before its handshake, so a start falls back to exec.
      spawnHost: (args, index) => {
        const host = new FakeMuseServeHost(args, 6000 + index);
        if (index > 0) setImmediate(() => host.exit(2));
        return host;
      },
    });
    const learning = h.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-learn',
      modelOptions: { approvalMode: 'auto' },
    });
    learning.catch(() => {});
    const host = await firstHost(h, () => learning);
    await replayMuseServeCapture(host, sandboxlessFrames(), {
      stopAt: captureIndex(
        'steer',
        (msg, dir) => dir === 'c2s' && msg.method === 'session/start',
      ),
    });
    await expect(learning).rejects.toMatchObject({
      code: 'sandbox_unavailable',
    });
    for (const approvalMode of ['ask', undefined] as const) {
      const threadId = `thread-${approvalMode ?? 'default'}`;
      await expect(
        h.adapter.startSession({
          provider: 'muse',
          threadId,
          ...(approvalMode ? { modelOptions: { approvalMode } } : {}),
        }),
      ).rejects.toMatchObject({ code: 'sandbox_unavailable' });
      expect(await h.adapter.hasSession(threadId)).toBe(false);
    }
    // `never` asks for no sandbox and no prompts: exec is that posture.
    await h.adapter.startSession({
      provider: 'muse',
      threadId: THREAD,
      modelOptions: { approvalMode: 'never' },
    });
    await settle();
    expect(
      of(h.events, 'session.configured').find(
        (event) => event.threadId === THREAD,
      )?.metadata,
    ).toMatchObject({ museTransport: 'exec' });
    // A turn of that exec session asking for a sandboxed posture is refused
    // before anything spawns; one under the session's `never` runs.
    await expect(
      h.adapter.sendTurn({
        threadId: THREAD,
        input: 'go',
        modelOptions: { approvalMode: 'ask' },
      }),
    ).rejects.toMatchObject({ kind: 'permission_denied' });
    expect(h.execSpawns).toEqual([]);
    await expect(
      h.adapter.sendTurn({ threadId: THREAD, input: 'go' }),
    ).rejects.toThrow('this test drives serve; exec must not spawn');
    expect(h.execSpawns).toHaveLength(1);
  });

  for (const approvalMode of ['ask', undefined] as const) {
    test(`a first ${approvalMode ?? 'default'} start whose host says there is no sandbox, then fails session/start, is refused rather than falling back to exec`, async () => {
      const h = harness();
      const starting = h.adapter.startSession({
        provider: 'muse',
        threadId: THREAD,
        cwd: '/workspace/probe/repo',
        ...(approvalMode ? { modelOptions: { approvalMode } } : {}),
      });
      starting.catch(() => {});
      const host = await firstHost(h, () => starting);
      await replayMuseServeCapture(host, sandboxlessFrames(), {
        stopAt: captureIndex(
          'steer',
          (msg, dir) => dir === 'c2s' && msg.method === 'session/start',
        ),
      });
      // The host answered without a sandbox; its session start then fails
      // for an unrelated reason.
      const request = await host.nextRequest('session/start', new Set());
      reject(host, request, -32603);
      await expect(starting).rejects.toMatchObject({
        code: 'sandbox_unavailable',
      });
      expect(h.execSpawns).toEqual([]);
      expect(await h.adapter.hasSession(THREAD)).toBe(false);
      expect(of(h.events, 'session.started')).toEqual([]);
    });
  }

  test('a host refused for an unverified fingerprint still teaches "no sandbox": an ask start is refused rather than falling back to exec', async () => {
    const h = harness();
    const starting = h.adapter.startSession({
      provider: 'muse',
      threadId: THREAD,
      modelOptions: { approvalMode: 'ask' },
    });
    starting.catch(() => {});
    for (let attempt = 0; attempt < 100 && !h.hosts[0]; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const host = h.hosts[0];
    const init = await host.nextRequest('initialize', new Set());
    // A Muse upgrade: a fingerprint this adapter never verified, on a machine
    // whose host says it cannot enforce a sandbox.
    host.writeFrame({
      jsonrpc: '2.0',
      id: init.id,
      result: {
        serverInfo: { name: 'muse', version: '9.9.9' },
        schema: { version: 1, fingerprint: 'sha256:unverified' },
        sessionDurability: 'durable',
        sandboxAvailability: 'unavailable',
      },
    });
    await expect(starting).rejects.toMatchObject({
      code: 'sandbox_unavailable',
    });
    expect(h.execSpawns).toEqual([]);
    expect(await h.adapter.hasSession(THREAD)).toBe(false);
  });

  test('an unverified host reporting its sandbox available does not clear a learned "no sandbox"', async () => {
    const h = harness();
    const beforeTurn = captureIndex(
      'steer',
      (msg) => msg.method === 'turn/start',
    );
    const learning = h.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-learn',
      modelOptions: { approvalMode: 'ask' },
    });
    for (let attempt = 0; attempt < 100 && !h.hosts[0]; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await replayMuseServeCapture(h.hosts[0], sandboxlessFrames(), {
      stopAt: beforeTurn,
    });
    await learning;
    const starting = h.adapter.startSession({
      provider: 'muse',
      threadId: THREAD,
      modelOptions: { approvalMode: 'ask' },
    });
    starting.catch(() => {});
    for (let attempt = 0; attempt < 100 && !h.hosts[1]; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const init = await h.hosts[1].nextRequest('initialize', new Set());
    h.hosts[1].writeFrame({
      jsonrpc: '2.0',
      id: init.id,
      result: {
        serverInfo: { name: 'muse', version: '9.9.9' },
        schema: { version: 1, fingerprint: 'sha256:unverified' },
        sessionDurability: 'durable',
        sandboxAvailability: 'available',
      },
    });
    await expect(starting).rejects.toMatchObject({
      code: 'sandbox_unavailable',
    });
    expect(h.execSpawns).toEqual([]);
  });

  test('a later host that does not report sandbox availability keeps the learned "no sandbox", so a failed serve start still refuses exec', async () => {
    const h = harness({
      // Host 2 dies before its handshake, so its start falls back to exec.
      spawnHost: (args, index) => {
        const host = new FakeMuseServeHost(args, 6100 + index);
        if (index === 2) setImmediate(() => host.exit(2));
        return host;
      },
    });
    const nthHost = async (index: number) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (h.hosts[index]) return h.hosts[index];
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error(`host ${index} was never spawned`);
    };
    const beforeTurn = captureIndex(
      'steer',
      (msg) => msg.method === 'turn/start',
    );
    // Host 0 says this machine has no sandbox.
    const learning = h.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-learn',
      modelOptions: { approvalMode: 'ask' },
    });
    await replayMuseServeCapture(await nthHost(0), sandboxlessFrames(), {
      stopAt: beforeTurn,
    });
    await learning;
    // Host 1 answers without `sandboxAvailability` (unknown) and starts.
    const unknownFrames = structuredClone(loadMuseServeCapture('steer'));
    const init = unknownFrames.find(
      (frame) =>
        frame.dir === 's2c' &&
        (frame.msg.result as { schema?: unknown } | undefined)?.schema,
    );
    delete (init!.msg.result as Record<string, unknown>).sandboxAvailability;
    const silent = h.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-silent',
      modelOptions: { approvalMode: 'ask' },
    });
    await replayMuseServeCapture(await nthHost(1), unknownFrames, {
      stopAt: beforeTurn,
    });
    await silent;
    // Host 2 fails: exec would run unsandboxed and unprompted.
    await expect(
      h.adapter.startSession({
        provider: 'muse',
        threadId: THREAD,
        modelOptions: { approvalMode: 'ask' },
      }),
    ).rejects.toMatchObject({ code: 'sandbox_unavailable' });
    expect(await h.adapter.hasSession(THREAD)).toBe(false);
    expect(h.execSpawns).toEqual([]);
  });

  test('a host that reports its sandbox available labels turns enabled and warns nothing', async () => {
    const h = harness();
    const host = await liveSession(h);
    await dispatchTurn(h, host);
    expect(of(h.events, 'turn.started')[0].metadata).toMatchObject({
      museSandbox: 'enabled',
    });
    expect(
      of(h.events, 'runtime.warning').filter(
        (event) => event.code === MUSE_SANDBOX_UNAVAILABLE_CODE,
      ),
    ).toEqual([]);
  });
});

/** The live 1.4.18 `initialize` result (steer capture, scrubbed). */
function liveInitializeResult(): Record<string, unknown> {
  const frame = loadMuseServeCapture('steer').find(
    (entry) =>
      entry.dir === 's2c' &&
      (entry.msg.result as { schema?: unknown } | undefined)?.schema,
  );
  return structuredClone(frame?.msg.result as Record<string, unknown>);
}

/**
 * A host that answers `initialize` with `init`, then each listed query in
 * order, as the live host did for a session-less discovery read.
 */
function discoveryHost(
  answers: Array<[method: string, result: unknown]>,
  init: Record<string, unknown> = liveInitializeResult(),
) {
  return (args: string[]) => {
    const host = new FakeMuseServeHost(args);
    void (async () => {
      const consumed = new Set<SentFrame>();
      const initialize = await host.nextRequest('initialize', consumed);
      consumed.add(initialize);
      reply(host, initialize, init);
      for (const [method, result] of answers) {
        const request = await host.nextRequest(method, consumed);
        consumed.add(request);
        reply(host, request, result);
      }
    })().catch(() => {});
    return host;
  };
}

/** Schema-shaped `model/list` rows (MSP 1.4.18 `ModelCatalogEntry`). */
function catalogEntry(overrides: Record<string, unknown>) {
  return {
    modelId: 'muse-spark-1.3-contributor',
    displayLabel: 'Muse Spark 1.3',
    providerId: 'meta',
    profileId: null,
    description: null,
    contextLimit: 262144,
    outputLimit: 32768,
    releaseDate: null,
    cost: { input: '1.25', output: '10', cached: '0.125', currency: 'USD' },
    isActive: false,
    isDefault: true,
    variants: ['low', 'medium', 'high'],
    reasoningEffortVariants: [
      { tier: 'low', description: 'Faster' },
      { tier: 'medium' },
      { tier: 'high', description: 'Deeper' },
    ],
    defaultReasoningEffort: 'high',
    ...overrides,
  };
}

describe('Muse parity: the model catalog through a short-lived host (#2266)', () => {
  test('an empty live catalog is an empty answer: initialize, model/list with no session, then the host is closed', async () => {
    const h = harness({
      spawnHost: discoveryHost([
        [
          'model/list',
          {
            providerId: 'meta',
            profileId: 'profile',
            source: 'bundledCatalog',
            models: [],
          },
        ],
      ]),
    });
    await expect(h.adapter.listModelCatalog!()).resolves.toEqual({
      models: [],
    });
    expect(h.hosts).toHaveLength(1);
    const methods = h.hosts[0].sent.map((frame) => frame.method);
    expect(methods).toEqual(['initialize', 'initialized', 'model/list']);
    expect(h.hosts[0].sent[2].params).toEqual({});
    expect(h.hosts[0].stdinEnded).toBe(true);
    expect(h.hosts[0].exitCode).not.toBeNull();
    expect(h.adapter.metadata.abortSettlement).toBe('await');
  });

  test('rows map to selectable models with their effort tiers and window; what Station has no field for is left out', async () => {
    const h = harness({
      spawnHost: discoveryHost([
        [
          'model/list',
          {
            providerId: 'meta',
            profileId: null,
            source: 'providerCatalog',
            models: [
              catalogEntry({}),
              catalogEntry({
                modelId: 'muse-lite',
                displayLabel: 'Muse Lite',
                contextLimit: null,
                variants: 'unknown',
                reasoningEffortVariants: undefined,
                defaultReasoningEffort: undefined,
              }),
              catalogEntry({ modelId: 'bad id; rm -rf /' }),
            ],
          },
        ],
      ]),
    });
    const catalog = await h.adapter.listModelCatalog!();
    expect(catalog).toEqual({
      models: [
        {
          id: 'muse-spark-1.3-contributor',
          name: 'Muse Spark 1.3',
          originalId: 'muse-spark-1.3-contributor',
          capabilities: {
            supportsEffort: true,
            supportedEffortLevels: ['low', 'medium', 'high'],
            effortLabels: { low: 'Faster', high: 'Deeper' },
            contextWindow: 262144,
          },
        },
        { id: 'muse-lite', name: 'Muse Lite', originalId: 'muse-lite' },
      ],
    });
    // A second read inside the cache window starts no host.
    await expect(h.adapter.listModels!({ maxEntries: 1 })).resolves.toEqual([
      expect.objectContaining({ id: 'muse-spark-1.3-contributor' }),
    ]);
    expect(h.hosts).toHaveLength(1);
  });

  test('#1942: the catalog is read under the active profile, and a profile switch is not served from the global cache', async () => {
    let active: string | undefined;
    const h = harness({
      getAppHomeEnv: async () =>
        active
          ? {
              env: { XDG_CONFIG_HOME: `/profiles/muse/${active}` },
              profileRef: active,
            }
          : { profileRef: null },
      spawnHost: discoveryHost([
        [
          'model/list',
          {
            providerId: 'meta',
            profileId: null,
            source: 'providerCatalog',
            models: [],
          },
        ],
      ]),
    });
    await h.adapter.listModelCatalog!();
    active = 'work';
    await h.adapter.listModelCatalog!();
    expect(h.hostEnvs).toEqual([
      undefined,
      { XDG_CONFIG_HOME: '/profiles/muse/work' },
    ]);
  });

  test('a host with an unverified schema is not asked for its catalog', async () => {
    const init = liveInitializeResult();
    (init.schema as Record<string, unknown>).fingerprint =
      `sha256:${'0'.repeat(64)}`;
    const h = harness({ spawnHost: discoveryHost([], init) });
    await expect(h.adapter.listModelCatalog!()).rejects.toThrow(
      /unverified MSP schema/,
    );
    expect(h.hosts[0].sent.map((frame) => frame.method)).toEqual([
      'initialize',
    ]);
    expect(h.hosts[0].stdinEnded).toBe(true);
  });

  test('an abort settles only after the host it started is terminated', async () => {
    let terminated = false;
    const h = harness({
      // Answers initialize, never model/list.
      spawnHost: discoveryHost([]),
      terminateHost: async (host) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        terminated = true;
        host.exit(0);
      },
    });
    const controller = new AbortController();
    const reading = h.adapter.listModelCatalog!({ signal: controller.signal });
    // The host starts after the profile resolves, so wait for it.
    await vi.waitFor(() => expect(h.hosts).toHaveLength(1));
    await h.hosts[0].nextRequest('model/list', new Set());
    const abortedAt = Date.now();
    controller.abort(new Error('caller gave up'));
    await expect(reading).rejects.toThrow('caller gave up');
    expect(terminated).toBe(true);
    // Settled by the abort itself, not by the 2 s request deadline.
    expect(Date.now() - abortedAt).toBeLessThan(1_000);
  });

  test('an exec-only adapter and the echo override expose no catalog and no quota', () => {
    expect(new MuseAdapter().listModelCatalog).toBeUndefined();
    expect(new MuseAdapter().readQuotaSnapshot).toBeUndefined();
    const echo = new MuseAdapter({
      serve: {},
      env: {
        STATION_HOME_SOURCE: '--temp-home',
        STATION_INSTANCE_ID: 'e2e-smoke-live-1788039214298-qpssuh',
        STATION_E2E_MUSE_PROVIDER: 'echo',
      },
    });
    expect(echo.listModelCatalog).toBeUndefined();
    expect(echo.readQuotaSnapshot).toBeUndefined();
    expect(echo.metadata).not.toHaveProperty('abortSettlement');
  });
});

describe('Muse parity: the subscription allowance through usage/read', () => {
  test('`{}` (live: nothing observed) is not-reported, never a window at 0%', async () => {
    const h = harness({ spawnHost: discoveryHost([['usage/read', {}]]) });
    await expect(
      h.adapter.readQuotaSnapshot!({ connectionId: 'muse' }),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-reported',
      detail: 'Muse has observed no subscription usage yet.',
    });
    expect(h.hosts[0].sent.map((frame) => frame.method)).toEqual([
      'initialize',
      'initialized',
      'usage/read',
    ]);
  });

  test('an observed allowance is a provider-reported snapshot with normalized reset deadlines', async () => {
    const observedAtMs = Date.parse('2026-11-13T15:00:00.000Z');
    const h = harness({
      spawnHost: discoveryHost([
        [
          'usage/read',
          {
            usage: {
              observedAtMs,
              tier: 'pro',
              window: {
                usedPercent: 42,
                resetsAtMs: Date.parse('2026-11-13T18:00:00.000Z'),
                windowDurationMins: 300,
              },
              weekly: {
                usedPercent: 107,
                resetsAtMs: Date.parse('2026-11-17T00:00:00.000Z'),
              },
            },
          },
        ],
      ]),
    });
    await expect(
      h.adapter.readQuotaSnapshot!({ connectionId: 'muse' }),
    ).resolves.toEqual({
      kind: 'snapshot',
      snapshot: {
        connectionId: 'muse',
        provider: 'muse',
        observedAt: '2026-11-13T15:00:00.000Z',
        baselineAt: '2026-11-13T15:00:00.000Z',
        source: 'provider-reported',
        accountScope: 'global',
        plan: {
          value: { type: 'pro' },
          observedAt: '2026-11-13T15:00:00.000Z',
        },
        windows: [
          {
            id: 'window',
            label: 'Current window',
            usedPercent: 42,
            observedAt: '2026-11-13T15:00:00.000Z',
            windowDurationMins: 300,
            resetDeadlineAt: '2026-11-13T18:00:00.000Z',
          },
          {
            id: 'weekly',
            label: 'Weekly',
            usedPercent: 107,
            observedAt: '2026-11-13T15:00:00.000Z',
            resetDeadlineAt: '2026-11-17T00:00:00.000Z',
          },
        ],
      },
    });
  });

  test('#1942: a profile connection reads its allowance under that profile, never the global account', async () => {
    const profileEnv = { XDG_CONFIG_HOME: '/profiles/muse/work' };
    const getAppHomeEnv = vi.fn(async (ref?: string) =>
      ref === 'work'
        ? { env: profileEnv, profileRef: 'work' }
        : { profileRef: null },
    );
    const h = harness({
      getAppHomeEnv,
      spawnHost: discoveryHost([
        [
          'usage/read',
          {
            usage: {
              observedAtMs: Date.parse('2026-11-13T15:00:00.000Z'),
              window: { usedPercent: 5 },
            },
          },
        ],
      ]),
    });
    await expect(
      h.adapter.readQuotaSnapshot!({
        connectionId: 'muse',
        credentialProfileRef: 'work',
      }),
    ).resolves.toMatchObject({
      kind: 'snapshot',
      snapshot: { accountScope: 'profile' },
    });
    expect(getAppHomeEnv).toHaveBeenCalledWith('work');
    expect(h.hostEnvs).toEqual([profileEnv]);
  });

  test('#1942: a named profile that cannot be prepared fails the read instead of reading the global account', async () => {
    const h = harness({
      getAppHomeEnv: async () => {
        throw new Error('profile home is unwritable');
      },
      spawnHost: discoveryHost([['usage/read', {}]]),
    });
    await expect(
      h.adapter.readQuotaSnapshot!({
        connectionId: 'muse',
        credentialProfileRef: 'work',
      }),
    ).resolves.toMatchObject({ kind: 'unavailable', reason: 'provider-error' });
    expect(h.hosts).toEqual([]);
  });

  test('a host that fails the read is a provider error, not a snapshot', async () => {
    const h = harness({
      spawnHost: (args) => {
        const host = new FakeMuseServeHost(args);
        setImmediate(() => host.exit(2));
        return host;
      },
    });
    await expect(
      h.adapter.readQuotaSnapshot!({ connectionId: 'muse' }),
    ).resolves.toMatchObject({ kind: 'unavailable', reason: 'provider-error' });
  });
});

const WORKFLOW_TURN_1418 = '00000000-0000-7000-8000-000000000007';
const WORKFLOW_CHILD_1418 = '00000000-0000-7000-8000-000000000025';
const OWNER_NOTE = 'Note from the owner: include the word ZEBRA in your reply.';

/**
 * The `workflow-child-steer` capture as a NATIVE subagent would put it on
 * the wire: no `workflow` items, no `workflowRunId`, and the turn held open
 * until the child reports (a native spawn the model waits on). Every frame
 * is the live one; the only additions are that reorder and a terminal
 * revision of the `subagent` item, shaped from its live `resultReady`
 * revision with the schema's terminal `status` (no native spawn was
 * capturable: the live agent offered no spawn tool outside workflows).
 */
function nativeSubagentCapture() {
  const frames = loadMuseServeCapture('workflow-child-steer');
  const itemOf = (frame: (typeof frames)[number]) => {
    const params = frame.msg.params as Record<string, unknown> | undefined;
    return params?.item as Record<string, unknown> | undefined;
  };
  const dispatchedEnd = frames.findIndex(
    (frame) =>
      frame.msg.method === 'turn/completed' &&
      (frame.msg.params as Record<string, unknown>).turnId ===
        WORKFLOW_TURN_1418,
  );
  const [turnEnd] = frames.splice(dispatchedEnd, 1);
  const kept = frames
    .filter((frame) => itemOf(frame)?.kind !== 'workflow')
    .map((frame) => {
      const item = itemOf(frame);
      if (item?.kind !== 'subagent') return frame;
      const { workflowRunId: _run, ...native } = item;
      return {
        ...frame,
        msg: {
          ...frame.msg,
          params: { ...(frame.msg.params as object), item: native },
        },
      };
    });
  const resultAt = kept.findIndex(
    (frame) =>
      itemOf(frame)?.kind === 'subagent' &&
      (itemOf(frame)?.result as { summary?: string } | undefined)?.summary,
  );
  const resultFrame = kept[resultAt];
  const resultItem = itemOf(resultFrame) as Record<string, unknown>;
  const terminal = {
    ...resultFrame,
    msg: {
      ...resultFrame.msg,
      method: 'item/completed',
      params: {
        ...(resultFrame.msg.params as object),
        item: {
          ...resultItem,
          revision: (resultItem.revision as number) + 1,
          status: 'completed',
          controlStatus: 'closed',
        },
      },
    },
  };
  kept.splice(resultAt + 1, 0, terminal, turnEnd);
  return kept;
}

describe('Muse parity: subagents and background tasks are child work', () => {
  test("a workflow child's own subagent item names its result, and it takes a steer after the launching turn ended", async () => {
    const h = harness();
    const host = await startServe(h);
    let sent: Promise<{ turnId: string }> | undefined;
    let steered: Promise<unknown> | undefined;
    const driven = await replayMuseServeCapture(
      host,
      loadMuseServeCapture('workflow-child-steer'),
      {
        onDrivenRequest: (method, _occurrence, captured) => {
          if (method === 'turn/start') {
            sent = h.adapter.sendTurn({ threadId: THREAD, input: 'go' });
            return sent;
          }
          if (method === 'subagent/sendMessage') {
            steered = (async () =>
              h.adapter.steerChildWork(
                THREAD,
                String(captured.subagentId),
                (await sent!).turnId,
                OWNER_NOTE,
              ))();
            return steered;
          }
          return undefined;
        },
      },
    );
    await settle();
    const [child] = childWorkForReporter(fold(h.events), THREAD);
    // The child's own reply, not 1.4.18's reconciliation `final_summary`
    // (a JSON rendering of the whole script's return value).
    expect(child).toMatchObject({
      childId: WORKFLOW_CHILD_1418,
      status: 'completed',
      kindLabel: 'workflow',
      result: { summary: 'CHILDDONE ZEBRA', source: 'provider-summary' },
    });
    // muse ends the launching turn before it lists the child; the child is
    // still offered a steer, its token the launching turn, because the
    // adapter declares its children outlive that turn.
    expect(h.adapter.childSteerOutlivesParentTurn).toBe(true);
    const turnEnded = h.events.findIndex(
      (event) =>
        event.method === 'turn.completed' &&
        event.turnId === WORKFLOW_TURN_1418,
    );
    const offeredAfterEnd = h.events
      .slice(turnEnded + 1)
      .flatMap((event) =>
        event.method !== 'child-work.updated'
          ? []
          : event.delta.kind === 'snapshot'
            ? event.delta.running
            : event.delta.kind === 'upsert'
              ? [event.delta.item]
              : [],
      )
      .filter((item) => item.childId === WORKFLOW_CHILD_1418);
    expect(turnEnded).toBeGreaterThanOrEqual(0);
    expect(offeredAfterEnd.length).toBeGreaterThan(0);
    for (const item of offeredAfterEnd)
      expect(item.controls?.steer).toEqual({ turnId: WORKFLOW_TURN_1418 });
    // The live send, made after that turn ended, is the steer.
    await expect(steered).resolves.toEqual({
      outcome: 'steered',
      turnId: WORKFLOW_TURN_1418,
    });
    expect(
      driven.find((frame) => frame.method === 'subagent/sendMessage')?.params,
    ).toEqual({
      commandId: expect.any(String),
      sessionId: SESSION_1418,
      subagentId: WORKFLOW_CHILD_1418,
      body: OWNER_NOTE,
    });
  });

  test('a native subagent is running child work with a steer; the steer is subagent/sendMessage, and its terminal settles it with its result', async () => {
    const h = harness();
    const host = await startServe(h);
    let sent: Promise<{ turnId: string }> | undefined;
    let steered: Promise<unknown> | undefined;
    const driven = await replayMuseServeCapture(host, nativeSubagentCapture(), {
      onDrivenRequest: (method, _occurrence, captured) => {
        if (method === 'turn/start') {
          sent = h.adapter.sendTurn({ threadId: THREAD, input: 'go' });
          return sent;
        }
        if (method === 'subagent/sendMessage') {
          steered = (async () =>
            h.adapter.steerChildWork(
              THREAD,
              String(captured.subagentId),
              (await sent!).turnId,
              `  ${OWNER_NOTE}\n`,
            ))();
          return steered;
        }
        return undefined;
      },
    });
    await settle();
    await expect(steered).resolves.toEqual({
      outcome: 'steered',
      turnId: WORKFLOW_TURN_1418,
    });
    expect(
      driven.find((frame) => frame.method === 'subagent/sendMessage')?.params,
    ).toEqual({
      commandId: expect.any(String),
      sessionId: SESSION_1418,
      subagentId: WORKFLOW_CHILD_1418,
      body: OWNER_NOTE,
    });
    const firstSnapshot = childWorkDeltas(h.events).find(
      (delta) => delta.kind === 'snapshot',
    );
    expect(firstSnapshot).toMatchObject({
      running: [
        expect.objectContaining({
          childId: WORKFLOW_CHILD_1418,
          status: 'running',
          kindLabel: 'workflow-agent',
          workKind: 'agent',
          depth: 1,
          title: expect.stringMatching(/^Run the shell command `sleep 30`/),
          parent: { turnId: WORKFLOW_TURN_1418 },
          backgrounded: false,
          controls: {
            stop: 'provider-task-stop',
            steer: { turnId: WORKFLOW_TURN_1418 },
          },
        }),
      ],
    });
    const [child] = childWorkForReporter(fold(h.events), THREAD);
    expect(child).toMatchObject({
      childId: WORKFLOW_CHILD_1418,
      status: 'completed',
      usage: { totalTokens: 59007 + 306, durationMs: 34846 },
      result: { summary: 'CHILDDONE ZEBRA', source: 'provider-summary' },
    });
  });

  test("muse refusing a child steer (the child's state no longer takes input) is no-active-task", async () => {
    const h = harness();
    const host = await startServe(h);
    const frames = nativeSubagentCapture();
    let sent: Promise<{ turnId: string }> | undefined;
    await replayMuseServeCapture(host, frames, {
      stopAt: frames.findIndex(
        (frame) => frame.msg.method === 'subagent/sendMessage',
      ),
      onDrivenRequest: (method) => {
        if (method !== 'turn/start') return undefined;
        sent = h.adapter.sendTurn({ threadId: THREAD, input: 'go' });
        return sent;
      },
    });
    const steering = h.adapter.steerChildWork(
      THREAD,
      WORKFLOW_CHILD_1418,
      (await sent!).turnId,
      OWNER_NOTE,
    );
    const request = await host.nextRequest('subagent/sendMessage', new Set());
    // Muse 1.4.18's own refusal, captured live for a child that had ended.
    host.writeFrame({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32030,
        message: `subagent/sendMessage command ${String(request.params?.commandId)} rejected: subagent_state_ineligible`,
        data: {
          kind: 'commandRejected',
          retryable: false,
          reason: 'subagent_state_ineligible',
        },
      },
    });
    await expect(steering).resolves.toEqual({ outcome: 'no-active-task' });
  });

  test('a call still running when its turn completes is a background task: its row returns, the task is child work until its own terminal, and stop is task/stop', async () => {
    const h = harness();
    const host = await startServe(h);
    let stop: Promise<unknown> | undefined;
    const driven = await replayMuseServeCapture(
      host,
      loadMuseServeCapture('background-task-stop'),
      {
        stopAt: captureIndex(
          'background-task-stop',
          (msg) => msg.method === 'session/compact',
        ),
        onDrivenRequest: (method, _occurrence, captured) => {
          if (method === 'turn/start')
            return h.adapter.sendTurn({ threadId: THREAD, input: 'go' });
          if (method === 'task/stop') {
            stop = h.adapter.stopProviderTask(THREAD, String(captured.taskId));
            return stop;
          }
          return undefined;
        },
      },
    );
    await settle();
    const FIRST_TASK = '00000000-0000-7000-8000-000000000019';
    const SECOND_TASK = '00000000-0000-7000-8000-000000000045';
    await expect(stop).resolves.toEqual({
      outcome: 'stopped',
      taskId: SECOND_TASK,
    });
    expect(
      driven.find((frame) => frame.method === 'task/stop')?.params,
    ).toEqual({
      commandId: expect.any(String),
      sessionId: SESSION_1418,
      taskId: SECOND_TASK,
    });
    expect(driven.some((frame) => frame.method === 'subagent/stop')).toBe(
      false,
    );
    // Each row closes as a call that returned, never as one whose fate is
    // unknown, and once: the task's later revisions are the task's.
    const rows = of(h.events, 'tool.completed').filter(
      (event) => event.toolName === 'bash',
    );
    expect(rows.map((row) => [row.toolCallId, row.status])).toEqual([
      ['call_00000000000000000000000000000001', 'success'],
      ['call_00000000000000000000000000000002', 'success'],
    ]);
    expect(String(rows[0].output)).toContain('background_running');
    const deltas = childWorkDeltas(h.events);
    const firstSnapshot = deltas.find((delta) => delta.kind === 'snapshot');
    expect(firstSnapshot).toMatchObject({
      running: [
        {
          producer: 'engine-subagent',
          childId: FIRST_TASK,
          status: 'running',
          parent: {
            turnId: WORKFLOW_TURN_1418,
            toolCallId: 'call_00000000000000000000000000000001',
          },
          title: 'Start sleep marker command',
          kindLabel: 'bash',
          workKind: 'command',
          backgrounded: true,
          controls: { stop: 'provider-task-stop' },
        },
      ],
    });
    expect(
      deltas.some(
        (delta) =>
          delta.kind === 'settle' &&
          delta.childId === SECOND_TASK &&
          delta.status === 'stopped-unconfirmed',
      ),
    ).toBe(true);
    const settled = childWorkForReporter(fold(h.events), THREAD);
    expect(settled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          childId: FIRST_TASK,
          status: 'completed',
          result: { summary: 'bg-one-done\n', source: 'tool-return' },
        }),
        expect.objectContaining({
          childId: SECOND_TASK,
          status: 'cancelled',
          result: {
            summary: 'cancelled by runtime client',
            source: 'provider-error',
          },
        }),
      ]),
    );
  });

  test('a stop for a task that already ended is no-active-task, and nothing reaches muse', async () => {
    const h = harness();
    const host = await startServe(h);
    await replayMuseServeCapture(
      host,
      loadMuseServeCapture('background-task-stop'),
      {
        stopAt: captureIndex(
          'background-task-stop',
          (msg) => msg.method === 'turn/start' && (msg.id as number) > 4,
        ),
        onDrivenRequest: (method) =>
          method === 'turn/start'
            ? h.adapter.sendTurn({ threadId: THREAD, input: 'go' })
            : undefined,
      },
    );
    await settle();
    const sent = host.sent.length;
    await expect(
      h.adapter.stopProviderTask(
        THREAD,
        '00000000-0000-7000-8000-000000000019',
      ),
    ).resolves.toEqual({
      outcome: 'no-active-task',
      taskId: '00000000-0000-7000-8000-000000000019',
    });
    expect(host.sent.slice(sent)).toEqual([]);
  });
});

describe('Muse parity: /compact is session/compact', () => {
  const compactAt = () =>
    captureIndex(
      'background-task-stop',
      (msg) => msg.method === 'session/compact',
    );

  /** The capture up to its idle `session/compact`, both turns driven. */
  async function idleSession(h: Harness) {
    const host = await startServe(h);
    await replayMuseServeCapture(
      host,
      loadMuseServeCapture('background-task-stop'),
      {
        stopAt: compactAt(),
        onDrivenRequest: (method, _occurrence, captured) => {
          if (method === 'turn/start')
            return h.adapter.sendTurn({ threadId: THREAD, input: 'go' });
          if (method === 'task/stop')
            return h.adapter.stopProviderTask(THREAD, String(captured.taskId));
          return undefined;
        },
      },
    );
    await settle();
    return host;
  }

  test('a serve adapter lists /compact as its own action', async () => {
    const h = harness();
    await expect(h.adapter.getCommands?.()).resolves.toEqual([
      expect.objectContaining({
        name: 'compact',
        passthrough: true,
        route: { kind: 'adapter-action', action: 'compact' },
      }),
    ]);
  });

  test("compaction muse says is unavailable for the session's model refuses the send, with nothing shown as done", async () => {
    const h = harness();
    const host = await startServe(h);
    let compacting: Promise<unknown> | undefined;
    const driven = await replayMuseServeCapture(
      host,
      loadMuseServeCapture('background-task-stop'),
      {
        onDrivenRequest: (method, _occurrence, captured) => {
          if (method === 'turn/start')
            return h.adapter.sendTurn({ threadId: THREAD, input: 'go' });
          if (method === 'task/stop')
            return h.adapter.stopProviderTask(THREAD, String(captured.taskId));
          if (method === 'session/compact') {
            compacting = h.adapter.sendTurn({
              threadId: THREAD,
              input: ' /compact ',
            });
            return compacting;
          }
          return undefined;
        },
      },
    );
    await settle();
    const refusal = await (compacting as Promise<unknown>).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(SendTurnRefusedError);
    expect(refusal).toMatchObject({
      kind: 'input_unsupported',
      message:
        "Muse can't compact this session: compaction isn't available for its model.",
    });
    expect(
      driven.find((frame) => frame.method === 'session/compact')?.params,
    ).toEqual({ commandId: expect.any(String), sessionId: SESSION_1418 });
    expect(driven.some((frame) => frame.method === 'turn/start')).toBe(true);
    expect(
      of(h.events, 'turn.started').some(
        (event) => event.prompt === ' /compact ',
      ),
    ).toBe(false);
  });

  test('/compact on a muse exec fallback session is refused before anything runs, never sent as prompt text', async () => {
    const h = harness({
      spawnHost: (args) => {
        const host = new FakeMuseServeHost(args);
        setImmediate(() => host.exit(2));
        return host;
      },
    });
    await h.adapter.startSession({ provider: 'muse', threadId: THREAD });
    await settle();
    expect(of(h.events, 'session.configured')[0].metadata).toMatchObject({
      museTransport: 'exec',
    });
    await expect(
      h.adapter.sendTurn({ threadId: THREAD, input: ' /compact ' }),
    ).rejects.toMatchObject({
      name: 'SendTurnRefusedError',
      kind: 'input_unsupported',
      message: expect.stringContaining('muse exec'),
    });
    expect(h.execSpawns).toEqual([]);
    expect(of(h.events, 'turn.started')).toEqual([]);
  });

  test("muse's own run_active refusal is a retryable busy refusal", async () => {
    const h = harness();
    const host = await idleSession(h);
    const compacting = h.adapter.sendTurn({
      threadId: THREAD,
      input: '/compact',
    });
    const request = await host.nextRequest('session/compact', new Set());
    // Muse 1.4.18's own refusal, captured live while a workflow ran.
    host.writeFrame({
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32030,
        message: `session/compact command ${String(request.params?.commandId)} rejected: run_active`,
        data: {
          kind: 'commandRejected',
          retryable: false,
          commandId: request.params?.commandId,
          reason: 'run_active',
        },
      },
    });
    await expect(compacting).rejects.toMatchObject({
      name: 'SendTurnRefusedError',
      kind: 'busy',
      retryable: true,
    });
  });

  test('an admitted compaction is a turn that says it started, never that it finished', async () => {
    const h = harness();
    const host = await idleSession(h);
    const compacting = h.adapter.sendTurn({
      threadId: THREAD,
      input: '/compact',
      invocationId: 'invocation-compact',
    });
    const request = await host.nextRequest('session/compact', new Set());
    // The schema's admission ack (`SessionCompactResult`); no live capture
    // admitted one (the account's model had no summarizer).
    host.writeFrame({
      jsonrpc: '2.0',
      id: request.id,
      result: { commandId: request.params?.commandId, status: 'accepted' },
    });
    const { turnId } = await compacting;
    // The turn is closed by the time the send returns: draining only
    // microtasks (no timer or I/O turn) already delivers its terminal.
    for (let hop = 0; hop < 50; hop += 1) await Promise.resolve();
    expect(
      of(h.events, 'turn.completed').some((event) => event.turnId === turnId),
    ).toBe(true);
    await settle();
    const forTurn = h.events.filter(
      (event) => (event as { turnId?: string }).turnId === turnId,
    );
    expect(forTurn.map((event) => event.method)).toEqual([
      'turn.started',
      'content.text-delta',
      'turn.completed',
    ]);
    expect(forTurn[0]).toMatchObject({
      prompt: '/compact',
      invocationId: 'invocation-compact',
    });
    expect(forTurn[2]).toMatchObject({
      finishReason: 'stop',
      outputText: "Muse started compacting this session's context.",
    });
    expect(
      host.sent.some(
        (frame) =>
          frame.method === 'turn/start' && frame.params?.input === '/compact',
      ),
    ).toBe(false);
  });

  test('/compact with instructions, or while a turn runs, is refused before anything reaches muse', async () => {
    const idle = harness();
    const idleHost = await idleSession(idle);
    await expect(
      idle.adapter.sendTurn({
        threadId: THREAD,
        input: '/compact keep the plan',
      }),
    ).rejects.toMatchObject({ kind: 'input_unsupported' });
    expect(
      idleHost.sent.some((frame) => frame.method === 'session/compact'),
    ).toBe(false);

    const h = harness();
    const host = await startServe(h);
    await replayMuseServeCapture(host, loadMuseServeCapture('steer'), {
      stopAt: captureIndex('steer', (msg) => msg.method === 'turn/steer'),
      onDrivenRequest: (method) =>
        method === 'turn/start'
          ? h.adapter.sendTurn({ threadId: THREAD, input: 'go' })
          : undefined,
    });
    await expect(
      h.adapter.sendTurn({ threadId: THREAD, input: '/compact' }),
    ).rejects.toMatchObject({ name: 'SendTurnRefusedError', kind: 'busy' });
    expect(host.sent.some((frame) => frame.method === 'session/compact')).toBe(
      false,
    );
  });
});

// Muse parity, slice 4. `muse-serve-1.4.18-resume-goal-fork` is a SECOND
// `muse serve` process re-attaching the session the first one started;
// `muse-serve-1.4.18-goal-set-pause` is one session's goal set and paused.
const RESUMED_SESSION = '00000000-0000-7000-8000-000000000002';
const GOAL_OBJECTIVE = 'Reply with exactly the word DONE.';

/** Index of the first frame of `frames` matching, from `from`. */
function frameIndex(
  frames: MuseServeCaptureFrame[],
  predicate: (msg: Record<string, unknown>, dir: string) => boolean,
  from = 0,
): number {
  const index = frames.findIndex(
    (frame, at) => at >= from && predicate(frame.msg, frame.dir),
  );
  if (index < 0) throw new Error('no such frame');
  return index;
}

/**
 * The resume capture without the probe's own second `session/resume` (of
 * an unknown id) and its refusal, which the adapter never sends.
 */
function resumeFrames(): MuseServeCaptureFrame[] {
  const frames = loadMuseServeCapture('resume-goal-fork');
  const probeOnly = frames.filter(
    (frame) =>
      frame.dir === 'c2s' &&
      frame.msg.method === 'session/resume' &&
      (frame.msg.params as { sessionId?: string }).sessionId !==
        RESUMED_SESSION,
  );
  const ids = new Set(probeOnly.map((frame) => frame.msg.id));
  return frames.filter(
    (frame) =>
      !probeOnly.includes(frame) &&
      !(
        frame.dir === 's2c' &&
        ids.has(frame.msg.id) &&
        frame.msg.method === undefined
      ),
  );
}

/** Answers the re-attach's `approval/listPending` (the probe sent none). */
function answerListPending(host: FakeMuseServeHost) {
  void host
    .nextRequest('approval/listPending', new Set())
    .then((request) => reply(host, request, { approvals: [], userInputs: [] }))
    .catch(() => {});
}

function resumeSession(h: Harness, museSessionId = RESUMED_SESSION) {
  return h.adapter.startSession({
    provider: 'muse',
    threadId: THREAD,
    cwd: '/workspace/probe/repo',
    // The resumed session reports `allowAll`, which `auto` applies.
    modelOptions: { approvalMode: 'auto' },
    resumeCursor: { museSessionId },
  });
}

/** A resumed session, idle, up to the probe's `goal/resume`. */
async function resumedSession(h: Harness) {
  const frames = resumeFrames();
  const starting = resumeSession(h);
  const host = await firstHost(h, () => starting);
  answerListPending(host);
  const goalResumeAt = frameIndex(
    frames,
    (msg, dir) => dir === 'c2s' && msg.method === 'goal/resume',
  );
  await replayMuseServeCapture(host, frames, { stopAt: goalResumeAt });
  const session = await starting;
  return { host, session, frames, goalResumeAt };
}

describe('Muse parity: a serve session resumes after a Station restart', () => {
  test('a fresh serve session carries its muse session id as the resume cursor; the adapter declares same-session resume', async () => {
    const h = harness();
    expect(h.adapter.metadata.continuity?.resume).toBe('same-session');
    const starting = h.adapter.startSession({
      provider: 'muse',
      threadId: THREAD,
      cwd: '/workspace/probe/repo',
    });
    const host = await firstHost(h, () => starting);
    await replayMuseServeCapture(host, loadMuseServeCapture('steer'), {
      stopAt: captureIndex('steer', (msg) => msg.method === 'turn/start'),
    });
    const session = await starting;
    expect(session.resumeCursor).toEqual({ museSessionId: SESSION_1418 });
    expect(h.adapter.nativeSessionIdentity(session.resumeCursor)).toEqual({
      sessionId: SESSION_1418,
    });
  });

  test('an exec-fallback session has no resume cursor, and an exec-only adapter declares no resume', async () => {
    const h = harness({
      spawnHost: (args) => {
        const host = new FakeMuseServeHost(args);
        setImmediate(() => host.exit(2));
        return host;
      },
    });
    const session = await h.adapter.startSession({
      provider: 'muse',
      threadId: THREAD,
    });
    expect(session.resumeCursor).toBeUndefined();
    expect(new MuseAdapter({}).metadata.continuity?.resume).toBe('none');
  });

  test('a resume re-attaches the durable session on a fresh host with session/resume, never session/start', async () => {
    const h = harness();
    const { host, session } = await resumedSession(h);
    const resume = host.sent.find((frame) => frame.method === 'session/resume');
    expect(resume?.params).toEqual({
      commandId: expect.any(String),
      sessionId: RESUMED_SESSION,
      excludeItems: true,
    });
    expect(host.sent.some((frame) => frame.method === 'session/start')).toBe(
      false,
    );
    expect(h.execSpawns).toEqual([]);
    expect(session.resumeCursor).toEqual({ museSessionId: RESUMED_SESSION });
    expect(session.model).toBe('muse-spark-1.3-contributor');
    expect(of(h.events, 'session.configured')[0].metadata).toMatchObject({
      museTransport: 'serve',
      museSessionId: RESUMED_SESSION,
    });
  });

  test('muse no longer having the session ends the binding: refused, published binding-dead, and no session (serve or exec) stands in', async () => {
    const h = harness();
    const notFound = loadMuseServeCapture('resume-goal-fork').find(
      (frame) =>
        (frame.msg.error as { code?: number } | undefined)?.code === -32020,
    );
    const starting = resumeSession(h, '00000000-0000-7000-8000-000000000006');
    const host = await firstHost(h, () => starting);
    const consumed = new Set<SentFrame>();
    const initialize = await host.nextRequest('initialize', consumed);
    consumed.add(initialize);
    reply(host, initialize, liveInitializeResult());
    const resume = await host.nextRequest('session/resume', consumed);
    // Muse 1.4.18's own answer to a resume of an unknown id.
    host.writeFrame({
      jsonrpc: '2.0',
      id: resume.id,
      error: notFound?.msg.error,
    });
    await expect(starting).rejects.toThrow(/no longer has the session/);
    expect(of(h.events, 'runtime.error').map((event) => event.code)).toEqual([
      ENGINE_SESSION_BINDING_DEAD_CODE,
    ]);
    expect(host.sent.some((frame) => frame.method === 'session/start')).toBe(
      false,
    );
    expect(h.execSpawns).toEqual([]);
    expect(await h.adapter.hasSession(THREAD)).toBe(false);
    expect(of(h.events, 'session.started')).toEqual([]);
  });

  test('muse answering a resume with another session is a dead binding too, never adopted', async () => {
    const h = harness();
    const resumed = loadMuseServeCapture('resume-goal-fork').find(
      (frame) =>
        (frame.msg.result as { history?: unknown } | undefined)?.history !==
        undefined,
    );
    const result = structuredClone(
      resumed?.msg.result as { session: { sessionId: string } },
    );
    result.session.sessionId = '00000000-0000-7000-8000-0000000000ff';
    const starting = resumeSession(h);
    const host = await firstHost(h, () => starting);
    const consumed = new Set<SentFrame>();
    const initialize = await host.nextRequest('initialize', consumed);
    consumed.add(initialize);
    reply(host, initialize, liveInitializeResult());
    reply(host, await host.nextRequest('session/resume', consumed), result);
    await expect(starting).rejects.toThrow(/a different session/);
    expect(of(h.events, 'runtime.error').map((event) => event.code)).toEqual([
      ENGINE_SESSION_BINDING_DEAD_CODE,
    ]);
    expect(await h.adapter.hasSession(THREAD)).toBe(false);
  });

  test('a host that cannot be used refuses the resume as retryable, with no exec fallback and no binding-dead claim', async () => {
    const h = harness({
      spawnHost: (args) => {
        const host = new FakeMuseServeHost(args);
        setImmediate(() => host.exit(2));
        return host;
      },
    });
    await expect(resumeSession(h)).rejects.toThrow(
      /could not resume this conversation's session/,
    );
    expect(h.execSpawns).toEqual([]);
    expect(of(h.events, 'runtime.error')).toEqual([]);
    expect(of(h.events, 'session.started')).toEqual([]);
  });
});

describe("Muse parity: a serve session's goal", () => {
  test('a fresh session has no goal; a goal muse set and the pause Station sends read through, with no token figures', async () => {
    const h = harness();
    const frames = loadMuseServeCapture('goal-set-pause');
    const starting = h.adapter.startSession({
      provider: 'muse',
      threadId: THREAD,
      cwd: '/workspace/probe/repo',
      modelOptions: { approvalMode: 'auto' },
    });
    const host = await firstHost(h, () => starting);
    const turnAt = frameIndex(
      frames,
      (msg, dir) => dir === 'c2s' && msg.method === 'turn/start',
    );
    await replayMuseServeCapture(host, frames, { stopAt: turnAt });
    await starting;
    const fresh = await h.adapter.goals!.read(THREAD);
    expect(fresh).toMatchObject({ state: 'available', goal: null });
    // The rest: one turn, then the probe's own `goal/set` (Station offers
    // none) starts a goal turn, and Station pauses the goal.
    const setAt = frameIndex(
      frames,
      (msg, dir) => dir === 'c2s' && msg.method === 'goal/set',
    );
    const emptySetAt = frameIndex(
      frames,
      (msg, dir) => dir === 'c2s' && msg.method === 'goal/set',
      setAt + 1,
    );
    let active: unknown;
    let paused: Promise<unknown> | undefined;
    await replayMuseServeCapture(host, frames.slice(turnAt, emptySetAt), {
      onDrivenRequest: (method) => {
        if (method === 'turn/start')
          return h.adapter.sendTurn({ threadId: THREAD, input: 'go' });
        if (method !== 'goal/pause') return undefined;
        return (async () => {
          active = await h.adapter.goals!.read(THREAD);
          paused = h.adapter.goals!.control(THREAD, { operation: 'pause' });
          return paused;
        })();
      },
    });
    await settle();
    expect(active).toEqual({
      state: 'available',
      capability: {
        implementation: 'engine',
        operations: ['read', 'pause', 'clear'],
        maxObjectiveChars: 4000,
        tokenBudget: 'unsupported',
        completion: 'implementation-reported',
        saveState: 'paused',
      },
      goal: { objective: GOAL_OBJECTIVE, status: 'active' },
    });
    await expect(paused).resolves.toEqual({
      state: 'applied',
      goal: { objective: GOAL_OBJECTIVE, status: 'paused' },
    });
    expect(
      host.sent.find((frame) => frame.method === 'goal/pause')?.params,
    ).toEqual({ commandId: expect.any(String), sessionId: expect.any(String) });
  });

  test('an acknowledged pause that muse never shows as paused is indeterminate, not applied', async () => {
    const h = harness();
    const host = await liveSession(h);
    const pausing = h.adapter.goals!.control(THREAD, { operation: 'pause' });
    const request = await host.nextRequest('goal/pause', new Set());
    // The schema's admission ack, with no `session/goalChanged` before it.
    reply(host, request, {
      commandId: request.params?.commandId,
      status: 'accepted',
    });
    await expect(pausing).resolves.toEqual({ state: 'indeterminate' });
  });

  test("muse's missing_goal rejection says the resumed session has no goal", async () => {
    const h = harness();
    const { host } = await resumedSession(h);
    const clearing = h.adapter.goals!.control(THREAD, { operation: 'clear' });
    const request = await host.nextRequest('goal/clear', new Set());
    const rejected = loadMuseServeCapture('resume-goal-fork').find(
      (frame) =>
        typeof (frame.msg.error as { message?: string } | undefined)
          ?.message === 'string' &&
        (frame.msg.error as { message: string }).message.includes('goal/clear'),
    );
    host.writeFrame({
      jsonrpc: '2.0',
      id: request.id,
      error: rejected?.msg.error,
    });
    await expect(clearing).resolves.toEqual({
      state: 'refused',
      reason: 'invalid-command',
    });
    await expect(h.adapter.goals!.read(THREAD)).resolves.toMatchObject({
      state: 'available',
      goal: null,
    });
  });

  test('set and resume are unsupported (each would start a goal turn) and nothing reaches muse', async () => {
    const h = harness();
    const host = await liveSession(h);
    const sent = host.sent.length;
    await expect(
      h.adapter.goals!.control(THREAD, {
        operation: 'set',
        objective: 'Ship it',
        tokenBudget: null,
      }),
    ).resolves.toEqual({ state: 'unsupported' });
    await expect(
      h.adapter.goals!.control(THREAD, { operation: 'resume' }),
    ).resolves.toEqual({ state: 'unsupported' });
    expect(host.sent.slice(sent)).toEqual([]);
  });

  test('after a resume the goal is unknown until muse reports it; clear applies, and a clear or pause muse rejects missing_goal is refused', async () => {
    const h = harness();
    const { host, frames, goalResumeAt } = await resumedSession(h);
    await expect(h.adapter.goals!.read(THREAD)).resolves.toEqual({
      state: 'unavailable',
      reason: 'provider-unavailable',
    });
    const closedAt = frameIndex(
      frames,
      (msg) => msg.method === 'session/closed',
    );
    const results: unknown[] = [];
    let before: unknown;
    await replayMuseServeCapture(host, frames.slice(goalResumeAt, closedAt), {
      onDrivenRequest: (method, occurrence) => {
        if (method !== 'goal/clear' && method !== 'goal/pause')
          return undefined;
        return (async () => {
          if (method === 'goal/clear' && occurrence === 0)
            before = await h.adapter.goals!.read(THREAD);
          const outcome = await h.adapter.goals!.control(THREAD, {
            operation: method === 'goal/clear' ? 'clear' : 'pause',
          });
          results.push(outcome);
          return outcome;
        })();
      },
    });
    await settle();
    // muse's goal turn (the probe's `goal/resume`) restated the goal; the
    // fork's own `goalChanged` (another session) did not move it.
    expect(before).toMatchObject({
      state: 'available',
      goal: { objective: GOAL_OBJECTIVE, status: 'active' },
    });
    expect(results).toEqual([
      { state: 'applied', goal: null },
      { state: 'refused', reason: 'invalid-command' },
      { state: 'refused', reason: 'invalid-command' },
    ]);
    await expect(h.adapter.goals!.read(THREAD)).resolves.toMatchObject({
      state: 'available',
      goal: null,
    });
  });
});

/**
 * `approval/reviewing` (stable MSP, Muse Code 1.4.18): no live capture holds
 * one, so the frame below is built to the exported schema's
 * `ApprovalRequestParams` (every required member), naming the bash call the
 * `steer` capture has open at that point.
 */
describe('approval/reviewing: muse’s automated reviewer holds a call', () => {
  const CALL_1418 = 'call_00000000000000000000000000000001';
  function reviewingFrame(overrides: Record<string, unknown> = {}) {
    return {
      jsonrpc: '2.0',
      method: 'approval/reviewing',
      params: {
        sessionId: '00000000-0000-7000-8000-000000000002',
        approvalId: '00000000-0000-7000-8000-0000000000a1',
        turnId: TURN_1418,
        taskId: '00000000-0000-7000-8000-0000000000a1',
        itemId: '00000000-0000-7000-8000-000000000014',
        toolCallId: CALL_1418,
        toolName: 'bash',
        rawArgs: '{"command":"sleep 20 && echo ALPHA"}',
        viewCursor: 'v10:00000000-0000-7000-8000-000000000002:99',
        sourceRange: {
          stream: {
            kind: 'session',
            id: '00000000-0000-7000-8000-000000000002',
          },
          first: { id: '00000000-0000-7000-8000-0000000000a2', sequence: 99 },
          last: { id: '00000000-0000-7000-8000-0000000000a2', sequence: 99 },
        },
        subject: { kind: 'shell', command: 'sleep 20 && echo ALPHA' },
        currentRequirementId: {
          approvalId: '00000000-0000-7000-8000-0000000000a1',
          sourceIndex: 0,
        },
        availableChoices: [],
        judgeEscalated: false,
        protectedWrite: false,
        ...overrides,
      },
    };
  }

  async function atOpenBashCall(h: Harness) {
    const host = await startServe(h);
    await replayMuseServeCapture(host, loadMuseServeCapture('steer'), {
      stopAt:
        captureIndex(
          'steer',
          (msg) =>
            msg.method === 'item/started' &&
            (msg.params as { item?: { kind?: string } })?.item?.kind ===
              'toolCall',
        ) + 1,
      // The capture steers before the call opens; that is not under test.
      notDriven: new Set(['turn/steer']),
      onDrivenRequest: (method) =>
        method === 'turn/start'
          ? h.adapter.sendTurn({ threadId: THREAD, input: 'go' })
          : undefined,
    });
    await settle();
    return host;
  }

  test('is progress on the waiting tool call, never a request to the user', async () => {
    const h = harness();
    const host = await atOpenBashCall(h);
    expect(of(h.events, 'tool.started').map((e) => e.toolCallId)).toEqual([
      CALL_1418,
    ]);
    host.writeFrame(reviewingFrame());
    await settle();
    expect(of(h.events, 'tool.progress')).toEqual([
      expect.objectContaining({
        turnId: TURN_1418,
        itemId: `tool:${CALL_1418}`,
        toolCallId: CALL_1418,
        message: MUSE_APPROVAL_REVIEWING_MESSAGE,
      }),
    ]);
    expect(of(h.events, 'request.opened')).toEqual([]);
  });

  test('a call Station has not seen, or a subagent’s, is not reported', async () => {
    const h = harness();
    const host = await atOpenBashCall(h);
    host.writeFrame(reviewingFrame({ toolCallId: 'call_unknown' }));
    host.writeFrame(
      reviewingFrame({
        subagentOrigin: { subagentId: 'child-1' },
      }),
    );
    await settle();
    expect(of(h.events, 'tool.progress')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Slice 7: the schema fingerprint policy and the 1.4.20 cost/context capture.

const SESSION_1420 = '00000000-0000-7000-8000-000000000002';
const TURN_1420 = '00000000-0000-7000-8000-000000000005';
const FINGERPRINT_1420 =
  'sha256:283b1b125dcc9172928fb5d6711a92a353796d030a7c186988ed527a13cf07f0';
/** A schema fingerprint no Muse release Station was verified against has. */
const UNKNOWN_FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const UNKNOWN_VERSION = '1.4.99';

/**
 * Muse Code 1.4.20's own `muse schema generate-json-schema` stable export,
 * with only its `description` texts removed.
 */
function stableSchemaExport(): Record<string, unknown> {
  // A fresh copy per call: tests edit the export they are handed.
  return structuredClone(museStableSchema) as Record<string, unknown>;
}

interface SchemaRun {
  args: string[];
  env: Record<string, string>;
  omitEnv?: readonly string[];
}

/**
 * A `muse` stand-in for the schema check: `--version` answers the next of
 * `versions` (then `version`), and the export writes `schema` (the 1.4.20
 * export, after `mutate`) into the folder it is given, as the real one does.
 */
function fakeSchemaMuse(
  options: {
    version?: string;
    versions?: string[];
    /** Build suffixes for successive `--version` runs (default `R1.1`). */
    builds?: string[];
    mutate?: (schema: Record<string, unknown>) => void;
    exportCode?: number;
  } = {},
) {
  const runs: SchemaRun[] = [];
  const versions = [...(options.versions ?? [])];
  const builds = [...(options.builds ?? [])];
  const runner: MuseSchemaCommandRunner = async ({ args, env, omitEnv }) => {
    runs.push({ args: [...args], env, ...(omitEnv ? { omitEnv } : {}) });
    if (args[0] === '--version') {
      const version = versions.shift() ?? options.version ?? UNKNOWN_VERSION;
      const build = builds.shift() ?? 'R1.1';
      return {
        stdout: `Muse Code ${version} (${version}-${build})\n`,
        stderr: '',
        code: 0,
      };
    }
    if (args[0] === 'schema' && args[1] === 'generate-json-schema') {
      if (options.exportCode !== undefined && options.exportCode !== 0) {
        return {
          stdout: '',
          stderr: 'export failed',
          code: options.exportCode,
        };
      }
      const dir = args[3];
      const schema = stableSchemaExport();
      options.mutate?.(schema);
      await writeFile(
        join(dir, 'manifest.json'),
        JSON.stringify({ experimental: false, schemaVersion: 1 }),
      );
      await writeFile(join(dir, 'msp.schema.json'), JSON.stringify(schema));
      return { stdout: '', stderr: '', code: 0 };
    }
    return null;
  };
  return {
    runner,
    runs,
    exports: () => runs.filter((run) => run.args[0] === 'schema'),
  };
}

/** The 1.4.18 `steer` capture, its host reporting `schema` and `version`. */
function steerCaptureReporting(
  schema: { fingerprint: string; version?: unknown },
  museVersion = UNKNOWN_VERSION,
): MuseServeCaptureFrame[] {
  const frames = loadMuseServeCapture('steer');
  const init = frames.find(
    (frame) =>
      frame.dir === 's2c' &&
      (frame.msg.result as { schema?: unknown } | undefined)?.schema,
  );
  const result = init?.msg.result as Record<string, unknown>;
  result.schema = { version: 1, ...schema };
  (result.serverInfo as Record<string, unknown>).version = museVersion;
  return frames;
}

/**
 * Starts a session for `threadId` on the next host, replays `frames` up to
 * the first `turn/start` (or only the handshake reply, when the host is
 * expected to be refused), and resolves once the start settles.
 */
async function startReporting(
  h: Harness,
  threadId: string,
  frames: MuseServeCaptureFrame[],
  expect: 'serve' | 'refused',
): Promise<FakeMuseServeHost> {
  const index = h.hosts.length;
  const started = h.adapter.startSession({
    provider: 'muse',
    threadId,
    cwd: '/workspace/probe/repo',
  });
  started.catch(() => {});
  for (let attempt = 0; attempt < 200 && !h.hosts[index]; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const host = h.hosts[index];
  const initReply = frames.findIndex(
    (frame) =>
      frame.dir === 's2c' &&
      (frame.msg.result as { schema?: unknown } | undefined)?.schema,
  );
  await replayMuseServeCapture(host, frames, {
    stopAt:
      expect === 'serve'
        ? frames.findIndex((frame) => frame.msg.method === 'turn/start')
        : initReply + 1,
  });
  await started;
  await settle();
  return host;
}

function transportOf(h: Harness, threadId: string) {
  return of(h.events, 'session.configured').find(
    (event) => event.threadId === threadId,
  )?.metadata?.museTransport;
}

function unavailableReason(h: Harness, threadId: string): string | undefined {
  const warning = of(h.events, 'runtime.warning').find(
    (event) =>
      event.threadId === threadId && event.code === MUSE_SERVE_UNAVAILABLE_CODE,
  );
  return (warning?.details as { reason?: string } | undefined)?.reason;
}

function compatibleWarnings(h: Harness) {
  return of(h.events, 'runtime.warning').filter(
    (event) => event.code === MUSE_SERVE_SCHEMA_UNVERIFIED_COMPATIBLE_CODE,
  );
}

describe('Muse serve: which schema fingerprints a host may report', () => {
  test('the committed 1.4.20 export has every member Station uses, and so does a 1.4.18 one without the field 1.4.20 added', () => {
    const schema = stableSchemaExport();
    expect(museServeSchemaSurfaceGaps(schema)).toEqual([]);
    // 1.4.18 differs only by not declaring `SessionStartParams.clear`.
    const defs = schema.$defs as Record<string, Record<string, unknown>>;
    delete (defs.SessionStartParams.properties as Record<string, unknown>)
      .clear;
    expect(museServeSchemaSurfaceGaps(schema)).toEqual([]);
  });

  test('a verified fingerprint (1.4.20) runs on serve with no export and no warning', async () => {
    const muse = fakeSchemaMuse();
    const h = harness({ schemaCommandRunner: muse.runner });
    await startReporting(
      h,
      THREAD,
      steerCaptureReporting({ fingerprint: FINGERPRINT_1420 }, '1.4.20'),
      'serve',
    );
    expect(transportOf(h, THREAD)).toBe('serve');
    expect(unavailableReason(h, THREAD)).toBeUndefined();
    expect(compatibleWarnings(h)).toEqual([]);
    expect(muse.runs).toEqual([]);
  });

  test('an unknown fingerprint whose export has every member Station uses runs on serve, says so once, and is exported once per fingerprint', async () => {
    const muse = fakeSchemaMuse();
    const h = harness({ schemaCommandRunner: muse.runner });
    const frames = () =>
      steerCaptureReporting({ fingerprint: UNKNOWN_FINGERPRINT });
    await startReporting(h, THREAD, frames(), 'serve');
    expect(transportOf(h, THREAD)).toBe('serve');
    expect(unavailableReason(h, THREAD)).toBeUndefined();
    const warnings = compatibleWarnings(h);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      threadId: THREAD,
      details: {
        fingerprint: UNKNOWN_FINGERPRINT,
        museVersion: UNKNOWN_VERSION,
      },
    });
    // After the session it describes exists.
    const order = h.events.map((event) => event.method);
    expect(order.indexOf('runtime.warning')).toBeGreaterThan(
      order.indexOf('session.configured'),
    );
    // `--version` around the export, all under the host's own env.
    expect(muse.runs.map((run) => run.args[0])).toEqual([
      '--version',
      'schema',
      '--version',
    ]);
    expect(muse.runs[1].args.slice(0, 3)).toEqual([
      'schema',
      'generate-json-schema',
      '--out',
    ]);
    for (const run of muse.runs) {
      expect(run.env).toMatchObject({
        MUSE_NO_AUTO_UPDATE: '1',
        MUSE_LOGIN: '0',
      });
    }
    // A second session on the same schema: no second export.
    await startReporting(h, 'thread-muse-serve-2', frames(), 'serve');
    expect(transportOf(h, 'thread-muse-serve-2')).toBe('serve');
    expect(muse.exports()).toHaveLength(1);
    expect(compatibleWarnings(h).map((event) => event.threadId)).toEqual([
      THREAD,
      'thread-muse-serve-2',
    ]);
  });

  test('an unknown fingerprint whose export lacks a member Station uses falls back to exec, naming what is missing', async () => {
    const muse = fakeSchemaMuse({
      mutate: (schema) => {
        delete (schema.methods as Record<string, unknown>)['turn/steer'];
        const item = (schema.$defs as Record<string, Record<string, unknown>>)
          .Item;
        delete (item.properties as Record<string, unknown>).callId;
      },
    });
    const h = harness({ schemaCommandRunner: muse.runner });
    const host = await startReporting(
      h,
      THREAD,
      steerCaptureReporting({ fingerprint: UNKNOWN_FINGERPRINT }),
      'refused',
    );
    expect(transportOf(h, THREAD)).toBe('exec');
    const reason = unavailableReason(h, THREAD);
    expect(reason).toContain('method turn/steer, Item.callId');
    expect(reason).toContain('sha256:aaaaaaaa');
    expect(compatibleWarnings(h)).toEqual([]);
    expect(host.sent.map((frame) => frame.method)).toEqual(['initialize']);
    expect(host.stdinEnded).toBe(true);
  });

  test('an export from another muse binary than the host proves nothing: a version mismatch falls back to exec', async () => {
    // The launcher swapped binaries between the host start and the export.
    const muse = fakeSchemaMuse({ versions: ['1.4.98', '1.4.98'] });
    const h = harness({ schemaCommandRunner: muse.runner });
    const host = await startReporting(
      h,
      THREAD,
      steerCaptureReporting({ fingerprint: UNKNOWN_FINGERPRINT }),
      'refused',
    );
    expect(transportOf(h, THREAD)).toBe('exec');
    expect(unavailableReason(h, THREAD)).toContain(
      `the host reported Muse ${UNKNOWN_VERSION}, but the installed muse is 1.4.98`,
    );
    expect(compatibleWarnings(h)).toEqual([]);
    expect(host.sent.map((frame) => frame.method)).toEqual(['initialize']);
    // ... including a swap DURING the export.
    const during = fakeSchemaMuse({
      versions: [UNKNOWN_VERSION, '1.4.98'],
    });
    const h2 = harness({ schemaCommandRunner: during.runner });
    await startReporting(
      h2,
      THREAD,
      steerCaptureReporting({ fingerprint: UNKNOWN_FINGERPRINT }),
      'refused',
    );
    expect(transportOf(h2, THREAD)).toBe('exec');
    expect(unavailableReason(h2, THREAD)).toContain(
      `${UNKNOWN_VERSION}, then 1.4.98`,
    );
  });

  test("two builds of the host's release swapped during the export prove nothing: falls back to exec", async () => {
    const muse = fakeSchemaMuse({ builds: ['R1.1', 'R2.1'] });
    const h = harness({ schemaCommandRunner: muse.runner });
    await startReporting(
      h,
      THREAD,
      steerCaptureReporting({ fingerprint: UNKNOWN_FINGERPRINT }),
      'refused',
    );
    expect(transportOf(h, THREAD)).toBe('exec');
    expect(unavailableReason(h, THREAD)).toContain('(another build)');
    expect(compatibleWarnings(h)).toEqual([]);
  });

  test('a failed export falls back to exec, and is not remembered: the next host exports again', async () => {
    const muse = fakeSchemaMuse({ exportCode: 3 });
    const h = harness({ schemaCommandRunner: muse.runner });
    const host = await startReporting(
      h,
      THREAD,
      steerCaptureReporting({ fingerprint: UNKNOWN_FINGERPRINT }),
      'refused',
    );
    expect(transportOf(h, THREAD)).toBe('exec');
    expect(unavailableReason(h, THREAD)).toContain('muse schema exited 3');
    expect(compatibleWarnings(h)).toEqual([]);
    expect(host.sent.map((frame) => frame.method)).toEqual(['initialize']);
    await startReporting(
      h,
      'thread-muse-serve-2',
      steerCaptureReporting({ fingerprint: UNKNOWN_FINGERPRINT }),
      'refused',
    );
    expect(muse.exports()).toHaveLength(2);
  });

  test('two hosts checked at once share one export, and its failure refuses both rather than throwing', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const muse = fakeSchemaMuse({ exportCode: 3 });
    const runner: MuseSchemaCommandRunner = async (input) => {
      if (input.args[0] === 'schema') await gate;
      return muse.runner(input);
    };
    const h = harness({ schemaCommandRunner: runner });
    const first = startReporting(
      h,
      THREAD,
      steerCaptureReporting({ fingerprint: UNKNOWN_FINGERPRINT }),
      'refused',
    );
    // The first check ran `--version`; its export is held at the gate.
    await vi.waitFor(() => expect(muse.runs).toHaveLength(1));
    await settle();
    const second = startReporting(
      h,
      'thread-muse-serve-2',
      steerCaptureReporting({ fingerprint: UNKNOWN_FINGERPRINT }),
      'refused',
    );
    await vi.waitFor(() => expect(h.hosts).toHaveLength(2));
    await settle();
    release();
    await Promise.all([first, second]);
    expect(muse.exports()).toHaveLength(1);
    for (const thread of [THREAD, 'thread-muse-serve-2']) {
      expect(transportOf(h, thread)).toBe('exec');
      expect(unavailableReason(h, thread)).toContain('muse schema exited 3');
    }
  });

  test('another schema version, or no export runner, refuses an unknown fingerprint without exporting', async () => {
    const muse = fakeSchemaMuse();
    const h = harness({ schemaCommandRunner: muse.runner });
    await startReporting(
      h,
      THREAD,
      steerCaptureReporting({ fingerprint: UNKNOWN_FINGERPRINT, version: 2 }),
      'refused',
    );
    expect(transportOf(h, THREAD)).toBe('exec');
    expect(unavailableReason(h, THREAD)).toContain('schema version 2');
    expect(muse.runs).toEqual([]);
    const bare = harness();
    await startReporting(
      bare,
      THREAD,
      steerCaptureReporting({ fingerprint: UNKNOWN_FINGERPRINT }),
      'refused',
    );
    expect(transportOf(bare, THREAD)).toBe('exec');
    expect(unavailableReason(bare, THREAD)).toContain(
      `unverified MSP schema fingerprint ${UNKNOWN_FINGERPRINT}`,
    );
  });

  test('a discovery read judges the host as a session does: a compatible unknown fingerprint is asked for its catalog', async () => {
    const muse = fakeSchemaMuse();
    const init = liveInitializeResult();
    (init.schema as Record<string, unknown>).fingerprint = UNKNOWN_FINGERPRINT;
    (init.serverInfo as Record<string, unknown>).version = UNKNOWN_VERSION;
    const h = harness({
      schemaCommandRunner: muse.runner,
      spawnHost: discoveryHost(
        [
          [
            'model/list',
            {
              providerId: 'meta',
              profileId: null,
              source: 'providerCatalog',
              models: [],
            },
          ],
        ],
        init,
      ),
    });
    await expect(h.adapter.listModelCatalog!()).resolves.toEqual({
      models: [],
    });
    expect(muse.exports()).toHaveLength(1);
  });
});

describe('Muse Code 1.4.20: a priced provider reports cost and context', () => {
  test('the live capture publishes the session cost and the context window from session/tokenUsage and session/contextUsage', async () => {
    const h = harness();
    const host = await startServe(h);
    const frames = loadMuseServeCapture('cost-context');
    expect(
      (frames[2].msg.result as { schema: { fingerprint: string } }).schema
        .fingerprint,
    ).toBe(FINGERPRINT_1420);
    await replayMuseServeCapture(host, frames, {
      onDrivenRequest: (method) =>
        method === 'turn/start'
          ? h.adapter.sendTurn({ threadId: THREAD, input: 'go' })
          : undefined,
    });
    await settle();
    // A verified host: serve, no fallback.
    expect(transportOf(h, THREAD)).toBe('serve');
    expect(of(h.events, 'session.configured')[0].metadata).toMatchObject({
      museSessionId: SESSION_1420,
    });
    const usage = of(h.events, 'token-usage.updated');
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      turnId: TURN_1420,
      promptTokens: 36166,
      completionTokens: 15,
      reportedCost: { amount: 0.0036196, unit: 'USD', scope: 'session' },
    });
    expect(usage[1]).toMatchObject({
      turnId: TURN_1420,
      contextTokens: 36434,
      contextWindowTokens: 1007997,
    });
    expect(of(h.events, 'turn.completed')).toHaveLength(1);
  });
});

/** Every request and notification the adapter wrote to any host in this file. */
function sentMethods(): Set<string> {
  return new Set(
    everyHost.flatMap((host) =>
      host.sent.flatMap((frame) => (frame.method ? [frame.method] : [])),
    ),
  );
}

describe('Muse serve: the required-surface manifest covers what the adapter uses', () => {
  /**
   * Replays a capture driving only the turn, with every host frame kept, or
   * with the host frames whose method the manifest does not name dropped.
   * The two must publish the same events: a frame the adapter reacts to is
   * part of the surface it relies on.
   */
  async function replayEvents(
    name: MuseServeCaptureName,
    dropUnlisted: boolean,
  ): Promise<string> {
    const listed = new Set([
      ...Object.keys(MUSE_SERVE_REQUIRED_SURFACE.notifications),
      ...Object.keys(MUSE_SERVE_REQUIRED_SURFACE.requests),
    ]);
    const frames = loadMuseServeCapture(name).filter(
      (frame) =>
        !dropUnlisted ||
        frame.dir !== 's2c' ||
        typeof frame.msg.method !== 'string' ||
        listed.has(frame.msg.method),
    );
    const h = harness();
    const host = await startServe(h);
    await replayMuseServeCapture(host, frames, {
      notDriven: new Set([
        'turn/interrupt',
        'approval/decide',
        'subagent/stop',
        'turn/steer',
        'userInput/answer',
        'userInput/cancel',
        'subagent/sendMessage',
        'task/stop',
        'session/compact',
        'goal/pause',
        'goal/clear',
      ]),
      onDrivenRequest: (method) =>
        method === 'turn/start'
          ? h.adapter.sendTurn({ threadId: THREAD, input: 'go' })
          : undefined,
    });
    await settle();
    const ids = new Map<string, string>();
    for (const event of h.events) ids.set(event.eventId, `e${ids.size}`);
    let text = JSON.stringify(
      h.events.map(({ createdAt: _createdAt, ...event }) => event),
    );
    for (const [id, label] of ids) text = text.split(id).join(label);
    return text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'T');
  }

  for (const name of [
    'workflow-child-approve',
    'steer',
    'user-input',
    'workflow-child-steer',
    'background-task-stop',
    'goal-set-pause',
    'cost-context',
  ] as const) {
    test(`${name}: dropping every host frame the manifest does not name changes nothing the adapter publishes`, async () => {
      const full = await replayEvents(name, false);
      expect(JSON.parse(full).length).toBeGreaterThan(2);
      expect(await replayEvents(name, true)).toBe(full);
    });
  }
});

/**
 * After every test in this file: each request and notification the adapter
 * wrote to a host is one the required-surface manifest names, so a host
 * missing it is refused rather than accepted as compatible.
 */
afterAll(() => {
  // A filtered run that drove no host has nothing to check.
  if (everyHost.length === 0) return;
  const sent = sentMethods();
  // Reached: the suite drove these at least.
  for (const method of ['initialize', 'initialized', 'turn/start'])
    expect(sent).toContain(method);
  const named = new Set([
    ...Object.keys(MUSE_SERVE_REQUIRED_SURFACE.methods),
    ...Object.keys(MUSE_SERVE_REQUIRED_SURFACE.notifications),
  ]);
  expect([...sent].filter((method) => !named.has(method))).toEqual([]);
});
