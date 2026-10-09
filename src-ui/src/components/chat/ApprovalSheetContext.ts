import { createContext, useContext } from 'react';
import type { RevealApprovalDetail } from '../status/approvalReveal';

export const ApprovalSheetContext = createContext<{
  apiBase?: string;
  insideSheet: boolean;
  show(request: RevealApprovalDetail): boolean;
  check(request: RevealApprovalDetail): Promise<'pending' | 'already-settled'>;
} | null>(null);

export function useApprovalSheet() {
  return useContext(ApprovalSheetContext);
}
