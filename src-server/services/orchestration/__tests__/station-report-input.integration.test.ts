import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flowRunHead, flowTransitionRef, loadRun } from '@kontourai/flow';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import {
  continueReportGroupReport,
  createReportGroup,
  narrowReportGroupAfterInput,
  readReportGroupContextCheckpoint,
  readReportGroupEvents,
  readReportGroupResult,
  syncReportGroupAfterInput,
} from '@kontourai/station-sdk/client';
import { prepareFileMutationOwner } from '@kontourai/station-shared/lifecycle-events';
import { Hono } from 'hono';
import { onTestFinished, test, vi } from 'vitest';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { createReportGroupRoutes } from '../../../routes/orchestration/report-groups.js';
import { isRuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
import * as inputRuntimeOwner from '../../../runtime/mcp/report-input-runtime.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { createLogger } from '../../../utils/logger.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { HomeWriterOwner } from '../../ssh/home-writer-owner.js';
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
  NOW,
  requestFor,
  setup,
} from './delegation-source-fixtures/report.js';
import {
  controlledInputStream,
  controlledTextStream,
} from './delegation-source-fixtures/streamed-text.js';

function useAdvancingHistoricalClock(startAt: number) {
  const OriginalDate = Date;
  const started = performance.now();
  const now = () => startAt + Math.floor(performance.now() - started);
  vi.stubGlobal(
    'Date',
    new Proxy(OriginalDate, {
      construct(target, args, newTarget) {
        return Reflect.construct(
          target,
          args.length ? args : [now()],
          newTarget,
        );
      },
      apply() {
        return new OriginalDate(now()).toString();
      },
      get(target, key, receiver) {
        return key === 'now' ? now : Reflect.get(target, key, receiver);
      },
    }),
  );
}

function publicationFor(h: Awaited<ReturnType<typeof setup>>) {
  const runtime = new StationRuntime({ projectHomeDir: h.f.home });
  const participant = Reflect.get(runtime, 'runtimePublicationParticipant');
  assert.ok(isRuntimePublicationParticipant(participant));
  const abort = new AbortController();
  const operations: Promise<unknown>[] = [];
  const inputErrors: unknown[] = [];
  const createInput = inputRuntimeOwner.createReportInputRuntime;
  const inputObserver = vi
    .spyOn(inputRuntimeOwner, 'createReportInputRuntime')
    .mockImplementation((...args) => {
      const actual = createInput(...args);
      return Object.assign(
        (...input: Parameters<typeof actual>) => {
          const pending = actual(...input);
          void pending.catch((error: unknown) => {
            inputErrors.push(error);
          });
          return pending;
        },
        { close: () => actual.close() },
      );
    });

  onTestFinished(async () => {
    abort.abort();
    const failures: unknown[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled(operations),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(Error('Owned input operation did not settle after abort')),
            5000,
          );
        }),
      ]);
    } catch (error) {
      failures.push(error);
    } finally {
      if (timer) clearTimeout(timer);
      inputObserver.mockRestore();
    }
    try {
      await runtime.shutdown();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        'Input fixture cleanup is unconfirmed',
      );
  });
  return {
    participant,
    inputFailure: () => inputErrors[0],
    inputCreated: () => inputObserver.mock.calls.length,
    signal: abort.signal,
    track: (operation: Promise<unknown>) => {
      operations.push(operation);
    },
    context: () => {
      const request = new Request(h.f.req, { signal: abort.signal });
      const principal = getRuntimeAuthenticatedRequestPrincipal(h.f.req);
      assert.ok(principal);
      setRuntimeAuthenticatedRequestPrincipal(request, principal);
      bindRuntimeLocalOperator(request);
      return h.f.context(request);
    },
  };
}

