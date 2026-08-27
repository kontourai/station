import type {
  ChatExecutionMetadata,
  EffectiveModelSource,
} from '../utils/execution';

/**
 * What model a REOPENED conversation should start on.
 *
 * Extracted so the decision is testable: it used to live inline in
 * `useChatDockActions`, whose hook body a test cannot reach without standing
 * up the whole dock, and the inline version seeded the AGENT DEFAULT when the
 * real model was not yet known (station#3165).
 *
 * A send in that window then dispatched `override: <agent default>` — a model
 * the user never chose for that conversation. Unknown must mean unset, so
 * `resolveTurnModel` sends no override at all until the snapshot lands.
 */
export function reopenedSessionExecution(
  agentExecution: ChatExecutionMetadata,
  model: string | undefined,
  modelSource: EffectiveModelSource = 'runtime',
): ChatExecutionMetadata {
  if (model) {
    return { ...agentExecution, model, modelSource };
  }
  return {
    ...agentExecution,
    model: undefined,
    modelSource: 'unknown' as const,
  };
}
