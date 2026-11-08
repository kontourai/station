import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import {
  claimReadyStep,
  evaluateClaimedStep,
  flowRunHead,
  flowTransitionRef,
  loadRun,
} from '@kontourai/flow';
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import {
  createDelegationRoundsController,
  type DelegationRoundsTransactionScope,
} from '@kontourai/flow-agents/delegation-group-rounds';
import { afterEach, type TestContext, test, vi } from 'vitest';
import { RuntimePublicationParticipant } from '../../../../runtime/bootstrap/runtime-publication-participant.js';
import { StationRuntime } from '../../../../runtime/bootstrap/station-runtime.js';
import { HomeWriterOwner } from '../../../ssh/home-writer-owner.js';
import { StationDelegationPersistence } from '../../delegation-group-persistence.js';
import { LocalSourceAdmissionOwner } from '../../delegation-group-source-admission.js';
import {
  type ReportRoundsScope,
  withReportRoundsPublication,
} from '../../report-rounds-publication.js';
import { StationReportGroupCustody } from '../../station-report-group-custody.js';
import { StationReportGroupPreparation } from '../../station-report-group-preparation.js';
import { createReportFlow } from './flow.js';
import { NOW, requestFor, setup } from './report.js';

export interface FinalizerFixture {
  h: Awaited<ReturnType<typeof setup>>;
  reportRoot: string;
  dispatch: FileAuthorizationLedger;
  prepared: ReturnType<StationReportGroupPreparation['read']>;
  handle: Awaited<ReturnType<StationReportGroupPreparation['prepare']>>;
  groupId: string;
  current(): undefined;
  persistence: StationDelegationPersistence;
  controller: Pick<
    ReturnType<typeof createDelegationRoundsController>,
    'create' | 'get' | 'reappraise' | 'authorizeRetry' | 'cancel'
  >;
  held: Awaited<
    ReturnType<ReturnType<typeof createDelegationRoundsController>['get']>
  >;
  flow: Awaited<ReturnType<typeof createReportFlow>>;
  flowAfterLoss: Awaited<ReturnType<typeof loadRun>>;
  authorityBefore: Awaited<
    ReturnType<ReturnType<typeof createDelegationAuthorityServiceV3>['inspect']>
  >;
  refuse(): never;
  runtime: StationRuntime;
  participant: RuntimePublicationParticipant;
  setParticipant(next: RuntimePublicationParticipant): void;
}
const pending = new Set<Promise<unknown>>();
const runtimes = new Set<StationRuntime>();
const lifetimes = new Set<AbortController>();

function observeFinalizerWork<T>(work: Promise<T>): Promise<T> {
  pending.add(work);
  void work.then(
    () => pending.delete(work),
    () => pending.delete(work),
  );
  return work;
}

export function finalizerTest(
  name: string,
  body: (context: TestContext) => Promise<void>,
  timeoutMs?: number,
): void {
  test(name, (context) => observeFinalizerWork(body(context)), timeoutMs);
}

export function createFinalizerRuntime(
  options: ConstructorParameters<typeof StationRuntime>[0],
  signal?: AbortSignal,
): StationRuntime {
  signal?.throwIfAborted();
  const runtime = new StationRuntime(options);
  runtimes.add(runtime);
  return runtime;
}

afterEach(async () => {
  for (const lifetime of lifetimes) lifetime.abort();
  lifetimes.clear();
  while (pending.size) await Promise.allSettled([...pending]);
  const closed = await Promise.allSettled(
    [...runtimes].map((runtime) => runtime.shutdown()),
  );
  runtimes.clear();
  const failures = closed.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(failures, 'Finalizer fixture teardown failed');
});

export function setupFinalizer(
  signal?: AbortSignal,
): Promise<FinalizerFixture> {
  const lifetime = new AbortController();
  lifetimes.add(lifetime);
  return observeFinalizerWork(
    createFinalizer(
      signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
    ),
  );
}

