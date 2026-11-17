/**
 * #2377 slice D (owner decision 2026-11-16): feedback analysis is Station's
 * own utility work. It runs on the default agent's model with no tools at
 * all, like chat-title generation: it acts for no person, so it has no
 * station-control caller, and an agent whose tools could only be refused
 * must not be offered them.
 */
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { IAgentFramework } from '../types.js';

const FEEDBACK_ANALYSIS_INSTRUCTIONS =
  'You analyze user feedback about Station and answer only from the text you are given.';

export function createFeedbackAnalyzer(deps: {
  framework: Pick<IAgentFramework, 'createTempAgent'>;
  /** The spec whose model the analysis uses (the default agent's). */
  resolveSpec(): AgentSpec | undefined;
  createModel(spec: AgentSpec): Promise<unknown>;
}): (prompt: string) => Promise<string> {
  return async (prompt) => {
    const spec = deps.resolveSpec();
    if (!spec) throw new Error('No agents available for feedback analysis');
    const agent = await deps.framework.createTempAgent({
      purpose: 'utility',
      name: 'feedback-analyzer',
      instructions: FEEDBACK_ANALYSIS_INSTRUCTIONS,
      model: (await deps.createModel(spec)) as never,
      tools: [],
      maxSteps: 1,
    });
    const result = await agent.generateText(prompt);
    return result.text ?? '';
  };
}
