import { afterEach, expect, it } from 'vitest';
import { captureVoltEntry } from '../voltagent.js';
import { fixture, messages } from './fixture.js';
import { nativeOptions, runtimeFixture } from './r1-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
for (const shape of [
  'index-getter',
  'map-getter',
  'hidden',
  'symbol',
  'prototype',
] as const)
  it(`R1.5 entry capture rejects ${shape} array without accessing caller code`, async () => {
    const f = await fixture();
    cleanup.push(() => f.close());
    let getters = 0;
    const values = ['one'];
    if (shape === 'index-getter')
      Object.defineProperty(values, '0', {
        enumerable: true,
        get() {
          getters++;
          return 'one';
        },
      });
    if (shape === 'map-getter')
      Object.defineProperty(values, 'map', {
        get() {
          getters++;
          return Array.prototype.map;
        },
      });
    if (shape === 'hidden')
      Object.defineProperty(values, 'secret', { value: 'hidden' });
    if (shape === 'symbol')
      Object.defineProperty(values, Symbol('hidden'), { value: 'hidden' });
    if (shape === 'prototype')
      Object.setPrototypeOf(values, { map: Array.prototype.map });
    const answer = await captureVoltEntry(f.bodies, {
      version: 1,
      binding: f.admission.binding,
      sourceCutoff: 'A',
      authoredDigest: `sha256:${'c'.repeat(64)}`,
      messages,
      generation: {},
      tools: [
        {
          type: 'function',
          name: 'probe',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string', enum: values } },
          },
        },
      ],
    }).then(
      () => 'accepted',
      () => 'refused',
    );
    expect(getters).toBe(0);
    expect(answer).toBe('refused');
  });
it('R1.5 native part discriminator accessor is never invoked', async () => {
  let getters = 0;
  const f = await runtimeFixture({
    stream(c) {
      c.enqueue({
        get type() {
          getters++;
          return 'text-start' as const;
        },
        id: 'a',
      });
      c.close();
    },
  });
  cleanup.push(() => f.close());
  const result = await f.control
    .run(async () => {
      const { stream } = await f.guarded.doStream(nativeOptions);
      return stream.getReader().read();
    })
    .then(
      () => 'accepted',
      () => 'refused',
    );
  expect(getters).toBe(0);
  expect(result).toBe('refused');
});
for (const shape of ['index-getter', 'hidden', 'symbol', 'prototype'] as const)
  it(`R1.5 native request rejects ${shape} schema array with an otherwise matching template`, async () => {
    const { z } = await import('zod');
    const { zodSchema } = await import('@ai-sdk/provider-utils');
    const converted = await zodSchema(
      z.object({ value: z.enum(['one']) }).strict(),
    ).jsonSchema;
    const original = JSON.parse(JSON.stringify(converted));
    let getters = 0;
    const values = ['one'];
    if (shape === 'index-getter')
      Object.defineProperty(values, '0', {
        enumerable: true,
        get() {
          getters++;
          return 'one';
        },
      });
    if (shape === 'hidden')
      Object.defineProperty(values, 'secret', { value: 'bad' });
    if (shape === 'symbol')
      Object.defineProperty(values, Symbol('bad'), { value: 'bad' });
    if (shape === 'prototype')
      Object.setPrototypeOf(values, { map: Array.prototype.map });
    const schema = {
      ...converted,
      properties: { value: { type: 'string' as const, enum: values } },
    };
    const f = await runtimeFixture({
      entryTools: [
        {
          type: 'function',
          name: 'probe',
          description: '',
          inputSchema: original,
        },
      ],
    });
    cleanup.push(() => f.close());
    const outcome = await f.control
      .run(() =>
        Promise.resolve(
          f.guarded.doStream({
            ...nativeOptions,
            tools: [
              {
                type: 'function',
                name: 'probe',
                description: '',
                inputSchema: schema,
              },
            ],
          }),
        ),
      )
      .then(
        () => 'accepted',
        () => 'refused',
      );
    expect(getters).toBe(0);
    expect(outcome).toBe('refused');
    expect(f.calls).toHaveLength(0);
  });
