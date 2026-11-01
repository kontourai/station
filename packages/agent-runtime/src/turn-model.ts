import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import { currentAgentTurn } from './turn-runtime.js';
import { agentWire, readAgentWire } from './turn-wire.js';

/** Instruments the provider boundary; each framework retains its native loop. */
export function durableLanguageModel(model: LanguageModelV3): LanguageModelV3 {
  const ordinals = new WeakMap<object, number>();
  return {
    specificationVersion: 'v3',
    provider: model.provider,
    modelId: model.modelId,
    supportedUrls: model.supportedUrls,
    doGenerate(options) {
      if (currentAgentTurn())
        throw new Error('DURABLE_AGENT_GENERATE_UNSUPPORTED');
      return model.doGenerate(options);
    },
    async doStream(options) {
      const turn = currentAgentTurn();
      if (!turn) return model.doStream(options);
      const ordinal = ordinals.get(turn) ?? 0;
      ordinals.set(turn, ordinal + 1);
      const id = `model:${ordinal}`;
      const { abortSignal: _signal, headers: _headers, ...request } = options;
      const planned = await turn.effect({
        type: 'effectPlan',
        intent: {
          id,
          kind: 'model',
          replay: 'unsafe',
          input: agentWire({
            provider: model.provider,
            model: model.modelId,
            request,
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
      const response = await model.doStream({
        ...options,
        abortSignal: turn.signal,
      });
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
}
