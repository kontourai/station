import * as sdk from '../../delegation-group-sdk-source-wire-owner.js';
import { fixture as qualification } from './qualification.js';
import { fixture, sdkCredentialFixture, selection, subject } from './source.js';

export { fixture, sdk, selection, subject };
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
export const tick = () => new Promise<void>((yes) => setImmediate(yes));
export function reply(provider: 'anthropic' | 'google', status = 200) {
  const body =
    status === 200
      ? provider === 'anthropic'
        ? {
            id: 'msg-fixture',
            type: 'message',
            role: 'assistant',
            model: 'fixture-model',
            content: [{ type: 'text', text: 'OK' }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 4, output_tokens: 2 },
          }
        : {
            modelVersion: 'fixture-revision',
            candidates: [
              {
                finishReason: 'STOP',
                index: 0,
                content: { role: 'model', parts: [{ text: 'OK' }] },
              },
            ],
            usageMetadata: {
              promptTokenCount: 4,
              candidatesTokenCount: 2,
              totalTokenCount: 6,
            },
          }
      : provider === 'anthropic'
        ? {
            type: 'error',
            error: { type: 'overloaded_error', message: 'owned synthetic 503' },
          }
        : {
            error: {
              code: 503,
              message: 'owned synthetic 503',
              status: 'UNAVAILABLE',
            },
          };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
export async function setup(
  provider: 'anthropic' | 'google' = 'anthropic',
  rawFetch: typeof fetch = () => Promise.resolve(reply(provider)),
  existing?: Awaited<ReturnType<typeof fixture>>,
) {
  const f = existing ?? (await fixture());
  const q = qualification(provider);
  const credentialOwner = await sdkCredentialFixture(f, provider);
  Object.assign(q.binding, {
    connectionId: credentialOwner.observed.connectionId,
    connectionRevision: credentialOwner.observed.connectionRevision,
    credentialRevision: credentialOwner.observed.credentialRevision,
  });
  q.publishFixture();
  let starts = 0;
  const abort = new AbortController();
  const configuration = {
    provider,
    modelId: 'fixture-model',
    credential: credentialOwner.credential,
    brief: 'R4 bounded source report',
    instructions: 'text only',
    maxOutputTokens: 10,
    contract: q.resolve(),
    remaining: {
      inputTokens: 1000,
      outputTokens: 1000,
      costMicros: 100000,
      currency: 'USD' as const,
    },
    now: () => 1000,
    signal: abort.signal,
    rawFetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      starts++;
      return rawFetch(input, init);
    },
  };
  const owner = sdk.createPreparedSdkSourceWireOwner(configuration);
  const sealed = await f.owner.captureSnapshot(f.context(), subject, selection);
  const prepared = await f.owner.prepareSdkSnapshot(
    f.context(),
    subject,
    sealed.capability,
    owner,
  );
  const { wire } = sdk.inspectSdkSourceWire(owner, prepared.sdkHandle);
  return {
    f,
    q,
    owner,
    sealed,
    prepared,
    wire,
    abort,
    get starts() {
      return starts;
    },
    start: () =>
      sdk.enterFinalFetch(owner, prepared.sdkHandle, wire.url, {
        method: 'POST',
        headers: Object.fromEntries(wire.headers),
        body: wire.body,
        redirect: 'error',
        signal: abort.signal,
      }),
  };
}
