import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_OPERATIONAL_EVENT_TYPE_REGISTRY,
  type OperationalEventEnvelope,
  type OperationalEventScope,
  type OperationalEventTypeRegistry,
  validateOperationalEventEnvelope,
} from '@kontourai/station-contracts/operational-event';
import {
  exactProcessIdentity,
  probeExactProcessIdentity,
} from '@kontourai/station-shared/process-identity';
import { operationalEventScopeKey } from './operational-event-outbox.js';

export const MAX_OPERATIONAL_EVENT_CONSUMERS = 64;
export const MAX_OPERATIONAL_EVENT_DELIVERY_ATTEMPTS = 5;
export const MAX_OPERATIONAL_EVENT_DEAD_LETTERS = 100;

const CONSUMER_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const FAILURE_CODE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

export interface OperationalEventConsumerConfig {
  consumerId: string;
  eventTypes: readonly string[];
  requiredScopes: readonly OperationalEventScope[];
}

export type OperationalEventDeliveryTransition =
  | { kind: 'applied' }
  | { kind: 'stale' }
  | { kind: 'invalid' }
  | { kind: 'unavailable' };

export interface OperationalEventDeliveryClaim {
  readonly journalSequence: number;
  readonly event: OperationalEventEnvelope;
  readonly idempotencyKey: string;
  readonly attempt: number;
  acknowledge(): OperationalEventDeliveryTransition;
  retry(failureCode: string): OperationalEventDeliveryTransition;
  deadLetter(failureCode: string): OperationalEventDeliveryTransition;
}

export interface OperationalEventReplayGap {
  readonly requestedAfterJournalSequence: number;
  readonly earliestAvailableJournalSequence: number;
  acknowledge(): OperationalEventDeliveryTransition;
}

export interface OperationalEventDeadLetter {
  journalSequence: number;
  eventId: string;
  idempotencyKey: string;
  attempt: number;
  failureCode: string;
  terminalAt: string;
}

export type OperationalEventClaimOutcome =
  | { kind: 'delivery'; claim: OperationalEventDeliveryClaim }
  | { kind: 'empty' }
  | { kind: 'busy' }
  | { kind: 'waiting'; nextAttemptAt: string }
  | { kind: 'gap'; gap: OperationalEventReplayGap }
  | { kind: 'dead-lettered'; journalSequence: number }
  | { kind: 'unavailable' };

export type OperationalEventDeadLetterOutcome =
  | { kind: 'available'; entries: OperationalEventDeadLetter[] }
  | { kind: 'unavailable' };

export interface OperationalEventConsumer {
  claim(): OperationalEventClaimOutcome;
  deadLetters(): OperationalEventDeadLetterOutcome;
  close(): void;
}

export type OperationalEventConsumerOpenOutcome =
  | { kind: 'opened'; consumer: OperationalEventConsumer }
  | { kind: 'conflict' | 'capacity' | 'invalid' | 'unavailable' };

export type OperationalEventDeliveryOwner =
  | { id: string; pid: number; birth: string; identityKind: 'exact' }
  | { id: string; pid: number; identityKind: 'unverified' };

export interface OperationalEventProcessIdentity {
  exact(pid: number): { pid: number; start: string } | null;
  probe(
    pid: number,
  ):
    | { state: 'dead' }
    | { state: 'unavailable' }
    | { state: 'exact'; identity: { pid: number; start: string } };
}

export interface OperationalEventDeliveryRecord {
  consumerId: string;
  journalSequence: number;
  event: OperationalEventEnvelope;
  idempotencyKey: string;
  attempt: number;
  state: 'claimed' | 'retry';
  ownerId: string | null;
  ownerPid: number | null;
  ownerBirth: string | null;
  ownerIdentityKind: string | null;
  nextAttemptAt: string | null;
}

export interface OperationalEventSettlementFence {
  settlementId: string;
  ownerId: string;
  ownerPid: number;
  ownerBirth: string | null;
  ownerIdentityKind: string;
}

export type OperationalEventDeliveryCurrentOutcome =
  | {
      kind: 'available';
      cursorSequence: number;
      earliestJournalSequence: number;
      latestJournalSequence: number;
      active?: OperationalEventDeliveryRecord;
      settlement?: OperationalEventSettlementFence;
    }
  | { kind: 'unavailable' };

