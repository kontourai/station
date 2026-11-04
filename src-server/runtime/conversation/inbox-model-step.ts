import { currentAgentTurn } from '@kontourai/agent-runtime';
import type { Memory } from '@voltagent/core';
import {
  type ModelMessage,
  type PrepareStepFunction,
  wrapLanguageModel,
} from 'ai';
import { z } from 'zod';
import {
  deliverPostToolInbox,
  type PostToolSteerInput,
} from '../../services/orchestration/post-tool-inbox.js';
import { currentAuthorizedTurnCorrelation } from './authorized-turn-correlation.js';

type ModelStep = Parameters<PrepareStepFunction>[0];
const preparedByInbox = Symbol('station.inbox-preparation');
interface InsertedSteer {
  readonly key: string;
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
  let streamOrdinal = -1;
  return async (step) => {
    if (step.stepNumber === 0) {
      streamOrdinal++;
      inserted.length = 0;
    }
    const prepared = await previous?.(step);
    if (prepared && Reflect.get(prepared, preparedByInbox) === true)
      return prepared;
    if (!correlation) return prepared;
    const model = prepared?.model ?? step.model;
    const pending: PostToolSteerInput[] = [];
    let restoredPending: InsertedSteer[] = [];
    const afterToolCallId = step.steps.at(-1)?.toolResults.at(-1)?.toolCallId;
    const capture = () => {
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
              key: input.key,
              afterToolCallId,
              message: { role: 'user', content: input.text },
            });
            pending.push(input);
          },
        );
      }
      return {
        entries: inserted.map((entry) => ({
          key: entry.key,
          afterToolCallId: entry.afterToolCallId,
          text: entry.message.content,
        })),
        pending: pending.map((input) => input.key),
      };
    };
    const turn = currentAgentTurn();
    if (turn) {
      // Capture prompt additions before dispatch. Recovery has no live inbox
      // handoff to repeat, but must reconstruct the identical pinned request.
      const saved = await turn.entry(
        `inbox-steers:${streamOrdinal}:${step.stepNumber}`,
        capture,
      );
      const savedSteers = z
        .object({
          entries: z.array(
            z
              .object({
                key: z.string().min(1),
                afterToolCallId: z.string().min(1),
                text: z.string(),
              })
              .strict(),
          ),
          pending: z.array(z.string().min(1)),
        })
        .strict()
        .parse(saved);
      inserted.splice(
        0,
        inserted.length,
        ...savedSteers.entries.map((entry) => ({
          key: entry.key,
          afterToolCallId: entry.afterToolCallId,
          message: { role: 'user' as const, content: entry.text },
        })),
      );
      restoredPending = inserted.filter(
        (entry) =>
          savedSteers.pending.includes(entry.key) &&
          !pending.some((input) => input.key === entry.key),
      );
    }
    if (!turn) capture();
    if (!inserted.length) return prepared;
    const remember = async (key: string, text: string) => {
      if (context?.memory && context.userId && context.conversationId) {
        await context.memory.addMessages(
          [
            {
              id: `inbox-steer:${correlation.sessionId}:${key}`,
              role: 'user',
              parts: [{ type: 'text', text }],
            },
          ],
          context.userId,
          context.conversationId,
        );
      }
    };
    let attempted = false;
    return {
      ...prepared,
      [preparedByInbox]: true,
      messages: withInsertedSteers(
        prepared?.messages ?? step.messages,
        step.steps,
        inserted,
      ),
      ...((pending.length || restoredPending.length) &&
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
                    await input.onDispatched(() =>
                      remember(input.key, input.text),
                    );
                  for (const entry of restoredPending)
                    await remember(entry.key, String(entry.message.content));
                  return result;
                },
              },
            }),
          }
        : {}),
    };
  };
}
