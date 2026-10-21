import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { afterEach, expect, it } from 'vitest';
import { bindDurableAiSdkModel } from '../ai-sdk.js';
import { createModelRuntime, type ModelStorage } from '../index.js';
import { captureVoltEntry } from '../voltagent.js';
import {
  finish,
  fixture,
  key,
  messages,
  nextOwner,
  owner,
  parts,
} from './fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const options: LanguageModelV3CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'COMPOSED-A' }] }],
};
async function streamFixture(
  supplied: readonly LanguageModelV3StreamPart[] = parts,
  storageTransform?: (storage: ModelStorage) => ModelStorage,
  tools: import('../codecs.js').VoltEntry['tools'] = [],
) {
  const f = await fixture();
  await f.storage.close();
  // fixture opened only a separate retained generation; this runtime starts a new one.
  const runtimeKey = {
    ...key,
    conversationId: 'stream',
    invocationId: 'stream',
  };
  f.storage = f.open();
  if (storageTransform) f.storage = storageTransform(f.storage);
  const runtime = createModelRuntime({
    storage: f.storage,
    bodies: f.bodies,
    admission: f.host,
    liveness: (o) => (o.id === owner.id ? 'live' : 'live'),
  });
  const entry = await runtime.start({
    key: runtimeKey,
    owner,
    admission: f.admission,
    capture: () =>
      captureVoltEntry(f.bodies, {
        version: 1,
        binding: f.admission.binding,
        sourceCutoff: 'A',
        authoredDigest: `sha256:${'c'.repeat(64)}`,
        messages,
        generation: {},
        tools,
      }),
  });
  const calls: LanguageModelV3CallOptions[] = [];
  const model: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'scripted',
    modelId: 'text',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('provider doGenerate');
    },
    async doStream(input) {
      calls.push(input);
      return {
        request: { body: 'SECRET-DEBUG' },
        response: { headers: { authorization: 'SECRET' } },
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(c) {
            for (const p of supplied) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  };
  return {
    ...f,
    runtimeKey,
    runtime,
    entry,
    calls,
    model,
    control: runtime.bind(entry),
    guarded: bindDurableAiSdkModel({ runtime, entry, model }),
  };
}
it('no-tool successful terminal and EOF remain held until actual complete acknowledgment', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const f = await streamFixture(parts, (storage) => ({
    async execute(command, context) {
      if (command.type === 'complete') {
        entered.resolve();
        await release.promise;
      }
      return storage.execute(command, context);
    },
    close: () => storage.close(),
  }));
  cleanup.push(() => f.close());
  const observed: string[] = [];
  const done = f.control.run(async () => {
    const response = await f.guarded.doStream(options);
    expect(Object.keys(response)).toEqual(['stream']);
    const reader = response.stream.getReader();
    while (true) {
      const item = await reader.read();
      if (item.done) {
        observed.push('EOF');
        break;
      }
      observed.push(item.value.type);
    }
  });
  try {
    await entered.promise;
    expect(observed).toEqual([
      'stream-start',
      'text-start',
      'text-delta',
      'text-end',
    ]);
    const audit = await f.storage.execute(
      { type: 'listOutbox', key: f.runtimeKey, limit: 10 },
      f.context,
    );
    expect(
      audit.kind === 'listed' ? audit.entries.map((p) => p.kind) : audit,
    ).toEqual(['partial', 'partial', 'partial', 'partial']);
  } finally {
    release.resolve();
  }
  await done;
  expect(observed).toEqual([
    'stream-start',
    'text-start',
    'text-delta',
    'text-end',
    'finish',
    'EOF',
  ]);
  await f.control.finish('completed');
});
it('tool-enabling suffix preserves every native part in order behind complete acknowledgment', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const toolParts: LanguageModelV3StreamPart[] = [
    { type: 'tool-input-start', id: 'call', toolName: 'probe' },
    { type: 'tool-input-delta', id: 'call', delta: '{}' },
    { type: 'reasoning-start', id: 'r' },
    { type: 'reasoning-delta', id: 'r', delta: 'after tool input' },
    { type: 'reasoning-end', id: 'r' },
    { type: 'tool-input-end', id: 'call' },
    { type: 'tool-call', toolCallId: 'call', toolName: 'probe', input: '{}' },
    finish,
  ];
  const f = await streamFixture(toolParts, (storage) => ({
    async execute(c, ctx) {
      if (c.type === 'complete') {
        entered.resolve();
        await release.promise;
      }
      return storage.execute(c, ctx);
    },
    close: () => storage.close(),
  }));
  cleanup.push(() => f.close());
  const observed: string[] = [];
  const done = f.control.run(async () => {
    const { stream } = await f.guarded.doStream(options);
    const reader = stream.getReader();
    while (true) {
      const i = await reader.read();
      if (i.done) break;
      observed.push(i.value.type);
    }
  });
  try {
    await entered.promise;
    expect(observed).toEqual([]);
  } finally {
    release.resolve();
  }
  await done;
  expect(observed).toEqual(toolParts.map((p) => p.type));
});
it('a failed complete never releases success terminal and the fatal latch refuses completed finish', async () => {
  const f = await streamFixture(parts, (s) => ({
    async execute(c, ctx) {
      if (c.type === 'complete')
        throw new Error('real acknowledgment unavailable');
      return s.execute(c, ctx);
    },
    close: () => s.close(),
  }));
  cleanup.push(() => f.close());
  const observed: string[] = [];
  await expect(
    f.control.run(async () => {
      const { stream } = await f.guarded.doStream(options);
      const r = stream.getReader();
      while (true) {
        const i = await r.read();
        if (i.done) {
          observed.push('EOF');
          break;
        }
        observed.push(i.value.type);
      }
    }),
  ).rejects.toThrow('DURABLE_STREAM_FAILED');
  expect(observed).toEqual([
    'stream-start',
    'text-start',
    'text-delta',
    'text-end',
  ]);
  await expect(f.control.finish('completed')).rejects.toThrow(
    'DURABLE_RUN_BLOCKED',
  );
});
it('lost begin acknowledgment is a receipt and never dispatches a provider', async () => {
  let lost = false;
  const f = await streamFixture(parts, (s) => ({
    async execute(c, ctx) {
      const result = await s.execute(c, ctx);
      if (c.type === 'begin' && !lost) {
        lost = true;
        throw new Error('lost begin ack');
      }
      return result;
    },
    close: () => s.close(),
  }));
  cleanup.push(() => f.close());
  await expect(
    f.control.run(() => Promise.resolve(f.guarded.doStream(options))),
  ).rejects.toThrow('DURABLE_NO_EXECUTION_GRANT');
  expect(f.calls).toHaveLength(0);
});
it('lost complete acknowledgment delivers exactly one successful response', async () => {
  let lost = false;
  const f = await streamFixture(parts, (s) => ({
    async execute(c, ctx) {
      const result = await s.execute(c, ctx);
      if (c.type === 'complete' && !lost) {
        lost = true;
        throw new Error('lost complete ack');
      }
      return result;
    },
    close: () => s.close(),
  }));
  cleanup.push(() => f.close());
  const observed: string[] = [];
  await f.control.run(async () => {
    const { stream } = await f.guarded.doStream(options);
    const reader = stream.getReader();
    while (true) {
      const i = await reader.read();
      if (i.done) break;
      observed.push(i.value.type);
    }
  });
  expect(observed.filter((t) => t === 'finish')).toHaveLength(1);
  expect(f.calls).toHaveLength(1);
  await f.control.finish('completed');
});
it('unbound and forged handles refuse with network zero; doGenerate never invokes provider', async () => {
  const f = await streamFixture();
  cleanup.push(() => f.close());
  await expect(Promise.resolve(f.guarded.doStream(options))).rejects.toThrow(
    'DURABLE_BINDING_REQUIRED',
  );
  expect(() =>
    bindDurableAiSdkModel({
      model: f.model,
      runtime: f.runtime,
      entry: { ...f.entry },
    }),
  ).toThrow('DURABLE_BINDING_REQUIRED');
  await expect(
    f.control.run(() => Promise.resolve(f.guarded.doGenerate(options))),
  ).rejects.toThrow('DURABLE_GENERATE_UNSUPPORTED');
  expect(f.calls).toHaveLength(0);
});
it.each([
  { ...options, providerOptions: { scripted: { state: 'opaque' } } },
  { ...options, headers: {} },
  {
    ...options,
    prompt: [
      {
        role: 'user' as const,
        content: [
          {
            type: 'file' as const,
            data: new URL('https://example.invalid/a'),
            mediaType: 'image/png',
          },
        ],
      },
    ],
  },
])(
  'unsupported meaningful request fields refuse before network',
  async (request) => {
    const f = await streamFixture();
    cleanup.push(() => f.close());
    await expect(
      f.control.run(() => Promise.resolve(f.guarded.doStream(request))),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  },
);
it.each([
  [{ type: 'raw', rawValue: { secret: 'no' } }],
  [
    {
      type: 'tool-call',
      toolCallId: 'x',
      toolName: 'probe',
      input: '{}',
      providerExecuted: true,
    },
    finish,
  ],
  [{ type: 'text-delta', id: 'never-started', delta: 'bad' }, finish],
  [finish, { type: 'error', error: { secret: 'no' } }],
] satisfies LanguageModelV3StreamPart[][])(
  'unsupported or invalid stream cannot acquire success authority',
  async (...streamParts) => {
    const f = await streamFixture(streamParts);
    cleanup.push(() => f.close());
    await expect(
      f.control.run(async () => {
        const { stream } = await f.guarded.doStream(options);
        const reader = stream.getReader();
        while (!(await reader.read()).done) {}
      }),
    ).rejects.toThrow('DURABLE_STREAM_FAILED');
    await expect(f.control.finish('completed')).rejects.toThrow(
      'DURABLE_RUN_BLOCKED',
    );
  },
);
it('explicit cancellation quiesces a backpressured reader and commits cancelled', async () => {
  const f = await streamFixture();
  cleanup.push(() => f.close());
  await f.control.run(async () => {
    const response = await f.guarded.doStream(options);
    const reader = response.stream.getReader();
    expect((await reader.read()).value?.type).toBe('stream-start');
    await reader.cancel();
  });
  expect(
    await f.storage.execute({ type: 'read', key: f.runtimeKey }, f.context),
  ).toMatchObject({ snapshot: { state: 'cancelled' } });
  await expect(f.control.finish('completed')).rejects.toThrow(
    'DURABLE_RUN_BLOCKED',
  );
});
it('first delivery and completed replay normalize envelope metadata warnings and Date identically', async () => {
  const stamped: LanguageModelV3StreamPart[] = [
    {
      type: 'stream-start',
      warnings: [
        { type: 'unsupported', feature: 'sample', details: 'SECRET-WARNING' },
      ],
    },
    {
      type: 'response-metadata',
      id: 'response-A',
      modelId: 'text',
      timestamp: new Date('2026-10-17T00:00:00.000Z'),
    },
    {
      type: 'text-start',
      id: 'a',
      providerMetadata: { scripted: { secret: 'SECRET-METADATA' } },
    },
    { type: 'text-delta', id: 'a', delta: 'NORMALIZED' },
    { type: 'text-end', id: 'a' },
    finish,
  ];
  const f = await streamFixture(stamped);
  cleanup.push(() => f.close());
  const collect = async (
    guarded: LanguageModelV3,
    control: typeof f.control,
  ) => {
    const result: LanguageModelV3StreamPart[] = [];
    await control.run(async () => {
      const response = await guarded.doStream(options);
      expect(Object.keys(response)).toEqual(['stream']);
      const reader = response.stream.getReader();
      while (true) {
        const i = await reader.read();
        if (i.done) break;
        result.push(i.value);
      }
    });
    return result;
  };
  const first = await collect(f.guarded, f.control);
  expect(first[0]).toEqual({
    type: 'stream-start',
    warnings: [
      {
        type: 'unsupported',
        feature: 'sample',
        details: 'Runtime warning details omitted.',
      },
    ],
  });
  expect(first[1]).toEqual({
    type: 'response-metadata',
    id: 'response-A',
    modelId: 'text',
    timestamp: new Date('2026-10-17T00:00:00.000Z'),
  });
  expect(first[2]).toEqual({ type: 'text-start', id: 'a' });
  const observed = await f.storage.execute(
    { type: 'read', key: f.runtimeKey },
    f.context,
  );
  if (observed.kind !== 'found') throw Error('completed journal prerequisite');
  const runtime = createModelRuntime({
    storage: f.storage,
    bodies: f.bodies,
    admission: f.host,
    liveness: (o) => (o.id === owner.id ? 'dead' : 'live'),
  });
  const entry = await runtime.restore({
    key: f.runtimeKey,
    observed: observed.snapshot.fence,
    owner: nextOwner,
    admission: f.admission,
  });
  const replay = await collect(
    bindDurableAiSdkModel({ model: f.model, runtime, entry }),
    runtime.bind(entry),
  );
  expect(replay).toEqual(first);
  expect(f.calls).toHaveLength(1);
});
it('pinned public Zod schema sidecar preserves enumerable schema on the actual first native dispatch', async () => {
  const { z } = await import('zod');
  const { zodSchema } = await import('@ai-sdk/provider-utils');
  const schema = await zodSchema(
    z.object({ value: z.enum(['ORIGINAL', 'OTHER']) }).strict(),
  ).jsonSchema;
  const d = Object.getOwnPropertyDescriptor(schema, '~standard');
  expect(d).toMatchObject({
    enumerable: false,
    writable: false,
    configurable: false,
  });
  expect(d).toHaveProperty('value');
  const capturedSchema = JSON.parse(JSON.stringify(schema));
  const f = await streamFixture(parts, undefined, [
    {
      type: 'function',
      name: 'probe',
      description: '',
      inputSchema: capturedSchema,
    },
  ]);
  cleanup.push(() => f.close());
  const request = {
    ...options,
    tools: [
      {
        type: 'function' as const,
        name: 'probe',
        description: '',
        inputSchema: schema,
      },
    ],
  };
  await f.control.run(async () => {
    const response = await f.guarded.doStream(request);
    const reader = response.stream.getReader();
    while (!(await reader.read()).done) {}
  });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.tools?.[0]).toEqual({
    type: 'function',
    name: 'probe',
    description: '',
    inputSchema: JSON.parse(JSON.stringify(schema)),
  });
  expect(
    Object.getOwnPropertyDescriptor(
      f.calls[0]?.tools?.[0]?.type === 'function'
        ? f.calls[0].tools[0].inputSchema
        : {},
      '~standard',
    ),
  ).toBeUndefined();
  const observed = await f.storage.execute(
    { type: 'read', key: f.runtimeKey },
    f.context,
  );
  if (observed.kind !== 'found') throw Error('pin prerequisite');
  const runtime = createModelRuntime({
    storage: f.storage,
    bodies: f.bodies,
    admission: f.host,
    liveness: (o) => (o.id === owner.id ? 'dead' : 'live'),
  });
  const entry = await runtime.restore({
    key: f.runtimeKey,
    observed: observed.snapshot.fence,
    owner: nextOwner,
    admission: f.admission,
  });
  const changed = await zodSchema(
    z.object({ value: z.enum(['CHANGED', 'OTHER']) }).strict(),
  ).jsonSchema;
  await expect(
    runtime.bind(entry).run(() =>
      Promise.resolve(
        bindDurableAiSdkModel({ model: f.model, runtime, entry }).doStream({
          ...request,
          tools: [
            {
              type: 'function',
              name: 'probe',
              description: '',
              inputSchema: changed,
            },
          ],
        }),
      ),
    ),
  ).rejects.toThrow('DURABLE_ENTRY_CHANGED');
  expect(f.calls).toHaveLength(1);
});
it.each([
  'getter',
  'hidden',
  'symbol',
  'enumerable-sidecar',
  'vendor',
  'version',
  'validate',
  'extra',
  'nested-sidecar',
])(
  'unsupported schema descriptor %s refuses before provider without invoking accessors',
  async (mode) => {
    const { z } = await import('zod');
    const native = z.toJSONSchema(z.object({ value: z.string() }).strict(), {
      target: 'draft-7',
    });
    const source = Object.getOwnPropertyDescriptor(native, '~standard')!;
    const sidecar = {
      ...source.value,
      jsonSchema: { ...source.value.jsonSchema },
    };
    const schema: Record<string, unknown> = JSON.parse(JSON.stringify(native));
    let getters = 0;
    if (mode === 'getter')
      Object.defineProperty(schema, 'unknown', {
        get() {
          getters++;
          return 'bad';
        },
        enumerable: true,
      });
    else if (mode === 'hidden')
      Object.defineProperty(schema, 'hidden', { value: 'bad' });
    else if (mode === 'symbol')
      Object.defineProperty(schema, Symbol('bad'), { value: 'bad' });
    else if (mode === 'nested-sidecar') {
      const nested = { type: 'string' };
      Object.defineProperty(nested, '~standard', source);
      schema.properties = { value: nested };
    } else {
      if (mode === 'vendor') sidecar.vendor = 'unknown';
      if (mode === 'version') sidecar.version = 2;
      if (mode === 'validate') sidecar.validate = 'not-a-function';
      if (mode === 'extra') sidecar.extra = 'unknown';
      Object.defineProperty(schema, '~standard', {
        value: sidecar,
        enumerable: mode === 'enumerable-sidecar',
        writable: false,
        configurable: false,
      });
    }
    const f = await streamFixture(parts, undefined, [
      {
        type: 'function',
        name: 'probe',
        description: '',
        inputSchema: JSON.parse(JSON.stringify(native)),
      },
    ]);
    cleanup.push(() => f.close());
    await expect(
      f.control.run(() =>
        Promise.resolve(
          f.guarded.doStream({
            ...options,
            tools: [{ type: 'function', name: 'probe', inputSchema: schema }],
          }),
        ),
      ),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
    expect(getters).toBe(0);
  },
);
it('native prefix mismatch refuses before provider even on the first frozen invocation', async () => {
  const f = await streamFixture();
  cleanup.push(() => f.close());
  await expect(
    f.control.run(() =>
      Promise.resolve(
        f.guarded.doStream({
          prompt: [
            { role: 'user', content: [{ type: 'text', text: 'WRONG-PREFIX' }] },
          ],
        }),
      ),
    ),
  ).rejects.toThrow('DURABLE_ENTRY_CHANGED');
  expect(f.calls).toHaveLength(0);
});
it('unknown outer native envelope field blocks successful delivery', async () => {
  const f = await streamFixture();
  cleanup.push(() => f.close());
  const model: LanguageModelV3 = {
    ...f.model,
    async doStream(o) {
      const value = await f.model.doStream(o);
      return { ...value, unknown: 'SECRET' };
    },
  };
  const guarded = bindDurableAiSdkModel({
    model,
    runtime: f.runtime,
    entry: f.entry,
  });
  await expect(
    f.control.run(() => Promise.resolve(guarded.doStream(options))),
  ).rejects.toThrow('DURABLE_UNSUPPORTED');
});
it('same-process duplicate wrapper call never dispatches or consumes the native stream twice', async () => {
  const f = await streamFixture();
  cleanup.push(() => f.close());
  await f.control.run(async () => {
    const first = Promise.resolve(f.guarded.doStream(options));
    const duplicate = Promise.resolve(f.guarded.doStream(options));
    const response = await first;
    await expect(duplicate).rejects.toThrow('DURABLE_DUPLICATE_CONSUMER');
    const reader = response.stream.getReader();
    while (!(await reader.read()).done) {}
  });
  expect(f.calls).toHaveLength(1);
});
it('text delta is not projected before its own partial COMMIT acknowledgment', async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const f = await streamFixture(parts, (storage) => ({
    async execute(command, context) {
      if (command.type === 'partial' && command.sequence === 2) {
        entered.resolve();
        await release.promise;
      }
      return storage.execute(command, context);
    },
    close: () => storage.close(),
  }));
  cleanup.push(() => f.close());
  const observed: string[] = [];
  const done = f.control.run(async () => {
    const { stream } = await f.guarded.doStream(options);
    const reader = stream.getReader();
    while (true) {
      const i = await reader.read();
      if (i.done) break;
      observed.push(i.value.type);
    }
  });
  try {
    await entered.promise;
    expect(observed).toEqual(['stream-start', 'text-start']);
    const audit = await f.storage.execute(
      { type: 'listOutbox', key: f.runtimeKey, limit: 10 },
      f.context,
    );
    expect(
      audit.kind === 'listed' ? audit.entries.map((p) => p.sequence) : audit,
    ).toEqual([0, 1]);
  } finally {
    release.resolve();
    await done;
  }
  expect(observed).toEqual([
    'stream-start',
    'text-start',
    'text-delta',
    'text-end',
    'finish',
  ]);
});
