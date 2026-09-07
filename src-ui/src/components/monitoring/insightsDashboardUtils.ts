export interface InsightsUsageData {
  toolUsage: Record<
    string,
    {
      calls: number;
      errors: number;
      outcomeUnknown?: number;
      /** station#1558; absent from a Station older than that change. */
      unresolved?: number;
    }
  >;
  hourlyActivity: number[];
  agentUsage: Record<string, { chats: number; tokens: number }>;
}

export interface MessageRatingSummary {
  id: string;
  rating: 'thumbs_up' | 'thumbs_down';
  reason?: string;
  analyzedAt?: string;
}

export function getInsightsUsageView(data: InsightsUsageData) {
  const maxHourly = Math.max(...data.hourlyActivity, 1);
  const topTools = Object.entries(data.toolUsage)
    .sort((left, right) => right[1].calls - left[1].calls)
    .slice(0, 10);
  const maxToolCalls = topTools.length > 0 ? topTools[0][1].calls : 1;
  const agents = Object.entries(data.agentUsage).sort(
    (left, right) => right[1].chats - left[1].chats,
  );

  return { agents, maxHourly, maxToolCalls, topTools };
}

export function getHourlyBarStyle(count: number, maxHourly: number) {
  return {
    height: `${Math.max((count / maxHourly) * 100, count > 0 ? 8 : 2)}%`,
    opacity: count > 0 ? 0.5 + (count / maxHourly) * 0.5 : 0.2,
  };
}

export function summarizeFeedbackRatings(ratings: MessageRatingSummary[]) {
  return {
    liked: ratings.filter((rating) => rating.rating === 'thumbs_up').length,
    disliked: ratings.filter((rating) => rating.rating === 'thumbs_down')
      .length,
    pending: ratings.filter((rating) => !rating.analyzedAt).length,
    noReason: ratings.filter((rating) => !rating.reason).length,
  };
}

export function formatRelativePast(iso?: string): string | null {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  return `${Math.round(mins / 60)} hr ago`;
}

export function formatRelativeFuture(iso?: string): string | null {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - Date.now();
  const mins = Math.round(diff / 60_000);
  if (mins <= 0) return 'soon';
  if (mins < 60) return `in ${mins} min`;
  return `in ${Math.round(mins / 60)} hr`;
}
