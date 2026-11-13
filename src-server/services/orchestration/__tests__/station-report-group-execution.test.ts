import assert from 'node:assert/strict';
import fs, { readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { type FlowMultiCursorClaimEvent, loadRun } from '@kontourai/flow';
import { DelegationRoundsTransactionUncertainError } from '@kontourai/flow-agents/delegation-group-rounds';
import {
  createReportGroup,
  finalizeReportGroupCancel,
  getReportGroup,
  listReportGroups,
  readReportGroupEvents,
  readReportGroupResult,
} from '@kontourai/station-sdk/client';
import { prepareFileMutationOwner } from '@kontourai/station-shared/lifecycle-events';
import {
  acquireStationHomeMaintenanceLease,
  StationHomeActiveError,
} from '@kontourai/station-shared/station-home-lifecycle';
import { Hono } from 'hono';
import { test, vi } from 'vitest';
import { runCli } from '../../../../packages/cli/src/cli.js';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { createReportGroupRoutes } from '../../../routes/orchestration/report-groups.js';
import { isRuntimePublicationParticipant } from '../../../runtime/bootstrap/runtime-publication-participant.js';
import { StationRuntime } from '../../../runtime/bootstrap/station-runtime.js';
import { AnthropicSealedPreparation } from '../../../runtime/conversation/anthropic-sealed-preparation.js';
import * as observedCredentials from '../../../runtime/conversation/provider-credential-observation.js';
import * as reservedTurns from '../../../runtime/conversation/reserved-station-turn.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { createLogger } from '../../../utils/logger.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { HomeWriterOwner } from '../../ssh/home-writer-owner.js';
import { RoundsFinalFetchLaunchFence } from '../delegation-group-launch-fence.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import * as sdkSource from '../delegation-group-sdk-source-wire-owner.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';
import { StationReportGroupPreparation } from '../station-report-group-preparation.js';
import { StationReportGroupRuntime } from '../station-report-group-runtime.js';
import {
  reportTerminalWitnessSchema,
  verifyReportTerminalWitness,
} from '../station-report-terminal-witness.js';
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import {
  installControl,
  NOW,
  newGrant,
  setup,
} from './delegation-source-fixtures/report.js';
import { controlledTextStream } from './delegation-source-fixtures/streamed-text.js';

type View = NonNullable<Awaited<ReturnType<StationReportGroupRuntime['get']>>>;
type Operation = Awaited<ReturnType<StationReportGroupRuntime['create']>>;

test.each([
  'independent',
  'flow',
  'mixed',
  'revoked-before-claim',
  'metadata-release-fault',
  'publication-release-fault',
  'launch-release-fault',
  'launch-body-release-fault',
] as const)(
  'report HTTP owner qualifies %s source custody and truthful accounting',
  async (scenario) => {
    const revokeBeforeClaim = scenario === 'revoked-before-claim';
    const metadataReleaseFault = scenario === 'metadata-release-fault';
    const publicationReleaseFault = scenario === 'publication-release-fault';
    const bodyReleaseFault = scenario === 'launch-body-release-fault';
    const launchReleaseFault =
      scenario === 'launch-release-fault' || bodyReleaseFault;
    const retirementFault =
      metadataReleaseFault || publicationReleaseFault || launchReleaseFault;
    const mode =
      scenario === 'flow' || scenario === 'mixed' ? scenario : 'independent';
    const wallNow = Date.now;
    const h = await setup();
    const startedAt = wallNow();
    const diagnosticStartedAt = performance.now();
    const runNow = NOW;
    vi.mocked(Date.now).mockImplementation(
      () => runNow + wallNow() - startedAt,
    );
    installControl(h);
    if (mode === 'mixed') {
      await h.f.storage.saveProviderConnection({
        id: 'google-1',
        name: 'Controlled Google connection',
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
        prompt: 'Configured Google report-only instructions',
        execution: {
          modelConnectionId: 'google-1',
          modelId: 'gemini-2.5-flash-lite',
        },
      });
    }
    const memberCount = mode === 'independent' ? 2 : 3;
    const flowRunId = 'report-http-flow';
    if (mode === 'flow') {
      await createReportFlow(h.f, flowRunId, [
        { id: 'left' },
        { id: 'right' },
        { id: 'join', needs: ['left', 'right'] },
      ]);
    }
    const heldResponses = new Map<
      string,
      { release(): void; forced: boolean }
    >();
    const responseTimers = new Set<ReturnType<typeof setTimeout>>();
    let returnedBeforeResponse = 0;
    let failedLaunchRetirements = 0;
    const start = RoundsFinalFetchLaunchFence.prototype.start;
    vi.spyOn(RoundsFinalFetchLaunchFence.prototype, 'start').mockImplementation(
      async function (this: RoundsFinalFetchLaunchFence, ...args) {
        let result: Awaited<ReturnType<typeof start>>;
        try {
          result = await start.apply(this, args);
        } catch (error) {
          const held = launchReleaseFault
            ? heldResponses.get(args[1].body)
            : undefined;
          if (held) {
            try {
              assert.equal(held.forced, false);
              assert.ok(
                error instanceof DelegationRoundsTransactionUncertainError,
              );
              assert.equal(error.status, 'returned-cleanup-unknown');
              failedLaunchRetirements++;
            } finally {
              held.release();
            }
          }
          throw error;
        }
        const gate = heldResponses.get(args[1].body);
        assert.ok(gate, 'actual provider request reached its response hold');
        let settled = false;
        void result.response.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await Promise.resolve();
        assert.equal(
          gate.forced,
          false,
          'launch must return before proof response deadline',
        );
        assert.equal(
          settled,
          false,
          'launch lease must close while provider response is pending',
        );
        returnedBeforeResponse++;
        gate.release();
        return result;
      },
    );
    const requestWriter = await HomeWriterOwner.forHome(h.f.home);
    let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cleaningUp = false;
    const refusedWires = new Map<object, object>();
    if (bodyReleaseFault) {
      const refuseResponse = sdkSource.refuseSdkResponse;
      vi.spyOn(sdkSource, 'refuseSdkResponse').mockImplementation(
        (owner, handle) => {
          refusedWires.set(handle, owner);
          return refuseResponse(owner, handle);
        },
      );
    }
    let releaseFault: { mockRestore(): void } | undefined;
    let failedRetirementAttempts = 0;
    let completedPublishCallbacks = 0;
    const installReleaseFault = () => {
      assert.equal(releaseFault, undefined);
      const remove = fs.rmSync;
      releaseFault = vi
        .spyOn(fs, 'rmSync')
        .mockImplementation((path, options) => {
          if (
            String(path).startsWith(
              join(h.f.home, 'security', '.home-writer.mutation.guard.stale-'),
            )
          ) {
            failedRetirementAttempts++;
            throw Error('controlled report home retirement failure');
          }
          return remove(path, options);
        });
      syncBuiltinESMExports();
    };
    let queuedExecutionWitness: Promise<void> | undefined;
    let witnessedExecution = false;
    const execute = reservedTurns.executeReservedStationTurn;
    vi.spyOn(reservedTurns, 'executeReservedStationTurn').mockImplementation(
      (...args) => {
        if (witnessedExecution) return execute(...args);
        witnessedExecution = true;
        const siblingHome = requestWriter.acquire();
        void siblingHome.catch(() => {});
        try {
          const complete = args[8];
          assert.ok(
            complete,
            'actual adapter supplies its protected completion callback',
          );
          let latePublication: Promise<void> | undefined;
          args[8] = (attempt, check) => {
            complete(attempt, check);
            completedPublishCallbacks++;
            if (publicationReleaseFault) {
              installReleaseFault();
              return;
            }
            latePublication = Promise.resolve().then(async () => {
              const sibling = await requestWriter.acquire();
              try {
                sibling.assertCurrent();
                let effects = 0;
                assert.throws(() =>
                  check(() => {
                    effects++;
                  }),
                );
                assert.equal(
                  effects,
                  0,
                  'expired publication check cannot borrow a live sibling lease',
                );
              } finally {
                await sibling.release();
              }
            });
            void latePublication.catch(() => {});
          };
          const actual = execute(...args);
          let settled = false;
          void actual.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          assert.throws(() => execute(...args), {
            code: 'reserved_station_turn_unavailable',
          });
          const reader = reservedTurns.reservedStationTurnResult(args[0]);
          void reader.catch(() => {});
          queuedExecutionWitness = siblingHome.then(async (held) => {
            try {
              held.assertCurrent();
              assert.equal(
                h.rawFetch.mock.calls.length,
                0,
                'queued claim cannot start a provider under sibling custody',
              );
              assert.equal(
                settled,
                false,
                'pending execution result is owned before admission',
              );
              if (revokeBeforeClaim)
                requestWriter.runWithLease(held, () => {
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
                  assert.equal(
                    h.f.environment.devicePairing.verifyCredential(
                      h.f.paired.credential,
                    ),
                    false,
                  );
                });
            } finally {
              await held.release();
            }
            if (metadataReleaseFault) installReleaseFault();
            if (revokeBeforeClaim || retirementFault) {
              const refused = await Promise.allSettled([actual, reader]);
              assert.ok(
                refused.every((result) => result.status === 'rejected'),
              );
              assert.equal(latePublication, undefined);
              return;
            }
            const [attempt, readback] = await Promise.all([actual, reader]);
            assert.deepEqual(
              readback.evidenceReference,
              attempt.evidenceReference,
            );
            assert.deepEqual(readback.accounting, attempt.accounting);
            assert.equal(readback.sdkResult.text, attempt.sdkResult.text);
            assert.ok(
              latePublication,
              'completion publication joined the actual result',
            );
            await latePublication;
          });
          void queuedExecutionWitness.catch(() => {});
          return actual;
        } catch (error) {
          queuedExecutionWitness = siblingHome.then(async (held) => {
            await held.release();
            throw error;
          });
          void queuedExecutionWitness.catch(() => {});
          throw error;
        }
      },
    );
    const physicalHomeProbe = await prepareFileMutationOwner(
      join(h.f.home, 'security', '.home-writer.mutation'),
    );
    const assertPhysicalHomeHeld = async (boundary = 'publication') => {
      const attempt = physicalHomeProbe.tryAcquire();
      if (attempt.kind === 'acquired') await attempt.lease.release();
      assert.equal(
        attempt.kind,
        'busy',
        `${boundary} must retain the physical home lock`,
      );
      assert.throws(
        () => requestWriter.runSynchronous(() => undefined),
        { name: 'HomeWriterUnavailableError', reason: 'busy' },
        `${boundary} must not lend ambient home authority to a sibling`,
      );
    };
    const transportOwnershipFailures: unknown[] = [];
    const reportText = 'Controlled report '.repeat(1200);
    h.rawFetch.mockImplementation(async (url, init) => {
      try {
        await assertPhysicalHomeHeld('provider transport');
      } catch (error) {
        transportOwnershipFailures.push(error);
        throw error;
      }
      const body = init?.body;
      assert.ok(typeof body === 'string');
      assert.equal(heldResponses.has(body), false);
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const gate = { release, forced: false };
      const timer = setTimeout(() => {
        gate.forced = true;
        gate.release();
      }, 30_000);
      responseTimers.add(timer);
      gate.release = () => {
        clearTimeout(timer);
        responseTimers.delete(timer);
        release();
      };
      heldResponses.set(body, gate);
      if (launchReleaseFault) installReleaseFault();
      await held;
      const response = String(url).startsWith(
        'https://generativelanguage.googleapis.com/',
      )
        ? controlledTextStream('google', 'gemini-2.5-flash-lite', reportText, {
            promptTokenCount: 4,
            candidatesTokenCount: 8000,
            thoughtsTokenCount: 0,
            totalTokenCount: 8004,
            cachedContentTokenCount: 0,
            serviceTier: 'standard',
          })
        : controlledTextStream('anthropic', 'claude-sonnet-4-6', reportText, {
            input_tokens: 4,
            output_tokens: 8000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          });
      if (bodyReleaseFault && !cleaningUp) {
        assert.ok(response.body);
        assert.equal(bodyReader, undefined);
        bodyReader = response.body.getReader();
        void bodyReader.closed.catch(() => {});
      }
      return response;
    });
    const input = {
      ...h.input,
      deadlineAt: runNow + 240_000,
      budget: {
        inputTokens: memberCount * 1048576,
        outputTokens: memberCount * 8000,
        costMicros: memberCount * (1048576 * 3 + 8000 * 15),
      },
      ...(mode === 'flow'
        ? {
            flow: {
              runId: flowRunId,
              steps: { left: 'left', right: 'right', join: 'join' },
            },
          }
        : {}),
      members: [
        ...h.input.members,
        ...(mode !== 'independent'
          ? [
              {
                ...h.input.members[0],
                seatId: 'join',
                brief: 'Review combined findings',
              },
            ]
          : []),
      ].map((member) => ({
        ...member,
        maxOutputTokens: 8000,
        ...(mode === 'mixed' && member.seatId === 'right'
          ? { agentId: 'google-reviewer' }
          : {}),
      })),
    };

    const bus = new EventBus();
    const protectedPublications: string[] = [];
    const stopPublicationObservation = bus.subscribe(({ event, data }) => {
      if (
        event !== 'orchestration:event' ||
        !data?.event ||
        typeof data.event !== 'object'
      )
        return;
      const method = Reflect.get(data.event, 'method');
      if (method === 'content.text-delta' || method === 'turn.completed')
        protectedPublications.push(method);
    });
    const eventStore = new EventStore(
      join(h.f.root, 'report-execution.sqlite'),
    );
    const logger = { debug() {}, warn() {} };
    const relay = vi.fn<typeof fetch>(async () => {
      throw Error('reserved execution must not relay');
    });
    const adapter = new StationAgentAdapter({
      apiBase: 'http://report-control.test',
      hasAgent: () => true,
      eventBus: bus,
      approvalRegistry: new ApprovalRegistry(logger, { eventBus: bus }),
      fetch: relay,
    });
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
    const runtimeOwner = new StationRuntime({ projectHomeDir: h.f.home });
    const publicationParticipant = Reflect.get(
      runtimeOwner,
      'runtimePublicationParticipant',
    );
    assert.ok(isRuntimePublicationParticipant(publicationParticipant));
    const owners = {
      publicationParticipant,
      runtime: h.preparationOwners.runtime,
      orchestration,
      rawFetch: h.rawFetch,
      delegationAttemptClaimStore: h.delegationAttemptClaimStore,
    };
    const roundsStore = StationDelegationPersistence.prototype.roundsStore;
    let groupWrites = 0;
    let groupStoreReturns = 0;
    const journalPhases: { kind: string; phase: string; elapsedMs: number }[] =
      [];
    const recordJournalPhase = (kind: string, phase: string) => {
      journalPhases.push({
        kind,
        phase,
        elapsedMs: performance.now() - diagnosticStartedAt,
      });
      if (journalPhases.length > 48) journalPhases.shift();
    };
    vi.spyOn(
      StationDelegationPersistence.prototype,
      'roundsStore',
    ).mockImplementation(function (
      this: StationDelegationPersistence,
      ...args
    ) {
      const actual = roundsStore.apply(this, args);
      return {
        ...actual,
        transact: async (groupId, body) => {
          let wrote = false;
          let lastKind = 'none';
          const result = await actual.transact(groupId, async (journal) => {
            const prior = journal?.events.length ?? 0;
            const next = await body(journal);
            if (next.journal && next.journal.events.length > prior) {
              const last = next.journal.events.at(-1);
              lastKind =
                last?.kind === 'command'
                  ? `command:${last.command.kind}`
                  : (last?.kind ?? 'none');
              recordJournalPhase(lastKind, 'body');
              await assertPhysicalHomeHeld();
              wrote = true;
              groupWrites++;
            }
            return next;
          });
          if (wrote) {
            await assertPhysicalHomeHeld();
            groupStoreReturns++;
            recordJournalPhase(lastKind, 'store-returned');
          }
          return result;
        },
      };
    });
    const qualifies = vi.spyOn(AnthropicSealedPreparation, 'create');
    const stampedPrincipal = getRuntimeAuthenticatedRequestPrincipal(h.f.req);
    assert.ok(stampedPrincipal && stampedPrincipal.kind !== 'internal');
    const principal = { ...stampedPrincipal };
    function appFor(runtime: StationReportGroupRuntime | null) {
      const app = new Hono();
      // Controlled ingress stamps; current credential and scope checks remain real owners.
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
      return app;
    }
    const createFailures: unknown[] = [];
    const create = StationReportGroupRuntime.prototype.create;
    vi.spyOn(StationReportGroupRuntime.prototype, 'create').mockImplementation(
      async function (this: StationReportGroupRuntime, ...args) {
        try {
          return await create.apply(this, args);
        } catch (error) {
          createFailures.push(error);
          throw error;
        }
      },
    );
    let app = appFor(new StationReportGroupRuntime(owners));
    const abort = new AbortController();
    const send = (
      method: 'GET' | 'POST',
      path = '',
      body?: unknown,
      credential = h.f.paired.credential,
      operator = true,
      extraHeaders: Record<string, string> = {},
    ) =>
      app.request(
        `http://report-control.test/api/orchestration/report-groups${path}`,
        {
          method,
          signal: abort.signal,
          headers: {
            Authorization: `Bearer ${credential}`,
            'Content-Type': 'application/json',
            ...(operator ? { 'X-Test-Operator': 'yes' } : {}),
            ...extraHeaders,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
    let sourceReads = 0;
    let upstreamSourceReads = 0;
    let upstreamCalls = 0;
    let inUpstream = false;
    let ownerGuardCalls = 0;
    let ownerReadSample: { reads: number } | undefined;
    const successfulOwnerReads: number[] = [];
    const guardObservers: Array<{ mockRestore(): void }> = [];
    if (scenario === 'independent') {
      const read = observedCredentials.readObservedSdkProviderCredential;
      guardObservers.push(
        vi
          .spyOn(observedCredentials, 'readObservedSdkProviderCredential')
          .mockImplementation((...args) => {
            sourceReads++;
            if (inUpstream) upstreamSourceReads++;
            else if (ownerReadSample) ownerReadSample.reads++;
            return read(...args);
          }),
      );
      const dispatch = StationReportGroupPreparation.prototype.dispatch;
      guardObservers.push(
        vi
          .spyOn(StationReportGroupPreparation.prototype, 'dispatch')
          .mockImplementation(function (
            this: StationReportGroupPreparation,
            handle,
            context,
            seatId,
            attempt,
            service,
          ) {
            const launch = attempt.transport.launch;
            assert.ok(launch.protocol === 'rounds-v1');
            const reportHome = launch.reportHome;
            assert.ok(reportHome);
            const withHome = reportHome.withHome;
            assert.ok(withHome);
            const current = launch.finalizeCurrent;
            let initialGuard:
              | {
                  original: Parameters<typeof withHome>[0];
                  observed: Parameters<typeof withHome>[0];
                }
              | undefined;
            const observeHome: typeof withHome = (guard, body) => {
              // Dispatch's first Home entry supplies its own guard; SDK guards retain their independent identity.
              initialGuard ??= {
                original: guard,
                observed: () => {
                  ownerGuardCalls++;
                  const sample = { reads: 0 };
                  const prior = ownerReadSample;
                  ownerReadSample = sample;
                  try {
                    const result = guard();
                    successfulOwnerReads.push(sample.reads);
                    return result;
                  } finally {
                    ownerReadSample = prior;
                  }
                },
              };
              return withHome(
                guard === initialGuard.original ? initialGuard.observed : guard,
                body,
              );
            };
            // These records are unbranded; retain every owned handle, lease and callback body.
            return dispatch.call(
              this,
              handle,
              context,
              seatId,
              {
                ...attempt,
                transport: {
                  ...attempt.transport,
                  launch: {
                    ...launch,
                    reportHome: { ...reportHome, withHome: observeHome },
                    finalizeCurrent: () => {
                      upstreamCalls++;
                      const prior = inUpstream;
                      inUpstream = true;
                      try {
                        return current();
                      } finally {
                        inUpstream = prior;
                      }
                    },
                  },
                },
              },
              service,
            );
          }),
      );
    }
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const disabled = await send(
        'POST',
        '/unmaterialized/continuation/finalize',
        {
          operationKey: 'final',
          expectedRevision: 0,
          continuationOperationKey: 'original',
        },
      );
      assert.equal(disabled.status, 503);
      assert.deepEqual(await disabled.json(), {
        success: false,
        code: 'report_continuation_finalizer_unavailable',
      });
      assert.equal(h.rawFetch.mock.calls.length, 0);
      assert.equal(qualifies.mock.calls.length, 0);
      assert.equal(
        (await send('POST', '', input, undefined, false)).status,
        503,
      );
      const response = await Promise.race([
        send('POST', '', input),
        new Promise<never>((_resolve, reject) => {
          watchdog = setTimeout(() => {
            abort.abort();
            reject(Error('report HTTP execution deadline'));
          }, input.deadlineAt - Date.now());
        }),
      ]);
      for (const gate of heldResponses.values()) gate.release();
      for (const timer of responseTimers) clearTimeout(timer);
      if (watchdog) clearTimeout(watchdog);
      const body = (await response.json()) as {
        success: boolean;
        data: Operation;
      };
      const flowDiagnostic =
        mode === 'flow' && response.status !== 200
          ? await loadRun(flowRunId, h.f.repo).then(
              (run) => ({
                status: run.state.status,
                currentStep: run.state.current_step,
                nextAction: run.state.next_action,
                activeClaims: run.state.multi_cursor.active_claims,
                claimHistory: run.state.multi_cursor.claim_history,
                blockedSteps: run.state.multi_cursor.blocked_steps,
                gateOutcomes: run.state.gate_outcomes,
              }),
              (error: unknown) => ({
                readError: error instanceof Error ? error.name : typeof error,
              }),
            )
          : undefined;
      createLogger({
        name: 'controlled-report-execution-profile',
        level: 'info',
      }).info('Controlled report execution phase timing', {
        scenario,
        mode,
        responseElapsedMs: performance.now() - diagnosticStartedAt,
        journalPhases: mode === 'flow' ? journalPhases : undefined,
        flowDiagnostic,
      });
      if (transportOwnershipFailures.length)
        throw transportOwnershipFailures[0];
      if (!revokeBeforeClaim && !retirementFault)
        assert.equal(
          response.status,
          200,
          `${JSON.stringify(body)} ${createFailures.map((error) => inspect(error, { depth: 8 })).join('\n')}\n${JSON.stringify({ journalPhases, flowDiagnostic, fetches: h.rawFetch.mock.calls.length, held: heldResponses.size, returnedBeforeResponse })}`,
        );
      assert.ok(
        queuedExecutionWitness,
        'actual reserved execution reached its queued ownership witness',
      );
      await queuedExecutionWitness;
      if (retirementFault) {
        assert.equal(response.status, 503, JSON.stringify(body));
        assert.ok(releaseFault, 'actual owned retirement fault was installed');
        const providerCalls = h.rawFetch.mock.calls.length;
        const publisherCalls = completedPublishCallbacks;
        if (metadataReleaseFault) {
          assert.equal(providerCalls, 0);
          assert.equal(publisherCalls, 0);
          assert.deepEqual(protectedPublications, []);
        } else if (launchReleaseFault) {
          assert.equal(providerCalls, 1);
          assert.equal(publisherCalls, 0);
          assert.equal(failedLaunchRetirements, 1);
          assert.ok(failedRetirementAttempts > 0);
          assert.deepEqual(protectedPublications, []);
        } else {
          assert.ok(providerCalls > 0);
          assert.equal(publisherCalls, 1);
          assert.ok(protectedPublications.includes('turn.completed'));
        }
        if (bodyReleaseFault) {
          assert.ok(
            bodyReader,
            'actual returned raw body has its owned reader',
          );
          assert.ok(refusedWires.size > 0);
          releaseFault.mockRestore();
          releaseFault = undefined;
          syncBuiltinESMExports();
          await requestWriter.settlePendingCleanup();
          const entrant = await requestWriter.acquire();
          await entrant.release();
        }
        await assert.rejects(runtimeOwner.shutdown(), {
          code: 'runtime_publication_pending',
        });
        assert.throws(
          () => acquireStationHomeMaintenanceLease(h.f.home),
          StationHomeActiveError,
        );
        bodyReader?.releaseLock();
        bodyReader = undefined;
        releaseFault?.mockRestore();
        releaseFault = undefined;
        syncBuiltinESMExports();
        await runtimeOwner.shutdown();
        assert.equal(
          h.rawFetch.mock.calls.length,
          providerCalls,
          'cleanup retry cannot resend a provider request',
        );
        assert.equal(
          completedPublishCallbacks,
          publisherCalls,
          'cleanup retry cannot rerun publication',
        );
        const maintenance = acquireStationHomeMaintenanceLease(h.f.home);
        maintenance.release();
        return;
      }
      if (revokeBeforeClaim) {
        assert.equal(response.status, 503, JSON.stringify(body));
        assert.equal(h.rawFetch.mock.calls.length, 0);
        assert.deepEqual(protectedPublications, []);
        return;
      }
      if (scenario === 'independent') {
        assert.ok(
          sourceReads > 0,
          'the real preparation source-read observer must be wired',
        );
        assert.ok(
          upstreamCalls > 0,
          'the actual dispatch must invoke its captured metadata finalizer',
        );
        assert.equal(
          upstreamSourceReads,
          0,
          `dispatch metadata must delegate source checks to preparation (upstream=${upstreamSourceReads}, total=${sourceReads}, upstream calls=${upstreamCalls})`,
        );
        assert.ok(
          ownerGuardCalls > 0,
          'the real preparation-owned guard must run',
        );
        assert.ok(
          successfulOwnerReads.length > 0,
          'at least one real preparation-owned guard must return successfully',
        );
        assert.ok(
          successfulOwnerReads.every((reads) => reads === 1),
          `each successful preparation-owned guard must check its one shared credential (calls=${ownerGuardCalls}, successful=${successfulOwnerReads.length}, reads=${successfulOwnerReads.reduce((sum, reads) => sum + reads, 0)})`,
        );
      }
      assert.equal(body.success, true, `${mode}: report execution succeeded`);
      assert.equal(
        protectedPublications.filter((method) => method === 'turn.completed')
          .length,
        memberCount,
      );
      assert.ok(protectedPublications.includes('content.text-delta'));
      const result = body.data;
      assert.equal(result.replayed, false);
      assert.equal(result.group.execution, 'returned');
      assert.equal(result.group.acceptance, 'unassessed');
      assert.equal(result.group.members.length, memberCount);
      assert.deepEqual(
        result.group.topology,
        mode === 'flow'
          ? { kind: 'flow', runId: flowRunId }
          : { kind: 'independent-advisory' },
      );
      if (mode === 'flow') {
        const run = await loadRun(flowRunId, h.f.repo);
        assert.equal(run.state.status, 'completed');
        const history: FlowMultiCursorClaimEvent[] =
          run.state.multi_cursor.claim_history;
        const claimed = history.filter((event) => event.action === 'claimed');
        const settled = history.filter((event) => event.action === 'settled');
        assert.deepEqual(claimed.map((event) => event.step_id).sort(), [
          'join',
          'left',
          'right',
        ]);
        assert.equal(new Set(claimed.map((event) => event.claim_id)).size, 3);
        assert.deepEqual(
          settled.map((event) => event.claim_id).sort(),
          claimed.map((event) => event.claim_id).sort(),
        );
        assert.deepEqual(run.state.multi_cursor.active_claims, []);
        assert.deepEqual(run.state.multi_cursor.blocked_steps, []);
      }
      assert.equal(h.rawFetch.mock.calls.length, memberCount);
      assert.equal(relay.mock.calls.length, 0);
      for (const member of result.group.members) {
        assert.equal(member.attempts.length, 1);
        assert.deepEqual(member.attempts[0].usage, {
          inputTokens: 4,
          outputTokens: 8000,
          costMicros:
            mode === 'mixed' && member.seatId === 'right' ? 3201 : 120012,
        });
        assert.equal(
          member.attempts[0].accountingTerminal,
          true,
          `${mode}: member accounting is terminal`,
        );
        assert.ok(member.attempts[0].terminal);
        const terminal = JSON.parse(
          readFileSync(
            join(
              h.f.home,
              'report-groups',
              'station-report-observations-v1',
              `${member.attempts[0].terminal.id}.json`,
            ),
            'utf8',
          ),
        );
        assert.ok(terminal.observation.recipient);
        const witness = reportTerminalWitnessSchema.parse(
          terminal.observation.witness,
        );
        assert.equal(
          verifyReportTerminalWitness(witness, h.f.environment),
          true,
          `${mode}: retained terminal witness verifies`,
        );
        assert.equal(witness.data.groupId, result.group.groupId);
        assert.equal(
          witness.data.invocationId,
          member.attempts[0].invocationId,
        );
        assert.equal(witness.data.terminal.sessionId, member.taskId);
        assert.equal(witness.data.terminal.clientTurnId, member.clientTurnId);
        assert.equal(
          witness.data.terminal.terminalEventId,
          terminal.observation.eventId,
        );
        const receipt = JSON.parse(
          readFileSync(
            join(
              h.f.home,
              'report-groups',
              'station-report-flow-observations-v1',
              `${terminal.observation.recipient.id}.json`,
            ),
            'utf8',
          ),
        );
        assert.equal(receipt.kind, 'recipient');
        assert.equal(
          receipt.value.invocationId,
          member.attempts[0].invocationId,
        );
        assert.equal(receipt.value.identity.executionId, member.taskId);
        assert.equal(receipt.value.identity.generation, 1);
        assert.match(receipt.value.identity.recipientId, /^station-recipient:/);
      }
      for (const privateValue of [
        'synthetic-not-a-live-key',
        'synthetic-google-not-live',
        'credentialDigest',
        'authenticated_principal_ref',
        'Configured report-only instructions',
        'Review correctness',
        h.f.root,
      ])
        assert.ok(!JSON.stringify(body).includes(privateValue), privateValue);
      assert.equal(qualifies.mock.calls.length, 1);
      vi.mocked(Date.now).mockReturnValue(Date.parse('2026-11-14T08:18:01Z'));
      await assert.rejects(() => AnthropicSealedPreparation.create(), {
        code: 'stale_contract',
      });
      const returning = newGrant(h);
      h.f.environment.devicePairing.revokeDevice(
        h.f.paired.device.id,
        'operator-credential',
      );
      app = appFor(new StationReportGroupRuntime(owners));
      assert.equal(qualifies.mock.calls.length, 2);
      const controlFetch = globalThis.fetch;
      let cliIngress = false;
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (url, init) => {
          if (
            String(url).startsWith(
              'http://report-control.test/api/orchestration/report-groups',
            ) ||
            String(url).startsWith(
              'http://127.0.0.1:43979/api/orchestration/report-groups',
            )
          )
            return app.request(
              String(url),
              cliIngress
                ? {
                    ...init,
                    headers: {
                      ...Object.fromEntries(new Headers(init?.headers)),
                      'X-Test-Operator': 'yes',
                    },
                  }
                : init,
            );
          return controlFetch(url, init);
        }),
      );
      const sdkOptions = {
        credential: returning.credential,
        credentialOrigin: 'http://report-control.test',
        headers: { 'X-Test-Operator': 'yes' },
        signal: abort.signal,
      };
      const sdkReplay = await createReportGroup(
        'http://report-control.test',
        input,
        sdkOptions,
      );
      assert.equal(sdkReplay.replayed, true, `${mode}: SDK replay recognized`);
      assert.deepEqual(sdkReplay.group, result.group);
      assert.deepEqual(
        await getReportGroup(
          'http://report-control.test',
          result.group.groupId,
          sdkOptions,
        ),
        result.group,
      );
      assert.deepEqual(
        (
          await listReportGroups(
            'http://report-control.test',
            undefined,
            sdkOptions,
          )
        ).groups,
        [result.group],
      );
      const cliOutput: string[] = [];
      const priorExitCode = process.exitCode;
      const log = vi.spyOn(console, 'log').mockImplementation((value) => {
        cliOutput.push(String(value));
      });
      cliIngress = true;
      try {
        await runCli([
          'group',
          'report-get',
          result.group.groupId,
          '--api-base=http://127.0.0.1:43979',
          `--credential=${returning.credential}`,
          '--json',
        ]);
      } finally {
        cliIngress = false;
        log.mockRestore();
        process.exitCode = priorExitCode;
      }
      assert.deepEqual(JSON.parse(cliOutput[0]), result.group);
      const replayResponse = await send(
        'POST',
        '',
        input,
        returning.credential,
      );
      assert.equal(replayResponse.status, 200);
      const replay = (await replayResponse.json()) as { data: Operation };
      assert.equal(
        replay.data.replayed,
        true,
        `${mode}: HTTP replay recognized`,
      );
      assert.deepEqual(replay.data.group, result.group);
      assert.equal(qualifies.mock.calls.length, 2);
      const changed = await send(
        'POST',
        '',
        { ...input, maxConcurrent: 1 },
        returning.credential,
      );
      assert.equal(changed.status, 503);
      const groupId = result.group.groupId;
      assert.equal((await send('GET', `/${groupId}`)).status, 503);
      const inspected = await send(
        'GET',
        `/${groupId}`,
        undefined,
        returning.credential,
      );
      assert.equal(inspected.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(
        ((await inspected.json()) as { data: View }).data,
        result.group,
      );
      const list = await send('GET', '', undefined, returning.credential);
      assert.deepEqual(
        ((await list.json()) as { data: { groups: View[] } }).data.groups,
        [result.group],
      );
      const eventsResponse = await send(
        'GET',
        `/${groupId}/events`,
        undefined,
        returning.credential,
      );
      assert.equal(eventsResponse.status, 200);
      const eventsPage = (
        (await eventsResponse.json()) as {
          data: {
            events: { revision: number; kind: string }[];
            nextRevision: number;
            hasMore: boolean;
          };
        }
      ).data;
      assert.deepEqual(
        eventsPage.events.map((e) => e.revision),
        Array.from({ length: result.group.revision }, (_, i) => i + 1),
      );
      assert.equal(eventsPage.nextRevision, result.group.revision);
      assert.equal(eventsPage.hasMore, false);
      assert.deepEqual(
        await readReportGroupEvents(
          'http://report-control.test',
          groupId,
          0,
          sdkOptions,
        ),
        eventsPage,
      );
      const resumed = await send(
        'GET',
        `/${groupId}/events?afterRevision=${eventsPage.nextRevision}`,
        undefined,
        returning.credential,
      );
      assert.deepEqual(
        ((await resumed.json()) as { data: { events: unknown[] } }).data.events,
        [],
      );
      const streamResponse = await send(
        'GET',
        `/${groupId}/events/stream`,
        undefined,
        returning.credential,
      );
      assert.equal(streamResponse.status, 200);
      const reader = streamResponse.body!.getReader();
      try {
        const first = await reader.read();
        const frame = new TextDecoder().decode(first.value);
        assert.ok(frame.includes('event: report-group-events'));
        assert.ok(frame.includes(`id: report:${encodeURIComponent(groupId)}:`));
        assert.ok(!frame.includes('authenticated_principal_ref'));
      } finally {
        await reader.cancel();
      }
      const foreignCursor = await send(
        'GET',
        `/${groupId}/events/stream`,
        undefined,
        returning.credential,
        true,
        { 'Last-Event-ID': `group:${encodeURIComponent(groupId)}:0` },
      );
      assert.equal(foreignCursor.status, 400);
      const member = result.group.members[0];
      const attempt = member.attempts[0];
      const resultPath = `/${groupId}/members/${member.seatId}/results/${attempt.invocationId}`;
      const rawResponse = await send(
        'GET',
        resultPath,
        undefined,
        returning.credential,
      );
      assert.equal(rawResponse.status, 200);
      const raw = (
        (await rawResponse.json()) as {
          data: {
            kind: string;
            text: string;
            nextOffset: number;
            hasMore: boolean;
          };
        }
      ).data;
      assert.equal(raw.kind, 'result');
      assert.equal(raw.text, reportText.slice(0, 16_384));
      assert.equal(
        raw.hasMore,
        true,
        `${mode}: retained result requires another page`,
      );
      assert.deepEqual(
        await readReportGroupResult(
          'http://report-control.test',
          groupId,
          member.seatId,
          attempt.invocationId,
          0,
          sdkOptions,
        ),
        raw,
      );
      const eof = await send(
        'GET',
        `${resultPath}?afterOffset=${raw.nextOffset}`,
        undefined,
        returning.credential,
      );
      const rest = (
        (await eof.json()) as {
          data: { text: string; hasMore: boolean; nextOffset: number };
        }
      ).data;
      assert.equal(raw.text + rest.text, reportText);
      assert.equal(rest.hasMore, false);
      assert.ok(attempt.observation);
      const observationFile = join(
        h.f.home,
        'report-groups',
        'station-report-observations-v1',
        `${attempt.observation.id}.json`,
      );
      const retainedBytes = readFileSync(observationFile);
      const substituted = JSON.parse(retainedBytes.toString());
      substituted.observation.text = 'Altered raw result';
      writeFileSync(observationFile, JSON.stringify(substituted), {
        mode: 0o600,
      });
      assert.equal(
        (await send('GET', resultPath, undefined, returning.credential)).status,
        503,
      );
      writeFileSync(observationFile, retainedBytes, { mode: 0o600 });
      assert.equal(
        (await send('GET', resultPath, undefined, returning.credential)).status,
        200,
      );
      const memberRead = vi
        .spyOn(orchestration, 'inspectTurnDelivery')
        .mockReturnValueOnce(null);
      assert.equal(
        (await send('GET', resultPath, undefined, returning.credential)).status,
        503,
      );
      memberRead.mockRestore();
      const interrupt = vi.spyOn(orchestration, 'dispatchWithReceipt');
      const command = {
        operationKey: 'cancel-completed',
        expectedRevision: result.group.revision,
      };
      const originalRoundsStore = roundsStore;
      const journalCommit = vi
        .spyOn(StationDelegationPersistence.prototype, 'roundsStore')
        .mockImplementation(function (
          this: StationDelegationPersistence,
          ...args
        ) {
          const store = originalRoundsStore.apply(this, args);
          return {
            transact: (id, body) =>
              store.transact(id, async (previous) => {
                const next = await body(previous);
                if (
                  next.journal.events[next.journal.events.length - 1]?.kind ===
                  'cancel_requested'
                )
                  throw Error('controlled cancellation journal commit loss');
                return next;
              }),
          };
        });
      const cancelResponse = await send(
        'POST',
        `/${groupId}/cancel`,
        command,
        returning.credential,
      );
      journalCommit.mockRestore();
      assert.equal(cancelResponse.status, 503);
      const repeated = await send(
        'POST',
        `/${groupId}/cancel`,
        command,
        returning.credential,
      );
      assert.equal(
        ((await repeated.json()) as { data: { replayed: boolean } }).data
          .replayed,
        true,
        `${mode}: cancellation replay recognized after journal failure`,
      );
      const pending = await getReportGroup(
        'http://report-control.test',
        groupId,
        sdkOptions,
      );
      assert.ok(pending);
      assert.equal(pending.cancellation, 'pending');
      const recovery = {
        operationKey: 'finalize-completed',
        cancelOperationKey: command.operationKey,
        expectedRevision: pending.revision,
      };
      const finalized = await finalizeReportGroupCancel(
        'http://report-control.test',
        groupId,
        recovery,
        sdkOptions,
      );
      assert.equal(finalized.replayed, false);
      assert.equal(finalized.cancellation, 'requested');
      const finalCli: string[] = [];
      const finalLog = vi.spyOn(console, 'log').mockImplementation((value) => {
        finalCli.push(String(value));
      });
      cliIngress = true;
      try {
        await runCli([
          'group',
          'report-finalize-cancel',
          groupId,
          '--api-base=http://127.0.0.1:43979',
          `--credential=${returning.credential}`,
          `--operation=${recovery.operationKey}`,
          `--cancel-operation=${command.operationKey}`,
          `--revision=${recovery.expectedRevision}`,
          '--json',
        ]);
      } finally {
        cliIngress = false;
        finalLog.mockRestore();
        process.exitCode = priorExitCode;
      }
      assert.equal(
        JSON.parse(finalCli[0]).replayed,
        true,
        `${mode}: CLI cancellation replay recognized`,
      );
      const after = await send(
        'GET',
        `/${groupId}`,
        undefined,
        returning.credential,
      );
      assert.ok(groupWrites > 0);
      assert.equal(groupStoreReturns, groupWrites);
      assert.equal(returnedBeforeResponse, memberCount);
      const afterView = ((await after.json()) as { data: View }).data;
      assert.equal(
        afterView.authorityRevoked,
        true,
        `${mode}: later read observes authority revocation`,
      );
      assert.deepEqual(afterView.members, result.group.members);
      assert.equal(interrupt.mock.calls.length, 0);
      assert.equal(h.rawFetch.mock.calls.length, memberCount);
      app = appFor(null);
      assert.equal(
        (await send('GET', '', undefined, returning.credential)).status,
        503,
      );
    } finally {
      for (const observer of guardObservers) observer.mockRestore();
      cleaningUp = true;
      releaseFault?.mockRestore();
      syncBuiltinESMExports();
      for (const gate of heldResponses.values()) gate.release();
      bodyReader?.releaseLock();
      bodyReader = undefined;
      for (const timer of responseTimers) clearTimeout(timer);
      if (watchdog) clearTimeout(watchdog);
      abort.abort();
      for (const [handle, owner] of refusedWires)
        await sdkSource.retireSdkSourceWire(owner, handle);
      await queuedExecutionWitness?.catch(() => {});
      await orchestration.shutdown();
      stopPublicationObservation();
      await physicalHomeProbe.close();
      await runtimeOwner.shutdown();
      eventStore.close();
      if (revokeBeforeClaim) assert.deepEqual(protectedPublications, []);
    }
  },
  270_000,
);
