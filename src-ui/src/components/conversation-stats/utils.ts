import type { ConversationStatsSnapshot, ModelStats } from './types';

// Meter rungs are theme tokens (#2140). The literals this returned were the
// dark values, painted through `style={}` where the theme cannot follow; on
// light the mid and low rungs measured 2.2:1 and 2.5:1 against a white panel.
export function getContextWindowColor(percentage: number): string {
  return percentage > 80
    ? 'var(--meter-high)'
    : percentage > 50
      ? 'var(--meter-mid)'
      : 'var(--meter-low)';
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
  // (archive#3201).
  if (turns <= 0 || totalTokens === undefined) {
    return null;
  }

  return Math.round(totalTokens / turns).toLocaleString();
}

/**
 * An engine-reported cost in the engine's own unit, never as USD: `0.0745
 * credits`, `1.20 EUR`. A currency code stays a suffix; a vendor unit is
 * pluralized only when it is a plain lowercase word.
 */
export function formatReportedCost(cost: {
  amount: number;
  unit: string;
}): string {
  const amount =
    cost.amount >= 100
      ? cost.amount.toFixed(0)
      : cost.amount >= 1
        ? cost.amount.toFixed(2)
        : cost.amount.toPrecision(3).replace(/0+$/, '').replace(/\.$/, '');
  const word = /^[a-z]+$/.test(cost.unit);
  const unit =
    word && cost.amount !== 1 && !cost.unit.endsWith('s')
      ? `${cost.unit}s`
      : cost.unit;
  return `${amount} ${unit}`;
}
