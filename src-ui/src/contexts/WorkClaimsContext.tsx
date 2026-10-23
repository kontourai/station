import {
  parseWorkClaimView,
  type WorkClaimView,
} from '@kontourai/station-contracts/work-claims';
import { getJson } from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { useHostRequestAuthorityScope } from './ApiBaseContext';

/**
 * station#3413 part B: the active work claims of the Sessions this person may
 * read (`GET /api/orchestration/work-claims`), for the rows that show what a
 * Session says it is on. One read for the app, made by the provider; rows
 * read the context, so a row rendered outside the provider shows none.
 * Claims expire on the minute scale, so a slow poll keeps them honest. With
 * no connection scope the read stays disabled.
 */
const POLL_MS = 30_000;
const EMPTY: readonly WorkClaimView[] = [];

const WorkClaimsContext = createContext<readonly WorkClaimView[]>(EMPTY);

export function WorkClaimsProvider({ children }: { children: ReactNode }) {
  // The Station this read answers for is the captured scope's own.
  const scope = useHostRequestAuthorityScope();
  const query = useQuery({
    queryKey: ['work-claims', scope?.apiBase, scope?.authorityKey ?? null],
    enabled: Boolean(scope),
    retry: false,
    staleTime: POLL_MS / 2,
    refetchInterval: POLL_MS,
    queryFn: async ({ signal }): Promise<WorkClaimView[]> => {
      const response = await getJson(
        `${scope?.apiBase}/api/orchestration/work-claims`,
        {
          signal,
          ...(scope ? { requestScope: scope } : {}),
          maxResponseBytes: 512 * 1024,
        },
      );
      const body = (await response.json()) as {
        success?: boolean;
        data?: { claims?: unknown };
      };
      if (!response.ok || body.success !== true)
        throw new Error(`Work claims read failed (${response.status})`);
      const claims = Array.isArray(body.data?.claims) ? body.data.claims : [];
      return claims.flatMap((claim) => {
        const parsed = parseWorkClaimView(claim);
        return parsed ? [parsed] : [];
      });
    },
  });
  return (
    <WorkClaimsContext.Provider value={query.data ?? EMPTY}>
      {children}
    </WorkClaimsContext.Provider>
  );
}

/**
 * The claims of one Session row: those its Session made, or a Session of its
 * conversation made (a later Session of a conversation keeps its claims).
 */
export function useSessionWorkClaims(row: {
  orchestrationThreadId?: string;
  chatSessionId?: string;
  conversationId?: string;
}): readonly WorkClaimView[] {
  const claims = useContext(WorkClaimsContext);
  const { orchestrationThreadId, chatSessionId, conversationId } = row;
  return useMemo(() => {
    if (claims.length === 0) return EMPTY;
    const sessions = new Set(
      [orchestrationThreadId, chatSessionId].filter(Boolean),
    );
    const conversations = new Set(
      [conversationId, orchestrationThreadId, chatSessionId].filter(Boolean),
    );
    return claims.filter(
      (claim) =>
        sessions.has(claim.sessionId) ||
        (claim.conversationId !== undefined &&
          conversations.has(claim.conversationId)),
    );
  }, [claims, orchestrationThreadId, chatSessionId, conversationId]);
}
