import type {
  OperationalEventEnvelope,
  OperationalEventProjection,
  OperationalEventScope,
} from '@kontourai/station-contracts/operational-event';
import type {
  OperationalEventConsumer,
  OperationalEventConsumerConfig,
  OperationalEventConsumerOpenOutcome,
  OperationalEventDeliveryTransition,
} from './operational-event-delivery.js';

export type OperationalEventSubscriberClass =
  | 'built-in'
  | 'trusted-plugin'
  | 'sandboxed-plugin'
  | 'analytics'
  | 'flow-kit';

export type OperationalEventSubscriptionPurpose =
  | 'ui-projection'
  | 'plugin-observation'
  | 'analytics'
  | 'flow-trigger'
  | 'verification';

export interface OperationalEventSubscriptionDeclaration {
  subscriber: {
    id: string;
    version: string;
    class: OperationalEventSubscriberClass;
  };
  purpose: OperationalEventSubscriptionPurpose;
  eventTypes: readonly string[];
  requiredScopes: readonly OperationalEventScope[];
}

export type OperationalEventSubscriptionProjection = OperationalEventProjection;

export type OperationalEventSubscriptionAuthorization =
  | {
      kind: 'granted';
      consumerId: string;
      projection: 'redacted' | 'metadata' | 'envelope';
    }
  | { kind: 'denied' };

/** Host-owned policy Adapter. Declarations never carry their own grant. */
export interface OperationalEventSubscriptionAuthorizer {
  authorize(
    declaration: OperationalEventSubscriptionDeclaration,
  ): OperationalEventSubscriptionAuthorization;
}

export interface OperationalEventSubscriberAdapter {
  observe(input: {
    projection: OperationalEventSubscriptionProjection;
    idempotencyKey: string;
    attempt: number;
    signal: AbortSignal;
  }): Promise<
    | { kind: 'accepted' }
    | { kind: 'retry'; failureCode: string }
    | { kind: 'rejected'; failureCode: string }
  >;
}

export type OperationalEventSubscriptionDispatchOutcome =
  | { kind: 'delivered' | 'retrying' | 'dead-lettered' }
  | {
      kind: 'empty' | 'busy' | 'waiting' | 'gap' | 'revoked' | 'unavailable';
    };

export interface OperationalEventSubscription {
  dispatchOne(): Promise<OperationalEventSubscriptionDispatchOutcome>;
  close(): OperationalEventSubscriptionCloseOutcome;
}

export type OperationalEventSubscriptionCloseOutcome =
  | { kind: 'closed' }
  | { kind: 'pending' | 'unavailable' };

export type OperationalEventSubscriptionOpenOutcome =
  | { kind: 'opened'; subscription: OperationalEventSubscription }
  | { kind: 'denied' | 'invalid' | 'conflict' | 'capacity' | 'unavailable' };

export interface OperationalEventSubscriptionRegistry {
  open(input: {
    declaration: OperationalEventSubscriptionDeclaration;
    adapter: OperationalEventSubscriberAdapter;
  }): OperationalEventSubscriptionOpenOutcome;
  close(): OperationalEventSubscriptionCloseOutcome;
}

const SUBSCRIBER_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;
const FAILURE_CODE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;
const SUBSCRIBER_CLASSES = new Set<OperationalEventSubscriberClass>([
  'built-in',
  'trusted-plugin',
  'sandboxed-plugin',
  'analytics',
  'flow-kit',
]);
const PURPOSES = new Set<OperationalEventSubscriptionPurpose>([
  'ui-projection',
  'plugin-observation',
  'analytics',
  'flow-trigger',
  'verification',
]);

function declarationIsValid(
  declaration: OperationalEventSubscriptionDeclaration,
): boolean {
  if (
    !SUBSCRIBER_ID.test(declaration.subscriber.id) ||
    !VERSION.test(declaration.subscriber.version) ||
    !SUBSCRIBER_CLASSES.has(declaration.subscriber.class) ||
    !PURPOSES.has(declaration.purpose) ||
    !Array.isArray(declaration.eventTypes) ||
    !declaration.eventTypes.every((type) => typeof type === 'string') ||
    !Array.isArray(declaration.requiredScopes) ||
    declaration.eventTypes.length < 1 ||
    declaration.eventTypes.length > 32 ||
    new Set(declaration.eventTypes).size !== declaration.eventTypes.length ||
    declaration.requiredScopes.length > 8
  )
    return false;
  if (
    declaration.subscriber.class === 'analytics' &&
    declaration.purpose !== 'analytics'
  )
    return false;
  if (
    declaration.subscriber.class === 'sandboxed-plugin' &&
    declaration.purpose !== 'plugin-observation'
  )
    return false;
  return true;
}

