import type { DelegationRetainedAccountingV1 } from '@kontourai/flow-agents/delegation-dispatch';
import type { StationDelegationPersistence } from '../../services/orchestration/delegation-group-persistence.js';
import {
  deliverSdkResponse,
  disposeSdkSourceWire,
  enterFinalFetch,
  inspectSdkSourceWire,
  refuseSdkResponse,
  sdkResultPromise,
} from '../../services/orchestration/delegation-group-sdk-source-wire-owner.js';
import { assertSynchronous } from '../../services/orchestration/delegation-group-wire-intent-store.js';
import {
  ReservedProviderFetch,
  ReservedProviderUnavailable,
} from './reserved-provider-fetch.js';

const claimedAttempts = new WeakSet<object>();

// UNWIRED #91: private issuance and the AccountingV1 settlement caller remain required.
/** Consume a prepared sealed source only inside the durable reservation's final fetch. */
export async function runReservedSdkSourceAttempt(input: {
  persistence: StationDelegationPersistence;
  sdkOwner: object;
  sdkHandle: object;
  transport: Omit<
    ConstructorParameters<typeof ReservedProviderFetch>[0],
    'launch'
  > & {
    /** Canonical persistence views; do not wrap another launch fence's guarded views. */
    launch: Omit<
      ConstructorParameters<typeof ReservedProviderFetch>[0]['launch'],
      'fetch'
    >;
  };
}) {
  const { sdkOwner, sdkHandle, persistence } = input;
  const finalizeCurrent = input.transport.launch.finalizeCurrent;
  if (claimedAttempts.has(sdkHandle))
    throw new ReservedProviderUnavailable(
      'Reserved source attempt already claimed',
    );
  const { wire } = inspectSdkSourceWire(sdkOwner, sdkHandle);
  claimedAttempts.add(sdkHandle);
  const result = sdkResultPromise(sdkOwner, sdkHandle);
  void result.catch(() => {});
  try {
    const transport = new ReservedProviderFetch({
      ...input.transport,
      launch: {
        ...input.transport.launch,
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
