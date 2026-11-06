import { useApprovalAnswering } from '../components/conversation/useApprovalAnswering';

/** Compatibility adapter for Task/detail callers being adopted in P2. */
export function useToolApproval(apiBase: string) {
  return useApprovalAnswering(apiBase);
}
