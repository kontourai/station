import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationalEventEnvelope } from '@kontourai/station-contracts/operational-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from '../../orchestration/event-store.js';
import type {
  OperationalEventClaimOutcome,
  OperationalEventConsumer,
} from '../operational-event-delivery.js';
import { openOperationalEventSubscription } from '../operational-event-subscriptions.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function event(): OperationalEventEnvelope {
  return {
    schemaVersion: 'station.operational-event/v1',
    id: 'event-1',
    type: 'station.runtime.lifecycle/v1',
    producer: { id: 'station-server', version: '1' },
    occurredAt: '2026-08-16T00:00:00.000Z',
    scopes: [{ kind: 'project', projectId: 'project-1' }],
    payload: {
      schema: 'station.runtime.lifecycle/v1',
      data: { phase: 'ready' },
    },
    privacy: 'private',
    delivery: 'durable',
  };
}

function declaration(
  subscriberClass:
    | 'built-in'
    | 'trusted-plugin'
    | 'sandboxed-plugin'
    | 'analytics'
    | 'flow-kit' = 'built-in',
) {
  return {
    subscriber: {
      id: 'subscriber-1',
      version: '1.0.0',
      class: subscriberClass,
    },
    purpose:
      subscriberClass === 'analytics'
        ? ('analytics' as const)
        : subscriberClass === 'sandboxed-plugin'
          ? ('plugin-observation' as const)
          : ('ui-projection' as const),
    eventTypes: ['station.runtime.lifecycle/v1'],
    requiredScopes: [{ kind: 'project' as const, projectId: 'project-1' }],
  };
}

function consumer(outcome: OperationalEventClaimOutcome) {
  return {
    claim: vi.fn(() => outcome),
    deadLetters: vi.fn(() => ({ kind: 'available' as const, entries: [] })),
    close: vi.fn(),
  } satisfies OperationalEventConsumer;
}

