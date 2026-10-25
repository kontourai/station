import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { onTestFinished, test, vi } from 'vitest';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { createLogger } from '../../../utils/logger.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';
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
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(now);
  onTestFinished(() => {
    vi.useRealTimers();
  });
  installControl(h);
  const flow = await createReportFlow(h.f, 'input-intent', [
    { id: 'right' },
    { id: 'left' },
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
      maxSyncs: 1,
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
