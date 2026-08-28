import {
  useAchievementsQuery,
  useAnalyticsRescanMutation,
  useInvalidateQuery,
  useUsageQuery,
} from '@kontourai/station-sdk';
import React, { createContext, useCallback, useContext, useMemo } from 'react';

const AnalyticsContext = createContext<{
  refresh: () => void;
  rescan: () => Promise<void>;
} | null>(null);

export function AnalyticsProvider({ children }: { children: React.ReactNode }) {
  const invalidate = useInvalidateQuery();
  const rescanMutation = useAnalyticsRescanMutation();

  const refresh = useCallback(() => {
    invalidate(['analytics', 'usage']);
    invalidate(['analytics', 'achievements']);
  }, [invalidate]);

  // TanStack returns a fresh result object per render; `mutateAsync` is the
  // stable handle, so depending on it is what lets `rescan` — and the value
  // below — hold identity (archive#3796).
  const rescanAsync = rescanMutation.mutateAsync;
  const rescan = useCallback(async () => {
    await rescanAsync();
    refresh();
  }, [refresh, rescanAsync]);

  // archive#3796: one memoised value per provider — a fresh object literal
  // here republishes the context to every consumer on any render of this
  // provider, whatever the render was actually about.
  const value = useMemo(() => ({ refresh, rescan }), [refresh, rescan]);

  return (
    <AnalyticsContext.Provider value={value}>
      {children}
    </AnalyticsContext.Provider>
  );
}

export function useAnalytics() {
  const context = useContext(AnalyticsContext);
  if (!context)
    throw new Error('useAnalytics must be used within AnalyticsProvider');

  const {
    data: usageStats,
    isLoading: usageLoading,
    error: usageError,
  } = useUsageQuery();
  const {
    data: achievements,
    isLoading: achievementsLoading,
    error: achievementsError,
  } = useAchievementsQuery();

  return {
    usageStats,
    achievements,
    loading: usageLoading || achievementsLoading,
    error: usageError || achievementsError,
    refresh: context.refresh,
    rescan: context.rescan,
  };
}
