// UNWIRED #91: boot custody, private issuance and managed transport composition remain required.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { FlowDurableStepClaim } from '@kontourai/flow';
import {
  createDelegationAuthorityService,
  type DelegationAuthorityHost,
  type DelegationAuthorityLedger,
  type DelegationAuthorityStore,
  type DelegationInvocationAmounts,
} from '@kontourai/flow-agents/delegation-authority-service';
import {
  type DelegationAuthorityStoreV3,
  validateDelegationAuthorityLedgerV3,
} from '@kontourai/flow-agents/delegation-authority-service-v3';
import {
  type DelegationEnvelopeV2,
  delegationEnvelopeDigestV2,
  rootAuthorityReferenceV2,
  validateDelegationAncestryV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import {
  type DelegationRoundsStore,
  projectDelegationRounds,
} from '@kontourai/flow-agents/delegation-group-rounds';
import {
  type DelegationGroupStoreV2,
  projectDelegationGroupV2,
} from '@kontourai/flow-agents/delegation-group-v2';
import { canonicalJson } from '@kontourai/relay';
import { outsideStationServerScope } from '../../security/station-server-scope.js';
import type {
  HomeWriterLease,
  HomeWriterOwner,
} from '../ssh/home-writer-owner.js';
import type { StationDelegationPersistence } from './delegation-group-persistence.js';
import type { SourceFlowLaunchOwner } from './delegation-group-source-admission.js';
import {
  assertSynchronous,
  type FileFinalWireIntentStore,
  type FinalWireIntentIdentity,
  type SingleFinalWireIntentIdentity,
  type WireFinalizer,
  WireIntentRefusal,
  wireIdentityDigest,
} from './delegation-group-wire-intent-store.js';
import type { ReportRoundsScope } from './report-rounds-publication.js';

const launchContext = new AsyncLocalStorage<{ active: boolean }>();
function forbidNestedOwner(): void {
  if (launchContext.getStore()?.active)
    throw new WireIntentRefusal('nested_launch_or_store_reentry');
}
function requireLaunch(value: unknown): asserts value {
  if (!value) throw new WireIntentRefusal('reserved_launch_join_unavailable');
}
const same = (a: unknown, b: unknown): boolean =>
  canonicalJson(a) === canonicalJson(b);

/** One reserved physical request without a synthetic group/controller/seat.
 * Host authentication, qualified wire/pricing and native confinement remain owner inputs.
 * The response stays observable when a later store commit or unlock fails. */
export class SingleDelegationFinalFetchLaunchFence {
  readonly response: Promise<Response>;
  readonly authorities: DelegationAuthorityStoreV3;
  #resolveResponse!: (response: Response | PromiseLike<Response>) => void;
  #rejectResponse!: (error: unknown) => void;
  #started = false;
  #invoked = false;

  constructor(
    private readonly owners: LaunchOwners & {
      authorities: DelegationAuthorityStoreV3;
      scope: ReportRoundsScope;
    },
  ) {
    this.response = new Promise((resolve, reject) => {
      this.#resolveResponse = resolve;
      this.#rejectResponse = reject;
    });
    outsideStationServerScope(() => {
      void this.response.catch(() => {});
    });
    this.authorities = {
      transact: (id, body) => {
        forbidNestedOwner();
        return owners.authorities.transact(id, body);
      },
    };
  }

  get invoked(): boolean {
    return this.#invoked;
  }

  async start(
    bindingInput: SingleReservedWireBinding,
    wireInput: FinalWire,
    signal: AbortSignal,
  ): Promise<SingleFinalWireIntentIdentity> {
    if (this.#started)
      throw new WireIntentRefusal('single_launch_already_started');
    this.#started = true;
    const scope = { active: true };
    try {
      forbidNestedOwner();
      const binding = structuredClone(bindingInput);
      const wire = snapshotFinalWire(wireInput);
      requireLaunch(wireIdentityDigest(wire) === binding.expectedWireDigest);
      signal.throwIfAborted();
      this.owners.scope.current();
      this.owners.scope.check(() =>
        assertSynchronous(this.owners.finalizeCurrent),
      );
      return await launchContext.run(scope, () =>
        this.owners.authorities.transact(
          binding.authority.id,
          async (ledger) => {
            if (!ledger) throw new WireIntentRefusal('authority_missing');
            validateDelegationAuthorityLedgerV3(ledger);
            const epoch = ledger.epochs.at(-1);
            requireLaunch(
              epoch &&
                ledger.origins.some(
                  (origin) =>
                    origin.invocationId === binding.invocationId &&
                    origin.epoch === ledger.epochs.length - 1,
                ),
            );
            const current: DelegationAuthorityLedger = {
              root: epoch.root,
              envelopes: epoch.envelopes,
              cancelled: ledger.cancelled,
              invocations: ledger.invocations,
            };
            const host = this.owners.host;
            const scopedHost: DelegationAuthorityHost = {
              now: () => host.now(),
              authorize: (...args) =>
                this.owners.scope.check(() => ({
                  value: host.authorize(...args),
                })).value,
              confirmExecution: (...args) =>
                this.owners.scope.check(() => ({
                  value: host.confirmExecution(...args),
                })).value,
            };
            const { envelope, reservation } = await admitReservedInvocation(
              { host: scopedHost },
              current,
              binding,
            );
            const identity: SingleFinalWireIntentIdentity = {
              scope: 'single-delegation/v1',
              root: rootAuthorityReferenceV2(current.root),
              envelope: structuredClone(binding.envelope),
              executionId: envelope.execution_id,
              invocationId: binding.invocationId,
              effect: binding.effect,
              allocation: structuredClone(reservation.allocation),
              executionBindingDigest: wireIdentityDigest(
                envelope.execution_binding,
              ),
              principalDigest: current.root.authenticated_principal_ref.digest,
              subjectDigest: current.root.authenticated_subject_ref.digest,
              finalWireDigest: wireIdentityDigest(wire),
            };
            const finalChecks = (): undefined =>
              this.owners.scope.check(() => {
                signal.throwIfAborted();
                const chain: DelegationEnvelopeV2[] = [];
                let cursor = envelope;
                for (;;) {
                  chain.unshift(cursor);
                  if (!cursor.parent) break;
                  const parent = current.envelopes.find(
                    (candidate) => candidate.envelope_id === cursor.parent?.id,
                  );
                  requireLaunch(
                    parent && chain.length <= current.envelopes.length,
                  );
                  cursor = parent;
                }
                validateDelegationAncestryV2(
                  current.root,
                  chain,
                  this.owners.host.now(),
                );
                assertSynchronous(this.owners.finalizeCurrent);
                return undefined;
              });
            await this.owners.intents.consumeSingle(identity, finalChecks);
            this.owners.scope.check(() => {
              finalChecks();
              this.#invoked = true;
              try {
                this.#resolveResponse(
                  this.owners.fetch(wire.url, {
                    method: wire.method,
                    headers: wire.headers.map(([name, value]) => [name, value]),
                    body: wire.body,
                    redirect: 'error',
                    signal,
                  }),
                );
              } catch (error) {
                this.#rejectResponse(error);
                throw error;
              }
            });
            return { ledger, result: identity };
          },
        ),
      );
    } catch (error) {
      if (!this.#invoked) this.#rejectResponse(error);
      throw error;
    } finally {
      scope.active = false;
    }
  }
}

export type FinalWire = {
  url: string;
  method: 'POST';
  headers: readonly (readonly [string, string])[];
  body: string;
};
export type ReservedWireBinding = {
  groupId: string;
  controller: { id: string; generation: number };
  seatId: string;
  authority: { id: string; authority_epoch: number; digest: string };
  envelope: { id: string; generation: number; digest: string };
  invocationId: string;
  effect: string;
  allocation: DelegationInvocationAmounts;
  expectedWireDigest: string;
  /** Captured from the actual Flow controller callback, never a route input. */
  flowClaim?: FlowDurableStepClaim;
};
export type SingleReservedWireBinding = Pick<
  ReservedWireBinding,
  | 'authority'
  | 'envelope'
  | 'invocationId'
  | 'effect'
  | 'allocation'
  | 'expectedWireDigest'
>;
export function snapshotFinalWire(input: FinalWire): FinalWire {
  if (
    input.method !== 'POST' ||
    typeof input.body !== 'string' ||
    Buffer.byteLength(input.body) > 2_097_152
  )
    throw new WireIntentRefusal('wire_shape_unsupported');
  const url = new URL(input.url);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new WireIntentRefusal('wire_url_unsupported');
  const headers = new Headers();
  for (const [name, value] of input.headers) headers.append(name, value);
  return {
    url: url.href,
    method: 'POST',
    body: input.body,
    headers: [...headers.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
  };
}

export type FinalFetchCheck = ReportRoundsScope['check'];
type LaunchOwners = {
  host: DelegationAuthorityHost;
  intents: FileFinalWireIntentStore;
  finalizeCurrent: WireFinalizer;
  fetch(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
    check?: FinalFetchCheck,
  ): Promise<Response>;
};
export type LegacyFinalFetchOwners = LaunchOwners & {
  protocol?: 'group-v2';
  groups: DelegationGroupStoreV2;
  authorities: DelegationAuthorityStore;
  flow?: SourceFlowLaunchOwner;
};
export type RoundsFinalFetchOwners = LaunchOwners & {
  protocol: 'rounds-v1';
  groups: DelegationRoundsStore;
  authorities: DelegationAuthorityStoreV3;
  flow?: SourceFlowLaunchOwner;
  reportHome?: {
    owner: HomeWriterOwner;
    persistence: StationDelegationPersistence;
    current: WireFinalizer;
    preparationCurrent: WireFinalizer;
    retainCleanup?(cleanup: () => Promise<void>): () => Promise<void>;
    withFinalFetchScope?<Value>(
      body: (
        scope: ReportRoundsScope,
        facades: Pick<
          RoundsFinalFetchOwners,
          'groups' | 'authorities' | 'host'
        >,
      ) => Promise<Value>,
    ): Promise<Value>;
    check?<Value>(current: WireFinalizer, body: () => Value): Promise<Value>;
    withHome?<Value>(
      current: WireFinalizer,
      body: (
        scope: Pick<ReportRoundsScope, 'current' | 'check'>,
      ) => Promise<Value>,
    ): Promise<Value>;
    invokeCurrent?<Value>(
      current: WireFinalizer,
      invoke: (check: <Result>(work: () => Result) => Result) => Promise<Value>,
    ): Promise<Value>;
  };
  flowScope?: { owner: HomeWriterOwner; lease: HomeWriterLease };
};
export type ReservedFinalFetchOwners =
  | LegacyFinalFetchOwners
  | RoundsFinalFetchOwners;
export type PreparedReservedFinalFetchOwners =
  | Omit<LegacyFinalFetchOwners, 'fetch'>
  | Omit<RoundsFinalFetchOwners, 'fetch'>;

async function admitReservedInvocation(
  owners: Pick<LaunchOwners, 'host'>,
  current: DelegationAuthorityLedger,
  binding: Pick<
    SingleReservedWireBinding,
    'authority' | 'envelope' | 'invocationId' | 'effect' | 'allocation'
  >,
): Promise<{
  envelope: DelegationEnvelopeV2;
  reservation: DelegationAuthorityLedger['invocations'][number];
}> {
  const snapshot = canonicalJson(current);
  requireLaunch(
    same(rootAuthorityReferenceV2(current.root), binding.authority),
  );
  let active = true;
  const readView: DelegationAuthorityStore = {
    async transact(id, body) {
      requireLaunch(active && id === binding.authority.id);
      const result = await body(structuredClone(current));
      requireLaunch(active && canonicalJson(result.ledger) === snapshot);
      return result.result;
    },
  };
  try {
    const service = createDelegationAuthorityService(readView, owners.host);
    const { envelope } = await service.admitEffect(
      binding.authority.id,
      binding.envelope.id,
      binding.effect,
    );
    requireLaunch(
      envelope.generation === binding.envelope.generation &&
        delegationEnvelopeDigestV2(envelope) === binding.envelope.digest,
    );
    const reservation = current.invocations.find(
      (value) => value.invocationId === binding.invocationId,
    );
    requireLaunch(
      reservation &&
        !reservation.terminal &&
        reservation.usage === null &&
        reservation.envelopeId === envelope.envelope_id &&
        same(reservation.allocation, binding.allocation),
    );
    return { envelope, reservation };
  } finally {
    active = false;
  }
}

async function sendReservedWire(
  owners: LaunchOwners,
  current: DelegationAuthorityLedger,
  binding: ReservedWireBinding,
  wire: FinalWire,
  signal: AbortSignal,
  flowLaunch?: (
    launch: () => {
      response: Promise<Response>;
      intent: FinalWireIntentIdentity;
    },
  ) => Promise<{
    response: Promise<Response>;
    intent: FinalWireIntentIdentity;
  }>,
): Promise<{ response: Promise<Response>; intent: FinalWireIntentIdentity }> {
  const digest = wireIdentityDigest(wire);
  const { envelope, reservation } = await admitReservedInvocation(
    owners,
    current,
    binding,
  );
  const identity: FinalWireIntentIdentity = {
    groupId: binding.groupId,
    controller: structuredClone(binding.controller),
    seatId: binding.seatId,
    root: rootAuthorityReferenceV2(current.root),
    envelope: structuredClone(binding.envelope),
    executionId: envelope.execution_id,
    invocationId: binding.invocationId,
    effect: binding.effect,
    allocation: structuredClone(reservation.allocation),
    executionBindingDigest: wireIdentityDigest(envelope.execution_binding),
    principalDigest: current.root.authenticated_principal_ref.digest,
    subjectDigest: current.root.authenticated_subject_ref.digest,
    finalWireDigest: digest,
  };
  const finalChecks = (): undefined => {
    signal.throwIfAborted();
    const chain: DelegationEnvelopeV2[] = [];
    let cursor = envelope;
    for (;;) {
      chain.unshift(cursor);
      if (!cursor.parent) break;
      const parentId = cursor.parent.id;
      const parent = current.envelopes.find(
        (value) => value.envelope_id === parentId,
      );
      if (!parent || chain.length > current.envelopes.length)
        throw new WireIntentRefusal('ancestry_unavailable');
      cursor = parent;
    }
    validateDelegationAncestryV2(current.root, chain, owners.host.now());
    assertSynchronous(owners.finalizeCurrent);
    return undefined;
  };
  await owners.intents.consume(identity, finalChecks);
  const launch = () => {
    finalChecks();
    const response = owners.fetch(wire.url, {
      method: wire.method,
      headers: wire.headers.map(([name, value]) => [name, value]),
      body: wire.body,
      redirect: 'error',
      signal,
    });
    outsideStationServerScope(() => {
      void Promise.resolve(response).catch(() => {});
    });
    return { response, intent: identity };
  };
  return flowLaunch ? flowLaunch(launch) : launch();
}

/**
 * Host-only final fetch owner. Canonical persistence, authenticated host and finalizer
 * are boot/request dependencies, never route input or a fabricated grant issuer.
 */
export class FinalFetchLaunchFence {
  readonly #groups: DelegationGroupStoreV2;
  readonly #authorities: DelegationAuthorityStore;
  readonly groups: DelegationGroupStoreV2;
  readonly authorities: DelegationAuthorityStore;
  constructor(
    private readonly owners:
      | LegacyFinalFetchOwners
      | Omit<LegacyFinalFetchOwners, 'fetch'>,
  ) {
    this.#groups = owners.groups;
    this.#authorities = owners.authorities;
    // All services/controller callbacks in this composition use these guarded views.
    this.groups = {
      transact: (id, body) => {
        forbidNestedOwner();
        return this.#groups.transact(id, body);
      },
      scan: (body) => {
        forbidNestedOwner();
        return this.#groups.scan(body);
      },
    };
    this.authorities = {
      transact: (id, body) => {
        forbidNestedOwner();
        return this.#authorities.transact(id, body);
      },
    };
  }

  async start(
    bindingInput: ReservedWireBinding,
    wireInput: FinalWire,
    signal: AbortSignal,
  ): Promise<{ response: Promise<Response>; intent: FinalWireIntentIdentity }> {
    const owners = this.owners;
    if (!('fetch' in owners))
      throw new WireIntentRefusal('wire_transport_unavailable');
    const binding = structuredClone(bindingInput);
    const wire = snapshotFinalWire(wireInput);
    requireLaunch(Buffer.byteLength(wire.body) <= 1_048_576);
    requireLaunch(wireIdentityDigest(wire) === binding.expectedWireDigest);
    return this.#withCurrentReservation(binding, signal, (current, flow) =>
      sendReservedWire(
        owners,
        current,
        binding,
        wire,
        signal,
        flow
          ? async (launch) =>
              (
                await flow.owner.withCurrentClaim(flow.claim, () => ({
                  value: launch(),
                }))
              ).value
          : undefined,
      ),
    );
  }

  /** Validate reservation before Task creation without consuming its wire intent. */
  async admitTask(
    binding: ReservedWireBinding,
    signal: AbortSignal,
  ): Promise<void> {
    const captured = structuredClone(binding);
    await this.#withCurrentReservation(
      captured,
      signal,
      async (current, flow) => {
        await admitReservedInvocation(this.owners, current, captured);
        const check = () => {
          assertSynchronous(this.owners.finalizeCurrent);
          signal.throwIfAborted();
          return { value: undefined };
        };
        if (flow) await flow.owner.withCurrentClaim(flow.claim, check);
        else check();
      },
    );
  }

  async #withCurrentReservation<T>(
    bindingInput: ReservedWireBinding,
    signal: AbortSignal,
    work: (
      current: DelegationAuthorityLedger,
      flow?: { owner: SourceFlowLaunchOwner; claim: FlowDurableStepClaim },
    ) => Promise<T>,
  ): Promise<T> {
    forbidNestedOwner();
    const binding = structuredClone(bindingInput);
    signal.throwIfAborted();
    assertSynchronous(this.owners.finalizeCurrent);
    const scope = { active: true };
    try {
      return await launchContext.run(scope, () =>
        this.#groups.transact(binding.groupId, async (journal) => {
          if (!journal) throw new WireIntentRefusal('group_missing');
          const group = projectDelegationGroupV2(journal);
          const seat = group.spec.seats.find(
            (value) => value.seatId === binding.seatId,
          );
          const member = group.members.find(
            (value) => value.seatId === binding.seatId,
          );
          requireLaunch(
            group.execution === 'execution_unknown' &&
              group.cancellation === 'none' &&
              group.terminal === 'unproven' &&
              !journal.events.some((event) => event.kind === 'run_returned'),
          );
          requireLaunch(
            same(group.spec.controller, binding.controller) &&
              same(group.spec.rootAuthorityRef, binding.authority),
          );
          requireLaunch(
            seat &&
              same(seat.envelope, binding.envelope) &&
              seat.effect === binding.effect &&
              same(seat.allocation, binding.allocation),
          );
          requireLaunch(
            member?.invocationId === binding.invocationId &&
              member.observation === null &&
              member.terminalReference === null,
          );
          let flow:
            | { owner: SourceFlowLaunchOwner; claim: FlowDurableStepClaim }
            | undefined;
          if (group.spec.topology.kind === 'flow') {
            const owner = this.owners.flow;
            const claim = binding.flowClaim;
            requireLaunch(
              owner &&
                claim &&
                same(owner.topology, group.spec.topology) &&
                member.claimId === claim.claim_id &&
                claim.run_id === group.spec.topology.runId &&
                claim.step_id === seat.stepId &&
                same(claim.definition, group.spec.topology.definition) &&
                same(claim.actor, group.spec.topology.actor),
            );
            flow = { owner, claim };
          } else requireLaunch(!binding.flowClaim);
          const result = await this.#authorities.transact(
            binding.authority.id,
            async (current) => {
              if (!current) throw new WireIntentRefusal('authority_missing');
              if (flow) {
                const envelope = current.envelopes.find(
                  (value) => value.envelope_id === binding.envelope.id,
                );
                const flowBinding = envelope?.execution_binding.flow_binding;
                requireLaunch(
                  envelope &&
                    same(
                      flow.owner.source,
                      envelope.execution_binding.source,
                    ) &&
                    flowBinding?.status === 'bound' &&
                    flowBinding.flow_run_id === flow.claim.run_id &&
                    flowBinding.flow_step_id === flow.claim.step_id &&
                    same(flowBinding.definition, flow.claim.definition),
                );
              }
              const result = await work(current, flow);
              return { ledger: current, result };
            },
          );
          return { journal, result };
        }),
      );
    } finally {
      scope.active = false;
    }
  }
}

