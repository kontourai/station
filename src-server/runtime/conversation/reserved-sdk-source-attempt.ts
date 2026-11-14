import { isDeepStrictEqual } from 'node:util';
import type { DelegationRetainedAccountingV1 } from '@kontourai/flow-agents/delegation-dispatch';
import type { PreparedReservedFinalFetchOwners } from '../../services/orchestration/delegation-group-launch-fence.js';
import type { StationDelegationPersistence } from '../../services/orchestration/delegation-group-persistence.js';
import {
  deliverSdkResponse,
  disposeSdkSourceWire,
  enterFinalFetch,
  inspectSdkSourceWire,
  refuseSdkResponse,
  retireSdkSourceWire,
  type SdkSourceAdmission,
  type SdkSourceCheck,
  sdkResultPromise,
} from '../../services/orchestration/delegation-group-sdk-source-wire-owner.js';
import {
  assertSynchronous,
  type WireFinalizer,
} from '../../services/orchestration/delegation-group-wire-intent-store.js';
import { readBoundedApiReportInput } from './bounded-api-provider-contract.js';
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
  onTextDelta?: (text: string, check: SdkSourceCheck) => void;
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
  claimedAttempts.add(sdkHandle);
  try {
    const reportHome =
      input.transport.launch.protocol === 'rounds-v1'
        ? input.transport.launch.reportHome
        : undefined;
    const withHome = reportHome?.withHome;
    reportHome?.retainCleanup?.(() => retireSdkSourceWire(sdkOwner, sdkHandle));
    const invokeCurrent = reportHome?.invokeCurrent;
    const admissionCurrent = reportHome?.current;
    const admission: SdkSourceAdmission | undefined =
      withHome && invokeCurrent && admissionCurrent
        ? {
            check: <Value>(body: () => Value) =>
              reportHome?.check
                ? reportHome.check(admissionCurrent, body)
                : withHome(admissionCurrent, async (scope) =>
                    scope.check(body),
                  ),
            publish: (publish) =>
              invokeCurrent(admissionCurrent, (check) => {
                publish(check);
                return Promise.resolve();
              }),
          }
        : undefined;
    const register = () => {
      const { wire, outputDelivery } = inspectSdkSourceWire(
        sdkOwner,
        sdkHandle,
      );
      return {
        wire,
        outputDelivery,
        result: sdkResultPromise(
          sdkOwner,
          sdkHandle,
          input.onTextDelta,
          admission,
        ),
      };
    };
    const { wire, outputDelivery, result } = admission
      ? await admission.check(register)
      : register();
    void result.catch(() => {});
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
        fetch: (request, init, check) =>
          enterFinalFetch(sdkOwner, sdkHandle, request, init, check),
      },
    });
    const response = await transport.fetch(wire.url, {
      method: wire.method,
      headers: wire.headers.map(([name, value]) => [name, value]),
      body: wire.body,
      redirect: 'error',
      signal: input.transport.signal,
    });
    if (admission)
      await admission.check(() =>
        deliverSdkResponse(sdkOwner, sdkHandle, response),
      );
    else deliverSdkResponse(sdkOwner, sdkHandle, response);
    const [sdkResult, evidence] = await Promise.all([
      result,
      transport.evidence,
    ]);
    const evidenceReference = withHome
      ? await withHome(finalizeCurrent, (scope) =>
          persistence.retainProviderEvidence(
            evidence,
            scope.current,
            (commit) => scope.check(commit),
          ),
        )
      : reportHome
        ? await reportHome.owner.runOwnedLease(
            input.transport.signal,
            (lease) =>
              persistence.retainProviderEvidence(
                evidence,
                () => reportHome.owner.runWithLease(lease, finalizeCurrent),
                (commit) => reportHome.owner.runWithLease(lease, commit),
              ),
          )
        : await persistence.retainProviderEvidence(evidence, finalizeCurrent);
    if (admission)
      await admission.check(() => assertSynchronous(finalizeCurrent));
    else if (reportHome)
      await reportHome.owner.runRequest(
        input.transport.signal,
        finalizeCurrent,
      );
    else assertSynchronous(finalizeCurrent);
    const readRawInput = () =>
      readBoundedApiReportInput(
        input.transport.contract,
        evidence.rawResponseJson,
        input.transport.now(),
      );
    const rawInput = admission
      ? await admission.check(readRawInput)
      : readRawInput();
    if (!isDeepStrictEqual(sdkResult.inputRequest, rawInput))
      throw new ReservedProviderUnavailable(
        'SDK and raw input request disagree',
      );
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
    // Launch retirement may fail while raw transport still owns an unresolved response.
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
