import type { AgentData } from '../../contexts/AgentsContext';

type ProjectChatCta = {
  /** Invites a chat without overriding the composer's Agent selection. */
  headline: string;
  detail: string;
  actionLabel: string;
};

export function projectChatCta(
  chatReadyAgents: readonly Pick<AgentData, 'name'>[],
): ProjectChatCta | null {
  if (chatReadyAgents.length === 0) return null;
  return {
    headline: 'Start a chat in this project.',
    detail: 'Choose an agent above, then ask a question or describe a task.',
    actionLabel: 'Start a chat',
  };
}
