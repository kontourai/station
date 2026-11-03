import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import { DelegationRoundsTransactionUncertainError } from '@kontourai/flow-agents/delegation-group-rounds';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import {
  createReportGroup,
  narrowReportGroupAfterInput,
  readReportGroupContextCheckpoint,
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
import * as localGrantOwner from '../../../runtime/conversation/local-grant-observation-owner.js';
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
import { StationReportPreparationUnavailable } from '../station-report-group-input.js';
import { StationReportGroupRuntime } from '../station-report-group-runtime.js';
import { StationReportRetainedTurns } from '../station-report-retained-turn.js';
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import {
  installControl,
  NOW,
  setup,
} from './delegation-source-fixtures/report.js';
import { useAdvancingHistoricalClock } from './delegation-source-fixtures/report-clock.js';
import {
  controlledInputStream,
  controlledTextStream,
} from './delegation-source-fixtures/streamed-text.js';

test.each([
  'owned-commit',
  'held-home',
  'candidate-close-failed',
  'capture-close-failed',
  'lost-adoption',
  'shutdown-preparing',
  'revoked-after-renew',
  'response-contention',
  'response-revoked',
  'checkpoint-contention',
  'request-witness-cost',
  'response-original-witness',
  'question-provider-binding',
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
      delegationAttemptClaimStore: h.delegationAttemptClaimStore,
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
    let narrowFailure: unknown;
    const narrow = runtime.narrowAfterInput.bind(runtime);
    const observeNarrow = vi
      .spyOn(runtime, 'narrowAfterInput')
      .mockImplementation(async (...args) => {
        try {
          const result = await narrow(...args);
          if (
            scenario === 'response-contention' ||
            scenario === 'response-revoked'
          ) {
            responseRequest = args[0].req.raw;
            held = await writer.acquire();
            responseReady();
          }
          return result;
        } catch (error) {
          narrowFailure = error;
          throw error;
        }
      });
    onTestFinished(() => observeNarrow.mockRestore());
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
    let responseRequest: Request | undefined;
    let responseReady!: () => void;
    const responseEntered = new Promise<void>((resolve) => {
      responseReady = resolve;
    });
    let responseQueued!: () => void;
    const responseQueue = new Promise<void>((resolve) => {
      responseQueued = resolve;
    });
    let onHomeAcquire = () => {};
    const acquire = HomeWriterOwner.prototype.acquire;
    const admissions = vi
      .spyOn(HomeWriterOwner.prototype, 'acquire')
      .mockImplementation(function (this: HomeWriterOwner, ...args) {
        const work = acquire.apply(this, args);
        if (this.homeDir === writer.homeDir) {
          onHomeAcquire();
          if (responseRequest && args[0] === responseRequest.signal)
            responseQueued();
        }
        return work;
      });
    onTestFinished(() => admissions.mockRestore());
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
    if (
      scenario === 'request-witness-cost' ||
      scenario === 'response-original-witness'
    ) {
      const captures = vi.spyOn(
        localGrantOwner,
        'captureEnvironmentLocalGrantReadOwner',
      );
      onTestFinished(() => captures.mockRestore());
      const url = `http://renewal-control.test/api/orchestration/report-groups/${created.group.groupId}`;
      const request = () => {
        const raw = new Request(url, {
          headers: {
            Authorization: `Bearer ${h.f.paired.credential}`,
            'X-Test-Operator': 'yes',
          },
        });
        setRuntimeAuthenticatedRequestPrincipal(raw, { ...principal });
        bindRuntimeLocalOperator(raw);
        return raw;
      };
      if (scenario === 'request-witness-cost') {
        const response = await app.fetch(request());
        assert.equal(response.status, 200);
        assert.equal(
          captures.mock.calls.length,
          1,
          'one HTTP read must share its pre-work host witness with custody',
        );
        const context = h.f.context(request());
        assert.ok(await runtime.get(context, created.group.groupId));
        assert.equal(captures.mock.calls.length, 2);
        assert.ok(await runtime.get(context, created.group.groupId));
        assert.equal(
          captures.mock.calls.length,
          3,
          'standalone calls must capture anew even for the same Request',
        );
        const foreign = h.custody.bindRequest(context);
        assert.throws(
          () => runtime.bindRequest(foreign),
          /custody is unavailable/i,
        );
        const bound = runtime.bindRequest(context);
        context.req.raw = request();
        await assert.rejects(
          runtime.authorizeResponse(bound),
          /custody is unavailable/i,
        );
        const malformed = await app.fetch(
          new Request(`${url}?unexpected=yes`, {
            headers: {
              Authorization: `Bearer ${h.f.paired.credential}`,
              'X-Test-Operator': 'yes',
            },
          }),
        );
        assert.equal(malformed.status, 400);
        return;
      }
      const get = runtime.get.bind(runtime);
      let replaced = false;
      const originalId = (await h.f.environment.readExistingRecord())
        .environmentId;
      const afterWork = vi
        .spyOn(runtime, 'get')
        .mockImplementation(async (...args) => {
          const value = await get(...args);
          assert.ok(
            value,
            'the real authorized read must complete before key replacement',
          );
          writeFileSync(
            join(h.f.home, 'security', `revision-evidence-${originalId}.key`),
            randomBytes(32).toString('base64url'),
            { mode: 0o600 },
          );
          replaced = true;
          return value;
        });
      onTestFinished(() => afterWork.mockRestore());
      const response = await app.fetch(request());
      assert.equal(replaced, true);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        success: false,
        code: 'report_group_unavailable',
      });
      assert.equal(
        captures.mock.calls.length,
        1,
        'response must validate the original witness rather than recapturing after effects',
      );
      assert.equal(
        (await h.f.environment.readExistingRecord()).environmentId,
        originalId,
      );
      const freshContext = h.f.context(request());
      const fresh = await runtime.authorizeResponse(freshContext);
      await runtime.withResponseCurrent(freshContext, fresh, () => undefined);
      assert.equal(
        captures.mock.calls.length,
        2,
        'a fresh witness is valid, isolating rejection to the original host signature',
      );
      return;
    }
    if (scenario === 'checkpoint-contention') {
      const checkpoint = StationReportRetainedTurns.prototype.checkpoint;
      const checkpointBody = vi
        .spyOn(StationReportRetainedTurns.prototype, 'checkpoint')
        .mockImplementation(async function (
          this: StationReportRetainedTurns,
          ...args
        ) {
          const result = await checkpoint.apply(this, args);
          responseRequest = args[0].req.raw;
          held = await writer.acquire();
          responseReady();
          return result;
        });
      onTestFinished(() => checkpointBody.mockRestore());
      const checking = readReportGroupContextCheckpoint(
        'http://renewal-control.test',
        created.group.groupId,
        { seatId: 'left', expectedRevision: created.group.revision },
        options,
      );
      void checking.catch(() => {});
      pending.push(checking);
      await Promise.race([
        responseEntered,
        checking.then(() => {
          throw Error('checkpoint returned before contention');
        }),
      ]);
      const first = await Promise.race([
        responseQueue.then(() => 'queued'),
        checking.then(
          () => 'returned',
          () => 'refused',
        ),
      ]);
      await held?.release();
      held = undefined;
      assert.equal(
        first,
        'queued',
        'checkpoint currency must fairly wait after its actual body returns',
      );
      const checked = await checking;
      assert.equal(checked.revision, created.group.revision);
      assert.match(checked.flowHead, /^[a-f0-9]{64}$/);
      assert.equal(h.rawFetch.mock.calls.length, 1);
      assert.equal(starts.mock.calls.length, 1);
      return;
    }
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
                  h.f.environment.devicePairing.verifyCredential(
                    h.f.paired.credential,
                  ),
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
    const captureError = Error('controlled retained capture failure');
    const retirementError = Error(
      'controlled candidate retirement confirmation failure',
    );
    let captureFaultApplied = false;
    if (scenario === 'capture-close-failed') {
      const inspect = sourceWireOwner.inspectSdkSourceWire;
      const captureFault = vi
        .spyOn(sourceWireOwner, 'inspectSdkSourceWire')
        .mockImplementation((...args) => {
          inspect(...args);
          captureFaultApplied = true;
          throw captureError;
        });
      onTestFinished(() => captureFault.mockRestore());
    }
    const retireCalls: Array<
      Parameters<typeof sourceWireOwner.retireSdkSourceWire>
    > = [];
    if (
      scenario === 'candidate-close-failed' ||
      scenario === 'capture-close-failed'
    ) {
      const retire = sourceWireOwner.retireSdkSourceWire;
      const fault = vi
        .spyOn(sourceWireOwner, 'retireSdkSourceWire')
        .mockImplementation((...args) => {
          retireCalls.push(args);
          if (!cleanupAllowed) return Promise.reject(retirementError);
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
    if (scenario === 'response-contention' || scenario === 'response-revoked') {
      await Promise.race([
        responseEntered,
        narrowing.then(() => {
          throw Error('narrow returned before response contention');
        }),
      ]);
      const first = await Promise.race([
        responseQueue.then(() => 'queued'),
        narrowing.then(
          () => 'returned',
          () => 'refused',
        ),
      ]);
      if (scenario === 'response-revoked') {
        assert.ok(held);
        writer.runWithLease(held, () => {
          assert.equal(
            h.f.environment.devicePairing.verifyCredential(
              h.f.paired.credential,
            ),
            true,
          );
          h.f.environment.devicePairing.revokeDevice(
            h.f.paired.device.id,
            'operator-credential',
          );
        });
      }
      await held?.release();
      held = undefined;
      assert.equal(
        first,
        'queued',
        'response currency must fairly admit after sibling Home custody',
      );
      if (scenario === 'response-revoked') {
        await assert.rejects(
          narrowing,
          (error: unknown) =>
            error instanceof Error && 'status' in error && error.status === 503,
        );
        assert.equal(
          narrowFailure,
          undefined,
          'renewal succeeded before response authority was withdrawn',
        );
        const persistence = new StationDelegationPersistence(
          join(h.f.loader.getProjectHomeDir(), 'report-groups'),
        );
        const execution = await persistence.readReportExecution(
          created.group.groupId,
          created.group.groupId,
          () => undefined,
        );
        assert.equal(execution.authority?.epochs.length, 2);
        assert.equal(execution.group?.grants.authority.authority_epoch, 2);
        assert.equal(h.rawFetch.mock.calls.length, 1);
        assert.equal(starts.mock.calls.length, 1);
        return;
      }
    }
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
      onHomeAcquire = queued;
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
    if (
      scenario === 'candidate-close-failed' ||
      scenario === 'capture-close-failed'
    ) {
      await assert.rejects(
        narrowing,
        (error: unknown) =>
          error instanceof Error && 'status' in error && error.status === 503,
      );
      if (scenario === 'capture-close-failed')
        assert.equal(captureFaultApplied, true);
      assert.ok(
        narrowFailure instanceof DelegationRoundsTransactionUncertainError,
      );
      let cleanupOutcome = narrowFailure;
      while (
        cleanupOutcome.errors[0] instanceof
        DelegationRoundsTransactionUncertainError
      )
        cleanupOutcome = cleanupOutcome.errors[0];
      assert.equal(
        cleanupOutcome.status,
        scenario === 'candidate-close-failed'
          ? 'returned-cleanup-unknown'
          : 'publication-unknown',
      );
      const persistence = new StationDelegationPersistence(
        join(h.f.loader.getProjectHomeDir(), 'report-groups'),
      );
      const execution = await persistence.readReportExecution(
        created.group.groupId,
        created.group.groupId,
        () => undefined,
      );
      if (scenario === 'candidate-close-failed') {
        assert.equal(execution.authority?.epochs.length, 2);
        assert.equal(execution.group?.grants.authority.authority_epoch, 2);
      } else {
        assert.equal(captureFaultApplied, true);
        const captureOutcome = narrowFailure.errors[0];
        assert.ok(
          captureOutcome instanceof DelegationRoundsTransactionUncertainError,
        );
        assert.deepEqual(captureOutcome.errors, [
          captureError,
          retirementError,
        ]);
        let first: unknown = narrowFailure;
        while (first instanceof AggregateError && first.errors.length)
          first = first.errors[0];
        assert.equal(first, captureError);
        assert.equal(execution.authority?.epochs.length, 1);
        assert.equal(execution.group?.grants.authority.authority_epoch, 1);
      }
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
    if (scenario === 'question-provider-binding') {
      const checkpoint = await readReportGroupContextCheckpoint(
        'http://renewal-control.test',
        created.group.groupId,
        { seatId: 'left', expectedRevision: narrowed.group.revision },
        options,
      );
      const command = {
        operationKey: 'provider-bound-answer-sync',
        seatId: 'left',
        expectedRevision: checkpoint.revision,
        flowHead: checkpoint.flowHead,
        renewalOperationKey: 'finish-input',
      };
      const persistence = new StationDelegationPersistence(
        join(h.f.home, 'report-groups'),
      );
      const before = await persistence.readReportExecution(
        created.group.groupId,
        created.group.groupId,
        () => undefined,
      );
      assert.equal(before.authority?.epochs.length, 2);
      const reservation = vi.spyOn(
        FileAuthorizationLedger.prototype,
        'reserve',
      );
      const paidSync = vi.spyOn(runtime, 'sync');
      let syncFailure: unknown;
      const syncAfterInput = runtime.syncAfterInput.bind(runtime);
      const responseFailure = vi
        .spyOn(runtime, 'syncAfterInput')
        .mockImplementation(async (...args) => {
          try {
            return await syncAfterInput(...args);
          } catch (error) {
            syncFailure = error;
            throw error;
          }
        });
      let providerFaultApplied = false;
      const read = orchestration.readSessionEventById.bind(orchestration);
      const fault = vi
        .spyOn(orchestration, 'readSessionEventById')
        .mockImplementation((...args) => {
          const event = read(...args);
          if (
            !providerFaultApplied &&
            args[0] === opened.threadId &&
            args[1] === opened.eventId
          ) {
            assert.ok(event?.method === 'request.opened');
            assert.equal(event.provider, 'station-agent');
            assert.equal(event.eventId, opened.eventId);
            assert.equal(event.requestId, opened.requestId);
            providerFaultApplied = true;
            return { ...event, provider: 'claude' as const };
          }
          return event;
        });
      onTestFinished(() => {
        fault.mockRestore();
        responseFailure.mockRestore();
        paidSync.mockRestore();
        reservation.mockRestore();
      });
      h.rawFetch.mockImplementation(async (_url, init) => {
        const wire = JSON.parse(String(init?.body));
        const prompt = JSON.parse(wire.messages[0].content[0].text);
        assert.ok(prompt.brief.startsWith('Receive context only.'));
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
      const sync = () =>
        syncReportGroupAfterInput(
          'http://renewal-control.test',
          created.group.groupId,
          command,
          options,
        );
      try {
        await assert.rejects(
          sync(),
          (error: unknown) =>
            error instanceof Error && 'status' in error && error.status === 503,
        );
        assert.equal(
          providerFaultApplied,
          true,
          'the exact canonical question provider must be changed',
        );
        assert.ok(syncFailure instanceof StationReportPreparationUnavailable);
        assert.equal(syncFailure.code, 'group_preparation_unavailable');
        assert.equal(
          paidSync.mock.calls.length,
          0,
          'provider authentication must refuse before entering paid sync',
        );
        assert.equal(reservation.mock.calls.length, 0);
        assert.equal(h.rawFetch.mock.calls.length, 1);
        assert.equal(starts.mock.calls.length, 1);
        const after = await persistence.readReportExecution(
          created.group.groupId,
          created.group.groupId,
          () => undefined,
        );
        assert.deepEqual(after.authority, before.authority);
        assert.deepEqual(after.group, before.group);
      } finally {
        fault.mockRestore();
      }
      const synced = await sync();
      assert.equal(synced.group.contextSyncs?.at(-1)?.state, 'acknowledged');
      assert.equal(paidSync.mock.calls.length, 1);
      assert.equal(reservation.mock.calls.length, 1);
      assert.equal(h.rawFetch.mock.calls.length, 2);
      assert.equal(relay.mock.calls.length, 0);
      return;
    }
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
