import type { Memory } from '@voltagent/core';
import {
  type ModelMessage,
  type PrepareStepFunction,
  wrapLanguageModel,
} from 'ai';
import {
  deliverPostToolInbox,
  type PostToolSteerInput,
} from '../../services/orchestration/post-tool-inbox.js';
import { currentAuthorizedTurnCorrelation } from './authorized-turn-correlation.js';

/** prepareStep observes settled tools; the model wrapper acknowledges accepted dispatch. */
export function createInboxStepPreparation(
  previous?: PrepareStepFunction,
  context?: {
    memory: Memory | false | undefined;
    userId?: string;
    conversationId?: string;
  },
): PrepareStepFunction {
  const correlation = currentAuthorizedTurnCorrelation();
  const inserted: ModelMessage[] = [];
  return async (step) => {
    const prepared = await previous?.(step);
    if (!correlation) return prepared;
    const model = prepared?.model ?? step.model;
    const pending: PostToolSteerInput[] = [];
    if (
      (!context?.memory || (context.userId && context.conversationId)) &&
      typeof model !== 'string' &&
      model.specificationVersion === 'v3' &&
      step.steps.at(-1)?.toolResults.length
    ) {
      deliverPostToolInbox(
        correlation.sessionId,
        correlation.turnId,
        (input) => {
          inserted.push({ role: 'user', content: input.text });
          pending.push(input);
        },
      );
    }
    if (!inserted.length) return prepared;
    let attempted = false;
    return {
      ...prepared,
      messages: [...(prepared?.messages ?? step.messages), ...inserted],
      ...(pending.length &&
      typeof model !== 'string' &&
      model.specificationVersion === 'v3'
        ? {
            model: wrapLanguageModel({
              model,
              middleware: {
                specificationVersion: 'v3',
                wrapStream: async ({ doStream }) => {
                  if (attempted)
                    throw new Error(
                      'The model request carrying this steer was already attempted.',
                    );
                  attempted = true;
                  const result = await doStream();
                  for (const input of pending)
                    await input.onDispatched(async () => {
                      if (
                        context?.memory &&
                        context.userId &&
                        context.conversationId
                      ) {
                        await context.memory.addMessages(
                          [
                            {
                              id: `inbox-steer:${correlation.sessionId}:${input.key}`,
                              role: 'user',
                              parts: [{ type: 'text', text: input.text }],
                            },
                          ],
                          context.userId,
                          context.conversationId,
                        );
                      }
                    });
                  return result;
                },
              },
            }),
          }
        : {}),
    };
  };
}
