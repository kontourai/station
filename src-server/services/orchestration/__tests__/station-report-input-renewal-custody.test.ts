import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DelegationRoundsTransactionUncertainError } from '@kontourai/flow-agents/delegation-group-rounds';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import {
  createReportGroup,
  narrowReportGroupAfterInput,
} from '@kontourai/station-sdk/client';
import { prepareFileMutationOwner } from '@kontourai/station-shared/lifecycle-events';
import { Hono } from 'hono';
import { onTestFinished, test, vi } from 'vitest';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { createReportGroupRoutes } from '../../../routes/orchestration/report-groups.js';
import { isRuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { createLogger } from '../../../utils/logger.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { HomeWriterOwner } from '../../ssh/home-writer-owner.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import * as sourceWireOwner from '../delegation-group-sdk-source-wire-owner.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';
import { StationReportGroupRuntime } from '../station-report-group-runtime.js';
import { StationReportRetainedTurns } from '../station-report-retained-turn.js';
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import {
  installControl,
  NOW,
  setup,
} from './delegation-source-fixtures/report.js';
import { useAdvancingHistoricalClock } from './delegation-source-fixtures/report-clock.js';
import { controlledInputStream } from './delegation-source-fixtures/streamed-text.js';

test.each([
  'owned-commit',
  'held-home',
  'candidate-close-failed',
  'lost-adoption',
  'shutdown-preparing',
  'revoked-after-renew',
] as const)(
  'input renewal keeps real caller custody: %s',
  async (scenario) => {
    const h = await setup('local-grant', NOW);
    vi.spyOn(Date, 'now').mockRestore();
    useAdvancingHistoricalClock(NOW);
    installControl(h);
    const flow = await createReportFlow(h.f, `renewal-${scenario}`, [
      { id: 'left', requiredEvidence: true, routeBack: 'left' },
    ]);
    const bus = new EventBus();
    const eventStore = new EventStore(join(h.f.root, 'renewal-home.sqlite'));
    const logger = createLogger({
      name: 'renewal-home-fixture',
      level: 'error',
    });
    const relay = vi.fn<typeof fetch>(async () => {
      throw Error('unexpected relay');
    });
    const adapter = new StationAgentAdapter({
      apiBase: 'http://renewal-control.test',
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
    h.rawFetch.mockImplementation(async () =>
      controlledInputStream('claude-sonnet-4-6', 'Which scope?'),
    );
    const ownerRuntime = new StationRuntime({ projectHomeDir: h.f.home });
    const participant = Reflect.get(
      ownerRuntime,
      'runtimePublicationParticipant',
    );
    assert.ok(isRuntimePublicationParticipant(participant));
    const runtime = new StationReportGroupRuntime({
      runtime: h.preparationOwners.runtime,
      orchestration,
      rawFetch: h.rawFetch,
      publicationParticipant: participant,
    });
    let createFailure: unknown;
    const create = runtime.create.bind(runtime);
    const observeCreate = vi
      .spyOn(runtime, 'create')
      .mockImplementation(async (...args) => {
        try {
          return await create(...args);
        } catch (error) {
          createFailure = error;
          throw error;
        }
      });
    onTestFinished(() => observeCreate.mockRestore());
    const principal = getRuntimeAuthenticatedRequestPrincipal(h.f.req);
    assert.ok(principal && principal.kind !== 'internal');
    const abort = new AbortController();
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
      createReportGroupRoutes(runtime),
    );
    const controlFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        return url.startsWith(
          'http://renewal-control.test/api/orchestration/report-groups',
        )
          ? app.fetch(new Request(input, init))
          : controlFetch(input, init);
      }),
    );
    const options = {
      signal: abort.signal,
      credential: h.f.paired.credential,
      credentialOrigin: 'http://renewal-control.test',
      headers: { 'X-Test-Operator': 'yes' },
    };
    const writer = await HomeWriterOwner.forHome(h.f.home);
    const probe = await prepareFileMutationOwner(
      join(h.f.home, 'security', '.home-writer.mutation'),
    );
    let held: Awaited<ReturnType<typeof writer.acquire>> | undefined;
    let resumeCandidate = () => {};
    let cleanupAllowed = false;
    const pending: Promise<unknown>[] = [];
    let stop = () => {};
    onTestFinished(async () => {
      cleanupAllowed = true;
      abort.abort('renewal fixture cleanup');
      resumeCandidate();
      stop();
      const failures: unknown[] = [];
      try {
        await held?.release();
      } catch (error) {
        failures.push(error);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(pending),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error('renewal fixture did not settle after abort')),
              5000,
            );
          }),
        ]);
      } catch (error) {
        failures.push(error);
      } finally {
        if (timer) clearTimeout(timer);
      }
      try {
        await orchestration.shutdown();
      } catch (error) {
        failures.push(error);
      }
      try {
        await ownerRuntime.shutdown();
      } catch (error) {
        failures.push(error);
      }
      try {
        await probe.close();
      } catch (error) {
        failures.push(error);
      }
      eventStore.close();
      if (failures.length)
        throw new AggregateError(
          failures,
          'renewal fixture cleanup unconfirmed',
        );
    });
    type Opened = Extract<
      ReturnType<EventStore['listEvents']>[number]['payload'],
      { method: 'request.opened' }
    >;
    const question = new Promise<Opened>((resolve, reject) => {
      stop = bus.subscribe(({ event }) => {
        if (event !== SERVER_EVENTS.ORCHESTRATION_EVENT) return;
        const thread = starts.mock.calls[0]?.[0].threadId;
        if (!thread) return;
        const events = eventStore.listEvents(thread);
        const opened = events.find(
          ({ payload }) => payload.method === 'request.opened',
        )?.payload;
        if (opened?.method === 'request.opened') {
          stop();
          resolve(opened);
        }
        const failure = events.find(
          ({ payload }) => payload.method === 'runtime.error',
        );
        if (failure) {
          stop();
          reject(Error('renewal input turn refused before question'));
        }
      });
    });
    void question.catch(() => {});
    const input = {
      ...h.input,
      operationId: `renewal-${scenario}`,
      maxConcurrent: 1,
      flow,
      members: [
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
    const creating = createReportGroup(
      'http://renewal-control.test',
      input,
      options,
    ).catch((error: unknown) => {
      throw new Error('renewal fixture create failed', {
        cause: createFailure ?? error,
      });
    });
    void creating.catch(() => {});
    pending.push(creating);
    const opened = await Promise.race([
      question,
      creating.then(() => {
        throw Error('report returned without canonical question');
      }),
    ]);
    await orchestration.dispatch({
      type: 'respondToRequest',
      threadId: opened.threadId,
      requestId: opened.requestId,
      expectedRequestEventId: opened.eventId,
      decision: 'accept',
      content: { answer: 'Current source only' },
    });
    const created = await creating;
    assert.equal(created.group.members.length, 1);
    assert.equal(h.rawFetch.mock.calls.length, 1);
    const observed: Array<{
      domain: string;
      phase: string;
      physical: string;
      bound: boolean;
    }> = [];
    const late: Array<() => void> = [];
    const observe = async (
      domain: string,
      phase: string,
      scope: Parameters<StationDelegationPersistence['roundsStore']>[2],
    ) => {
      const attempt = probe.tryAcquire();
      if (attempt.kind === 'acquired') await attempt.lease.release();
      observed.push({ domain, phase, physical: attempt.kind, bound: !!scope });
      if (scope) {
        scope.owner.runWithLease(scope.lease, () => undefined);
        late.push(() => scope.owner.runWithLease(scope.lease, () => undefined));
      }
    };
    let revocationApplied = false;
    const authorityFactory =
      StationDelegationPersistence.prototype.roundsAuthorityStore;
    const authority = vi
      .spyOn(StationDelegationPersistence.prototype, 'roundsAuthorityStore')
      .mockImplementation(function (
        this: StationDelegationPersistence,
        ...args
      ) {
        const store = authorityFactory.apply(this, args);
        return {
          transact: async (id, body) => {
            let renewed = false;
            const result = await store.transact(id, async (previous) => {
              const epochs = previous?.epochs.length ?? 0;
              const next = await body(previous);
              renewed = next.ledger.epochs.length > epochs;
              await observe('authority', 'body', args[2]);
              return next;
            });
            await observe('authority', 'return', args[2]);
            if (scenario === 'revoked-after-renew' && renewed) {
              const scope = args[2];
              assert.ok(scope);
              scope.owner.runWithLease(scope.lease, () => {
                assert.equal(
                  h.f.environment.devicePairing.verifyCredential(h.f.paired.credential),
                  true,
                );
                h.f.environment.devicePairing.revokeDevice(
                  h.f.paired.device.id,
                  'operator-credential',
                );
                revocationApplied = true;
              });
            }
            return result;
          },
        };
      });
    let adoptionFaultApplied = false;
    let loseAdoption = scenario === 'lost-adoption';
    const groupFactory = StationDelegationPersistence.prototype.roundsStore;
    const group = vi
      .spyOn(StationDelegationPersistence.prototype, 'roundsStore')
      .mockImplementation(function (
        this: StationDelegationPersistence,
        ...args
      ) {
        const store = groupFactory.apply(this, args);
        return {
          transact: async (id, body) => {
            const result = await store.transact(id, async (previous) => {
              const previousRevision = previous?.events.length ?? 0;
              const next = await body(previous);
              await observe('group', 'body', args[2]);
              const adoption = next.journal.events.at(-1);
              if (
                loseAdoption &&
                next.journal.events.length > previousRevision &&
                adoption?.kind === 'grant_adopted' &&
                adoption.command.operationKey === 'adopt:finish-input'
              ) {
                adoptionFaultApplied = true;
                throw Error('controlled lost adoption commit');
              }
              return next;
            });
            await observe('group', 'return', args[2]);
            return result;
          },
        };
      });
    onTestFinished(() => {
      authority.mockRestore();
      group.mockRestore();
    });
    let candidateReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      candidateReady = resolve;
    });
    const continueCandidate = new Promise<void>((resolve) => {
      resumeCandidate = resolve;
    });
    const prepare =
      StationReportRetainedTurns.prototype.prepareRenewalCandidate;
    const candidate = vi
      .spyOn(StationReportRetainedTurns.prototype, 'prepareRenewalCandidate')
      .mockImplementation(async function (
        this: StationReportRetainedTurns,
        ...args
      ) {
        const result = await prepare.apply(this, args);
        candidateReady();
        if (scenario === 'held-home' || scenario === 'shutdown-preparing')
          await continueCandidate;
        return result;
      });
    onTestFinished(() => candidate.mockRestore());
    const retireCalls: Array<
      Parameters<typeof sourceWireOwner.retireSdkSourceWire>
    > = [];
    if (scenario === 'candidate-close-failed') {
      const retire = sourceWireOwner.retireSdkSourceWire;
      const fault = vi
        .spyOn(sourceWireOwner, 'retireSdkSourceWire')
        .mockImplementation((...args) => {
          retireCalls.push(args);
          if (!cleanupAllowed)
            return Promise.reject(
              new Error('controlled candidate retirement confirmation failure'),
            );
          return retire(...args);
        });
      onTestFinished(() => fault.mockRestore());
    }
    const narrowing = narrowReportGroupAfterInput(
      'http://renewal-control.test',
      created.group.groupId,
      {
        operationKey: 'finish-input',
        seatId: 'left',
        expectedRevision: created.group.revision,
      },
      options,
    );
    void narrowing.catch(() => {});
    pending.push(narrowing);
    if (scenario === 'shutdown-preparing') {
      await Promise.race([
        ready,
        narrowing.then(() => {
          throw Error('narrow returned before candidate');
        }),
      ]);
      await assert.rejects(
        ownerRuntime.shutdown(),
        /Runtime publication remains pending/,
      );
      resumeCandidate();
      const narrowed = await narrowing;
      assert.equal(narrowed.replayed, false);
      await ownerRuntime.shutdown();
      assert.equal(h.rawFetch.mock.calls.length, 1);
      assert.equal(starts.mock.calls.length, 1);
      assert.equal(relay.mock.calls.length, 0);
      return;
    }
    if (scenario === 'revoked-after-renew') {
      await assert.rejects(narrowing);
      assert.equal(revocationApplied, true);
      const persistence = new StationDelegationPersistence(
        join(h.f.loader.getProjectHomeDir(), 'report-groups'),
      );
      const execution = await persistence.readReportExecution(
        created.group.groupId,
        created.group.groupId,
        () => undefined,
      );
      assert.equal(execution.authority?.epochs.length, 2);
      assert.equal(execution.group?.grants.authority.authority_epoch, 1);
      assert.equal(h.rawFetch.mock.calls.length, 1);
      assert.equal(starts.mock.calls.length, 1);
      assert.equal(relay.mock.calls.length, 0);
      return;
    }
    if (scenario === 'lost-adoption') {
      await assert.rejects(narrowing);
      assert.equal(adoptionFaultApplied, true);
      loseAdoption = false;
      const persistence = new StationDelegationPersistence(
        join(h.f.loader.getProjectHomeDir(), 'report-groups'),
      );
      const beforeReplay = await persistence.readReportExecution(
        created.group.groupId,
        created.group.groupId,
        () => undefined,
      );
      assert.equal(beforeReplay.authority?.epochs.length, 2);
      assert.equal(beforeReplay.group?.grants.authority.authority_epoch, 1);
      const captures = candidate.mock.calls.length;
      const replayed = await narrowReportGroupAfterInput(
        'http://renewal-control.test',
        created.group.groupId,
        {
          operationKey: 'finish-input',
          seatId: 'left',
          expectedRevision: created.group.revision,
        },
        options,
      );
      assert.equal(replayed.replayed, true);
      assert.equal(candidate.mock.calls.length, captures);
      const afterReplay = await persistence.readReportExecution(
        created.group.groupId,
        created.group.groupId,
        () => undefined,
      );
      assert.equal(afterReplay.authority?.epochs.length, 2);
      assert.equal(afterReplay.group?.grants.authority.authority_epoch, 2);
      assert.equal(h.rawFetch.mock.calls.length, 1);
      assert.equal(starts.mock.calls.length, 1);
      assert.equal(relay.mock.calls.length, 0);
      return;
    }
    if (scenario === 'held-home') {
      await Promise.race([
        ready,
        narrowing.then(() => {
          throw Error('narrow returned before candidate');
        }),
      ]);
      held = await writer.acquire();
      let queued!: () => void;
      const queuedPromise = new Promise<void>((resolve) => {
        queued = resolve;
      });
      const acquire = HomeWriterOwner.prototype.acquire;
      const admission = vi
        .spyOn(HomeWriterOwner.prototype, 'acquire')
        .mockImplementation(function (this: HomeWriterOwner, ...args) {
          const result = acquire.apply(this, args);
          if (this.homeDir === writer.homeDir) queued();
          return result;
        });
      onTestFinished(() => admission.mockRestore());
      resumeCandidate();
      const first = await Promise.race([
        queuedPromise.then(() => 'queued'),
        narrowing.then(
          () => 'returned',
          () => 'refused',
        ),
      ]);
      await held.release();
      held = undefined;
      assert.equal(
        first,
        'queued',
        'narrow must fairly admit after an independent Home holder',
      );
    }
    if (scenario === 'candidate-close-failed') {
      await assert.rejects(
        narrowing,
        (error: unknown) =>
          error instanceof DelegationRoundsTransactionUncertainError ||
          (error instanceof Error && 'status' in error && error.status === 503),
      );
      assert.ok(
        retireCalls.length > 0,
        'candidate retirement failure must execute',
      );
      await assert.rejects(
        ownerRuntime.shutdown(),
        /Runtime publication remains pending/,
      );
      const beforeRetry = retireCalls.length;
      cleanupAllowed = true;
      await ownerRuntime.shutdown();
      assert.ok(
        retireCalls.length > beforeRetry,
        'shutdown must retry retirement confirmation',
      );
      assert.ok(
        retireCalls.every(
          (args) =>
            args[0] === retireCalls[0][0] && args[1] === retireCalls[0][1],
        ),
        'retry must retire the same SDK wire',
      );
      assert.equal(h.rawFetch.mock.calls.length, 1);
      assert.equal(starts.mock.calls.length, 1);
      return;
    }
    const narrowed = await narrowing;
    assert.equal(narrowed.replayed, false);
    assert.ok(observed.some((entry) => entry.domain === 'authority'));
    assert.ok(observed.some((entry) => entry.domain === 'group'));
    assert.ok(
      observed.every((entry) => entry.physical === 'busy' && entry.bound),
      JSON.stringify(observed),
    );
    assert.ok(late.length > 0);
    for (const check of late) assert.throws(check, /unavailable/);
    assert.equal(h.rawFetch.mock.calls.length, 1);
    assert.equal(starts.mock.calls.length, 1);
    assert.equal(relay.mock.calls.length, 0);
  },
  180000,
);
