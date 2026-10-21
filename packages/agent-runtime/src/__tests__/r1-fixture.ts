import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { bindDurableAiSdkModel } from '../ai-sdk.js';
import {
  type Bodies,
  createModelRuntime,
  type ModelStorage,
} from '../index.js';
import { captureVoltEntry } from '../voltagent.js';
import { fixture, messages, owner, parts } from './fixture.js';
export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
export const nativeOptions: LanguageModelV3CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'COMPOSED-A' }] }],
};
export async function runtimeFixture(
  options: {
    bodies?: (b: Bodies) => Bodies;
    storage?: (s: ModelStorage) => ModelStorage;
    entryTools?: import('../codecs.js').VoltEntry['tools'];
    stream?: (
      c: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
    ) => void;
  } = {},
) {
  const f = await fixture();
  const storage = options.storage?.(f.storage) ?? f.storage;
  const bodies = options.bodies?.(f.bodies) ?? f.bodies;
  let revoked = false;
  let writer = 'writer-1';
  const admission = () => {
    if (revoked) throw Error('host revoked');
    return { ...f.admission, writerGeneration: writer };
  };
  const runtime = createModelRuntime({
    storage,
    bodies,
    admission,
    liveness: () => 'live',
  });
  const entry = await runtime.start({
    key: { ...f.opened.snapshot.spec.key, conversationId: 'r1' },
    owner,
    admission: admission(),
    capture: () =>
      captureVoltEntry(f.bodies, {
        version: 1,
        binding: f.admission.binding,
        sourceCutoff: 'A',
        authoredDigest: `sha256:${'c'.repeat(64)}`,
        messages,
        generation: {},
        tools: options.entryTools ?? [],
      }),
  });
  const calls: LanguageModelV3CallOptions[] = [];
  let upstreamCancelled = false;
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'scripted',
    modelId: 'text',
    supportedUrls: {},
    async doGenerate() {
      throw Error('not supported');
    },
    async doStream(o) {
      calls.push(o);
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(c) {
            if (options.stream) options.stream(c);
            else {
              for (const p of parts) c.enqueue(p);
              c.close();
            }
          },
          cancel() {
            upstreamCancelled = true;
          },
        }),
      };
    },
  };
  return {
    ...f,
    runtime,
    entry,
    control: runtime.bind(entry),
    model,
    calls,
    guarded: bindDurableAiSdkModel({ runtime, entry, model }),
    revoke() {
      revoked = true;
    },
    changeWriter() {
      writer = 'writer-2';
    },
    get upstreamCancelled() {
      return upstreamCancelled;
    },
  };
}
