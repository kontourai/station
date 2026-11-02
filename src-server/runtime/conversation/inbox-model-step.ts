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

type ModelStep = Parameters<PrepareStepFunction>[0];
interface InsertedSteer {
  readonly afterToolCallId: string;
  readonly message: ModelMessage;
}

function hasToolId(message: ModelMessage, ids: ReadonlySet<string>): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some(
      (part) => 'toolCallId' in part && ids.has(part.toolCallId),
    )
  );
}

function withInsertedSteers(
  base: ModelMessage[],
  steps: ModelStep['steps'],
  inserted: InsertedSteer[],
): ModelMessage[] {
  const messages = [...base];
  let floor = 0;
  for (const entry of inserted) {
    const anchor = new Set([entry.afterToolCallId]);
    let position = -1;
    for (let index = 0; index < messages.length; index++) {
      if (messages[index].role === 'tool' && hasToolId(messages[index], anchor))
        position = index + 1;
    }
    if (position < 0) {
      const boundary = steps.findIndex((step) =>
        step.toolResults.some(
          (result) => result.toolCallId === entry.afterToolCallId,
        ),
      );
      const following = new Set(
        steps
          .slice(boundary + 1)
          .flatMap((step) => step.toolCalls.map((call) => call.toolCallId)),
      );
      position = messages.findIndex((message) => hasToolId(message, following));
      if (position < 0) {
        // If compaction removed every anchor, precede its replacement for later replies.
        const firstContext = following.size
          ? messages.findIndex((message) => message.role !== 'system')
          : -1;
        position = firstContext < 0 ? messages.length : firstContext;
      }
    }
    position = Math.max(position, floor);
    messages.splice(position, 0, entry.message);
    floor = position + 1;
  }
  return messages;
}

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
  const inserted: InsertedSteer[] = [];
  return async (step) => {
    const prepared = await previous?.(step);
    if (!correlation) return prepared;
    const model = prepared?.model ?? step.model;
    const pending: PostToolSteerInput[] = [];
    const afterToolCallId = step.steps.at(-1)?.toolResults.at(-1)?.toolCallId;
    if (
      (!context?.memory || (context.userId && context.conversationId)) &&
      typeof model !== 'string' &&
      model.specificationVersion === 'v3' &&
      afterToolCallId
    ) {
      deliverPostToolInbox(
        correlation.sessionId,
        correlation.turnId,
        (input) => {
          inserted.push({
            afterToolCallId,
            message: { role: 'user', content: input.text },
          });
          pending.push(input);
        },
      );
    }
    if (!inserted.length) return prepared;
    let attempted = false;
    return {
      ...prepared,
      messages: withInsertedSteers(
        prepared?.messages ?? step.messages,
        step.steps,
        inserted,
      ),
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
                  let result: Awaited<ReturnType<typeof doStream>>;
                  try {
                    result = await doStream();
                  } catch (error) {
                    for (const input of pending) input.onUnconfirmed();
                    throw error;
                  }
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
