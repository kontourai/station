export function formatRecordedCost(stats: {
  cost: number;
  reportedCostUsd?: number;
  estimatedCostUsd?: number;
}): string {
  if (
    stats.reportedCostUsd === undefined &&
    stats.estimatedCostUsd === undefined &&
    stats.cost === 0
  )
    return 'Not reported';
  return `$${stats.cost.toFixed(2)}`;
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
      reportedCostUsd: stats.reportedCostUsd,
      estimatedCostUsd: stats.estimatedCostUsd,
    }))
    .sort((a, b) => b.messages - a.messages);
}
