import type { DelegationRetainedAccountingV1 } from '@kontourai/flow-agents/delegation-dispatch';
import type { PreparedReservedFinalFetchOwners } from '../../services/orchestration/delegation-group-launch-fence.js';
import type { StationDelegationPersistence } from '../../services/orchestration/delegation-group-persistence.js';
import {
  deliverSdkResponse,
  disposeSdkSourceWire,
  enterFinalFetch,
  inspectSdkSourceWire,
  refuseSdkResponse,
  sdkResultPromise,
} from '../../services/orchestration/delegation-group-sdk-source-wire-owner.js';
import {
  assertSynchronous,
  type WireFinalizer,
} from '../../services/orchestration/delegation-group-wire-intent-store.js';
import {
  ReservedProviderFetch,
  ReservedProviderUnavailable,
} from './reserved-provider-fetch.js';

const claimedAttempts = new WeakSet<object>();

/** Consume a prepared sealed source only inside the durable reservation's final fetch. */
export async function runReservedSdkSourceAttempt(input: {
  persistence: StationDelegationPersistence;
  sdkOwner: object;
  sdkHandle: object;
  /** Session replacement fences launch; retained response evidence uses the original authority. */
  assertSessionCurrent?: WireFinalizer;
  onTextDelta?: (text: string) => void;
  transport: Omit<
    ConstructorParameters<typeof ReservedProviderFetch>[0],
    'launch'
  > & {
    /** Canonical persistence views; do not wrap another launch fence's guarded views. */
    launch: PreparedReservedFinalFetchOwners;
  };
}) {
  const { sdkOwner, sdkHandle, persistence } = input;
  const finalizeCurrent = input.transport.launch.finalizeCurrent;
  const assertSessionCurrent = input.assertSessionCurrent;
  if (claimedAttempts.has(sdkHandle))
    throw new ReservedProviderUnavailable(
      'Reserved source attempt already claimed',
    );
  const { wire, outputDelivery } = inspectSdkSourceWire(sdkOwner, sdkHandle);
  claimedAttempts.add(sdkHandle);
  const result = sdkResultPromise(sdkOwner, sdkHandle, input.onTextDelta);
  void result.catch(() => {});
  try {
    const assertFetchCurrent = (): undefined => {
      assertSynchronous(finalizeCurrent);
      if (assertSessionCurrent) assertSynchronous(assertSessionCurrent);
      return undefined;
    };
    const transport = new ReservedProviderFetch({
      ...input.transport,
      launch: {
        ...input.transport.launch,
        finalizeCurrent: assertFetchCurrent,
        fetch: (request, init) =>
          enterFinalFetch(sdkOwner, sdkHandle, request, init),
      },
    });
    const response = await transport.fetch(wire.url, {
      method: wire.method,
      headers: wire.headers.map(([name, value]) => [name, value]),
      body: wire.body,
      redirect: 'error',
      signal: input.transport.signal,
    });
    deliverSdkResponse(sdkOwner, sdkHandle, response);
    const [sdkResult, evidence] = await Promise.all([
      result,
      transport.evidence,
    ]);
    const evidenceReference = await persistence.retainProviderEvidence(
      evidence,
      finalizeCurrent,
    );
    assertSynchronous(finalizeCurrent);
    const accounting: DelegationRetainedAccountingV1 = Object.freeze({
      inputTokens: evidence.usage.inputTokens,
      outputTokens: evidence.usage.outputTokens,
      costMicros: evidence.usage.costMicros,
      costBasis: 'tariff-upper-bound',
    });
    return Object.freeze({
      sdkResult,
      outputDelivery,
      evidence,
      evidenceReference,
      accounting,
    });
  } catch {
    // A completed HTTP response rejected by the raw observer must also terminate the waiting SDK.
    try {
      refuseSdkResponse(sdkOwner, sdkHandle);
    } catch {
      /* A delivered or unstarted response needs no second refusal. */
    }
    disposeSdkSourceWire(sdkOwner, sdkHandle);
    throw new ReservedProviderUnavailable(
      'Reserved source attempt unavailable',
    );
  }
}
