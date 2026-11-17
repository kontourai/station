import { useFeaturePreviewsQuery } from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';

/** Appearance controls follow the Station and signed-in authority that owns the view. */
export function useAppearanceStudioEnabled(
  scope: (ApiRequestScope & { isCurrent(): boolean }) | null | undefined,
): boolean {
  const query = useFeaturePreviewsQuery(
    scope?.apiBase,
    {
      enabled: !!scope && scope.isCurrent(),
      refetchOnMount: 'always',
      refetchInterval: 15000,
      retry: false,
    },
    scope ?? undefined,
  );
  return (
    !!scope &&
    scope.isCurrent() &&
    !query.isError &&
    query.data?.some(
      (preview) => preview.id === 'appearance-studio' && preview.enabled,
    ) === true
  );
}
