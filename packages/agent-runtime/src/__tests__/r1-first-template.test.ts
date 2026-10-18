import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
} from '@ai-sdk/provider';
import { FunctionTool } from '@strands-agents/sdk';
import { VercelModel } from '@strands-agents/sdk/models/vercel';
import { createTool } from '@voltagent/core';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { createModelRuntime, DEFAULT_MODEL_POLICY } from '../index.js';
import { openSqliteModelStorage } from '../sqlite.js';
import {
  captureStrandsEntry,
  createDurableStrandsConsumer,
} from '../strands.js';
import { captureVoltEntry, createDurableVoltConsumer } from '../voltagent.js';
import { fixture, owner, parts } from './fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});
for (const framework of ['voltagent', 'strands-vercel'] as const)
  for (const fault of [
    'schema',
    'name',
    'order',
    'additional-generation',
    'omitted-generation',
  ] as const)
    it(`R1.2 ${framework} refuses first native ${fault} mismatch with network zero`, async () => {
      const f = await fixture();
      cleanup.push(() => f.close());
      const binding = {
        ...f.admission.binding,
        framework,
        frameworkVersion:
          framework === 'voltagent' ? ('2.10.0' as const) : ('1.19.0' as const),
      };
      const admission = { binding, writerGeneration: 'writer-1' };
      const host = () => admission;
      const storage = openSqliteModelStorage({
        database: f.database,
        host,
        policy: DEFAULT_MODEL_POLICY,
      });
      cleanup.push(() => storage.close());
      const runtime = createModelRuntime({
        storage,
        bodies: f.bodies,
        admission: host,
        liveness: () => 'live',
      });
      const tools: import('../codecs.js').VoltEntry['tools'] = [
        {
          type: 'function' as const,
          name: 'one',
          description: 'One',
          inputSchema: {
            type: 'object' as const,
            properties: { value: { type: 'string' as const } },
            required: ['value'],
            additionalProperties: false,
          },
        },
        {
          type: 'function' as const,
          name: 'two',
          description: 'Two',
          inputSchema: {
            type: 'object' as const,
            properties: {},
            additionalProperties: false,
          },
        },
      ];
      const entry = await runtime.start({
        key: {
          scopeId: 'scope',
          conversationId: 'template',
          invocationId: 'turn',
        },
        owner,
        admission,
        capture: () =>
          framework === 'voltagent'
            ? captureVoltEntry(f.bodies, {
                version: 1,
                binding,
                sourceCutoff: 'A',
                authoredDigest: `sha256:${'c'.repeat(64)}`,
                messages: [
                  {
                    id: 'u',
                    role: 'user',
                    parts: [{ type: 'text', text: 'INPUT' }],
                  },
                ],
                generation:
                  fault === 'omitted-generation' ? { temperature: 0.2 } : {},
                tools,
              })
            : captureStrandsEntry(f.bodies, {
                version: 1,
                binding,
                sourceCutoff: 'A',
                authoredDigest: `sha256:${'c'.repeat(64)}`,
                prefix: [],
                effectiveInput: 'INPUT',
                systemPrompt: '',
                vercelConfig:
                  fault === 'omitted-generation' ? { temperature: 0.2 } : {},
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
          throw Error('unsupported');
        },
        async doStream(o) {
          calls.push(o);
          return {
            stream: new ReadableStream({
              start(c) {
                for (const p of parts) c.enqueue(p);
                c.close();
              },
            }),
          };
        },
      };
      if (framework === 'voltagent') {
        const c = createDurableVoltConsumer({ runtime, entry, model });
        if (fault === 'additional-generation')
          Object.assign(c.raw, { temperature: 0.6 });
        else if (fault === 'omitted-generation') {
          const selected = c.raw.model;
          if (
            !selected ||
            typeof selected !== 'object' ||
            !('specificationVersion' in selected) ||
            selected.specificationVersion !== 'v3'
          )
            throw Error('real native model prerequisite');
          const dispatch = selected.doStream.bind(selected);
          selected.doStream = (options) => {
            const { temperature: _temperature, ...rest } = options;
            return dispatch(rest);
          };
        } else {
          c.raw.removeTools(['one', 'two']);
          const supplied =
            fault === 'order'
              ? [...tools].reverse()
              : tools.map((t, i) =>
                  i === 0
                    ? {
                        ...t,
                        name: fault === 'name' ? 'changed' : t.name,
                        inputSchema:
                          fault === 'schema'
                            ? {
                                type: 'object' as const,
                                properties: {
                                  value: { type: 'number' as const },
                                },
                                required: ['value'],
                                additionalProperties: false,
                              }
                            : t.inputSchema,
                      }
                    : t,
                );
          c.raw.addTools(
            supplied.map((t) =>
              createTool({
                name: t.name,
                description: t.description ?? '',
                parameters: z.fromJSONSchema(t.inputSchema),
                execute: async () => 'not reached',
              }),
            ),
          );
        }
        await c.control
          .run(async () => {
            const result = await c.raw.streamText([
              {
                id: 'u',
                role: 'user',
                parts: [{ type: 'text', text: 'INPUT' }],
              },
            ]);
            for await (const _ of result.fullStream) {
            }
          })
          .catch(() => {});
      } else {
        const c = createDurableStrandsConsumer({ runtime, entry, model });
        if (fault === 'additional-generation') {
          if (!(c.agent.model instanceof VercelModel))
            throw Error('real Vercel prerequisite');
          c.agent.model.updateConfig({
            ...c.agent.model.getConfig(),
            temperature: 0.6,
          });
        } else if (fault === 'omitted-generation') {
          if (!(c.agent.model instanceof VercelModel))
            throw Error('real Vercel prerequisite');
          c.agent.model.updateConfig({
            ...c.agent.model.getConfig(),
            temperature: undefined,
          });
        } else {
          const supplied =
            fault === 'order'
              ? [...tools].reverse()
              : tools.map((t, i) =>
                  i === 0
                    ? {
                        ...t,
                        name: fault === 'name' ? 'changed' : t.name,
                        inputSchema:
                          fault === 'schema'
                            ? {
                                type: 'object' as const,
                                properties: {
                                  value: { type: 'number' as const },
                                },
                                required: ['value'],
                                additionalProperties: false,
                              }
                            : t.inputSchema,
                      }
                    : t,
                );
          c.agent.toolRegistry.clear();
          c.agent.toolRegistry.add(
            supplied.map(
              (t) =>
                new FunctionTool({
                  name: t.name,
                  description: t.description ?? '',
                  inputSchema: t.inputSchema,
                  callback: () => 'not reached',
                }),
            ),
          );
        }
        await c.control
          .run(async () => {
            for await (const _ of c.agent.stream('INPUT')) {
            }
          })
          .catch(() => {});
      }
      expect(calls).toHaveLength(0);
    });
