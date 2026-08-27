import { useBrandingQuery } from '@kontourai/station-sdk';

export function useBranding() {
  const { data, isLoading } = useBrandingQuery();
  return {
    appName: data?.appName ?? 'Station',
    logo: data?.logo ?? null,
    theme: data?.theme ?? null,
    welcomeMessage: data?.welcomeMessage ?? null,
    loading: isLoading,
  };
}
