import {
  useAccountDetails,
  useAccountOpportunities,
  useUserTasks,
} from '../data';

/**
 * Composes account details, opportunities, and tasks into a single panel hook.
 */
export function useCRMDetailPanel(accountId: string | null) {
  const account = useAccountDetails(accountId);
  const opportunities = useAccountOpportunities(accountId);
  const tasks = useUserTasks({ limit: 25 });

  return {
    account: account.data,
    opportunities: opportunities.data ?? [],
    tasks: tasks.data?.tasks ?? [],
    isLoading: account.isLoading || opportunities.isLoading || tasks.isLoading,
    error: account.error || opportunities.error || tasks.error,
  };
}