describe('OperationalEventSubscriptions', () => {
  it('composes authorization and durable delivery through EventStore', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'station-event-subscription-'),
    );
    directories.push(directory);
    const store = new EventStore(join(directory, 'events.sqlite'));
    expect(
      store.createOperationalEventPublisher().append(event()),
    ).toMatchObject({ kind: 'appended' });
    const observe = vi.fn(async () => ({ kind: 'accepted' as const }));
    const registry = store.createOperationalEventSubscriptionRegistry({
      authorize: (requested) =>
        requested.subscriber.id === 'subscriber-1'
          ? {
              kind: 'granted',
              consumerId: 'subscription.subscriber-1',
              projection: 'envelope',
            }
          : { kind: 'denied' },
    });
    const opened = registry.open({
      declaration: declaration(),
      adapter: { observe },
    });
    expect(opened.kind).toBe('opened');
    if (opened.kind !== 'opened') throw new Error('subscription not opened');
    await expect(opened.subscription.dispatchOne()).resolves.toEqual({
      kind: 'delivered',
    });
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.any(String),
        projection: expect.objectContaining({ kind: 'envelope' }),
      }),
    );
    registry.close();
    await expect(opened.subscription.dispatchOne()).resolves.toEqual({
      kind: 'unavailable',
    });
    store.close();
  });

  it('defers EventStore shutdown until an in-flight subscription settles', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'station-event-subscription-shutdown-'),
    );
    directories.push(directory);
    const databasePath = join(directory, 'events.sqlite');
    const firstStore = new EventStore(databasePath);
    const secondStore = new EventStore(databasePath);
    expect(
      firstStore.createOperationalEventPublisher().append(event()),
    ).toMatchObject({ kind: 'appended' });
    const authorize = () => ({
      kind: 'granted' as const,
      consumerId: 'subscription.shutdown',
      projection: 'envelope' as const,
    });
    const firstRegistry = firstStore.createOperationalEventSubscriptionRegistry(
      { authorize },
    );
    let finishObservation!: (value: { kind: 'accepted' }) => void;
    const observe = vi.fn(
      () =>
        new Promise<{ kind: 'accepted' }>((resolve) => {
          finishObservation = resolve;
        }),
    );
    const first = firstRegistry.open({
      declaration: declaration(),
      adapter: { observe },
    });
    if (first.kind !== 'opened') throw new Error('subscription not opened');
    const dispatch = first.subscription.dispatchOne();
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());

    expect(firstStore.close()).toEqual({ kind: 'pending' });
    const secondRegistry =
      secondStore.createOperationalEventSubscriptionRegistry({ authorize });
    const secondObserve = vi.fn(async () => ({ kind: 'accepted' as const }));
    const second = secondRegistry.open({
      declaration: declaration(),
      adapter: { observe: secondObserve },
    });
    if (second.kind !== 'opened') throw new Error('subscription not opened');
    await expect(second.subscription.dispatchOne()).resolves.toEqual({
      kind: 'busy',
    });
    expect(secondObserve).not.toHaveBeenCalled();

    await expect(dispatch).resolves.toEqual({ kind: 'dead-lettered' });
    expect(firstStore.close()).toEqual({ kind: 'pending' });
    finishObservation({ kind: 'accepted' });
    await vi.waitFor(() =>
      expect(firstStore.close()).toEqual({ kind: 'closed' }),
    );
    await expect(second.subscription.dispatchOne()).resolves.toEqual({
      kind: 'empty',
    });
    expect(secondObserve).not.toHaveBeenCalled();
    expect(secondStore.close()).toEqual({ kind: 'closed' });
  });

  it('removes closed subscription consumers from EventStore tracking', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'station-event-subscription-tracking-'),
    );
    directories.push(directory);
    const store = new EventStore(join(directory, 'events.sqlite'));
    const registry = store.createOperationalEventSubscriptionRegistry({
      authorize: () => ({
        kind: 'granted',
        consumerId: 'subscription.tracking',
        projection: 'metadata',
      }),
    });
    const opened = registry.open({
      declaration: declaration(),
      adapter: { observe: vi.fn() },
    });
    if (opened.kind !== 'opened') throw new Error('subscription not opened');
    const tracked = store as unknown as {
      operationalEventConsumers: Set<OperationalEventConsumer>;
      operationalEventSubscriptionRegistries: Set<unknown>;
    };
    expect(tracked.operationalEventConsumers.size).toBe(1);
    expect(tracked.operationalEventSubscriptionRegistries.size).toBe(1);
    expect(opened.subscription.close()).toEqual({ kind: 'closed' });
    expect(tracked.operationalEventConsumers.size).toBe(0);
    expect(registry.close()).toEqual({ kind: 'closed' });
    expect(tracked.operationalEventSubscriptionRegistries.size).toBe(0);
    expect(store.close()).toEqual({ kind: 'closed' });
  });

  it('projects redacted facts to analytics and settles accepted delivery', async () => {
    const acknowledge = vi.fn(() => ({ kind: 'applied' as const }));
    const target = consumer({
      kind: 'delivery',
      claim: {
        journalSequence: 1,
        event: event(),
        idempotencyKey: 'delivery-key',
        attempt: 1,
        acknowledge,
        retry: vi.fn(),
        deadLetter: vi.fn(),
      },
    });
    const observe = vi.fn(async () => ({ kind: 'accepted' as const }));
    const opened = openOperationalEventSubscription({
      declaration: declaration('analytics'),
      authorizer: {
        authorize: () => ({
          kind: 'granted',
          consumerId: 'analytics-1',
          projection: 'redacted',
        }),
      },
      openConsumer: () => ({ kind: 'opened', consumer: target }),
      adapter: { observe },
    });
    expect(opened.kind).toBe('opened');
    if (opened.kind !== 'opened') throw new Error('subscription not opened');
    await expect(opened.subscription.dispatchOne()).resolves.toEqual({
      kind: 'delivered',
    });
    expect(observe).toHaveBeenCalledWith({
      projection: {
        kind: 'redacted',
        event: expect.not.objectContaining({
          payload: expect.anything(),
          scopes: expect.anything(),
        }),
      },
      idempotencyKey: 'delivery-key',
      attempt: 1,
      signal: expect.any(AbortSignal),
    });
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it.each(['analytics', 'sandboxed-plugin'] as const)(
    'refuses an envelope grant for %s before opening delivery',
    (subscriberClass) => {
      const openConsumer = vi.fn();
      expect(
        openOperationalEventSubscription({
          declaration: declaration(subscriberClass),
          authorizer: {
            authorize: () => ({
              kind: 'granted',
              consumerId: 'consumer-1',
              projection: 'envelope',
            }),
          },
          openConsumer,
          adapter: { observe: vi.fn() },
        }),
      ).toEqual({ kind: 'denied' });
      expect(openConsumer).not.toHaveBeenCalled();
    },
  );

  it('totalizes a throwing host authorizer before opening delivery', () => {
    const openConsumer = vi.fn();
    expect(
      openOperationalEventSubscription({
        declaration: declaration(),
        authorizer: {
          authorize: () => {
            throw new Error('policy unavailable');
          },
        },
        openConsumer,
        adapter: { observe: vi.fn() },
      }),
    ).toEqual({ kind: 'unavailable' });
    expect(openConsumer).not.toHaveBeenCalled();
  });

  it('rejects a malformed authorization result without opening delivery', () => {
    const openConsumer = vi.fn();
    expect(
      openOperationalEventSubscription({
        declaration: declaration(),
        authorizer: { authorize: () => null as never },
        openConsumer,
        adapter: { observe: vi.fn() },
      }),
    ).toEqual({ kind: 'unavailable' });
    expect(openConsumer).not.toHaveBeenCalled();
  });

  it('uses immutable declaration and authorization snapshots', async () => {
    const mutableDeclaration = declaration('analytics');
    const mutableAuthorization = {
      kind: 'granted' as const,
      consumerId: 'analytics-1',
      projection: 'redacted' as const,
    };
    let snapshotProjectionKind: string | undefined;
    const observe = vi.fn(
      async ({ projection }: { projection: { kind: string } }) => {
        snapshotProjectionKind = projection.kind;
        return { kind: 'accepted' as const };
      },
    );
    const target = consumer({
      kind: 'delivery',
      claim: {
        journalSequence: 1,
        event: event(),
        idempotencyKey: 'delivery-key',
        attempt: 1,
        acknowledge: vi.fn(() => ({ kind: 'applied' as const })),
        retry: vi.fn(),
        deadLetter: vi.fn(),
      },
    });
    const openConsumer = vi.fn(() => ({
      kind: 'opened' as const,
      consumer: target,
    }));
    let authorizationCalls = 0;
    const opened = openOperationalEventSubscription({
      declaration: mutableDeclaration,
      authorizer: {
        authorize: (candidate) => {
          authorizationCalls += 1;
          (candidate.requiredScopes as unknown[]).splice(0);
          candidate.subscriber.class = 'built-in';
          mutableDeclaration.requiredScopes.splice(0);
          return authorizationCalls === 1
            ? mutableAuthorization
            : {
                kind: 'granted' as const,
                consumerId: 'analytics-1',
                projection: 'redacted' as const,
              };
        },
      },
      openConsumer,
      adapter: { observe },
    });
    mutableAuthorization.projection = 'envelope' as never;
    if (opened.kind !== 'opened') throw new Error('subscription not opened');
    await opened.subscription.dispatchOne();
    expect(openConsumer).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredScopes: [{ kind: 'project', projectId: 'project-1' }],
      }),
    );
    expect(snapshotProjectionKind).toBe('redacted');
  });

  it('stops before claiming when host authorization is revoked', async () => {
    let granted = true;
    const target = consumer({ kind: 'empty' });
    const opened = openOperationalEventSubscription({
      declaration: declaration(),
      authorizer: {
        authorize: () =>
          granted
            ? {
                kind: 'granted',
                consumerId: 'consumer-1',
                projection: 'metadata',
              }
            : { kind: 'denied' },
      },
      openConsumer: () => ({ kind: 'opened', consumer: target }),
      adapter: { observe: vi.fn() },
    });
    if (opened.kind !== 'opened') throw new Error('subscription not opened');
    granted = false;

    await expect(opened.subscription.dispatchOne()).resolves.toEqual({
      kind: 'revoked',
    });
    expect(target.claim).not.toHaveBeenCalled();
    expect(target.close).toHaveBeenCalledOnce();
  });

  it('re-authorizes after claim and never invokes a newly revoked Adapter', async () => {
    let authorizationCalls = 0;
    const deadLetter = vi.fn(() => ({ kind: 'applied' as const }));
    const target = consumer({
      kind: 'delivery',
      claim: {
        journalSequence: 1,
        event: event(),
        idempotencyKey: 'delivery-key',
        attempt: 1,
        acknowledge: vi.fn(() => ({ kind: 'applied' as const })),
        retry: vi.fn(),
        deadLetter,
      },
    });
    const observe = vi.fn(async () => ({ kind: 'accepted' as const }));
    const opened = openOperationalEventSubscription({
      declaration: declaration(),
      authorizer: {
        authorize: () => {
          authorizationCalls += 1;
          return authorizationCalls < 3
            ? {
                kind: 'granted' as const,
                consumerId: 'consumer-1',
                projection: 'metadata' as const,
              }
            : { kind: 'denied' as const };
        },
      },
      openConsumer: () => ({ kind: 'opened', consumer: target }),
      adapter: { observe },
    });
    if (opened.kind !== 'opened') throw new Error('subscription not opened');

    await expect(opened.subscription.dispatchOne()).resolves.toEqual({
      kind: 'dead-lettered',
    });
    expect(observe).not.toHaveBeenCalled();
    expect(deadLetter).toHaveBeenCalledWith('subscriber_revoked');
    expect(target.close).toHaveBeenCalledOnce();
  });

  it('does not claim while current authorization is unavailable', async () => {
    let available = true;
    const target = consumer({ kind: 'empty' });
    const opened = openOperationalEventSubscription({
      declaration: declaration(),
      authorizer: {
        authorize: () => {
          if (!available) throw new Error('grant store unavailable');
          return {
            kind: 'granted',
            consumerId: 'consumer-1',
            projection: 'metadata',
          };
        },
      },
      openConsumer: () => ({ kind: 'opened', consumer: target }),
      adapter: { observe: vi.fn() },
    });
    if (opened.kind !== 'opened') throw new Error('subscription not opened');
    available = false;
    await expect(opened.subscription.dispatchOne()).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(target.claim).not.toHaveBeenCalled();
    available = true;
    await expect(opened.subscription.dispatchOne()).resolves.toEqual({
      kind: 'empty',
    });
  });

  it('serializes dispatch and settles before close releases ownership', async () => {
    const deadLetter = vi.fn(() => ({ kind: 'applied' as const }));
    const target = consumer({
      kind: 'delivery',
      claim: {
        journalSequence: 1,
        event: event(),
        idempotencyKey: 'delivery-key',
        attempt: 1,
        acknowledge: vi.fn(),
        retry: vi.fn(),
        deadLetter,
      },
    });
    let observedSignal: AbortSignal | undefined;
    let finishObservation!: (value: { kind: 'accepted' }) => void;
    const observe = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<{ kind: 'accepted' }>((resolve) => {
          observedSignal = signal;
          finishObservation = resolve;
        }),
    );
    const opened = openOperationalEventSubscription({
      declaration: declaration(),
      authorizer: {
        authorize: () => ({
          kind: 'granted',
          consumerId: 'consumer-1',
          projection: 'envelope',
        }),
      },
      openConsumer: () => ({ kind: 'opened', consumer: target }),
      adapter: { observe },
    });
    if (opened.kind !== 'opened') throw new Error('subscription not opened');
    const first = opened.subscription.dispatchOne();
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
    await expect(opened.subscription.dispatchOne()).resolves.toEqual({
      kind: 'busy',
    });
    expect(opened.subscription.close()).toEqual({ kind: 'pending' });
    await expect(first).resolves.toEqual({ kind: 'dead-lettered' });
    expect(observedSignal?.aborted).toBe(true);
    expect(deadLetter).toHaveBeenCalledWith('subscriber_closed');
    expect(target.close).not.toHaveBeenCalled();
    expect(opened.subscription.close()).toEqual({ kind: 'pending' });
    finishObservation({ kind: 'accepted' });
    await vi.waitFor(() =>
      expect(opened.subscription.close()).toEqual({ kind: 'closed' }),
    );
    expect(target.close).toHaveBeenCalledOnce();
  });

  it('does not invoke an Adapter when close wins before invocation', async () => {
    const retry = vi.fn(() => ({ kind: 'applied' as const }));
    const target = consumer({
      kind: 'delivery',
      claim: {
        journalSequence: 1,
        event: event(),
        idempotencyKey: 'delivery-key',
        attempt: 1,
        acknowledge: vi.fn(),
        retry,
        deadLetter: vi.fn(),
      },
    });
    const observe = vi.fn(async () => ({ kind: 'accepted' as const }));
    const opened = openOperationalEventSubscription({
      declaration: declaration(),
      authorizer: {
        authorize: () => ({
          kind: 'granted',
          consumerId: 'consumer-1',
          projection: 'envelope',
        }),
      },
      openConsumer: () => ({ kind: 'opened', consumer: target }),
      adapter: { observe },
    });
    if (opened.kind !== 'opened') throw new Error('subscription not opened');
    const dispatch = opened.subscription.dispatchOne();
    expect(opened.subscription.close()).toEqual({ kind: 'pending' });
    await expect(dispatch).resolves.toEqual({ kind: 'retrying' });
    expect(observe).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledWith('subscriber_closed_before_invocation');
    expect(target.close).toHaveBeenCalledOnce();
  });

  it('bounds an abort-ignoring subscriber without replaying its effect', async () => {
    const deadLetter = vi.fn(() => ({ kind: 'applied' as const }));
    const target = consumer({
      kind: 'delivery',
      claim: {
        journalSequence: 1,
        event: event(),
        idempotencyKey: 'delivery-key',
        attempt: 1,
        acknowledge: vi.fn(),
        retry: vi.fn(),
        deadLetter,
      },
    });
    const opened = openOperationalEventSubscription({
      declaration: declaration(),
      authorizer: {
        authorize: () => ({
          kind: 'granted',
          consumerId: 'consumer-1',
          projection: 'envelope',
        }),
      },
      openConsumer: () => ({ kind: 'opened', consumer: target }),
      adapter: {
        observe: vi.fn(() => new Promise<{ kind: 'accepted' }>(() => {})),
      },
      dispatchTimeoutMs: 5,
    });
    if (opened.kind !== 'opened') throw new Error('subscription not opened');
    await expect(opened.subscription.dispatchOne()).resolves.toEqual({
      kind: 'dead-lettered',
    });
    expect(deadLetter).toHaveBeenCalledWith('subscriber_timeout');
  });

  it('retries only an unavailable timeout settlement before dispatching again', async () => {
    const deadLetter = vi
      .fn()
      .mockReturnValueOnce({ kind: 'unavailable' as const })
      .mockReturnValue({ kind: 'applied' as const });
    const target = consumer({
      kind: 'delivery',
      claim: {
        journalSequence: 1,
        event: event(),
        idempotencyKey: 'delivery-key',
        attempt: 1,
        acknowledge: vi.fn(),
        retry: vi.fn(),
        deadLetter,
      },
    });
    let finishObservation!: (value: { kind: 'accepted' }) => void;
    const observe = vi.fn(
      () =>
        new Promise<{ kind: 'accepted' }>((resolve) => {
          finishObservation = resolve;
        }),
    );
    const opened = openOperationalEventSubscription({
      declaration: declaration(),
      authorizer: {
        authorize: () => ({
          kind: 'granted',
          consumerId: 'consumer-1',
          projection: 'envelope',
        }),
      },
      openConsumer: () => ({ kind: 'opened', consumer: target }),
      adapter: { observe },
      dispatchTimeoutMs: 5,
    });
    if (opened.kind !== 'opened') throw new Error('subscription not opened');
    await expect(opened.subscription.dispatchOne()).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(opened.subscription.dispatchOne()).resolves.toEqual({
      kind: 'dead-lettered',
    });
    await expect(opened.subscription.dispatchOne()).resolves.toEqual({
      kind: 'busy',
    });
    expect(observe).toHaveBeenCalledOnce();
    expect(deadLetter).toHaveBeenCalledTimes(2);
    expect(opened.subscription.close()).toEqual({ kind: 'pending' });
    finishObservation({ kind: 'accepted' });
    await vi.waitFor(() =>
      expect(opened.subscription.close()).toEqual({ kind: 'closed' }),
    );
  });

  it('retains ownership until an unavailable close settlement applies', async () => {
    const deadLetter = vi
      .fn()
      .mockReturnValueOnce({ kind: 'unavailable' as const })
      .mockReturnValueOnce({ kind: 'unavailable' as const })
      .mockReturnValue({ kind: 'applied' as const });
    const target = consumer({
      kind: 'delivery',
      claim: {
        journalSequence: 1,
        event: event(),
        idempotencyKey: 'delivery-key',
        attempt: 1,
        acknowledge: vi.fn(),
        retry: vi.fn(),
        deadLetter,
      },
    });
    let finishObservation!: (value: { kind: 'accepted' }) => void;
    const observe = vi.fn(
      () =>
        new Promise<{ kind: 'accepted' }>((resolve) => {
          finishObservation = resolve;
        }),
    );
    const opened = openOperationalEventSubscription({
      declaration: declaration(),
      authorizer: {
        authorize: () => ({
          kind: 'granted',
          consumerId: 'consumer-1',
          projection: 'envelope',
        }),
      },
      openConsumer: () => ({ kind: 'opened', consumer: target }),
      adapter: { observe },
    });
    if (opened.kind !== 'opened') throw new Error('subscription not opened');
    const dispatch = opened.subscription.dispatchOne();
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
    expect(opened.subscription.close()).toEqual({ kind: 'pending' });
    await expect(dispatch).resolves.toEqual({ kind: 'unavailable' });
    expect(target.close).not.toHaveBeenCalled();
    expect(opened.subscription.close()).toEqual({ kind: 'unavailable' });
    expect(target.close).not.toHaveBeenCalled();
    expect(opened.subscription.close()).toEqual({ kind: 'pending' });
    finishObservation({ kind: 'accepted' });
    await vi.waitFor(() =>
      expect(opened.subscription.close()).toEqual({ kind: 'closed' }),
    );
    expect(target.close).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledOnce();
    expect(deadLetter).toHaveBeenCalledTimes(3);
  });

  it('turns a throwing subscriber into one idempotent retry intent', async () => {
    const retry = vi.fn(() => ({ kind: 'applied' as const }));
    const target = consumer({
      kind: 'delivery',
      claim: {
        journalSequence: 1,
        event: event(),
        idempotencyKey: 'delivery-key',
        attempt: 1,
        acknowledge: vi.fn(),
        retry,
        deadLetter: vi.fn(),
      },
    });
    const opened = openOperationalEventSubscription({
      declaration: declaration(),
      authorizer: {
        authorize: () => ({
          kind: 'granted',
          consumerId: 'consumer-1',
          projection: 'envelope',
        }),
      },
      openConsumer: () => ({ kind: 'opened', consumer: target }),
      adapter: {
        observe: vi.fn(async () => {
          throw new Error('subscriber unavailable');
        }),
      },
    });
    if (opened.kind !== 'opened') throw new Error('subscription not opened');
    await expect(opened.subscription.dispatchOne()).resolves.toEqual({
      kind: 'retrying',
    });
    expect(retry).toHaveBeenCalledWith('subscriber_unavailable');
  });

  it('dead-letters a malformed subscriber outcome without replaying it', async () => {
    const deadLetter = vi.fn(() => ({ kind: 'applied' as const }));
    const target = consumer({
      kind: 'delivery',
      claim: {
        journalSequence: 1,
        event: event(),
        idempotencyKey: 'delivery-key',
        attempt: 1,
        acknowledge: vi.fn(),
        retry: vi.fn(),
        deadLetter,
      },
    });
    const opened = openOperationalEventSubscription({
      declaration: declaration(),
      authorizer: {
        authorize: () => ({
          kind: 'granted',
          consumerId: 'consumer-1',
          projection: 'envelope',
        }),
      },
      openConsumer: () => ({ kind: 'opened', consumer: target }),
      adapter: {
        observe: vi.fn(
          async () => ({ kind: 'retry', failureCode: 'BAD CODE' }) as never,
        ),
      },
    });
    if (opened.kind !== 'opened') throw new Error('subscription not opened');
    await expect(opened.subscription.dispatchOne()).resolves.toEqual({
      kind: 'dead-lettered',
    });
    expect(deadLetter).toHaveBeenCalledWith('subscriber_invalid_outcome');
  });

  it('exposes gap truth without handing out its acknowledgement capability', async () => {
    const acknowledge = vi.fn();
    const target = consumer({
      kind: 'gap',
      gap: {
        requestedAfterJournalSequence: 0,
        earliestAvailableJournalSequence: 10,
        acknowledge,
      },
    });
    const opened = openOperationalEventSubscription({
      declaration: declaration(),
      authorizer: {
        authorize: () => ({
          kind: 'granted',
          consumerId: 'consumer-1',
          projection: 'envelope',
        }),
      },
      openConsumer: () => ({ kind: 'opened', consumer: target }),
      adapter: { observe: vi.fn() },
    });
    if (opened.kind !== 'opened') throw new Error('subscription not opened');
    await expect(opened.subscription.dispatchOne()).resolves.toEqual({
      kind: 'gap',
    });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(Object.keys(opened.subscription).sort()).toEqual([
      'close',
      'dispatchOne',
    ]);
  });

  it('closes the private delivery capability exactly once', () => {
    const target = consumer({ kind: 'empty' });
    const opened = openOperationalEventSubscription({
      declaration: declaration(),
      authorizer: {
        authorize: () => ({
          kind: 'granted',
          consumerId: 'consumer-1',
          projection: 'envelope',
        }),
      },
      openConsumer: () => ({ kind: 'opened', consumer: target }),
      adapter: { observe: vi.fn() },
    });
    if (opened.kind !== 'opened') throw new Error('subscription not opened');
    expect(opened.subscription.close()).toEqual({ kind: 'closed' });
    expect(opened.subscription.close()).toEqual({ kind: 'closed' });
    expect(target.close).toHaveBeenCalledOnce();
  });
});
