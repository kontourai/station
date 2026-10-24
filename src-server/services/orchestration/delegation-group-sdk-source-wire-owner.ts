import { isDeepStrictEqual } from 'node:util';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { REPORT_GROUP_CONTEXT_LIMITS } from '@kontourai/station-contracts/report-group';
import {
  assertBoundedApiCredentialBinding,
  type BoundedApiAttemptQuote,
  type BoundedApiProvider,
  type BoundedApiRemainingEnvelope,
  quoteBoundedApiProviderAttempt,
  type ResolvedBoundedApiProviderContract,
} from '../../runtime/conversation/bounded-api-provider-contract.js';
import {
  type ObservedSdkProviderCredential,
  readObservedSdkProviderCredential,
} from '../../runtime/conversation/provider-credential-observation.js';
import {
  isSealedProviderPreparation,
  type SealedProviderPreparation,
} from '../../runtime/conversation/sealed-provider-preparation.js';
import {
  type FinalWire,
  snapshotFinalWire,
} from './delegation-group-launch-fence.js';
import {
  claimSdkSourceLease,
  type SdkSourceLease,
} from './delegation-group-source-admission.js';
import { wireIdentityDigest } from './delegation-group-wire-intent-store.js';

export class SdkSourceRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SdkSourceRefusal';
    this.stack = `SdkSourceRefusal: ${code}`;
  }
}
function fail(code: string): never {
  throw new SdkSourceRefusal(code);
}
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
type OptionsBase = Readonly<{
  provider: BoundedApiProvider;
  outputDelivery?: 'streamed';
  modelId: string;
  credential: ObservedSdkProviderCredential;
  brief: string;
  instructions: string;
  maxOutputTokens: number;
  remaining: BoundedApiRemainingEnvelope;
  now(): number;
  rawFetch: typeof fetch;
  signal: AbortSignal;
}>;
type Qualification =
  | { contract: ResolvedBoundedApiProviderContract; preparation?: never }
  | { preparation: SealedProviderPreparation; contract?: never };
type Options = OptionsBase & Qualification;
type SdkResult = Readonly<{
  text: string;
  usage: unknown;
  finishReason: unknown;
}>;
type State = {
  owner: object;
  lease: object;
  authorization: SdkSourceLease;
  captured: ReturnType<typeof deferred<void>>;
  response: ReturnType<typeof deferred<Response>> | undefined;
  disposed: ReturnType<typeof deferred<void>>;
  controller: AbortController;
  wire?: Readonly<FinalWire>;
  quote?: BoundedApiAttemptQuote;
  contract?: ResolvedBoundedApiProviderContract;
  result: Promise<SdkResult>;
  rawResponse?: Promise<Response>;
  taken: boolean;
  delivered: boolean;
  started: boolean;
  rawSettled: boolean;
  abandoned: boolean;
  settled: boolean;
  release: boolean;
  deadline: ReturnType<typeof setTimeout>;
  abortListener?: () => void;
  onTextDelta?: (text: string) => void;
};
const owners = new WeakMap<object, Options>();
const syncContexts = new WeakMap<object, string>();
const handles = new WeakMap<object, State>();
const usedOwners = new WeakSet<object>();
function stateFor(owner: object, handle: object) {
  const s = handles.get(handle);
  if (!owners.has(owner) || !s || s.owner !== owner)
    fail('sdk_owner_or_handle_unavailable');
  return s;
}
function optionsFor(owner: object) {
  const options = owners.get(owner);
  if (!options) fail('sdk_owner_unavailable');
  return options;
}
function finishDisposal(s: State) {
  if (!s.settled || !s.release || (s.started && !s.rawSettled)) return;
  s.wire = undefined;
  s.quote = undefined;
  s.response = undefined;
  s.onTextDelta = undefined;
  s.rawResponse = undefined;
  clearTimeout(s.deadline);
  s.disposed.resolve();
}
/** Boot-only raw fetch and qualified contract dependencies. No route DTO, source grant issuer,
 * caller validation callback, provider options object, or global fetch/config mutation. */
export function createPreparedSdkSourceWireOwner(input: Options): object {
  return createWireOwner(input);
}