export interface OperationalEventDeliveryCoordinator {
  open(input: {
    consumerId: string;
    configFingerprint: string;
    eventTypes: string[];
    scopeKeys: string[];
    now: string;
    maxConsumers: number;
  }): 'opened' | 'conflict' | 'capacity' | 'unavailable';
  current(consumerId: string): OperationalEventDeliveryCurrentOutcome;
  claimNext(input: {
    consumerId: string;
    owner: OperationalEventDeliveryOwner;
    now: string;
  }):
    | { kind: 'claimed'; delivery: OperationalEventDeliveryRecord }
    | {
        kind: 'gap';
        cursorSequence: number;
        earliestJournalSequence: number;
      }
    | { kind: 'empty' | 'busy' | 'unavailable' };
  reclaim(input: {
    consumerId: string;
    journalSequence: number;
    expectedAttempt: number;
    expectedOwnerId: string | null;
    owner: OperationalEventDeliveryOwner;
    now: string;
    maxAttempts: number;
  }):
    | { kind: 'claimed'; delivery: OperationalEventDeliveryRecord }
    | { kind: 'dead-lettered' }
    | { kind: 'stale' | 'unavailable' };
  acknowledge(input: {
    consumerId: string;
    journalSequence: number;
    attempt: number;
    owner: OperationalEventDeliveryOwner;
    settlementId: string;
    now: string;
  }): OperationalEventDeliveryTransition;
  retry(input: {
    consumerId: string;
    journalSequence: number;
    attempt: number;
    owner: OperationalEventDeliveryOwner;
    settlementId: string;
    failureCode: string;
    nextAttemptAt: string;
    now: string;
  }): OperationalEventDeliveryTransition;
  deadLetter(input: {
    consumerId: string;
    journalSequence: number;
    attempt: number;
    owner: OperationalEventDeliveryOwner;
    settlementId: string;
    failureCode: string;
    now: string;
    maxDeadLetters: number;
  }): OperationalEventDeliveryTransition;
  acknowledgeGap(input: {
    consumerId: string;
    expectedCursor: number;
    earliestJournalSequence: number;
    owner: OperationalEventDeliveryOwner;
    settlementId: string;
    now: string;
  }): OperationalEventDeliveryTransition;
  discardSettlement(input: {
    consumerId: string;
    settlementId: string;
    ownerId: string;
  }): OperationalEventDeliveryTransition;
  deadLetters(consumerId: string): OperationalEventDeadLetterOutcome;
}

const activeOwners = new Set<string>();

export function releaseOperationalEventDeliveryOwner(ownerId: string): void {
  activeOwners.delete(ownerId);
}

function registryType(registry: OperationalEventTypeRegistry, type: string) {
  return registry.definitions.find(
    (definition) =>
      `${definition.namespace}.${definition.name}/v${definition.version}` ===
      type,
  );
}

function validateConfig(
  config: OperationalEventConsumerConfig,
  registry: OperationalEventTypeRegistry,
): { eventTypes: string[]; scopes: OperationalEventScope[] } | undefined {
  if (!CONSUMER_ID.test(config.consumerId)) return undefined;
  if (
    !Array.isArray(config.eventTypes) ||
    config.eventTypes.length < 1 ||
    config.eventTypes.length > 32 ||
    new Set(config.eventTypes).size !== config.eventTypes.length ||
    !Array.isArray(config.requiredScopes) ||
    config.requiredScopes.length > 8
  )
    return undefined;
  const eventTypes = [...config.eventTypes].sort();
  let canonicalScopes: OperationalEventScope[] | undefined;
  for (const type of eventTypes) {
    const definition = registryType(registry, type);
    if (!definition) return undefined;
    const checked = validateOperationalEventEnvelope(
      {
        schemaVersion: 'station.operational-event/v1',
        id: 'consumer-config-validation',
        type,
        producer: { id: 'station-server', version: '1' },
        occurredAt: '2000-01-01T00:00:00.000Z',
        scopes: config.requiredScopes,
        payload: { schema: definition.payloadSchema, data: {} },
        privacy: 'private',
        delivery: 'durable',
      },
      registry,
    );
    if (!checked.ok) return undefined;
    canonicalScopes ??= checked.event.scopes;
  }
  return { eventTypes, scopes: canonicalScopes ?? [] };
}

