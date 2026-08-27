import type { ConversationStatsSnapshot, ModelStats } from './types';

export function getContextWindowColor(percentage: number): string {
  return percentage > 80 ? '#ef4444' : percentage > 50 ? '#f59e0b' : '#10b981';
}

export function getContextBreakdownEntries(
  stats: Partial<
    Pick<
      ConversationStatsSnapshot,
      | 'systemPromptTokens'
      | 'mcpServerTokens'
      | 'userMessageTokens'
      | 'assistantMessageTokens'
      | 'contextFilesTokens'
    >
  >,
) {
  return [
    stats.systemPromptTokens !== undefined
      ? { label: 'System Prompt', value: stats.systemPromptTokens }
      : null,
    stats.mcpServerTokens !== undefined
      ? { label: 'MCP Tools', value: stats.mcpServerTokens }
      : null,
    stats.userMessageTokens !== undefined
      ? { label: 'User Messages', value: stats.userMessageTokens }
      : null,
    stats.assistantMessageTokens !== undefined
      ? { label: 'Assistant Messages', value: stats.assistantMessageTokens }
      : null,
    stats.contextFilesTokens !== undefined && stats.contextFilesTokens > 0
      ? { label: 'Context Files', value: stats.contextFilesTokens }
      : null,
  ].filter(
    (entry): entry is { label: string; value: number } => entry !== null,
  );
}

export function getModelStatsEntries(
  modelStats?: Record<string, ModelStats>,
): Array<[string, ModelStats]> {
  return Object.entries(modelStats ?? {});
}

export function formatAverageTokens(
  totalTokens: number | undefined,
  turns: number,
) {
  // `undefined` is "never measured", and an average of an unmeasured
  // figure is not zero — the caller renders the shared unreported dash
  // (station#3201).
  if (turns <= 0 || totalTokens === undefined) {
    return null;
  }

  return Math.round(totalTokens / turns).toLocaleString();
}