/** Separate bounded context carriage; ordinary report brief limits remain unchanged. */
export function createContextSyncSdkSourceWireOwner(
  input: Omit<OptionsBase, 'brief'> &
    Qualification & { runId: string; text: string },
): { owner: object; input: string } {
  const { runId, text, ...configuration } = input;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId) ||
    typeof text !== 'string' ||
    Buffer.byteLength(text) > REPORT_GROUP_CONTEXT_LIMITS.textBytes
  )
    fail('sdk_context_unsupported');
  const brief = `Receive context only. Do not call tools. Reply exactly ACK SYNC ${runId}`;
  return {
    owner: createWireOwner({ ...configuration, brief }, text),
    input: brief,
  };
}

function createWireOwner(input: Options, context?: string): object {
  const expected = [
    'brief',
    'credential',
    'instructions',
    'maxOutputTokens',
    'modelId',
    'now',
    'provider',
    'rawFetch',
    'remaining',
    'signal',
  ];
  expected.push('preparation' in input ? 'preparation' : 'contract');
  if (input.outputDelivery !== undefined) expected.push('outputDelivery');
  expected.sort();
  if (
    Object.keys(input).sort().join(',') !== expected.join(',') ||
    !['anthropic', 'google'].includes(input.provider) ||
    (input.outputDelivery !== undefined &&
      input.outputDelivery !== 'streamed') ||
    typeof input.modelId !== 'string' ||
    !input.modelId ||
    typeof input.rawFetch !== 'function' ||
    typeof input.now !== 'function' ||
    typeof input.brief !== 'string' ||
    typeof input.instructions !== 'string' ||
    (context === undefined
      ? Buffer.byteLength(input.brief) + Buffer.byteLength(input.instructions) >
        65536
      : Buffer.byteLength(input.instructions) > 65536 ||
        Buffer.byteLength(input.brief) > 512) ||
    !Number.isSafeInteger(input.maxOutputTokens) ||
    input.maxOutputTokens < 1
  )
    fail('sdk_configuration_unsupported');
  if (input.preparation) {
    if (!isSealedProviderPreparation(input.preparation))
      fail('sdk_configuration_unsupported');
    input.preparation.assertSelection(input.provider, input.modelId);
    readObservedSdkProviderCredential(input.credential, input.provider);
  } else {
    assertBoundedApiCredentialBinding(
      input.contract,
      readObservedSdkProviderCredential(input.credential, input.provider),
      input.now(),
    );
  }
  const owner = Object.freeze({});
  if (context !== undefined) syncContexts.set(owner, context);
  owners.set(
    owner,
    Object.freeze({
      ...input,
      remaining: Object.freeze({ ...input.remaining }),
    }),
  );
  return owner;
}
function sdkInstruction(owner: object, options: Options): string {
  const context = syncContexts.get(owner);
  return JSON.stringify({
    brief: options.brief,
    instructions: options.instructions,
    ...(context === undefined ? {} : { context }),
  });
}
function boundedWire(wire: FinalWire) {
  return {
    ...wire,
    headers: Object.fromEntries(wire.headers),
    redirect: 'error' as const,
    requestOrdinal: 1,
  };
}
function assertCredentialWire(
  o: Options,
  wire: FinalWire,
  contract: ResolvedBoundedApiProviderContract,
): void {
  const now = o.now();
  const credential = readObservedSdkProviderCredential(
    o.credential,
    o.provider,
  );
  assertBoundedApiCredentialBinding(contract, credential, now);
  const name = o.provider === 'anthropic' ? 'x-api-key' : 'x-goog-api-key';
  if (
    new Headers(wire.headers.map(([key, value]) => [key, value])).get(name) !==
    credential.apiKey
  )
    fail('sdk_credential_changed');
}
function validateEmbedding(o: Options, s: State, wire: FinalWire) {
  const lease = claimSdkSourceLease(s.lease);
  if (
    Buffer.byteLength(wire.body) >
    (syncContexts.has(s.owner) ? 2_097_152 : 1_048_576)
  )
    fail('sdk_wire_too_large');
  const body = JSON.parse(wire.body);
  const instruction = sdkInstruction(s.owner, o);
  const expected =
    o.provider === 'anthropic'
      ? [
          {
            role: 'user',
            content: [
              { type: 'text', text: instruction },
              { type: 'text', text: lease.serialization },
            ],
          },
        ]
      : [
          {
            role: 'user',
            parts: [{ text: instruction }, { text: lease.serialization }],
          },
        ];
  if (
    !isDeepStrictEqual(
      o.provider === 'anthropic' ? body.messages : body.contents,
      expected,
    )
  )
    fail('sdk_source_block_mismatch');
}
export function beginSdkSourceWire(owner: object, leaseToken: object): object {
  const o = optionsFor(owner),
    lease = claimSdkSourceLease(leaseToken);
  lease.assertCurrentSync();
  o.signal.throwIfAborted();
  if (usedOwners.has(owner)) fail('sdk_owner_already_used');
  usedOwners.add(owner);
  const handle = Object.freeze({}),
    captured = deferred<void>(),
    response = deferred<Response>(),
    disposed = deferred<void>(),
    controller = new AbortController();
  const s: State = {
    owner,
    lease: leaseToken,
    authorization: lease,
    captured,
    response,
    disposed,
    controller,
    result: Promise.reject(new Error('sdk_not_started')),
    taken: false,
    delivered: false,
    started: false,
    rawSettled: false,
    abandoned: false,
    settled: false,
    release: false,
    deadline: setTimeout(() => disposeSdkSourceWire(owner, handle), 10000),
  };
  void s.result.catch(() => {});
  handles.set(handle, s);
  s.abortListener = () => disposeSdkSourceWire(owner, handle);
  o.signal.addEventListener('abort', s.abortListener, { once: true });
  const signal = AbortSignal.any([o.signal, controller.signal]);
  const interceptor: typeof fetch = async (input, init) => {
    try {
      signal.throwIfAborted();
      if (
        s.abandoned ||
        s.wire ||
        input instanceof Request ||
        init?.method !== 'POST' ||
        typeof init.body !== 'string'
      )
        fail('sdk_capture_unsupported');
      const body = JSON.parse(init.body);
      // Fixed permitted provider defaults are applied before the sole final wire capture.
      if (o.provider === 'anthropic') {
        body.inference_geo = 'global';
        body.service_tier = 'standard_only';
      } else body.serviceTier = 'standard';
      const headers = new Headers(init.headers);
      if (o.preparation && o.provider === 'anthropic')
        headers.set('anthropic-version', o.preparation.apiVersion);
      const wire = snapshotFinalWire({
        url: String(input),
        method: 'POST',
        headers: [...headers.entries()],
        body: JSON.stringify(body),
      });
      const contract =
        o.contract ??
        o.preparation.qualifySourceWire(
          leaseToken,
          o.credential,
          boundedWire(wire),
        );
      s.contract = contract;
      assertCredentialWire(o, wire, contract);
      s.quote = quoteBoundedApiProviderAttempt(
        contract,
        boundedWire(wire),
        o.remaining,
        o.now(),
      );
      validateEmbedding(o, s, wire);
      lease.assertCurrentSync();
      s.wire = Object.freeze({
        ...wire,
        headers: Object.freeze(
          wire.headers.map((pair) =>
            Object.freeze([pair[0], pair[1]] as const),
          ),
        ),
      });
      clearTimeout(s.deadline);
      captured.resolve();
      return await response.promise;
    } catch {
      const error = new SdkSourceRefusal('sdk_prepare_failed');
      captured.reject(error);
      throw error;
    }
  };
  const provider =
    o.provider === 'anthropic'
      ? createAnthropic({
          apiKey: readObservedSdkProviderCredential(o.credential, o.provider)
            .apiKey,
          baseURL: 'https://api.anthropic.com/v1',
          fetch: interceptor,
        })
      : createGoogleGenerativeAI({
          apiKey: readObservedSdkProviderCredential(o.credential, o.provider)
            .apiKey,
          baseURL: 'https://generativelanguage.googleapis.com/v1beta',
          fetch: interceptor,
        });
  const model = provider(o.modelId);
  const call: Parameters<typeof model.doGenerate>[0] = {
    prompt: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: sdkInstruction(owner, o),
          },
          { type: 'text', text: lease.serialization },
        ],
      },
    ],
    maxOutputTokens: o.maxOutputTokens,
    ...(o.provider === 'google' && o.preparation
      ? {
          providerOptions: {
            google: { thinkingConfig: { thinkingBudget: 0 } },
          },
        }
      : {}),
    abortSignal: signal,
  };
  const sdk =
    o.outputDelivery === 'streamed'
      ? model.doStream(call).then(async ({ stream }) => {
          const text: string[] = [];
          let bytes = 0;
          let terminal:
            | Extract<LanguageModelV3StreamPart, { type: 'finish' }>
            | undefined;
          for await (const part of stream) {
            signal.throwIfAborted();
            lease.assertDisclosureCurrentSync();
            if (terminal) fail('sdk_stream_after_finish');
            if (part.type === 'text-delta') {
              bytes += Buffer.byteLength(part.delta);
              if (bytes > 8 * 1024 * 1024) fail('sdk_stream_oversized');
              text.push(part.delta);
              s.onTextDelta?.(part.delta);
            } else if (part.type === 'finish') terminal = part;
            else if (
              ![
                'stream-start',
                'response-metadata',
                'text-start',
                'text-end',
              ].includes(part.type)
            )
              fail('sdk_non_text_output');
          }
          if (!terminal) fail('sdk_stream_incomplete');
          return {
            content: [{ type: 'text' as const, text: text.join('') }],
            usage: terminal.usage,
            finishReason: terminal.finishReason,
          };
        })
      : model.doGenerate(call);
  s.result = Promise.resolve(sdk)
    .then(
      (result) => {
        if (result.content.some((part) => part.type !== 'text'))
          fail('sdk_non_text_output');
        if (!s.wire || !s.contract) fail('sdk_wire_unavailable');
        assertCredentialWire(o, s.wire, s.contract);
        lease.assertCurrentSync();
        return Object.freeze({
          text: result.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join(''),
          usage: result.usage,
          finishReason: result.finishReason,
        });
      },
      () => {
        try {
          lease.assertDisclosureCurrentSync();
        } catch {
          throw new SdkSourceRefusal('sdk_disclosure_unavailable');
        }
        throw new SdkSourceRefusal('sdk_attempt_failed');
      },
    )
    .catch(() => {
      try {
        lease.assertDisclosureCurrentSync();
      } catch {
        throw new SdkSourceRefusal('sdk_disclosure_unavailable');
      }
      throw new SdkSourceRefusal('sdk_attempt_failed');
    })
    .finally(() => {
      s.settled = true;
      if (s.abortListener)
        o.signal.removeEventListener('abort', s.abortListener);
      finishDisposal(s);
    });
  void s.result.catch((error) => {
    captured.reject(error);
  });
  return handle;
}
export async function capturedSdkSourceWire(owner: object, handle: object) {
  const s = stateFor(owner, handle);
  await s.captured.promise;
  return inspectSdkSourceWire(owner, handle);
}
export function inspectSdkSourceWire(owner: object, handle: object) {
  const s = stateFor(owner, handle);
  if (s.abandoned || !s.wire || !s.quote || !s.contract)
    fail('sdk_wire_unavailable');
  assertCredentialWire(optionsFor(owner), s.wire, s.contract);
  claimSdkSourceLease(s.lease).assertCurrentSync();
  return Object.freeze({
    wire: s.wire,
    wireDigest: wireIdentityDigest(s.wire),
    quote: s.quote,
    contract: s.contract,
    sourceBinding: claimSdkSourceLease(s.lease).binding,
    outputDelivery: optionsFor(owner).outputDelivery ?? 'buffered',
  });
}
export function assertSdkSourceWireCurrentSync(owner: object, handle: object) {
  const s = stateFor(owner, handle),
    o = optionsFor(owner);
  if (s.abandoned || s.started || !s.wire || !s.quote || !s.contract)
    fail('sdk_wire_unavailable');
  const current = quoteBoundedApiProviderAttempt(
    s.contract,
    boundedWire(s.wire),
    o.remaining,
    o.now(),
  );
  if (!isDeepStrictEqual(current, s.quote)) fail('sdk_quote_changed');
  validateEmbedding(o, s, s.wire);
  claimSdkSourceLease(s.lease).assertCurrentSync();
  return undefined;
}
/** Innermost reserved transport: consume source, recheck its credential, then call boot raw fetch. */
export function enterFinalFetch(
  owner: object,
  handle: object,
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const s = stateFor(owner, handle),
    o = optionsFor(owner);
  if (s.started) fail('sdk_wire_unavailable');
  let ownsStart = false;
  try {
    assertSdkSourceWireCurrentSync(owner, handle);
    o.signal.throwIfAborted();
    init?.signal?.throwIfAborted();
    if (
      input instanceof Request ||
      init?.method !== 'POST' ||
      typeof init.body !== 'string' ||
      init.redirect !== 'error'
    )
      fail('sdk_final_wire_unsupported');
    const wire = snapshotFinalWire({
      url: String(input),
      method: 'POST',
      headers: [...new Headers(init.headers).entries()],
      body: init.body,
    });
    if (
      !s.wire ||
      wireIdentityDigest(wire) !== wireIdentityDigest(s.wire) ||
      !isDeepStrictEqual(wire, s.wire)
    )
      fail('sdk_final_wire_changed');
    if (!s.contract) fail('sdk_wire_unavailable');
    const contract = s.contract;
    const lease = claimSdkSourceLease(s.lease),
      digest = wireIdentityDigest(wire);
    const rawFetch = o.rawFetch,
      url = wire.url;
    const requestInit: RequestInit = {
      method: wire.method,
      headers: wire.headers.map(([k, v]) => [k, v]),
      body: wire.body,
      redirect: 'error',
      signal: init.signal,
    };
    assertCredentialWire(o, wire, contract);
    s.started = true;
    ownsStart = true;
    lease.consumeExactSync(owner, handle, digest);
    assertCredentialWire(o, wire, contract);
    const response = rawFetch(url, requestInit);
    s.rawResponse = Promise.resolve(response).then(
      (value) => {
        s.rawSettled = true;
        finishDisposal(s);
        return value;
      },
      () => {
        const error = new SdkSourceRefusal('sdk_http_failed');
        s.rawSettled = true;
        s.response?.reject(error);
        finishDisposal(s);
        throw error;
      },
    );
    void s.rawResponse.catch(() => {});
    s.release = true;
    finishDisposal(s);
    return s.rawResponse;
  } catch (error) {
    if (ownsStart) {
      s.rawSettled = true;
      s.response?.reject(new SdkSourceRefusal('sdk_attempt_failed'));
      s.release = true;
      finishDisposal(s);
    } else disposeSdkSourceWire(owner, handle);
    if (!ownsStart) throw error;
    throw new SdkSourceRefusal('sdk_attempt_failed');
  }
}
export function takeResponsePromise(owner: object, handle: object) {
  const s = stateFor(owner, handle);
  s.authorization.assertDisclosureCurrentSync();
  if (!s.started || !s.rawResponse || s.taken) fail('sdk_response_unavailable');
  s.taken = true;
  return s.rawResponse;
}
/** The parent response observer delivers its bounded forwarding Response here. */
export function deliverSdkResponse(
  owner: object,
  handle: object,
  response: Response,
) {
  const s = stateFor(owner, handle);
  s.authorization.assertDisclosureCurrentSync();
  if (
    !s.started ||
    s.abandoned ||
    s.delivered ||
    !s.response ||
    !(response instanceof Response)
  )
    fail('sdk_response_unavailable');
  s.delivered = true;
  s.response.resolve(response);
}
/** The bounded response observer may refuse a completed HTTP response before SDK delivery. */
export function refuseSdkResponse(owner: object, handle: object): void {
  const s = stateFor(owner, handle);
  if (!s.started || !s.rawSettled || s.delivered || !s.response)
    fail('sdk_response_unavailable');
  s.delivered = true;
  s.response.reject(new SdkSourceRefusal('sdk_response_unavailable'));
  s.release = true;
  finishDisposal(s);
}
export function sdkResultPromise(
  owner: object,
  handle: object,
  onTextDelta?: (text: string) => void,
) {
  const s = stateFor(owner, handle);
  s.authorization.assertDisclosureCurrentSync();
  if (onTextDelta) {
    if (s.delivered || s.onTextDelta) fail('sdk_stream_consumer_unavailable');
    s.onTextDelta = onTextDelta;
  }
  return s.result;
}
export function sdkDisposalPromise(owner: object, handle: object) {
  return stateFor(owner, handle).disposed.promise;
}
export function disposeSdkSourceWire(owner: object, handle: object) {
  const s = stateFor(owner, handle);
  s.release = true;
  if (!s.started && !s.abandoned) {
    s.abandoned = true;
    s.controller.abort(new SdkSourceRefusal('sdk_abandoned'));
    s.captured.reject(new SdkSourceRefusal('sdk_abandoned'));
    s.response?.reject(new SdkSourceRefusal('sdk_abandoned'));
  }
  finishDisposal(s);
}