function ownerIsLive(
  record: {
    ownerId: string | null;
    ownerPid: number | null;
    ownerBirth: string | null;
    ownerIdentityKind: string | null;
  },
  processIdentity: OperationalEventProcessIdentity,
): boolean {
  if (!record.ownerId || !record.ownerPid) return false;
  if (record.ownerPid === process.pid) return activeOwners.has(record.ownerId);
  const observed = processIdentity.probe(record.ownerPid);
  if (observed.state === 'dead') return false;
  if (observed.state === 'unavailable') return true;
  return (
    record.ownerIdentityKind !== 'exact' ||
    !record.ownerBirth ||
    observed.identity.start === record.ownerBirth
  );
}

export function operationalEventIdempotencyKey(
  consumerId: string,
  eventId: string,
): string {
  return `operational-event:${createHash('sha256')
    .update(`${consumerId}\0${eventId}`)
    .digest('hex')}`;
}

function retryAt(now: string, attempt: number): string {
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
  return new Date(Date.parse(now) + delay).toISOString();
}

function deliveryIsValid(
  delivery: OperationalEventDeliveryRecord,
  registry: OperationalEventTypeRegistry,
  expectedEventTypes: ReadonlySet<string>,
  expectedScopeKeys: readonly string[],
): boolean {
  const checked = validateOperationalEventEnvelope(delivery.event, registry);
  const ownerIsCoherent =
    delivery.ownerIdentityKind === 'exact'
      ? Boolean(delivery.ownerBirth)
      : delivery.ownerIdentityKind === 'unverified' &&
        delivery.ownerBirth === null;
  const stateIsCoherent =
    delivery.state === 'claimed'
      ? Boolean(
          delivery.ownerId &&
            Number.isSafeInteger(delivery.ownerPid) &&
            delivery.ownerPid! > 0 &&
            ownerIsCoherent,
        )
      : delivery.ownerId === null &&
        delivery.ownerPid === null &&
        delivery.ownerBirth === null &&
        delivery.ownerIdentityKind === null &&
        delivery.nextAttemptAt !== null &&
        Number.isFinite(Date.parse(delivery.nextAttemptAt));
  return (
    CONSUMER_ID.test(delivery.consumerId) &&
    Number.isSafeInteger(delivery.journalSequence) &&
    delivery.journalSequence > 0 &&
    Number.isSafeInteger(delivery.attempt) &&
    delivery.attempt >= 1 &&
    stateIsCoherent &&
    checked.ok &&
    expectedEventTypes.has(checked.event.type) &&
    expectedScopeKeys.every((scopeKey) =>
      checked.event.scopes.some(
        (scope) => operationalEventScopeKey(scope) === scopeKey,
      ),
    ) &&
    checked.event.id === delivery.event.id &&
    delivery.idempotencyKey ===
      operationalEventIdempotencyKey(delivery.consumerId, checked.event.id)
  );
}

function gapOutcome(input: {
  coordinator: OperationalEventDeliveryCoordinator;
  consumerId: string;
  expectedCursor: number;
  earliestJournalSequence: number;
  owner: OperationalEventDeliveryOwner;
  now: () => string;
}): OperationalEventClaimOutcome {
  const settlementId = randomUUID();
  return {
    kind: 'gap',
    gap: Object.freeze({
      requestedAfterJournalSequence: input.expectedCursor,
      earliestAvailableJournalSequence: input.earliestJournalSequence,
      acknowledge: () =>
        input.coordinator.acknowledgeGap({
          consumerId: input.consumerId,
          expectedCursor: input.expectedCursor,
          earliestJournalSequence: input.earliestJournalSequence,
          owner: input.owner,
          settlementId,
          now: input.now(),
        }),
    }),
  };
}

