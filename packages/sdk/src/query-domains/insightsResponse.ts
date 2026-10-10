import type { UsageInsights } from '@kontourai/station-contracts/insights';
import { z } from 'zod/v3';

const insightCount = z.number().finite().nonnegative();
const usageInsightsSchema = z
  .object({
    toolUsage: z.record(
      z
        .object({
          calls: insightCount,
          errors: insightCount,
          outcomeUnknown: insightCount.optional(),
          unresolved: insightCount.optional(),
        })
        .passthrough(),
    ),
    hourlyActivity: z.array(insightCount).length(24),
    agentUsage: z.record(
      z.object({ chats: insightCount, tokens: insightCount }).passthrough(),
    ),
    modelUsage: z.record(insightCount),
    totalChats: insightCount,
    totalToolCalls: insightCount,
    totalErrors: insightCount,
    totalOutcomeUnknown: insightCount.optional(),
    totalUnresolved: insightCount.optional(),
    days: z.number().int().min(1).max(365),
    applied: z
      .object({
        agent: z.string().optional(),
        tool: z.string().optional(),
        engine: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
      })
      .passthrough()
      .optional(),
    coverage: z
      .object({
        state: z.enum(['complete', 'partial', 'unknown']),
        scope: z.literal('retained-monitoring'),
        evaluatedAt: z.string().datetime(),
        issues: z.array(
          z.enum([
            'history-missing',
            'malformed-row',
            'invalid-timestamp',
            'unreadable-file',
          ]),
        ),
      })
      .passthrough()
      .optional(),
  })
  .passthrough() satisfies z.ZodType<UsageInsights>;

export function parseInsightsResponse(
  result: { success?: boolean; data?: unknown } | null | undefined,
): UsageInsights {
  const parsed = usageInsightsSchema.safeParse(result?.data);
  if (result?.success === false || !parsed.success)
    throw new Error('Insights returned no readable result');
  return parsed.data;
}
