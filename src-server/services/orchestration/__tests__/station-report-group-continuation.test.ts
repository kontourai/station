import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flowRunHead, loadRun, startRun } from '@kontourai/flow';
import { onTestFinished, test, vi } from 'vitest';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { reservedStationSessionRecipient } from '../../../runtime/conversation/reserved-station-turn.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';
import { StationReportGroupRuntime } from '../station-report-group-runtime.js';
import {
  installControl,
  NOW,
  requestFor,
  setup,
} from './delegation-source-fixtures/report.js';
import { controlledTextStream } from './delegation-source-fixtures/streamed-text.js';

test('returning report sync uses fresh SDK custody in the same actual Session and replays without resend', async () => {
  const h = await setup();
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  onTestFinished(() => {
    vi.useRealTimers();
  });
  installControl(h);
  const definition = join(h.f.repo, 'continuation.json');
  writeFileSync(
    definition,
    JSON.stringify({
      id: 'retained-report',
      version: '1',
      execution: { mode: 'multi-cursor', claim_contract_version: '1' },
      steps: [{ id: 'review', next: null, mutable_resources: [] }],
      gates: {
        review: {
          step: 'review',
          expects: [
            {
              id: 'external',
              kind: 'trust.bundle',
              required: true,
              description: 'A report is not accepted external evidence.',
              bundle_claim: {
                claimType: 'fixture.external',
                accepted_statuses: ['assumed'],
              },
            },
          ],
        },
      },
    }),
  );
  writeFileSync(join(h.f.repo, '.gitignore'), '.kontourai/\n');
  await h.f.git('add', 'continuation.json', '.gitignore');
  await h.f.git('commit', '-qm', 'real retained report continuation fixture');
  await startRun(definition, { cwd: h.f.repo, runId: 'retained-report-run' });
  const bus = new EventBus();
  const eventStore = new EventStore(join(h.f.root, 'continuation.sqlite'));
  const logger = { debug() {}, warn() {} };
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
  h.rawFetch.mockImplementation(async (_url, options) => {
    const wire = JSON.parse(String(options?.body));
    const prompt = JSON.parse(wire.messages[0].content[0].text);
    const text = Object.hasOwn(prompt, 'context')
      ? prompt.brief.split('Reply exactly ')[1]
      : 'Controlled initial report';
    return controlledTextStream('anthropic', 'claude-sonnet-4-6', text, {
      input_tokens: 4,
      output_tokens: 32,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });
  const owners = {
    runtime: h.preparationOwners.runtime,
    orchestration,
    rawFetch: h.rawFetch,
  };
  const runtime = new StationReportGroupRuntime(owners);
  const input = {
    ...h.input,
    deadlineAt: NOW + 240_000,
    maxConcurrent: 1,
    flow: { runId: 'retained-report-run', steps: { left: 'review' } },
    continuation: {
      attemptsPerMember: 3,
      maxRounds: 3,
      maxSyncs: 1,
      maxRenewals: 0,
      maxEvaluations: 2,
      maxRecoveries: 0,
    },
    budget: {
      inputTokens: 3 * 1_048_576,
      outputTokens: 3 * 256,
      costMicros: 3 * (1_048_576 * 3 + 256 * 15),
    },
    members: [{ ...h.input.members[0], maxOutputTokens: 256 }],
  };
  try {
    const initial = await runtime.create(h.f.context(), input);
    assert.equal(h.rawFetch.mock.calls.length, 1);
    const member = initial.group.members[0];
    assert.ok(member.attempts[0].terminal);
    const scope = {
      principalId: 'human:local:operator',
      environmentId: h.f.record.environmentId,
      threadId: member.taskId,
    };
    const original = reservedStationSessionRecipient(
      orchestration.captureReservedStationSession(member.taskId, {
        userId: scope.principalId,
      }),
      scope,
    );
    const before = await loadRun('retained-report-run', h.f.repo);
    assert.equal(before.state.status, 'blocked');
    const command = {
      operationKey: 'sync-findings',
      expectedRevision: initial.group.revision,
      seatId: member.seatId,
      flowHead: flowRunHead(before.state),
      text: 'Private corrected context for the existing reviewer.',
    };
    const returning = new StationReportGroupRuntime(owners);
    const result = await returning.sync(
      h.f.context(requestFor(h, 'POST')),
      initial.group.groupId,
      command,
    );
    assert.equal(result.replayed, false);
    assert.equal(h.rawFetch.mock.calls.length, 2);
    assert.equal(starts.mock.calls.length, 1);
    assert.equal(relay.mock.calls.length, 0);
    assert.deepEqual(
      reservedStationSessionRecipient(
        orchestration.captureReservedStationSession(member.taskId, {
          userId: scope.principalId,
        }),
        scope,
      ),
      original,
    );
    const turns = eventStore
      .listEvents(member.taskId)
      .filter((e) => e.payload.method === 'turn.completed');
    assert.equal(turns.length, 2);
    assert.notEqual(turns[0].payload.turnId, turns[1].payload.turnId);
    const replay = await returning.sync(
      h.f.context(requestFor(h, 'POST')),
      initial.group.groupId,
      command,
    );
    assert.equal(replay.replayed, true);
    assert.equal(h.rawFetch.mock.calls.length, 2);
    await assert.rejects(
      returning.sync(
        h.f.context(requestFor(h, 'POST')),
        initial.group.groupId,
        { ...command, text: 'Changed intent cannot replay.' },
      ),
    );
    assert.equal(h.rawFetch.mock.calls.length, 2);
  } finally {
    await orchestration.shutdown();
    eventStore.close();
  }
});