function claimCapability(input: {
  coordinator: OperationalEventDeliveryCoordinator;
  delivery: OperationalEventDeliveryRecord;
  owner: OperationalEventDeliveryOwner;
  now: () => string;
}): OperationalEventDeliveryClaim {
  const { coordinator, delivery, owner, now } = input;
  const exact = {
    consumerId: delivery.consumerId,
    journalSequence: delivery.journalSequence,
    attempt: delivery.attempt,
    owner,
  };
  type SettlementIntent =
    | { kind: 'acknowledge'; settlementId: string; now: string }
    | {
        kind: 'retry';
        settlementId: string;
        failureCode: string;
        nextAttemptAt: string;
        now: string;
      }
    | {
        kind: 'dead-letter';
        settlementId: string;
        failureCode: string;
        now: string;
      };
  let intent: SettlementIntent | undefined;
  let applied = false;
  return Object.freeze({
    journalSequence: delivery.journalSequence,
    event: delivery.event,
    idempotencyKey: delivery.idempotencyKey,
    attempt: delivery.attempt,
    acknowledge: () => {
      intent ??= {
        kind: 'acknowledge',
        settlementId: randomUUID(),
        now: now(),
      };
      if (intent.kind !== 'acknowledge') return { kind: 'stale' } as const;
      if (applied) return { kind: 'applied' } as const;
      const result = coordinator.acknowledge({ ...exact, ...intent });
      if (result.kind === 'applied') applied = true;
      return result;
    },
    retry: (failureCode: string) => {
      if (!FAILURE_CODE.test(failureCode)) return { kind: 'invalid' } as const;
      if (!intent) {
        const at = now();
        intent = {
          kind: 'retry',
          settlementId: randomUUID(),
          failureCode,
          nextAttemptAt: retryAt(at, delivery.attempt),
          now: at,
        };
      }
      if (intent.kind !== 'retry' || intent.failureCode !== failureCode)
        return { kind: 'stale' } as const;
      if (applied) return { kind: 'applied' } as const;
      const result = coordinator.retry({
        ...exact,
        settlementId: intent.settlementId,
        failureCode: intent.failureCode,
        nextAttemptAt: intent.nextAttemptAt,
        now: intent.now,
      });
      if (result.kind === 'applied') applied = true;
      return result;
    },
    deadLetter: (failureCode: string) => {
      if (!FAILURE_CODE.test(failureCode)) return { kind: 'invalid' } as const;
      intent ??= {
        kind: 'dead-letter',
        settlementId: randomUUID(),
        failureCode,
        now: now(),
      };
      if (intent.kind !== 'dead-letter' || intent.failureCode !== failureCode)
        return { kind: 'stale' } as const;
      if (applied) return { kind: 'applied' } as const;
      const result = coordinator.deadLetter({
        ...exact,
        settlementId: intent.settlementId,
        failureCode: intent.failureCode,
        now: intent.now,
        maxDeadLetters: MAX_OPERATIONAL_EVENT_DEAD_LETTERS,
      });
      if (result.kind === 'applied') applied = true;
      return result;
    },
  });
}

/**
 * Opens one scope-bound durable consumer without exposing cursor or owner keys.
 * Registration policy and grants remain a separate archive#1525 Adapter.
 */