test('funded three-seat mixed-model report serves input, member results and accounting through HTTP and SDK', async () => {
  const h = await setup('local-grant', NOW);
  vi.spyOn(Date, 'now').mockRestore();
  useAdvancingHistoricalClock(NOW);
  installControl(h);
  await h.f.storage.saveProviderConnection({
    id: 'google-1',
    name: 'Controlled Google',
    type: 'google',
    enabled: true,
    capabilities: ['llm'],
    config: {
      apiKey: 'synthetic-google-not-live',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    },
  });
  await h.f.loader.saveAgent('google-reviewer', {
    name: 'Google reviewer',
    prompt: 'Review source',
    execution: {
      modelConnectionId: 'google-1',
      modelId: 'gemini-2.5-flash-lite',
    },
  });
  const flow = await createReportFlow(h.f, 'input-mixed-journey', [
    { id: 'left' },
    { id: 'right' },
    { id: 'join', needs: ['left', 'right'] },
  ]);
  const bus = new EventBus();
  const eventStore = new EventStore(
    join(h.f.root, 'input-mixed-journey.sqlite'),
  );
  const logger = createLogger({
    name: 'report-input-mixed-fixture',
    level: 'error',
  });
  const relay = vi.fn<typeof fetch>(async () => {
    throw Error('unexpected relay');
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
  h.rawFetch.mockImplementation(async (url, init) => {
    if (String(url).startsWith('https://generativelanguage.googleapis.com/'))
      return controlledTextStream(
        'google',
        'gemini-2.5-flash-lite',
        'Google report',
        {
          promptTokenCount: 4,
          candidatesTokenCount: 2,
          thoughtsTokenCount: 0,
          totalTokenCount: 6,
          cachedContentTokenCount: 0,
          serviceTier: 'standard',
        },
      );
    return JSON.parse(String(init?.body)).tools
      ? controlledInputStream('claude-sonnet-4-6', 'Which scope?')
      : controlledTextStream(
          'anthropic',
          'claude-sonnet-4-6',
          'Anthropic report',
          {
            input_tokens: 4,
            output_tokens: 2,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        );
  });
  const operation = publicationFor(h);
  const publicationParticipant = operation.participant;
  const runtime = new StationReportGroupRuntime({
    runtime: h.preparationOwners.runtime,
    orchestration,
    rawFetch: h.rawFetch,
    publicationParticipant,
  });
  let runtimeFailure: unknown;
  const create = runtime.create.bind(runtime);
  const observeCreate = vi
    .spyOn(runtime, 'create')
    .mockImplementation(async (...args) => {
      try {
        return await create(...args);
      } catch (error) {
        runtimeFailure = error;
        throw error;
      }
    });
  onTestFinished(() => {
    observeCreate.mockRestore();
  });
  const principal = getRuntimeAuthenticatedRequestPrincipal(h.f.req);
  assert.ok(principal && principal.kind !== 'internal');
  const app = new Hono();
  app.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
      ...principal,
      credential: c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '',
    });
    if (c.req.header('X-Test-Operator') === 'yes')
      bindRuntimeLocalOperator(c.req.raw);
    await next();
  });
  app.route(
    '/api/orchestration/report-groups',
    createReportGroupRoutes(runtime),
  );
  const controlFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url, init) =>
      String(url).startsWith(
        'http://report-control.test/api/orchestration/report-groups',
      )
        ? app.fetch(new Request(url, init))
        : controlFetch(url, init),
    ),
  );
  const input = {
    ...h.input,
    flow,
    maxConcurrent: 2,
    members: [
      { ...h.input.members[0], input: 'operator-clarification-v1' as const },
      { ...h.input.members[1], agentId: 'google-reviewer' },
      { ...h.input.members[0], seatId: 'join', brief: 'Combine findings' },
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
      inputTokens: 12 * 1048576,
      outputTokens: 120,
      costMicros: 12 * 3145878,
    },
  };
  const options = {
    signal: operation.signal,
    credential: h.f.paired.credential,
    credentialOrigin: 'http://report-control.test',
    headers: { 'X-Test-Operator': 'yes' },
  };
  let failure: unknown;
  const running = createReportGroup(
    'http://report-control.test',
    input,
    options,
  ).catch((error: unknown) => {
    failure = new Error('report create failed at runtime boundary', {
      cause: runtimeFailure ?? error,
    });
    throw failure;
  });
  void running.catch(() => {});
  operation.track(running);
  let inputFailure: unknown;
  let opened:
    | Extract<
        ReturnType<EventStore['listEvents']>[number]['payload'],
        { method: 'request.opened' }
      >
    | undefined;
  await vi.waitFor(
    () => {
      if (failure) {
        inputFailure = failure;
        return;
      }
      const observed = starts.mock.calls.flatMap(([entry]) =>
        eventStore.listEvents(entry.threadId),
      );
      const rejected = observed.find(
        ({ payload }) => payload.method === 'runtime.error',
      )?.payload;
      if (rejected?.method === 'runtime.error') {
        inputFailure = Error(
          `Input runtime refused (${rejected.code ?? 'unclassified'}): ${rejected.message}`,
          { cause: operation.inputFailure() },
        );
        return;
      }
      const event = observed.find(
        ({ payload }) => payload.method === 'request.opened',
      )?.payload;
      if (event?.method !== 'request.opened')
        throw Error(
          `No canonical input: ${JSON.stringify({
            starts: starts.mock.calls.length,
            rawFetch: h.rawFetch.mock.calls.length,
            inputCreated: operation.inputCreated(),
            events: starts.mock.calls
              .flatMap(([entry]) => eventStore.listEvents(entry.threadId))
              .slice(-12)
              .map(({ payload }) => payload.method),
          })}`,
        );
      opened = event;
    },
    { timeout: 60000 },
  );
  if (inputFailure) throw inputFailure;
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
  assert.equal(result.replayed, false);
  assert.equal(result.group.members.length, 3);
  assert.deepEqual(
    new Set(result.group.members.map((member) => member.requestedModelId)),
    new Set(['claude-sonnet-4-6', 'gemini-2.5-flash-lite']),
  );
  assert.equal(h.rawFetch.mock.calls.length, 3);
  assert.equal(relay.mock.calls.length, 0);
  const events = await readReportGroupEvents(
    'http://report-control.test',
    result.group.groupId,
    0,
    options,
  );
  assert.ok(events.events.length > 0);
  let inputTokens = 0,
    outputTokens = 0,
    costMicros = 0;
  for (const member of result.group.members) {
    assert.ok(events.events.some((event) => event.seatId === member.seatId));
    assert.equal(member.attempts.length, 1);
    const attempt = member.attempts[0];
    assert.ok(attempt.usage && attempt.accountingTerminal);
    inputTokens += attempt.usage.inputTokens;
    outputTokens += attempt.usage.outputTokens;
    costMicros += attempt.usage.costMicros;
    const raw = await readReportGroupResult(
      'http://report-control.test',
      result.group.groupId,
      member.seatId,
      attempt.invocationId,
      0,
      options,
    );
    assert.equal(raw.kind, 'result');
    if (raw.kind === 'result')
      assert.equal(
        raw.text,
        member.seatId === 'right'
          ? 'Google report'
          : member.seatId === 'left'
            ? ''
            : 'Anthropic report',
      );
  }
  assert.deepEqual(result.group.accounting?.knownTerminalUsage, {
    inputTokens,
    outputTokens,
    costMicros,
  });
  assert.equal(result.group.accounting?.unsettledInvocations, 0);
  const replay = await createReportGroup(
    'http://report-control.test',
    input,
    options,
  );
  assert.equal(replay.replayed, true);
  assert.equal(h.rawFetch.mock.calls.length, 3);
}, 240000);

