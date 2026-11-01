import type { ModelMessage, PrepareStepFunction } from 'ai';
import { deliverPostToolInbox } from '../../services/orchestration/post-tool-inbox.js';
import { currentAuthorizedTurnCorrelation } from './authorized-turn-correlation.js';

/** VoltAgent's prepareStep runs after all tools in the preceding model step settle. */
export function createInboxStepPreparation(
  previous?: PrepareStepFunction,
): PrepareStepFunction {
  const correlation = currentAuthorizedTurnCorrelation();
  const inserted: { offset: number; message: ModelMessage }[] = [];
  return async (step) => {
    const prepared = await previous?.(step);
    if (!correlation) return prepared;
    const base = prepared?.messages ?? step.messages;
    if (step.steps.at(-1)?.toolResults.length) {
      deliverPostToolInbox(
        correlation.sessionId,
        correlation.turnId,
        (text) => {
          inserted.push({
            offset: base.length,
            message: { role: 'user', content: text },
          });
        },
      );
    }
    if (!inserted.length) return prepared;
    const messages = [...base];
    let added = 0;
    for (const entry of inserted) {
      messages.splice(
        Math.min(entry.offset + added, messages.length),
        0,
        entry.message,
      );
      added += 1;
    }
    return { ...prepared, messages };
  };
}
