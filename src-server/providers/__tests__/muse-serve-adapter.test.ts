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
  MUSE_APPROVAL_EXPIRED_CODE,
  MUSE_APPROVAL_MODE_NOT_APPLIED_CODE,
  MUSE_SERVE_HOST_EXITED_CODE,
  MUSE_SERVE_UNAVAILABLE_CODE,
  PROVIDER_TURN_IN_PROGRESS_CODE,
  unsupportedModelOptionKeys,
} from '@kontourai/station-contracts/provider';
import {
  type CanonicalRuntimeEvent,
  PROVIDER_TURN_TRIGGER,
} from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test } from 'vitest';
import { ProviderTurnInProgressError } from '../adapter-shape.js';
import {
  buildMuseServeArgs,
  MUSE_EXEC_CHILD_WORK_NOT_REPORTED_REASON,
  MuseAdapter,
  museServeEnvOverrides,
} from '../adapters/muse-adapter.js';
import { MUSE_CHILD_ALL_TOOLS_FAILED_PREFIX } from '../adapters/muse-serve-child-work.js';
import { museServeApprovalPlan } from '../adapters/muse-serve-session.js';
import {
  FakeMuseServeHost,
  loadMuseServeCapture,
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
}

const adapters: MuseAdapter[] = [];

afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stopAll();
});

function harness(
  options: {
    approvalTimeoutMs?: number;
    approvalEscalationMs?: number;
    spawnHost?: (args: string[], index: number) => FakeMuseServeHost;
    terminateHost?: (host: FakeMuseServeHost) => Promise<void>;
    onRelease?: (host: FakeMuseServeHost) => void;
    env?: NodeJS.ProcessEnv;
  } = {},
): Harness {
  const hosts: FakeMuseServeHost[] = [];
  const events: CanonicalRuntimeEvent[] = [];
  const execSpawns: string[][] = [];
  const adapter = new MuseAdapter({
    serve: {
      spawnHost: (posture) => {
        const args = buildMuseServeArgs(posture);
        const host =
          options.spawnHost?.(args, hosts.length) ??
          new FakeMuseServeHost(args, 5151 + hosts.length);
        hosts.push(host);
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
    },
    processFactory: (args) => {
      execSpawns.push(args);
      throw new Error('this test drives serve; exec must not spawn');
    },
    ...(options.env ? { env: options.env } : {}),
    logger: { warn: () => {}, info: () => {} },
  });
  adapters.push(adapter);
  void (async () => {
    for await (const event of adapter.streamEvents()) events.push(event);
  })();
  return { adapter, hosts, events, execSpawns };
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
          return h.adapter.sendTurn({ threadId: THREAD, input: 'go' });
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

  test('approvalMode is a muse model option the dispatcher admits', () => {
    expect(unsupportedModelOptionKeys('muse', { approvalMode: 'ask' })).toEqual(
      [],
    );
    expect(unsupportedModelOptionKeys('muse', { effort: 'high' })).toEqual([
      'effort',
    ]);
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
    const resolved = of(h.events, 'request.resolved');
    expect(resolved).toEqual([
      expect.objectContaining({
        requestId: APPROVAL,
        status: 'approved',
        response: { decision: 'approved', resolvedBy: 'user' },
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
          // The launching turn had already ended.
          backgrounded: true,
          controls: { stop: 'provider-task-stop' },
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
      },
    });
  });

  test("deny: a child whose every tool was denied stays completed (muse's verdict) but never reads as a clean success", async () => {
    const h = harness();
    await run(h, 'workflow-child-deny', {
      approvalMode: 'ask',
      decide: 'decline',
    });
    const [child] = childWorkForReporter(fold(h.events), THREAD);
    expect(child.status).toBe('completed');
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
    expect(of(h.events, 'request.resolved')).toEqual([]);
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
    expect(of(h.events, 'request.resolved')).toEqual([
      expect.objectContaining({
        requestId: APPROVAL,
        status: 'cancelled',
        response: { reason: 'subject-changed' },
      }),
    ]);
    const opened = of(h.events, 'request.opened');
    expect(opened).toHaveLength(2);
    expect(opened[1].requestId).not.toBe(APPROVAL);
    expect(opened[1].payload?.command).toBe('rm -rf ./stamp.txt');
  });
});

describe('#2452 fix round: host ownership and data home', () => {
  test('R5: a host Station could not confirm stopped keeps its ownership record until it exits', async () => {
    const released: FakeMuseServeHost[] = [];
    const h = harness({
      terminateHost: async () => {
        throw new Error('Process tree did not confirm exit after SIGKILL.');
      },
      onRelease: (host) => released.push(host),
    });
    const host = await upToFirstDecide(h);
    await expect(h.adapter.stopSession(THREAD)).rejects.toThrow(
      'could not confirm',
    );
    // stdin was closed, but the fake exits only when told to.
    expect(released).toEqual([]);
    host.exit(0);
    await settle();
    expect(released).toEqual([host]);
  });

  test("R6: production passes no data home, so the host uses the user's own; an override is explicit", () => {
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
