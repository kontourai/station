import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { z } from 'zod';
import { schemaData } from './codecs.js';
import {
  currentAgentTurn,
  nextProviderCallId,
  runWithProviderParent,
} from './turn-runtime.js';
import { agentWire, readAgentWire } from './turn-wire.js';

const providerLayer = Symbol('agent-runtime.provider-layer');

/** Instruments the provider boundary; each framework retains its native loop. */
export function durableLanguageModel(
  model: LanguageModelV3,
  options: {
    readonly layer?: 'provider';
    readonly affinity?: (
      providerSessionId: string,
      current: Parameters<LanguageModelV3['doStream']>[0]['providerOptions'],
    ) =>
      | NonNullable<
          Parameters<LanguageModelV3['doStream']>[0]['providerOptions']
        >
      | undefined;
  } = {},
): LanguageModelV3 {
  if (
    options.layer === 'provider' &&
    Reflect.get(model, providerLayer) === true
  )
    return model;
  const ordinals = new WeakMap<object, number>();
  const guarded: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate(options) {
      if (currentAgentTurn())
        throw new Error('DURABLE_AGENT_GENERATE_UNSUPPORTED');
      return model.doGenerate(options);
    },
    async doStream(callOptions) {
      const turn = currentAgentTurn();
      if (!turn) return model.doStream(callOptions);
      const affinity = options.affinity?.(
        turn.providerSessionId,
        callOptions.providerOptions,
      );
      const optionsWithAffinity = affinity
        ? {
            ...callOptions,
            providerOptions: { ...callOptions.providerOptions, ...affinity },
          }
        : callOptions;
      const ordinal = ordinals.get(turn) ?? 0;
      ordinals.set(turn, ordinal + 1);
      const id =
        options.layer === 'provider'
          ? nextProviderCallId(turn)
          : `model:${ordinal}`;
      const {
        abortSignal: _signal,
        headers: _headers,
        ...request
      } = optionsWithAffinity;
      const pinnedRequest = {
        ...request,
        ...(request.tools
          ? {
              tools: request.tools.map((tool) => {
                if (tool.type !== 'function')
                  throw new Error('DURABLE_AGENT_PROVIDER_TOOLS_UNSUPPORTED');
                return {
                  ...tool,
                  inputSchema: schemaData(
                    tool.inputSchema instanceof z.ZodType
                      ? z.toJSONSchema(tool.inputSchema)
                      : tool.inputSchema,
                  ),
                };
              }),
            }
          : {}),
      };
      const planned = await turn.effect({
        type: 'effectPlan',
        intent: {
          id,
          kind: options.layer === 'provider' ? 'provider' : 'model',
          replay: 'unsafe',
          input: agentWire({
            provider: model.provider,
            model: model.modelId,
            request: pinnedRequest,
          }),
        },
      });
      const restoredParts = (wire: string): LanguageModelV3StreamPart[] => {
        const value = readAgentWire(wire);
        if (
          !Array.isArray(value) ||
          !value.every(
            (part) =>
              part && typeof part === 'object' && typeof part.type === 'string',
          )
        )
          throw new Error('DURABLE_AGENT_MODEL_TAPE_DAMAGED');
        // The tape was captured from this pinned model implementation. The
        // data codec verifies the complete byte representation before replay.
        return value;
      };
      if (planned.effect.state === 'completed') {
        const parts = restoredParts(planned.effect.attempts.at(-1)!.output!);
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const part of parts) controller.enqueue(part);
              controller.close();
            },
          }),
        };
      }
      const begun = await turn.effect({ type: 'effectBegin', id });
      if (!begun.execute) throw new Error('DURABLE_AGENT_MODEL_INDETERMINATE');
      await turn.assertCurrent();
      const invoke = () =>
        model.doStream({
          ...pinnedRequest,
          headers: optionsWithAffinity.headers,
          abortSignal: turn.signal,
        });
      const response = await (options.layer === 'provider'
        ? invoke()
        : runWithProviderParent(id, invoke));
      const reader = response.stream.getReader();
      const parts: LanguageModelV3StreamPart[] = [];
      const held: LanguageModelV3StreamPart[] = [];
      let suffix = false;
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              const part = next.value;
              parts.push(part);
              if (part.type.startsWith('tool-') || part.type === 'finish')
                suffix = true;
              if (suffix) held.push(part);
              else {
                await turn.effect({
                  type: 'effectPartial',
                  id,
                  part: agentWire(part),
                });
                controller.enqueue(part);
              }
            }
            if (
              !parts.some((part) => part.type === 'finish') ||
              parts.some((part) => part.type === 'error')
            )
              throw new Error('DURABLE_AGENT_MODEL_INCOMPLETE');
            await turn.effect({
              type: 'effectComplete',
              id,
              output: agentWire(parts),
            });
            for (const part of held) controller.enqueue(part);
            controller.close();
          } catch (error) {
            controller.error(error);
          } finally {
            reader.releaseLock();
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
      return { ...response, stream };
    },
  };
  if (options.layer === 'provider')
    Object.defineProperty(guarded, providerLayer, { value: true });
  return guarded;
}
