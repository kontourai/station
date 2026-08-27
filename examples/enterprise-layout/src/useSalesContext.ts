import { useMyAccounts, useMyTerritories, useUserProfile } from './data';

/**
 * Composes user profile, territories, and accounts into a single context object.
 */
export function useSalesContext() {
  const profile = useUserProfile();
  const territories = useMyTerritories();
  const accounts = useMyAccounts();

  return {
    myDetails: profile.data ?? null,
    myTerritories: territories.data ?? [],
    myAccounts: accounts.data ?? [],
    loading: profile.isLoading || territories.isLoading || accounts.isLoading,
    error: profile.error || territories.error || accounts.error,
  };
}