async function createFinalizer(signal: AbortSignal): Promise<FinalizerFixture> {
  const h = await setup('local-grant', NOW, signal);
  const reportRoot = join(h.f.home, 'report-groups');
  const sourcesRoot = join(reportRoot, 'sources');
  const dispatchRoot = join(reportRoot, 'dispatch');
  for (const path of [reportRoot, sourcesRoot, dispatchRoot])
    mkdirSync(path, { mode: 0o700, recursive: true });
  h.f.store = sourcesRoot;
  h.f.owner = new LocalSourceAdmissionOwner(
    h.f.home,
    h.f.environment,
    sourcesRoot,
  );
  h.preparationOwners.sources = h.f.owner;
  h.owner = new StationReportGroupPreparation(h.preparationOwners);
  h.custodyOwners.persistence = new StationDelegationPersistence(reportRoot);
  h.custody = new StationReportGroupCustody({
    ...h.custodyOwners,
    canonicalLocalGrantOrigin: h.f.environment.canonicalLocalGrantOrigin(),
  });
  const flow = await createReportFlow(h.f, 'lost-reappraisal', [
    { id: 'first' },
    {
      id: 'review',
      needs: ['first'],
      requiredEvidence: true,
      routeBack: 'first',
    },
  ]);
  const handle = await h.owner.prepare(h.f.context(), {
    ...h.input,
    maxConcurrent: 1,
    budget: {
      inputTokens: 4 * 1_048_576,
      outputTokens: 40,
      costMicros: 4 * 3_145_878,
    },
    flow: { runId: flow.runId, steps: { left: 'first', right: 'review' } },
    continuation: {
      attemptsPerMember: 2,
      maxRounds: 4,
      maxSyncs: 0,
      maxRenewals: 0,
      maxEvaluations: 2,
      maxRecoveries: 2,
    },
  });
  const runtime = createFinalizerRuntime({ projectHomeDir: h.f.home }, signal);
  let participant = Reflect.get(
    runtime,
    'runtimePublicationParticipant',
  ) as RuntimePublicationParticipant;
  try {
    const prepared = h.owner.read(handle, h.f.req);
    const groupId = await h.custody.retain(h.f.context(), h.owner, handle);
    const current = (): undefined => {
      h.owner.assertCurrent(handle, h.f.req);
      return undefined;
    };
    const persistence = h.custodyOwners.persistence;
    const createAuthority = (scope?: ReportRoundsScope) => {
      const check = scope ? scope.current : current;
      const inspect = <Value>(body: () => Value): Value =>
        scope ? scope.check(body) : body();
      return createDelegationAuthorityServiceV3(
        persistence.roundsAuthorityStore(check, check, scope),
        {
          now: () => new Date(Date.now()).toISOString(),
          authorize: async (_action, root, envelope) =>
            inspect(() => h.owner.authorizes(handle, h.f.req, root, envelope)),
          confirmExecution: async (envelope) =>
            inspect(() => h.owner.confirmsExecution(handle, h.f.req, envelope)),
          authenticateRenewal: async () => null,
        },
        { maxRenewals: 0 },
      );
    };
    const writer = await HomeWriterOwner.forHome(h.f.home);
    const withAuthority = <Value>(
      work: (
        authority: ReturnType<typeof createDelegationAuthorityServiceV3>,
        scope: ReportRoundsScope,
      ) => Promise<Value>,
    ): Promise<Value> =>
      withReportRoundsPublication(
        { participant, home: h.f.home, signal },
        (publication) =>
          publication.withHome({ owner: writer, current }, (scope) =>
            work(createAuthority(scope), scope),
          ),
      );
    await withAuthority(async (authority, scope) => {
      await authority.issue(prepared.root);
      scope.check(current);
      for (const envelope of prepared.envelopes) {
        scope.check(current);
        await authority.derive(prepared.root.authority_id, envelope);
        scope.check(current);
      }
    });
    const dispatch = new FileAuthorizationLedger({ root: dispatchRoot });
    const refuse = (): never => {
      throw Error('unexpected execution');
    };
    const withController = <Value>(
      work: (
        controller: ReturnType<typeof createDelegationRoundsController>,
      ) => Promise<Value>,
    ): Promise<Value> =>
      withReportRoundsPublication(
        { participant, home: h.f.home, signal },
        async (publication) => {
          const build = (
            scope?: ReportRoundsScope,
          ): Pick<
            DelegationRoundsTransactionScope,
            'store' | 'host' | 'authorityService'
          > => {
            const check = scope ? scope.current : current;
            return {
              store: persistence.roundsStore(check, check, scope),
              authorityService: createAuthority(scope),
              host: {
                authorize: async () =>
                  prepared.root.authenticated_principal_ref,
                executionHost: refuse,
                prepareRequest: async () => refuse(),
                retainObservation: async () => refuse(),
                confirmTerminal: async () => refuse(),
                requestDescendantCancellation: async () => refuse(),
                retainContinuation: async () => {
                  throw Error('injected receipt retention outage');
                },
                flow: {
                  executionHost: refuse,
                  confirmRetainedResult: async () => false,
                  retainEvaluation: async () => refuse(),
                  acquireContinuationPublication: async () =>
                    publication.acquireContinuationPublication({
                      owner: writer,
                      current,
                      groupId,
                    }),
                },
              },
            };
          };
          return work(
            createDelegationRoundsController({
              ...build(),
              dispatchLedger: dispatch,
              cwd: h.f.repo,
              transactionOwner: publication.transactionOwner({
                owner: writer,
                current,
                groupId,
                build,
              }),
            }),
          );
        },
      );
    const controller: FinalizerFixture['controller'] = {
      create: (command) => withController((owner) => owner.create(command)),
      get: (id) => withController((owner) => owner.get(id)),
      reappraise: (command) =>
        withController((owner) => owner.reappraise(command)),
      authorizeRetry: (command) =>
        withController((owner) => owner.authorizeRetry(command)),
      cancel: (command) => withController((owner) => owner.cancel(command)),
    };
    const created = await controller.create({
      kind: 'create',
      groupId,
      operationKey: 'create',
      expectedRevision: 0,
      controller: prepared.spec.controller,
      spec: prepared.spec,
    });
    const actor = { key: 'fixture-evaluator', kind: 'test' };
    for (const [id, step] of [
      ['a', 'first'],
      ['b', 'review'],
      ['c', 'first'],
      ['d', 'review'],
    ]) {
      const { claim } = await claimReadyStep(flow.runId, {
        cwd: h.f.repo,
        step_id: step,
        claim_id: id,
        liveness_id: `${id}-live`,
        actor,
      });
      await evaluateClaimedStep(flow.runId, {
        cwd: h.f.repo,
        claim_id: claim.claim_id,
        liveness_id: claim.liveness_id,
        actor,
      });
    }
    const before = await loadRun(flow.runId, h.f.repo);
    const blocked = before.state.transitions.at(-1);
    assert.equal(blocked?.status, 'blocked');
    assert.equal(
      before.state.status,
      'blocked',
      JSON.stringify(before.state.transitions),
    );
    assert.equal(blocked.gate_id, 'review');
    await assert.rejects(
      controller.reappraise({
        kind: 'reappraise',
        groupId,
        operationKey: 'lost',
        expectedRevision: created.projection.revision,
        controller: prepared.spec.controller,
        checkpoint: prepared.root.revisions.policy,
        flowHead: flowRunHead(before.state),
        gate: 'review',
        blockedTransitionRef: flowTransitionRef(blocked),
      }),
      /injected receipt retention outage/,
    );
    const held = await controller.get(groupId);
    const flowAfterLoss = await loadRun(flow.runId, h.f.repo);
    const authorityBefore = await withAuthority((authority) =>
      authority.inspect(prepared.root.authority_id),
    );
    return {
      h,
      reportRoot,
      dispatch,
      prepared,
      handle,
      groupId,
      current,
      persistence,
      controller,
      held,
      flow,
      flowAfterLoss,
      authorityBefore,
      refuse,
      runtime,
      participant,
      setParticipant(next) {
        participant = next;
      },
    };
  } catch (error) {
    h.owner.close(handle);
    await runtime.shutdown();
    throw error;
  }
}