/** Final wire admission for ordinary claims and reserved sync commands; recipient admission remains separate. */
export class RoundsFinalFetchLaunchFence {
  readonly groups: DelegationRoundsStore;
  readonly authorities: DelegationAuthorityStoreV3;
  constructor(
    private readonly owners:
      | RoundsFinalFetchOwners
      | Omit<RoundsFinalFetchOwners, 'fetch'>,
  ) {
    this.groups = {
      transact: (id, body) => {
        forbidNestedOwner();
        return owners.groups.transact(id, body);
      },
    };
    this.authorities = {
      transact: (id, body) => {
        forbidNestedOwner();
        return owners.authorities.transact(id, body);
      },
    };
  }
  async start(
    bindingInput: ReservedWireBinding,
    wireInput: FinalWire,
    signal: AbortSignal,
  ): Promise<{ response: Promise<Response>; intent: FinalWireIntentIdentity }> {
    const owners = this.owners;
    if (!('fetch' in owners))
      throw new WireIntentRefusal('wire_transport_unavailable');
    const binding = structuredClone(bindingInput);
    const wire = snapshotFinalWire(wireInput);
    requireLaunch(
      Buffer.byteLength(wire.body) <=
        (binding.effect === 'context-sync' ? 2_097_152 : 1_048_576),
    );
    requireLaunch(wireIdentityDigest(wire) === binding.expectedWireDigest);
    return this.#withCurrentReservation(
      binding,
      signal,
      (current, flowLaunch, scoped) =>
        sendReservedWire(
          scoped as RoundsFinalFetchOwners,
          current,
          binding,
          wire,
          signal,
          flowLaunch,
        ),
    );
  }

  /** Read-only reservation admission before canonical Task creation. Wire
   * intent consumption and transport remain exclusive to start(). */
  async admitTask(
    binding: ReservedWireBinding,
    signal: AbortSignal,
  ): Promise<void> {
    const captured = structuredClone(binding);
    await this.#withCurrentReservation(
      captured,
      signal,
      async (current, _flow, scoped) => {
        await admitReservedInvocation(scoped, current, captured);
        assertSynchronous(scoped.finalizeCurrent);
        signal.throwIfAborted();
      },
    );
  }

  async #withCurrentReservation<T>(
    bindingInput: ReservedWireBinding,
    signal: AbortSignal,
    work: (
      current: DelegationAuthorityLedger,
      flowLaunch: Parameters<typeof sendReservedWire>[5],
      scoped: RoundsFinalFetchOwners | Omit<RoundsFinalFetchOwners, 'fetch'>,
    ) => Promise<T>,
  ): Promise<T> {
    forbidNestedOwner();
    const binding = structuredClone(bindingInput);
    signal.throwIfAborted();
    const reportHome = this.owners.reportHome;
    if (reportHome?.withFinalFetchScope) {
      return reportHome.withFinalFetchScope((scope, facades) => {
        const owners = this.owners;
        const transport = 'fetch' in owners ? owners.fetch : undefined;
        const scoped = {
          ...owners,
          ...facades,
          reportHome: undefined,
          flowScope: { owner: scope.owner, lease: scope.lease },
          finalizeCurrent: (): undefined =>
            scope.check(() => {
              assertSynchronous(owners.finalizeCurrent);
              return undefined;
            }),
          ...(transport
            ? {
                fetch: (
                  request: Parameters<typeof fetch>[0],
                  init?: Parameters<typeof fetch>[1],
                ) => transport(request, init, scope.check),
              }
            : {}),
        };
        return new RoundsFinalFetchLaunchFence(scoped).#withCurrentReservation(
          binding,
          signal,
          work,
        );
      });
    }
    if (reportHome) {
      return reportHome.owner.runOwnedLease(signal, (lease) => {
        const within = <R>(body: () => R): R =>
          reportHome.owner.runWithLease(lease, () => {
            signal.throwIfAborted();
            return body();
          });
        const current = (): undefined =>
          within(() => {
            assertSynchronous(reportHome.current);
            assertSynchronous(reportHome.preparationCurrent);
            assertSynchronous(this.owners.finalizeCurrent);
            return undefined;
          });
        const host = this.owners.host;
        const transport =
          'fetch' in this.owners ? this.owners.fetch : undefined;
        const scopedHost = {
          ...host,
          authorize: (...args: Parameters<typeof host.authorize>) =>
            within(() => ({ value: host.authorize(...args) })).value,
          confirmExecution: (
            ...args: Parameters<typeof host.confirmExecution>
          ) => within(() => ({ value: host.confirmExecution(...args) })).value,
        };
        const scoped = {
          ...this.owners,
          reportHome: undefined,
          flowScope: { owner: reportHome.owner, lease },
          host: scopedHost,
          groups: reportHome.persistence.roundsStore(current, current, {
            owner: reportHome.owner,
            lease,
          }),
          authorities: reportHome.persistence.roundsAuthorityStore(
            current,
            current,
            { owner: reportHome.owner, lease },
          ),
          finalizeCurrent: current,
          ...(transport
            ? {
                fetch: (...args: Parameters<typeof fetch>) =>
                  within(() => ({ value: transport(...args) })).value,
              }
            : {}),
        };
        return new RoundsFinalFetchLaunchFence(scoped).#withCurrentReservation(
          binding,
          signal,
          work,
        );
      });
    }
    assertSynchronous(this.owners.finalizeCurrent);
    const scope = { active: true };
    try {
      return await launchContext.run(scope, () =>
        this.owners.groups.transact(binding.groupId, async (journal) => {
          if (!journal) throw new WireIntentRefusal('group_missing');
          const group = projectDelegationRounds(journal);
          const seat = group.spec.seats.find(
            (s) => s.seatId === binding.seatId,
          );
          const grant = group.grants.envelopes.find(
            (s) => s.seatId === binding.seatId,
          );
          const attempt = group.attempts
            .filter((a) => a.seatId === binding.seatId)
            .at(-1);
          requireLaunch(
            group.cancellation === 'none' &&
              same(group.spec.controller, binding.controller) &&
              same(group.grants.authority, binding.authority),
          );
          const sync = binding.effect === 'context-sync';
          requireLaunch(
            seat &&
              grant &&
              same(grant.envelope, binding.envelope) &&
              (sync
                ? group.spec.topology.kind === 'flow'
                : seat.effect === binding.effect) &&
              same(seat.allocation, binding.allocation),
          );
          let flowLaunch: Parameters<typeof sendReservedWire>[5];
          let syncPrevious: string | undefined;
          if (sync) {
            const pending = group.continuations.filter((c) => !c.receipt);
            const continuation = pending[0];
            requireLaunch(
              pending.length === 1 &&
                continuation?.command.kind === 'sync' &&
                continuation.command.seatId === binding.seatId &&
                !continuation.prepared &&
                group.rounds.every((r) => r.returned) &&
                (!attempt ||
                  attempt.admission === 'not_admitted' ||
                  attempt.terminal !== null),
            );
            const command = continuation.command;
            // Bind the controller's sync reservation to its durable command.
            const runId = `roundsync_${createHash('sha256')
              .update(
                canonicalJson([
                  group.spec.groupId,
                  command.operationKey,
                  command.seatId,
                  command.contextRef,
                ]),
              )
              .digest('hex')}`;
            const identity = createHash('sha256')
              .update(
                JSON.stringify([
                  binding.authority.id,
                  binding.envelope.id,
                  runId,
                  command.contextRef.digest,
                ]),
              )
              .digest('hex');
            const first = `sync_${identity}_0`;
            requireLaunch(
              binding.invocationId === first ||
                binding.invocationId === `sync_${identity}_1`,
            );
            if (binding.invocationId !== first) syncPrevious = first;
            const flow = this.owners.flow;
            requireLaunch(flow && same(flow.topology, group.spec.topology));
            flowLaunch = async (launch) => {
              const result = await flow.withCurrentHead(
                command.flowHead,
                () => ({ value: launch() }),
                this.owners.flowScope,
              );
              return result.value;
            };
          } else {
            requireLaunch(
              attempt &&
                attempt.invocationId === binding.invocationId &&
                attempt.observation === null &&
                attempt.terminal === null &&
                group.rounds[attempt.round - 1]?.returned === false,
            );
            if (group.spec.topology.kind === 'flow') {
              const action = group.flowActions.find(
                (a) =>
                  a.round === attempt.round &&
                  a.seatId === binding.seatId &&
                  a.invocationId === binding.invocationId &&
                  a.mode === 'invoke',
              );
              requireLaunch(
                attempt.admission === 'claimed' &&
                  action?.claim !== null &&
                  action?.claim !== undefined,
              );
              const flow = this.owners.flow;
              requireLaunch(flow && same(flow.topology, group.spec.topology));
              const claim = action.claim.value;
              requireLaunch(
                claim.run_id === group.spec.topology.runId &&
                  claim.step_id === seat.stepId &&
                  same(claim.definition, group.spec.topology.definition) &&
                  same(claim.actor, group.spec.topology.actor),
              );
              flowLaunch = async (launch) => {
                const result = await flow.withCurrentClaim(
                  claim,
                  () => ({ value: launch() }),
                  this.owners.flowScope,
                );
                return result.value;
              };
            }
          }
          const result = await this.owners.authorities.transact(
            binding.authority.id,
            async (ledger) => {
              if (!ledger) throw new WireIntentRefusal('authority_missing');
              const epoch = ledger.epochs.at(-1);
              requireLaunch(
                epoch &&
                  ledger.origins.some(
                    (o) =>
                      o.invocationId === binding.invocationId &&
                      o.epoch === ledger.epochs.length - 1,
                  ),
              );
              const current: DelegationAuthorityLedger = {
                root: epoch.root,
                envelopes: epoch.envelopes,
                cancelled: ledger.cancelled,
                invocations: ledger.invocations,
              };
              if (flowLaunch) {
                const envelope = epoch.envelopes.find(
                  (value) => value.envelope_id === binding.envelope.id,
                );
                requireLaunch(
                  envelope &&
                    (!sync ||
                      envelope.execution_authority.allowed_tools.length ===
                        0) &&
                    this.owners.flow &&
                    current.root.authenticated_principal_ref.id ===
                      this.owners.flow.topology.actor.key &&
                    same(
                      envelope.execution_binding.source,
                      this.owners.flow.source,
                    ) &&
                    envelope.execution_binding.flow_binding.status ===
                      'bound' &&
                    envelope.execution_binding.flow_binding.flow_run_id ===
                      this.owners.flow.topology.runId &&
                    envelope.execution_binding.flow_binding.flow_step_id ===
                      seat.stepId &&
                    same(
                      envelope.execution_binding.flow_binding.definition,
                      this.owners.flow.topology.definition,
                    ),
                );
              }
              if (syncPrevious) {
                const prior = ledger.invocations.find(
                  (i) => i.invocationId === syncPrevious,
                );
                requireLaunch(
                  prior?.terminal &&
                    prior.usage !== null &&
                    prior.envelopeId === binding.envelope.id,
                );
              }
              const result = await work(current, flowLaunch, this.owners);
              return { ledger, result };
            },
          );
          return { journal, result };
        }),
      );
    } finally {
      scope.active = false;
    }
  }
}
