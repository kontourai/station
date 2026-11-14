// UNWIRED #91: boot issuance, provider qualification and exact ledger settlement remain required.
import {
  type FinalFetchCheck,
  FinalFetchLaunchFence,
  type ReservedFinalFetchOwners,
  type ReservedWireBinding,
  RoundsFinalFetchLaunchFence,
  snapshotFinalWire,
} from '../../services/orchestration/delegation-group-launch-fence.js';
import {
  assertSynchronous,
  type FinalWireIntentIdentity,
  wireIdentityDigest,
} from '../../services/orchestration/delegation-group-wire-intent-store.js';
import { assembleAnthropicStream } from './bounded-api-anthropic-stream.js';
import { assembleGoogleStream } from './bounded-api-google-stream.js';
import { observeBoundedApiJsonResponse } from './bounded-api-json-response.js';
import {
  type BoundedApiAttemptQuote,
  type BoundedApiProvider,
  boundedApiUsesReportInput,
  captureBoundedApiHistoricalPricing,
  priceBoundedApiProviderRawUsage,
  quoteBoundedApiProviderAttempt,
  type ResolvedBoundedApiProviderContract,
} from './bounded-api-provider-contract.js';
import { observeRawProviderSseResponse } from './bounded-api-sse-response.js';

type Usage = ReturnType<typeof priceBoundedApiProviderRawUsage>;
export interface ReservedProviderEvidence {
  readonly intent: FinalWireIntentIdentity;
  readonly usage: Usage;
  readonly quote: BoundedApiAttemptQuote;
  readonly rawBodySha256: string;
  readonly rawResponseJson: string;
  readonly historicalPricingJson?: string;
}
export class ReservedProviderUnavailable extends Error {
  readonly code = 'usage_unknown';
}
const fail = (): never => {
  throw new ReservedProviderUnavailable(
    'Reserved provider attempt unavailable',
  );
};

/** Private transport for an ALREADY reserved invocation. This cannot issue a root,
 * approve a provider record, reserve capacity, authenticate a Request or settle a ledger. */
export class ReservedProviderFetch {
  readonly fetch: typeof fetch;
  readonly evidence: Promise<ReservedProviderEvidence>;
  #started = false;
  constructor(
    owners: Readonly<{
      launch: ReservedFinalFetchOwners;
      reservation: Omit<ReservedWireBinding, 'expectedWireDigest'>;
      contract: ResolvedBoundedApiProviderContract;
      provider: BoundedApiProvider;
      signal: AbortSignal;
      now(): number;
      maxResponseBytes: number;
    }>,
  ) {
    if (
      !Number.isSafeInteger(owners.maxResponseBytes) ||
      owners.maxResponseBytes < 1 ||
      owners.maxResponseBytes > 8 * 1024 * 1024 ||
      !['anthropic', 'google'].includes(owners.provider)
    )
      fail();
    owners = Object.freeze({ ...owners });
    const launch = Object.freeze({ ...owners.launch });
    const reservation = structuredClone(owners.reservation);
    let resolve!: (value: ReservedProviderEvidence) => void,
      reject!: (reason: unknown) => void;
    this.evidence = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void this.evidence.catch(() => {});
    const home =
      launch.protocol === 'rounds-v1' ? launch.reportHome : undefined;
    const checkCurrent = <Value>(body: () => Value): Promise<Value> =>
      home?.check
        ? home.check(home.current, body)
        : home?.withHome
          ? home.withHome(home.current, async (scope) => scope.check(body))
          : Promise.resolve(body());
    const known = async (
      quote: BoundedApiAttemptQuote,
      readRaw: () => unknown,
      rawBodySha256: string,
      intent: FinalWireIntentIdentity,
    ) => {
      const evidence = await checkCurrent(() => {
        const rawResponseJson = JSON.stringify(readRaw());
        const pricedAtMs = owners.now();
        const usage = priceBoundedApiProviderRawUsage(
          owners.contract,
          quote,
          rawResponseJson,
          pricedAtMs,
        );
        const historicalPricingJson = captureBoundedApiHistoricalPricing(
          owners.contract,
          quote,
          pricedAtMs,
        );
        return Object.freeze({
          intent,
          usage,
          quote,
          rawBodySha256,
          rawResponseJson,
          historicalPricingJson,
        });
      });
      resolve(evidence);
    };
    this.fetch = async (input, init) => {
      try {
        owners.signal.throwIfAborted();
        if (this.#started) fail();
        this.#started = true;
        if (
          input instanceof Request ||
          init?.method?.toUpperCase() !== 'POST' ||
          typeof init.body !== 'string'
        )
          return fail();
        const upstreamSignal = init.signal;
        const signal = upstreamSignal
          ? AbortSignal.any([owners.signal, upstreamSignal])
          : owners.signal;
        signal.throwIfAborted();
        const wire = snapshotFinalWire({
          url: String(input),
          method: 'POST',
          headers: [...new Headers(init.headers).entries()],
          body: init.body,
        });
        const quote = await checkCurrent(() =>
          quoteBoundedApiProviderAttempt(
            owners.contract,
            {
              ...wire,
              headers: Object.fromEntries(wire.headers),
              redirect: 'error',
              requestOrdinal: 1,
            },
            { ...reservation.allocation, currency: 'USD' },
            owners.now(),
          ),
        );
        const guardedLaunch = {
          ...launch,
          fetch: (
            input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1],
            check?: FinalFetchCheck,
          ) => {
            const validate = () => {
              const current = quoteBoundedApiProviderAttempt(
                owners.contract,
                {
                  ...wire,
                  headers: Object.fromEntries(wire.headers),
                  redirect: 'error',
                  requestOrdinal: 1,
                },
                { ...reservation.allocation, currency: 'USD' },
                owners.now(),
              );
              if (JSON.stringify(current) !== JSON.stringify(quote)) fail();
              assertSynchronous(launch.finalizeCurrent);
              signal.throwIfAborted();
            };
            if (check) check(validate);
            else validate();
            return launch.fetch(input, init, check);
          },
        };
        const fence =
          guardedLaunch.protocol === 'rounds-v1'
            ? new RoundsFinalFetchLaunchFence(guardedLaunch)
            : new FinalFetchLaunchFence(guardedLaunch);
        const begun = await fence.start(
          { ...reservation, expectedWireDigest: wireIdentityDigest(wire) },
          wire,
          signal,
        );
        const response = await begun.response;
        const contentType = response.headers
          .get('content-type')
          ?.split(';')[0]
          .trim()
          .toLowerCase();
        if (contentType === 'text/event-stream') {
          const observed = observeRawProviderSseResponse(
            response,
            {
              maxBytes: owners.maxResponseBytes,
              maxFrameBytes: Math.min(owners.maxResponseBytes, 256 * 1024),
              maxFrames: 16384,
            },
            signal,
          );
          const finish = observed.complete.then((e) =>
            known(
              quote,
              () =>
                owners.provider === 'anthropic'
                  ? assembleAnthropicStream(
                      e.frames,
                      boundedApiUsesReportInput(owners.contract, owners.now()),
                    )
                  : assembleGoogleStream(e.frames),
              e.rawBodySha256,
              begun.intent,
            ),
          );
          void finish.catch(reject);
          return observed.response;
        }
        const observed = await observeBoundedApiJsonResponse(
          response,
          owners.maxResponseBytes,
          signal,
        );
        await known(
          quote,
          () => observed.raw,
          observed.rawBodySha256,
          begun.intent,
        );
        return observed.response;
      } catch (error) {
        reject(error);
        throw error;
      }
    };
  }
}