function project(
  event: OperationalEventEnvelope,
  projection: 'redacted' | 'metadata' | 'envelope',
): OperationalEventSubscriptionProjection {
  const cloned = structuredClone(event);
  if (projection === 'envelope') return { kind: 'envelope', event: cloned };
  if (projection === 'redacted') {
    const { schemaVersion, id, type, producer, occurredAt, privacy, delivery } =
      cloned;
    return {
      kind: 'redacted',
      event: {
        schemaVersion,
        id,
        type,
        producer,
        occurredAt,
        privacy,
        delivery,
      },
    };
  }
  const { payload: _payload, ...metadata } = cloned;
  return { kind: 'metadata', event: metadata };
}

function settle(
  transition: OperationalEventDeliveryTransition,
  appliedKind: 'delivered' | 'retrying' | 'dead-lettered',
): OperationalEventSubscriptionDispatchOutcome {
  return transition.kind === 'applied'
    ? { kind: appliedKind }
    : { kind: 'unavailable' };
}

function validFailureCode(value: unknown): value is string {
  return typeof value === 'string' && FAILURE_CODE.test(value);
}

function validAuthorization(
  value: unknown,
): value is OperationalEventSubscriptionAuthorization {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'denied') return true;
  return (
    candidate.kind === 'granted' &&
    typeof candidate.consumerId === 'string' &&
    typeof candidate.projection === 'string' &&
    ['redacted', 'metadata', 'envelope'].includes(candidate.projection)
  );
}

/**
 * Composes one authorized declaration over the private delivery capability.
 * The subscriber never receives the consumer, claim, cursor, or settlement
 * methods and therefore cannot widen its policy after admission.
 */