export function openOperationalEventConsumer(input: {
  coordinator: OperationalEventDeliveryCoordinator;
  config: OperationalEventConsumerConfig;
  registry?: OperationalEventTypeRegistry;
  processIdentity?: OperationalEventProcessIdentity;
  owner?: OperationalEventDeliveryOwner;
  now?: () => string;
}): OperationalEventConsumerOpenOutcome {
  const registry = input.registry ?? DEFAULT_OPERATIONAL_EVENT_TYPE_REGISTRY;
  const processIdentity = input.processIdentity ?? {
    exact: exactProcessIdentity,
    probe: probeExactProcessIdentity,
  };
  const canonical = validateConfig(input.config, registry);
  if (!canonical) return { kind: 'invalid' };
  const identity = processIdentity.exact(process.pid);
  const owner =
    input.owner ??
    (identity
      ? {
          id: randomUUID(),
          pid: process.pid,
          birth: identity.start,
          identityKind: 'exact' as const,
        }
      : {
          id: randomUUID(),
          pid: process.pid,
          identityKind: 'unverified' as const,
        });
  const now = input.now ?? (() => new Date().toISOString());
  const scopeKeys = canonical.scopes.map(operationalEventScopeKey).sort();
  const eventTypeSet = new Set(canonical.eventTypes);
  const configFingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        eventTypes: canonical.eventTypes,
        requiredScopes: scopeKeys,
      }),
    )
    .digest('hex');
  const opened = input.coordinator.open({
    consumerId: input.config.consumerId,
    configFingerprint,
    eventTypes: canonical.eventTypes,
    scopeKeys,
    now: now(),
    maxConsumers: MAX_OPERATIONAL_EVENT_CONSUMERS,
  });
  if (opened !== 'opened') return { kind: opened };
  activeOwners.add(owner.id);
  let closed = false;

  const consumer: OperationalEventConsumer = Object.freeze({
    claim(): OperationalEventClaimOutcome {
      if (closed) return { kind: 'unavailable' };
      let current = input.coordinator.current(input.config.consumerId);
      if (current.kind === 'unavailable') return current;
      if (current.settlement) {
        if (
          current.settlement.ownerId !== owner.id &&
          ownerIsLive(current.settlement, processIdentity)
        )
          return { kind: 'busy' };
        const discarded = input.coordinator.discardSettlement({
          consumerId: input.config.consumerId,
          settlementId: current.settlement.settlementId,
          ownerId: current.settlement.ownerId,
        });
        if (discarded.kind === 'unavailable') return { kind: 'unavailable' };
        current = input.coordinator.current(input.config.consumerId);
        if (current.kind === 'unavailable') return current;
        if (current.settlement) return { kind: 'busy' };
      }
      if (current.active) {
        const active = current.active;
        if (!deliveryIsValid(active, registry, eventTypeSet, scopeKeys))
          return { kind: 'unavailable' };
        const due =
          active.state === 'retry' &&
          active.nextAttemptAt !== null &&
          Date.parse(active.nextAttemptAt) <= Date.parse(now());
        if (active.state === 'retry' && !due)
          return {
            kind: 'waiting',
            nextAttemptAt: active.nextAttemptAt!,
          };
        if (ownerIsLive(active, processIdentity)) {
          if (active.ownerId !== owner.id) return { kind: 'busy' };
          return {
            kind: 'delivery',
            claim: claimCapability({
              coordinator: input.coordinator,
              delivery: active,
              owner,
              now,
            }),
          };
        }
        const reclaimed = input.coordinator.reclaim({
          consumerId: active.consumerId,
          journalSequence: active.journalSequence,
          expectedAttempt: active.attempt,
          expectedOwnerId: active.ownerId,
          owner,
          now: now(),
          maxAttempts: MAX_OPERATIONAL_EVENT_DELIVERY_ATTEMPTS,
        });
        if (reclaimed.kind === 'claimed')
          if (
            !deliveryIsValid(
              reclaimed.delivery,
              registry,
              eventTypeSet,
              scopeKeys,
            )
          )
            return { kind: 'unavailable' };
          else
            return {
              kind: 'delivery',
              claim: claimCapability({
                coordinator: input.coordinator,
                delivery: reclaimed.delivery,
                owner,
                now,
              }),
            };
        if (reclaimed.kind === 'dead-lettered')
          return {
            kind: 'dead-lettered',
            journalSequence: active.journalSequence,
          };
        return reclaimed.kind === 'unavailable'
          ? { kind: 'unavailable' }
          : { kind: 'busy' };
      }
      const claimed = input.coordinator.claimNext({
        consumerId: input.config.consumerId,
        owner,
        now: now(),
      });
      if (claimed.kind === 'gap')
        return gapOutcome({
          coordinator: input.coordinator,
          consumerId: input.config.consumerId,
          expectedCursor: claimed.cursorSequence,
          earliestJournalSequence: claimed.earliestJournalSequence,
          owner,
          now,
        });
      if (claimed.kind !== 'claimed') return claimed;
      if (!deliveryIsValid(claimed.delivery, registry, eventTypeSet, scopeKeys))
        return { kind: 'unavailable' };
      return {
        kind: 'delivery',
        claim: claimCapability({
          coordinator: input.coordinator,
          delivery: claimed.delivery,
          owner,
          now,
        }),
      };
    },
    deadLetters: (): OperationalEventDeadLetterOutcome =>
      closed
        ? { kind: 'unavailable' }
        : input.coordinator.deadLetters(input.config.consumerId),
    close: () => {
      if (closed) return;
      closed = true;
      releaseOperationalEventDeliveryOwner(owner.id);
    },
  });
  return { kind: 'opened', consumer };
}
