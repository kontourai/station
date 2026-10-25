import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import {
  narrowReportGroupAfterInput,
  readReportGroupContextCheckpoint,
  syncReportGroupAfterInput,
} from '@kontourai/station-sdk/client';
import { Hono } from 'hono';
import { onTestFinished, test, vi } from 'vitest';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { createReportGroupRoutes } from '../../../routes/orchestration/report-groups.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { createLogger } from '../../../utils/logger.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';
import { reportAdmissionSignature } from '../station-report-group-admission.js';
import { StationReportGroupCustody } from '../station-report-group-custody.js';
import { StationReportGroupRuntime } from '../station-report-group-runtime.js';
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import {
  installControl,
  requestFor,
  setup,
} from './delegation-source-fixtures/report.js';
import {
  controlledInputStream,
  controlledTextStream,
} from './delegation-source-fixtures/streamed-text.js';

test('explicit report input crosses real Flow dispatch, canonical answer and retained accounting once', async () => {
  const now = Date.parse('2026-10-25T20:10:14Z');
  const h = await setup('local-grant', now);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  onTestFinished(() => {
    vi.useRealTimers();
  });
  installControl(h);
  const flow = await createReportFlow(h.f, 'input-intent', [
    { id: 'right', requiredEvidence: true },
    { id: 'left', requiredEvidence: true },
  ]);
  const bus = new EventBus();
  const eventStore = new EventStore(join(h.f.root, 'input.sqlite'));
  const logger = createLogger({
    name: 'report-input-integration',
    level: 'error',
  });
  const relay = vi.fn<typeof fetch>(async () => {
    throw Error('reserved request must not relay');
  });
  const adapter = new StationAgentAdapter({
    apiBase: 'http://report-control.test',
    hasAgent: () => true,
    eventBus: bus,
    approvalRegistry: new ApprovalRegistry(logger, { eventBus: bus }),
    fetch: relay,
  });
  const starts = vi.spyOn(adapter, 'startSession');
  const orchestration = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: bus,
    eventStore,
    logger,
    resolveSessionAgent: createSessionAgentResolver({
      loadAgentSpec: (slug) => h.f.loader.loadAgent(slug),
      resolveToolServer: async () => null,
      resolveSkillDir: async () => null,
    }),
  });
  onTestFinished(async () => {
    await orchestration.shutdown();
    eventStore.close();
  });
  h.rawFetch.mockImplementation(async (_url, init) =>
    JSON.parse(String(init?.body)).tools
      ? controlledInputStream('claude-sonnet-4-6', 'Which scope?')
      : controlledTextStream('anthropic', 'claude-sonnet-4-6', 'Plain report', {
          input_tokens: 4,
          output_tokens: 2,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }),
  );
  const runtime = new StationReportGroupRuntime({
    runtime: h.preparationOwners.runtime,
    orchestration,
    rawFetch: h.rawFetch,
  });
  const input = {
    ...h.input,
    maxConcurrent: 2,
    flow,
    members: [
      h.input.members[1],
      { ...h.input.members[0], input: 'operator-clarification-v1' as const },
    ],
    continuation: {
      attemptsPerMember: 4,
      maxRounds: 4,
      maxSyncs: 2,
      maxRenewals: 1,
      maxEvaluations: 2,
      maxRecoveries: 1,
    },
    budget: {
      inputTokens: 8 * 1048576,
      outputTokens: 80,
      costMicros: 8 * 3145878,
    },
  };
  await assert.rejects(
    () => runtime.create(h.f.context(), { ...input, continuation: undefined }),
    /report_input_continuation_required/,
  );
  let failure: unknown;
  let settled: Awaited<ReturnType<typeof runtime.create>> | undefined;
  const running = runtime
    .create(h.f.context(), input)
    .then((value) => {
      settled = value;
      return value;
    })
    .catch((error: unknown) => {
      failure = error;
      return null;
    });
  let opened:
    | Extract<
        ReturnType<EventStore['listEvents']>[number]['payload'],
        { method: 'request.opened' }
      >
    | undefined;
  await vi.waitFor(
    () => {
      if (failure) throw failure;
      if (settled) throw Error('Report returned before opening its question');
      const event = starts.mock.calls
        .flatMap(([input]) => eventStore.listEvents(input.threadId))
        .find(({ payload }) => payload.method === 'request.opened')?.payload;
      if (event?.method !== 'request.opened') throw Error('No canonical input');
      opened = event;
    },
    { timeout: 60000 },
  );
  assert.ok(opened);
  await orchestration.dispatch({
    type: 'respondToRequest',
    threadId: opened.threadId,
    requestId: opened.requestId,
    expectedRequestEventId: opened.eventId,
    decision: 'accept',
    content: { answer: 'Current source only' },
  });
  const result = await running;
  assert.equal(failure, undefined);
  assert.ok(result);
  const member = result.group.members.find(
    (member) => member.seatId === 'left',
  );
  assert.ok(member);
  const attempt = member.attempts[0];
  assert.ok(attempt.observation);
  const persistence = new StationDelegationPersistence(
    join(h.f.loader.getProjectHomeDir(), 'report-groups'),
  );
  const admission = await persistence.readReportAdmission(
    result.group.groupId,
    () => undefined,
  );
  assert.ok(admission);
  assert.deepEqual(
    admission.data.envelopes.find(
      (envelope) => envelope.selected_grant_id === 'left' && envelope.parent,
    )?.execution_authority.allowed_tools,
    ['station_request_input'],
  );
  assert.deepEqual(
    admission.data.envelopes.find(
      (envelope) => envelope.selected_grant_id === 'right' && envelope.parent,
    )?.execution_authority.allowed_tools,
    [],
  );
  const observation = await persistence.readReportObservation(
    result.group.groupId,
    attempt.invocationId,
    attempt.observation,
    () => undefined,
  );
  assert.equal(observation.observation.kind, 'result');
  if (observation.observation.kind !== 'result')
    throw Error('No retained result');
  assert.ok(observation.observation.inputReceipt);
  const receipt = await persistence.readReportInputReceipt(
    observation.observation.inputReceipt,
    {
      groupId: result.group.groupId,
      invocationId: attempt.invocationId,
      seatId: 'left',
      threadId: opened.threadId,
      turnId: opened.turnId,
    },
    () => undefined,
  );
  assert.deepEqual(receipt.response, {
    action: 'accept',
    content: { answer: 'Current source only' },
  });
  assert.equal(h.rawFetch.mock.calls.length, 2);
  assert.equal(relay.mock.calls.length, 0);
  assert.equal(starts.mock.calls.length, 2);
  const publicResult = await runtime.result(
    h.f.context(requestFor(h)),
    result.group.groupId,
    member.seatId,
    attempt.invocationId,
    0,
  );
  assert.ok(!JSON.stringify(publicResult).includes('Current source only'));
  assert.ok(!('inputReceipt' in publicResult));
  const replay = await runtime.create(h.f.context(), input);
  assert.equal(replay.replayed, true);
  assert.equal(h.rawFetch.mock.calls.length, 2);
  assert.equal(starts.mock.calls.length, 2);
  const narrowCommand = {
    operationKey: 'finish-input',
    seatId: 'left',
    expectedRevision: result.group.revision,
  };
  await assert.rejects(
    runtime.narrowAfterInput(
      h.f.context(requestFor(h, 'POST')),
      result.group.groupId,
      { ...narrowCommand, seatId: 'right' },
    ),
  );
  await assert.rejects(
    runtime.narrowAfterInput(
      h.f.context(requestFor(h, 'POST')),
      result.group.groupId,
      { ...narrowCommand, expectedRevision: result.group.revision + 1 },
    ),
  );
  const canonical = vi
    .spyOn(orchestration, 'readSessionEventById')
    .mockReturnValue(null);
  await assert.rejects(
    runtime.narrowAfterInput(
      h.f.context(requestFor(h, 'POST')),
      result.group.groupId,
      narrowCommand,
    ),
  );
  canonical.mockRestore();
  const admissionFile = join(
    h.f.loader.getProjectHomeDir(),
    'report-groups',
    'station-report-admissions-v1',
    `${createHash('sha256').update(result.group.groupId).digest('hex')}.json`,
  );
  const admissionBytes = readFileSync(admissionFile);
  const legacy = structuredClone(admission);
  for (const entry of legacy.data.members) delete entry.runtimeIdentity;
  legacy.signature = reportAdmissionSignature(legacy.data, h.f.environment);
  writeFileSync(admissionFile, JSON.stringify(legacy));
  try {
    assert.equal(
      (await runtime.get(h.f.context(requestFor(h)), result.group.groupId))
        ?.groupId,
      result.group.groupId,
    );
    await assert.rejects(
      runtime.narrowAfterInput(
        h.f.context(requestFor(h, 'POST')),
        result.group.groupId,
        narrowCommand,
      ),
    );
    assert.equal(h.rawFetch.mock.calls.length, 2);
  } finally {
    writeFileSync(admissionFile, admissionBytes);
  }
  const originalAgent = await h.f.loader.loadAgent('reviewer');
  await h.f.loader.saveAgent('reviewer', {
    ...originalAgent,
    prompt: 'Changed instructions after initial admission',
  });
  try {
    await assert.rejects(
      runtime.narrowAfterInput(
        h.f.context(requestFor(h, 'POST')),
        result.group.groupId,
        narrowCommand,
      ),
    );
    assert.equal(h.rawFetch.mock.calls.length, 2);
    assert.equal(
      (
        await persistence.readReportExecution(
          result.group.groupId,
          result.group.groupId,
          () => undefined,
        )
      ).authority?.epochs.length,
      1,
    );
  } finally {
    await h.f.loader.saveAgent('reviewer', originalAgent);
  }
  const beforeNarrow = await persistence.readReportExecution(
    result.group.groupId,
    result.group.groupId,
    () => undefined,
  );
  const principal = getRuntimeAuthenticatedRequestPrincipal(h.f.req);
  assert.ok(principal && principal.kind !== 'internal');
  const createApp = (owner: StationReportGroupRuntime) => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        ...principal,
        credential:
          c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '',
      });
      if (c.req.header('X-Test-Operator') === 'yes')
        bindRuntimeLocalOperator(c.req.raw);
      await next();
    });
    app.route(
      '/api/orchestration/report-groups',
      createReportGroupRoutes(owner),
    );
    return app;
  };
  let app = createApp(runtime);
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url, init) => app.fetch(new Request(url, init))),
  );
  const options = {
    credential: h.f.paired.credential,
    credentialOrigin: 'http://127.0.0.1:43979',
    headers: { 'X-Test-Operator': 'yes' },
  };
  await assert.rejects(
    narrowReportGroupAfterInput(
      'http://127.0.0.1:43979',
      result.group.groupId,
      narrowCommand,
      {
        credential: 'invalid',
        credentialOrigin: 'http://127.0.0.1:43979',
        headers: { 'X-Test-Operator': 'yes' },
      },
    ),
  );
  assert.equal(h.rawFetch.mock.calls.length, 2);
  const rounds = StationDelegationPersistence.prototype.roundsStore;
  const lostAdoption = vi
    .spyOn(StationDelegationPersistence.prototype, 'roundsStore')
    .mockImplementation(function (this: StationDelegationPersistence, current) {
      const store = rounds.call(this, current);
      return {
        transact: (id, body) =>
          store.transact(id, async (previous) => {
            const next = await body(previous);
            if (next.journal.events.at(-1)?.kind === 'grant_adopted')
              throw Error('controlled lost adoption commit');
            return next;
          }),
      };
    });
  await assert.rejects(
    narrowReportGroupAfterInput(
      'http://127.0.0.1:43979',
      result.group.groupId,
      narrowCommand,
      options,
    ),
  );
  lostAdoption.mockRestore();
  const held = await persistence.readReportExecution(
    result.group.groupId,
    result.group.groupId,
    () => undefined,
  );
  assert.equal(held.authority?.epochs.length, 2);
  assert.equal(held.group?.grants.authority.authority_epoch, 1);
  assert.equal(h.rawFetch.mock.calls.length, 2);
  app = createApp(
    new StationReportGroupRuntime({
      runtime: h.preparationOwners.runtime,
      orchestration,
      rawFetch: h.rawFetch,
    }),
  );
  const load = StationReportGroupCustody.prototype.loadIntentForMutation;
  let arrived = 0;
  let release!: () => void;
  const bothLoaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  const concurrent = vi
    .spyOn(StationReportGroupCustody.prototype, 'loadIntentForMutation')
    .mockImplementation(async function (
      this: StationReportGroupCustody,
      ...args
    ) {
      const result = await load.apply(this, args);
      if (++arrived === 2) release();
      await bothLoaded;
      return result;
    });
  const [narrowed, concurrentNarrowed] = await Promise.all(
    [0, 1].map(() =>
      narrowReportGroupAfterInput(
        'http://127.0.0.1:43979',
        result.group.groupId,
        narrowCommand,
        options,
      ),
    ),
  );
  concurrent.mockRestore();
  assert.equal(arrived, 2);
  assert.equal(concurrentNarrowed.replayed, true);
  assert.equal(narrowed.replayed, true);
  const execution = await persistence.readReportExecution(
    result.group.groupId,
    result.group.groupId,
    () => undefined,
  );
  assert.ok(execution.authority);
  assert.equal(execution.authority.epochs.length, 2);
  assert.equal(
    execution.authority.epochs[1].renewal?.command.schemaVersion,
    '3.1',
  );
  const priorEnvelope = admission.data.envelopes.find(
    (entry) => entry.execution_id === member.taskId,
  );
  const nextEnvelope = execution.authority.epochs[1].envelopes.find(
    (entry) => entry.execution_id === member.taskId,
  );
  assert.ok(priorEnvelope && nextEnvelope);
  assert.deepEqual(nextEnvelope.execution_authority, {
    ...priorEnvelope.execution_authority,
    allowed_tools: [],
  });
  assert.deepEqual(
    execution.authority.epochs[1].root.execution_grants.map(
      ({ authority_ceiling }) => authority_ceiling,
    ),
    admission.data.root.execution_grants.map(
      ({ authority_ceiling }) => authority_ceiling,
    ),
  );

  assert.deepEqual(execution.authority.epochs[0].root, admission.data.root);
  assert.deepEqual(
    execution.authority.epochs[1].root.delegation_ceiling,
    admission.data.root.delegation_ceiling,
  );
  assert.deepEqual(
    execution.authority.epochs[1].root.budget,
    admission.data.root.budget,
  );
  assert.deepEqual(
    execution.authority.invocations,
    beforeNarrow.authority?.invocations,
  );
  assert.deepEqual(
    execution.authority.epochs[1].envelopes.find(
      (entry) => entry.execution_id === member.taskId,
    )?.execution_authority.allowed_tools,
    [],
  );
  assert.equal(execution.group?.grants.renewals, 1);
  assert.equal(execution.group?.grants.authority.authority_epoch, 2);
  assert.equal(h.rawFetch.mock.calls.length, 2);
  assert.equal(starts.mock.calls.length, 2);
  assert.ok(!JSON.stringify(narrowed).includes('Current source only'));
  const replayNarrowed = await narrowReportGroupAfterInput(
    'http://127.0.0.1:43979',
    result.group.groupId,
    narrowCommand,
    options,
  );
  assert.equal(replayNarrowed.replayed, true);
  assert.equal(h.rawFetch.mock.calls.length, 2);
  assert.equal(
    (
      await persistence.readReportExecution(
        result.group.groupId,
        result.group.groupId,
        () => undefined,
      )
    ).authority?.epochs.length,
    2,
  );
  const checkpoint = await readReportGroupContextCheckpoint(
    'http://127.0.0.1:43979',
    result.group.groupId,
    { seatId: member.seatId, expectedRevision: replayNarrowed.group.revision },
    options,
  );
  const syncCommand = {
    operationKey: 'answer-sync',
    seatId: member.seatId,
    expectedRevision: checkpoint.revision,
    flowHead: checkpoint.flowHead,
    renewalOperationKey: narrowCommand.operationKey,
  };
  await assert.rejects(() =>
    syncReportGroupAfterInput(
      'http://127.0.0.1:43979',
      result.group.groupId,
      { ...syncCommand, renewalOperationKey: 'foreign-renewal' },
      options,
    ),
  );
  assert.equal(h.rawFetch.mock.calls.length, 2);
  let syncContext: unknown;
  let syncTools: unknown;
  h.rawFetch.mockImplementation(async (_url, init) => {
    const wire = JSON.parse(String(init?.body));
    syncTools = wire.tools;
    const prompt = JSON.parse(wire.messages[0].content[0].text);
    syncContext = JSON.parse(prompt.context);
    return controlledTextStream(
      'anthropic',
      'claude-sonnet-4-6',
      prompt.brief.split('Reply exactly ')[1],
      {
        input_tokens: 4,
        output_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    );
  });
  const synced = await syncReportGroupAfterInput(
    'http://127.0.0.1:43979',
    result.group.groupId,
    syncCommand,
    options,
  );
  assert.deepEqual(syncContext, {
    question: 'Which scope?',
    answer: { answer: 'Current source only' },
  });
  assert.deepEqual(syncTools ?? [], []);
  assert.equal(synced.group.contextSyncs?.at(-1)?.state, 'acknowledged');
  assert.equal(h.rawFetch.mock.calls.length, 3);
  assert.equal(starts.mock.calls.length, 2);
  assert.ok(!JSON.stringify(synced).includes('Current source only'));
  const replaySync = await syncReportGroupAfterInput(
    'http://127.0.0.1:43979',
    result.group.groupId,
    syncCommand,
    options,
  );
  assert.equal(replaySync.replayed, true);
  assert.equal(h.rawFetch.mock.calls.length, 3);
  const afterSync = await persistence.readReportExecution(
    result.group.groupId,
    result.group.groupId,
    () => undefined,
  );
  const syncPrepared = afterSync.group?.continuations.at(-1)?.prepared;
  const ackInvocation = syncPrepared?.invocations.at(-1);
  const ackProof = syncPrepared?.terminalProofs.find(
    (proof) => proof.invocationId === ackInvocation?.invocationId,
  );
  assert.ok(ackInvocation && ackProof);
  const ackTerminal = await persistence.readReportObservation(
    result.group.groupId,
    ackInvocation.invocationId,
    ackProof.reference,
    () => undefined,
  );
  assert.equal(ackTerminal.observation.kind, 'terminal');
  if (ackTerminal.observation.kind !== 'terminal')
    throw Error('terminal required');
  const missingEventId = ackTerminal.observation.eventId;
  const readEvent = orchestration.readSessionEventById.bind(orchestration);
  const missingTerminal = vi
    .spyOn(orchestration, 'readSessionEventById')
    .mockImplementation((threadId, eventId, authority) =>
      eventId === missingEventId
        ? null
        : readEvent(threadId, eventId, authority),
    );
  const nextCheckpoint = await runtime.checkpoint(
    h.f.context(requestFor(h, 'POST')),
    result.group.groupId,
    member.seatId,
    synced.group.revision,
  );
  await assert.rejects(() =>
    runtime.syncAfterInput(
      h.f.context(requestFor(h, 'POST')),
      result.group.groupId,
      {
        ...syncCommand,
        operationKey: 'missing-terminal-sync',
        expectedRevision: nextCheckpoint.revision,
        flowHead: nextCheckpoint.flowHead,
      },
    ),
  );
  missingTerminal.mockRestore();
  assert.equal(h.rawFetch.mock.calls.length, 3);
  const terminalHold = await persistence.readReportExecution(
    result.group.groupId,
    result.group.groupId,
    () => undefined,
  );
  assert.equal(
    terminalHold.authority?.invocations.length,
    afterSync.authority!.invocations.length + 1,
  );
  assert.equal(terminalHold.authority?.invocations.at(-1)?.usage, null);
  assert.equal(terminalHold.authority?.invocations.at(-1)?.terminal, false);
  const window = await orchestration.readSessionEventWindow(opened.threadId, {
    turnLimit: 20,
    authority: sessionReadAuthorityFromRequest(
      'human:local:operator',
      undefined,
      undefined,
    ),
  });
  assert.ok(
    window?.events.some(({ event }) => event.method === 'turn.completed'),
  );
}, 120000);