export function finalizeFixture(
  f: FinalizerFixture,
  request = requestFor(f.h, 'POST'),
) {
  return f.h.custody.finalizeContinuation(
    f.h.f.context(request),
    f.groupId,
    {
      operationKey: 'finish',
      expectedRevision: f.held.revision,
      continuationOperationKey: 'lost',
    },
    f.dispatch,
    f.h.f.owner,
    f.participant,
    (historical) => historical.group,
  );
}

export function observeFinalTransaction(
  f: FinalizerFixture,
  phase: 'body' | 'commit' | 'return',
  change: () => void,
) {
  const original = f.persistence.roundsStore.bind(f.persistence);
  const authority = vi.spyOn(f.persistence, 'roundsAuthorityStore');
  const guards: Array<() => void> = [];
  let transactions = 0;
  let reached = 0;
  let completedBodies = 0;
  const spy = vi
    .spyOn(f.persistence, 'roundsStore')
    .mockImplementation((...args) => {
      const store = original(...args);
      return {
        transact: async (id, body) => {
          const ordinal = ++transactions;
          if (ordinal !== 2) return store.transact(id, body);
          const within = args[2];
          assert.ok(
            within,
            'final continuation transaction must borrow its parent Home lease',
          );
          within.lease.assertCurrent();
          const other = authority.mock.calls.find(
            (call) => call[0] === args[0],
          )?.[2];
          assert.equal(other?.owner, within.owner);
          assert.equal(other?.lease, within.lease);
          assert.ok(args[1]);
          guards.push(args[0], args[1]);
          const inject = () => {
            reached++;
            change();
          };
          const result = await store.transact(id, async (journal) => {
            if (phase === 'body') inject();
            const result = await body(journal);
            completedBodies++;
            if (phase === 'commit') inject();
            return result;
          });
          if (phase === 'return') inject();
          return result;
        },
      };
    });
  return {
    guards,
    get reached() {
      return reached;
    },
    get completedBodies() {
      return completedBodies;
    },
    restore() {
      spy.mockRestore();
      authority.mockRestore();
    },
  };
}

export function observeNoFinalizerEffects(f: FinalizerFixture) {
  const preparation = [
    vi.spyOn(f.h.f.owner, 'prepareFlowSnapshot'),
    vi.spyOn(f.h.f.owner, 'prepareSdkSnapshot'),
    vi.spyOn(f.h.f.owner, 'readmitSnapshot'),
    vi.spyOn(f.h.f.owner, 'observe'),
  ];
  const reservation = vi.spyOn(f.h.delegationAttemptClaimStore, 'reserve');
  const fetches = f.h.rawFetch.mock.calls.length;
  const check = () => {
    assert.equal(f.h.rawFetch.mock.calls.length, fetches);
    assert.equal(reservation.mock.calls.length, 0);
    for (const spy of preparation) assert.equal(spy.mock.calls.length, 0);
  };
  return Object.assign(check, {
    restore() {
      for (const spy of preparation) spy.mockRestore();
      reservation.mockRestore();
    },
  });
}

export async function closeFinalizer(f: FinalizerFixture) {
  f.h.owner.close(f.handle);
  await f.runtime.shutdown();
}
