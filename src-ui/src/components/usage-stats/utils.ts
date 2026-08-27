export function getAverageCostPerMessage(lifetime: {
  totalCost: number;
  totalMessages: number;
}): number {
  return lifetime.totalMessages > 0
    ? lifetime.totalCost / lifetime.totalMessages
    : 0;
}

export function getTotalUsageConversations(lifetime: {
  totalConversations?: number;
  totalSessions?: number;
}): number {
  return lifetime.totalConversations ?? lifetime.totalSessions ?? 0;
}

export function getTopUsageEntries<T extends Record<string, any>>(
  items: T,
  limit = 5,
): Array<[string, any]> {
  return Object.entries(items)
    .sort(([, a], [, b]) => (b as any).messages - (a as any).messages)
    .slice(0, limit);
}

export function getUsageModelDisplayName(
  models: any[],
  modelId: string,
): string {
  const modelInfo = models.find(
    (model) => model.id === modelId || model.originalId === modelId,
  );
  return modelInfo?.name || modelId;
}

export function getUsageAgentsForModel({
  agentSlug,
  agents,
  modelId,
  modelOriginalId,
}: {
  agentSlug?: string;
  agents: any[];
  modelId: string;
  modelOriginalId?: string;
}) {
  if (agentSlug) {
    return agents.filter((agent) => agent.slug === agentSlug);
  }

  return agents.filter(
    (agent) => agent.model === modelId || agent.model === modelOriginalId,
  );
}

export function getAgentModelBreakdown({
  agentStats,
  models,
}: {
  agentStats: any;
  models: any[];
}) {
  if (!agentStats.models) {
    return [];
  }

  return Object.entries(agentStats.models)
    .map(([modelId, stats]: [string, any]) => ({
      modelId,
      displayName: getUsageModelDisplayName(models, modelId),
      messages: stats.messages,
      cost: stats.cost,
    }))
    .sort((a, b) => b.messages - a.messages);
}