export function openOperationalEventSubscription(input: {
  declaration: OperationalEventSubscriptionDeclaration;
  authorizer: OperationalEventSubscriptionAuthorizer;
  openConsumer(
    config: OperationalEventConsumerConfig,
  ): OperationalEventConsumerOpenOutcome;
  adapter: OperationalEventSubscriberAdapter;
  dispatchTimeoutMs?: number;
}): OperationalEventSubscriptionOpenOutcome {
  let declaration: OperationalEventSubscriptionDeclaration;
  try {
    declaration = structuredClone(input.declaration);
    if (!declarationIsValid(declaration)) return { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
  let authorization: OperationalEventSubscriptionAuthorization;
  try {
    const authorized = structuredClone(
      input.authorizer.authorize(structuredClone(declaration)),
    );
    if (!validAuthorization(authorized)) return { kind: 'unavailable' };
    authorization = authorized;
  } catch {
    return { kind: 'unavailable' };
  }
  if (authorization.kind === 'denied') return authorization;
  if (
    (declaration.subscriber.class === 'analytics' &&
      authorization.projection !== 'redacted') ||
    (declaration.subscriber.class === 'sandboxed-plugin' &&
      authorization.projection !== 'metadata')
  )
    return { kind: 'denied' };

  let opened: OperationalEventConsumerOpenOutcome;
  try {
    opened = input.openConsumer({
      consumerId: authorization.consumerId,
      eventTypes: [...declaration.eventTypes],
      requiredScopes: declaration.requiredScopes,
    });
  } catch {
    return { kind: 'unavailable' };
  }
  if (opened.kind !== 'opened') return opened;
  const consumer: OperationalEventConsumer = opened.consumer;
  let closed = false;
  let closing = false;
  let dispatching = false;
  let activeAbort: AbortController | undefined;
  let pendingSettlement:
    | {
        apply: () => OperationalEventDeliveryTransition;
        appliedKind: 'delivered' | 'retrying' | 'dead-lettered';
      }
    | undefined;
  let lingeringObservation: Promise<void> | undefined;
  const dispatchTimeoutMs =
    Number.isSafeInteger(input.dispatchTimeoutMs) &&
    input.dispatchTimeoutMs! > 0 &&
    input.dispatchTimeoutMs! <= DEFAULT_DISPATCH_TIMEOUT_MS
      ? input.dispatchTimeoutMs!
      : DEFAULT_DISPATCH_TIMEOUT_MS;

  const reauthorize = (): 'granted' | 'revoked' | 'unavailable' => {
    try {
      const current = structuredClone(
        input.authorizer.authorize(structuredClone(declaration)),
      );
      if (!validAuthorization(current)) return 'unavailable';
      if (current.kind === 'denied') return 'revoked';
      return current.consumerId === authorization.consumerId &&
        current.projection === authorization.projection
        ? 'granted'
        : 'revoked';
    } catch {
      return 'unavailable';
    }
  };

  const finishClose = (): OperationalEventSubscriptionCloseOutcome => {
    if (closed) return { kind: 'closed' };
    if (dispatching || pendingSettlement || lingeringObservation)
      return { kind: 'pending' };
    closed = true;
    consumer.close();
    return { kind: 'closed' };
  };

  const retryPendingSettlement = ():
    | OperationalEventSubscriptionDispatchOutcome
    | undefined => {
    if (!pendingSettlement) return undefined;
    const pending = pendingSettlement;
    const transition = pending.apply();
    const outcome = settle(transition, pending.appliedKind);
    if (transition.kind === 'applied') pendingSettlement = undefined;
    return outcome;
  };

  const retainSettlement = (
    apply: () => OperationalEventDeliveryTransition,
    appliedKind: 'delivered' | 'retrying' | 'dead-lettered',
  ): OperationalEventSubscriptionDispatchOutcome => {
    pendingSettlement = { apply, appliedKind };
    return retryPendingSettlement()!;
  };

  return {
    kind: 'opened',
    subscription: Object.freeze<OperationalEventSubscription>({
      async dispatchOne(): Promise<OperationalEventSubscriptionDispatchOutcome> {
        if (closed || closing) return { kind: 'unavailable' };
        if (dispatching) return { kind: 'busy' };
        const pending = retryPendingSettlement();
        if (pending) return pending;
        if (lingeringObservation) return { kind: 'busy' };
        const currentAuthorization = reauthorize();
        if (currentAuthorization === 'unavailable')
          return { kind: 'unavailable' };
        if (currentAuthorization === 'revoked') {
          closing = true;
          finishClose();
          return { kind: 'revoked' };
        }
        dispatching = true;
        try {
          const claimed = consumer.claim();
          if (claimed.kind === 'gap') return { kind: 'gap' };
          if (claimed.kind === 'waiting') return { kind: 'waiting' };
          if (claimed.kind !== 'delivery') return { kind: claimed.kind };
          const controller = new AbortController();
          activeAbort = controller;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let invocationStarted = false;
          type Observation =
            | Awaited<ReturnType<OperationalEventSubscriberAdapter['observe']>>
            | {
                kind: 'not-invoked';
                reason: 'closed' | 'revoked' | 'authorization-unavailable';
              };
          let observationSettled = false;
          const observation = Promise.resolve().then(
            async (): Promise<Observation> => {
              if (controller.signal.aborted)
                return { kind: 'not-invoked', reason: 'closed' };
              const invocationAuthorization = reauthorize();
              if (invocationAuthorization === 'revoked')
                return { kind: 'not-invoked', reason: 'revoked' };
              if (invocationAuthorization === 'unavailable')
                return {
                  kind: 'not-invoked',
                  reason: 'authorization-unavailable',
                };
              invocationStarted = true;
              return input.adapter.observe({
                projection: project(
                  claimed.claim.event,
                  authorization.projection,
                ),
                idempotencyKey: claimed.claim.idempotencyKey,
                attempt: claimed.claim.attempt,
                signal: controller.signal,
              });
            },
          );
          void observation.then(
            () => {
              observationSettled = true;
            },
            () => {
              observationSettled = true;
            },
          );
          const retainLingeringObservation = (): void => {
            if (observationSettled || lingeringObservation) return;
            const retained = observation
              .then(
                () => undefined,
                () => undefined,
              )
              .finally(() => {
                if (lingeringObservation === retained)
                  lingeringObservation = undefined;
                if (closing) finishClose();
              });
            lingeringObservation = retained;
          };
          const result = await Promise.race([
            observation.then(
              (value) => ({ kind: 'result' as const, value }),
              () => ({ kind: 'threw' as const }),
            ),
            new Promise<{ kind: 'timeout' } | { kind: 'closed' }>((resolve) => {
              controller.signal.addEventListener(
                'abort',
                () => resolve({ kind: closing ? 'closed' : 'timeout' }),
                { once: true },
              );
              timer = setTimeout(() => controller.abort(), dispatchTimeoutMs);
            }),
          ]);
          if (timer) clearTimeout(timer);
          activeAbort = undefined;
          if (result.kind === 'result' && result.value.kind === 'not-invoked') {
            if (result.value.reason === 'revoked') {
              closing = true;
              return retainSettlement(
                () => claimed.claim.deadLetter('subscriber_revoked'),
                'dead-lettered',
              );
            }
            if (result.value.reason === 'authorization-unavailable')
              return retainSettlement(
                () =>
                  claimed.claim.retry('subscriber_authorization_unavailable'),
                'retrying',
              );
            return retainSettlement(
              () => claimed.claim.retry('subscriber_closed_before_invocation'),
              'retrying',
            );
          }
          if (!invocationStarted)
            return retainSettlement(
              () => claimed.claim.retry('subscriber_closed_before_invocation'),
              'retrying',
            );
          if (result.kind === 'closed') {
            retainLingeringObservation();
            return retainSettlement(
              () => claimed.claim.deadLetter('subscriber_closed'),
              'dead-lettered',
            );
          }
          if (result.kind === 'timeout') {
            retainLingeringObservation();
            return retainSettlement(
              () => claimed.claim.deadLetter('subscriber_timeout'),
              'dead-lettered',
            );
          }
          if (result.kind === 'threw')
            return retainSettlement(
              () => claimed.claim.retry('subscriber_unavailable'),
              'retrying',
            );
          const observed = result.value;
          if (observed?.kind === 'accepted')
            return retainSettlement(
              () => claimed.claim.acknowledge(),
              'delivered',
            );
          if (
            observed?.kind === 'retry' &&
            validFailureCode(observed.failureCode)
          )
            return retainSettlement(
              () => claimed.claim.retry(observed.failureCode),
              'retrying',
            );
          const failureCode =
            observed?.kind === 'rejected' &&
            validFailureCode(observed.failureCode)
              ? observed.failureCode
              : 'subscriber_invalid_outcome';
          return retainSettlement(
            () => claimed.claim.deadLetter(failureCode),
            'dead-lettered',
          );
        } finally {
          activeAbort = undefined;
          dispatching = false;
          if (closing) finishClose();
        }
      },
      close() {
        if (closed) return { kind: 'closed' };
        closing = true;
        activeAbort?.abort();
        if (dispatching) return { kind: 'pending' };
        const settlement = retryPendingSettlement();
        if (settlement?.kind === 'unavailable') return { kind: 'unavailable' };
        return finishClose();
      },
    }),
  };
}

/** EventStore composition target: one host policy, many bounded declarations. */
export function createOperationalEventSubscriptionRegistry(input: {
  authorizer: OperationalEventSubscriptionAuthorizer;
  openConsumer(
    config: OperationalEventConsumerConfig,
  ): OperationalEventConsumerOpenOutcome;
}): OperationalEventSubscriptionRegistry {
  const active = new Set<OperationalEventSubscription>();
  let closed = false;
  return Object.freeze<OperationalEventSubscriptionRegistry>({
    open(request: {
      declaration: OperationalEventSubscriptionDeclaration;
      adapter: OperationalEventSubscriberAdapter;
    }): OperationalEventSubscriptionOpenOutcome {
      if (closed) return { kind: 'unavailable' };
      const opened = openOperationalEventSubscription({
        ...request,
        authorizer: input.authorizer,
        openConsumer: input.openConsumer,
      });
      if (opened.kind !== 'opened') return opened;
      const inner = opened.subscription;
      const subscription: OperationalEventSubscription =
        Object.freeze<OperationalEventSubscription>({
          dispatchOne: () => inner.dispatchOne(),
          close() {
            if (!active.has(subscription)) return { kind: 'closed' };
            const outcome = inner.close();
            if (outcome.kind === 'closed') active.delete(subscription);
            return outcome;
          },
        });
      active.add(subscription);
      return { kind: 'opened', subscription };
    },
    close() {
      if (closed && active.size === 0) return { kind: 'closed' };
      closed = true;
      let outcome: OperationalEventSubscriptionCloseOutcome = {
        kind: 'closed',
      };
      for (const subscription of [...active]) {
        const closedSubscription = subscription.close();
        if (closedSubscription.kind === 'unavailable')
          outcome = closedSubscription;
        else if (
          closedSubscription.kind === 'pending' &&
          outcome.kind === 'closed'
        )
          outcome = closedSubscription;
      }
      return outcome;
    },
  });
}