test('explicit report input crosses real Flow dispatch, canonical answer and retained accounting once', async () => {
  const h = await setup('local-grant', NOW);
  vi.spyOn(Date, 'now').mockRestore();
  useAdvancingHistoricalClock(NOW);
  installControl(h);
  const flow = await createReportFlow(h.f, 'input-intent', [
    { id: 'right', requiredEvidence: true },
    { id: 'left', requiredEvidence: true, routeBack: 'left' },
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
  const operation = publicationFor(h);
  const publicationParticipant = operation.participant;
  const runtime = new StationReportGroupRuntime({
    runtime: h.preparationOwners.runtime,
    orchestration,
    rawFetch: h.rawFetch,
    publicationParticipant,
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
    () =>
      runtime.create(operation.context(), {
        ...input,
        continuation: undefined,
      }),
    /report_input_continuation_required/,
  );
  let failure: unknown;
  let settled: Awaited<ReturnType<typeof runtime.create>> | undefined;
  const running = runtime
    .create(operation.context(), input)
    .then((value) => {
      settled = value;
      return value;
    })
    .catch((error: unknown) => {
      failure = error;
      return null;
    });
  operation.track(running);
  let inputFailure: unknown;
  let opened:
    | Extract<
        ReturnType<EventStore['listEvents']>[number]['payload'],
        { method: 'request.opened' }
      >
    | undefined;
  await vi.waitFor(
    () => {
      if (failure) {
        inputFailure = failure;
        return;
      }
      if (settled) {
        inputFailure = Error('Report returned before opening its question');
        return;
      }
      const observed = starts.mock.calls.flatMap(([entry]) =>
        eventStore.listEvents(entry.threadId),
      );
      const rejected = observed.find(
        ({ payload }) => payload.method === 'runtime.error',
      )?.payload;
      if (rejected?.method === 'runtime.error') {
        inputFailure = Error(
          `Input runtime refused (${rejected.code ?? 'unclassified'}): ${rejected.message}`,
          { cause: operation.inputFailure() },
        );
        return;
      }
      const event = observed.find(
        ({ payload }) => payload.method === 'request.opened',
      )?.payload;
      if (event?.method !== 'request.opened')
        throw Error(
          `No canonical input: ${JSON.stringify({
            starts: starts.mock.calls.length,
            rawFetch: h.rawFetch.mock.calls.length,
            inputCreated: operation.inputCreated(),
            events: starts.mock.calls
              .flatMap(([entry]) => eventStore.listEvents(entry.threadId))
              .slice(-12)
              .map(({ payload }) => payload.method),
          })}`,
        );
      opened = event;
    },
    { timeout: 60000 },
  );
  if (inputFailure) throw inputFailure;
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
  const replay = await runtime.create(operation.context(), input);
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
    signal: operation.signal,
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
  const writer = await HomeWriterOwner.forHome(h.f.home);
  const probe = await prepareFileMutationOwner(
    join(h.f.home, 'security', '.home-writer.mutation'),
  );
  onTestFinished(() => probe.close());
  const ownership: Array<{
    domain: 'group' | 'authority';
    phase: 'body' | 'return';
    physical: string;
    bound: boolean;
  }> = [];
  const retiredBindings: Array<() => void> = [];
  const observeOwnership = async (
    domain: 'group' | 'authority',
    phase: 'body' | 'return',
    scope: Parameters<StationDelegationPersistence['roundsStore']>[2],
  ) => {
    const attempt = probe.tryAcquire();
    if (attempt.kind === 'acquired') await attempt.lease.release();
    ownership.push({ domain, phase, physical: attempt.kind, bound: !!scope });
    if (scope) {
      scope.owner.runWithLease(scope.lease, () => undefined);
      retiredBindings.push(() =>
        scope.owner.runWithLease(scope.lease, () => undefined),
      );
    }
  };
  const authorityStore =
    StationDelegationPersistence.prototype.roundsAuthorityStore;
  const authorityObserver = vi
    .spyOn(StationDelegationPersistence.prototype, 'roundsAuthorityStore')
    .mockImplementation(function (this: StationDelegationPersistence, ...args) {
      const actual = authorityStore.apply(this, args);
      return {
        ...actual,
        transact: async (id, body) => {
          const result = await actual.transact(id, async (previous) => {
            const next = await body(previous);
            await observeOwnership('authority', 'body', args[2]);
            return next;
          });
          await observeOwnership('authority', 'return', args[2]);
          return result;
        },
      };
    });
  onTestFinished(() => authorityObserver.mockRestore());
  let loseAdoption = true;
  const rounds = StationDelegationPersistence.prototype.roundsStore;
  const lostAdoption = vi
    .spyOn(StationDelegationPersistence.prototype, 'roundsStore')
    .mockImplementation(function (this: StationDelegationPersistence, ...args) {
      const store = rounds.apply(this, args);
      return {
        transact: async (id, body) => {
          const result = await store.transact(id, async (previous) => {
            const next = await body(previous);
            await observeOwnership('group', 'body', args[2]);
            if (
              loseAdoption &&
              next.journal.events.at(-1)?.kind === 'grant_adopted'
            )
              throw Error('controlled lost adoption commit');
            return next;
          });
          await observeOwnership('group', 'return', args[2]);
          return result;
        },
      };
    });
  onTestFinished(() => lostAdoption.mockRestore());
  await assert.rejects(
    narrowReportGroupAfterInput(
      'http://127.0.0.1:43979',
      result.group.groupId,
      narrowCommand,
      options,
    ),
  );
  loseAdoption = false;
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
      publicationParticipant,
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
  authorityObserver.mockRestore();
  lostAdoption.mockRestore();
  for (const domain of ['group', 'authority'] as const)
    for (const phase of ['body', 'return'] as const)
      assert.ok(
        ownership.some(
          (entry) => entry.domain === domain && entry.phase === phase,
        ),
        `actual ${domain} store ${phase} was observed`,
      );
  assert.ok(
    ownership.every((entry) => entry.physical === 'busy'),
    `renewal and adoption must own Home through store return: ${JSON.stringify(ownership)}`,
  );
  assert.ok(
    ownership.every((entry) => entry.bound),
    'renewal and adoption stores must bind the exact Home lease',
  );
  for (const late of retiredBindings)
    assert.throws(late, {
      name: 'HomeWriterUnavailableError',
      reason: 'borrow-unavailable',
    });
  const released = probe.tryAcquire();
  assert.equal(released.kind, 'acquired');
  if (released.kind === 'acquired') await released.lease.release();
  writer.runSynchronous(() => undefined);
  const checkpoint = await readReportGroupContextCheckpoint(
    'http://127.0.0.1:43979',
    result.group.groupId,
    {
      seatId: member.seatId,
      expectedRevision: replayNarrowed.group.revision,
    },
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
  let reportContext: unknown;
  h.rawFetch.mockImplementation(async (_url, init) => {
    const wire = JSON.parse(String(init?.body));
    syncTools = wire.tools;
    const prompt = JSON.parse(wire.messages[0].content[0].text);
    const ack = prompt.brief.startsWith('Receive context only.');
    if (ack) syncContext = JSON.parse(prompt.context);
    else reportContext = prompt.context;
    return controlledTextStream(
      'anthropic',
      'claude-sonnet-4-6',
      ack ? prompt.brief.split('Reply exactly ')[1] : 'Answer-informed report',
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
  const currentRun = await loadRun(flow.runId, h.f.repo);
  const route = currentRun.state.transitions
    .filter((entry: { type?: string }) => entry.type === 'route_back')
    .at(-1);
  assert.ok(route);
  const reportCommand = {
    operationKey: 'answer-report',
    expectedRevision: synced.group.revision,
    seatId: member.seatId,
    flowHead: flowRunHead(currentRun.state),
    syncOperationKey: syncCommand.operationKey,
    previousInvocationId: member.attempts[0].invocationId,
    retryRef: flowTransitionRef(route),
  };
  await assert.rejects(() =>
    continueReportGroupReport(
      'http://127.0.0.1:43979',
      result.group.groupId,
      {
        ...reportCommand,
        retryRef: '0'.repeat(64),
      },
      options,
    ),
  );
  assert.equal(h.rawFetch.mock.calls.length, 3);
  const acknowledged = await persistence.readReportExecution(
    result.group.groupId,
    result.group.groupId,
    () => undefined,
  );
  const ackProof = acknowledged.group?.continuations
    .at(-1)
    ?.prepared?.terminalProofs.at(-1);
  assert.ok(ackProof);
  const ackTerminal = await persistence.readReportObservation(
    result.group.groupId,
    ackProof.invocationId,
    ackProof.reference,
    () => undefined,
  );
  assert.ok(ackTerminal.observation.kind === 'terminal');
  const ackEventId = ackTerminal.observation.eventId;
  const canonicalRead = orchestration.readSessionEventById.bind(orchestration);
  const missingAck = vi
    .spyOn(orchestration, 'readSessionEventById')
    .mockImplementation((threadId, eventId, authority) =>
      eventId === ackEventId
        ? null
        : canonicalRead(threadId, eventId, authority),
    );
  await assert.rejects(() =>
    continueReportGroupReport(
      'http://127.0.0.1:43979',
      result.group.groupId,
      reportCommand,
      options,
    ),
  );
  missingAck.mockRestore();
  assert.equal(h.rawFetch.mock.calls.length, 3);
  const reported = await continueReportGroupReport(
    'http://127.0.0.1:43979',
    result.group.groupId,
    reportCommand,
    options,
  );
  assert.deepEqual(JSON.parse(String(reportContext || 'null')), {
    question: 'Which scope?',
    answer: { answer: 'Current source only' },
  });
  assert.equal(h.rawFetch.mock.calls.length, 4);
  assert.equal(starts.mock.calls.length, 2);
  const reportAttempt = reported.group.members
    .find((entry) => entry.seatId === member.seatId)
    ?.attempts.at(-1);
  assert.ok(reportAttempt?.terminal);
  assert.equal(reported.invocationId, reportAttempt.invocationId);
  assert.equal(reported.operationKey, reportCommand.operationKey);
  assert.notEqual(reportAttempt.invocationId, member.attempts[0].invocationId);
  const read = await runtime.result(
    h.f.context(requestFor(h, 'GET')),
    result.group.groupId,
    member.seatId,
    reportAttempt.invocationId,
    0,
  );
  assert.equal(read.kind, 'result');
  if (read.kind === 'result') assert.equal(read.text, 'Answer-informed report');
  assert.equal(
    (
      await continueReportGroupReport(
        'http://127.0.0.1:43979',
        result.group.groupId,
        reportCommand,
        options,
      )
    ).replayed,
    true,
  );
  assert.equal(h.rawFetch.mock.calls.length, 4);
  const afterSync = await persistence.readReportExecution(
    result.group.groupId,
    result.group.groupId,
    () => undefined,
  );
  const previousAttempt = afterSync.group?.attempts.at(-1);
  assert.ok(previousAttempt?.terminal);
  const previousTerminal = await persistence.readReportObservation(
    result.group.groupId,
    previousAttempt.invocationId,
    previousAttempt.terminal,
    () => undefined,
  );
  assert.equal(previousTerminal.observation.kind, 'terminal');
  if (previousTerminal.observation.kind !== 'terminal')
    throw Error('terminal required');
  const missingEventId = previousTerminal.observation.eventId;
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
    reported.group.revision,
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
  assert.equal(h.rawFetch.mock.calls.length, 4);
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
  await orchestration.shutdown();
  const reopened = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore,
    logger,
  });
  onTestFinished(() => reopened.shutdown());
  assert.throws(() =>
    reopened.captureReservedStationSession(member.taskId, {
      userId: 'human:local:operator',
    }),
  );
  const historicalReader = new StationReportGroupRuntime({
    runtime: h.preparationOwners.runtime,
    orchestration: reopened,
    rawFetch: h.rawFetch,
    publicationParticipant,
  });
  const recovered = await historicalReader.result(
    h.f.context(requestFor(h, 'GET')),
    result.group.groupId,
    member.seatId,
    reportAttempt.invocationId,
    0,
  );
  assert.equal(recovered.kind, 'result');
  if (recovered.kind === 'result')
    assert.equal(recovered.text, 'Answer-informed report');
  assert.equal(h.rawFetch.mock.calls.length, 4);
  assert.equal(starts.mock.calls.length, 2);
}, 300000);
