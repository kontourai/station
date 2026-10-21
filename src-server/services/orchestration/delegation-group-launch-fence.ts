// UNWIRED #91: boot custody, private issuance and managed transport composition remain required.
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createDelegationAuthorityService,
  type DelegationAuthorityHost,
  type DelegationAuthorityStore,
  type DelegationInvocationAmounts,
} from '@kontourai/flow-agents/delegation-authority-service';
import {
  type DelegationEnvelopeV2,
  delegationEnvelopeDigestV2,
  rootAuthorityReferenceV2,
  validateDelegationAncestryV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import {
  type DelegationGroupStoreV2,
  projectDelegationGroupV2,
} from '@kontourai/flow-agents/delegation-group-v2';
import { canonicalJson } from '@kontourai/relay';
import {
  assertSynchronous,
  type FileFinalWireIntentStore,
  type FinalWireIntentIdentity,
  type WireFinalizer,
  WireIntentRefusal,
  wireIdentityDigest,
} from './delegation-group-wire-intent-store.js';

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
};
export function snapshotFinalWire(input: FinalWire): FinalWire {
  if (
    input.method !== 'POST' ||
    typeof input.body !== 'string' ||
    Buffer.byteLength(input.body) > 1_048_576
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
    private readonly owners: {
      groups: DelegationGroupStoreV2;
      authorities: DelegationAuthorityStore;
      host: DelegationAuthorityHost;
      intents: FileFinalWireIntentStore;
      finalizeCurrent: WireFinalizer;
      /** Already-qualified innermost transport. The test seam is explicitly no-billable. */
      fetch: typeof globalThis.fetch;
    },
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
    forbidNestedOwner();
    const binding = structuredClone(bindingInput);
    const wire = snapshotFinalWire(wireInput);
    const digest = wireIdentityDigest(wire);
    requireLaunch(digest === binding.expectedWireDigest);
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
          const result = await this.#authorities.transact(
            binding.authority.id,
            async (current) => {
              if (!current) throw new WireIntentRefusal('authority_missing');
              const snapshot = canonicalJson(current);
              requireLaunch(
                same(rootAuthorityReferenceV2(current.root), binding.authority),
              );
              let active = true;
              const readView: DelegationAuthorityStore = {
                async transact(id, body) {
                  requireLaunch(active && id === binding.authority.id);
                  const result = await body(structuredClone(current));
                  requireLaunch(
                    active && canonicalJson(result.ledger) === snapshot,
                  );
                  return result.result;
                },
              };
              try {
                const service = createDelegationAuthorityService(
                  readView,
                  this.owners.host,
                );
                const { envelope } = await service.admitEffect(
                  binding.authority.id,
                  binding.envelope.id,
                  binding.effect,
                );
                requireLaunch(
                  envelope.generation === binding.envelope.generation &&
                    delegationEnvelopeDigestV2(envelope) ===
                      binding.envelope.digest,
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
                const identity: FinalWireIntentIdentity = {
                  groupId: group.spec.groupId,
                  controller: structuredClone(group.spec.controller),
                  seatId: binding.seatId,
                  root: rootAuthorityReferenceV2(current.root),
                  envelope: structuredClone(binding.envelope),
                  executionId: envelope.execution_id,
                  invocationId: binding.invocationId,
                  effect: binding.effect,
                  allocation: structuredClone(reservation.allocation),
                  executionBindingDigest: wireIdentityDigest(
                    envelope.execution_binding,
                  ),
                  principalDigest:
                    current.root.authenticated_principal_ref.digest,
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
                  validateDelegationAncestryV2(
                    current.root,
                    chain,
                    this.owners.host.now(),
                  );
                  assertSynchronous(this.owners.finalizeCurrent);
                  return undefined;
                };
                await this.owners.intents.consume(identity, finalChecks);
                // LAST AWAIT before the actual controlled/native fetch invocation.
                finalChecks();
                const response = this.owners.fetch(wire.url, {
                  method: wire.method,
                  headers: wire.headers.map(([name, value]) => [name, value]),
                  body: wire.body,
                  redirect: 'error',
                  signal,
                });
                void Promise.resolve(response).catch(() => {});
                return {
                  ledger: current,
                  result: { response, intent: identity },
                };
              } finally {
                active = false;
              }
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
