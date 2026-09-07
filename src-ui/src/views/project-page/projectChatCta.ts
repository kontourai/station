import type { AgentData } from '../../contexts/AgentsContext';

export type ProjectChatCta = {
  /** Names the Agent the chat will actually start on. */
  headline: string;
  /** The promise, spoken only where a chat-ready Agent makes it true. */
  detail: string;
  actionLabel: string;
};

/**
 * The project page's "New here?" banner, derived from the Agents that can
 * start a chat in THIS project rather than asserted.
 *
 * The banner used to read "Chat with Station to get started — no setup
 * required" unconditionally. On a fresh install that was two false claims at
 * once: Station's own Agent is the one that needs a model configured, and the
 * three engine Agents that WERE ready went unnamed. Copy and enablement now
 * come from one fact — `selectChatReadyAgents` for this project — so the
 * banner cannot promise what the next click refuses.
 *
 * No chat-ready Agent means no banner. An invitation to start something that
 * cannot start is worse than silence; the engines surface, not a dead CTA in
 * a project page, is where that gets fixed.
 */
export function projectChatCta(
  chatReadyAgents: readonly Pick<AgentData, 'name'>[],
): ProjectChatCta | null {
  const first = chatReadyAgents[0];
  if (!first) return null;
  return {
    headline: `New here? Chat with ${first.name} to get started.`,
    detail: 'Ask a question or describe a task — no setup required.',
    actionLabel: 'Start a chat',
  };
}
