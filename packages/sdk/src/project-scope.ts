import { type ApiRequestScope, isApiRequestScope } from './client/http';

/** Snapshot of a validated request scope; never retains caller-owned objects. */
export interface CapturedProjectScope {
  apiBase: string;
  authorityKey: string;
}

export function captureProjectScope(
  candidate: ApiRequestScope | undefined,
): CapturedProjectScope | undefined {
  return isApiRequestScope(candidate)
    ? { apiBase: candidate.apiBase, authorityKey: candidate.authorityKey }
    : undefined;
}
