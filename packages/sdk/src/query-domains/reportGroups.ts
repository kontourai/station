import type { ReportGroupAmounts } from '@kontourai/station-contracts/report-group';
import {
  type ApiRequestScope,
  StationRequestAuthorityError,
} from '../client/http';
import {
  listReportGroups,
  readReportGroupResult,
} from '../client/report-groups';
import { useApiQuery } from '../query-core';

type Scope = ApiRequestScope & { isCurrent(): boolean };
export function useReportGroupsQuery(
  scope: Scope,
  options: { enabled: boolean; afterGroupId?: string },
) {
  return useApiQuery(
    [
      'report-groups',
      scope.apiBase,
      scope.authorityKey,
      options.afterGroupId ?? null,
    ],
    async (signal) => {
      if (!scope.isCurrent()) throw new StationRequestAuthorityError();
      const page = await listReportGroups(scope.apiBase, options.afterGroupId, {
        signal,
        requestScope: scope,
      });
      if (!scope.isCurrent()) throw new StationRequestAuthorityError();
      return page;
    },
    {
      enabled: options.enabled && scope.isCurrent(),
      retry: false,
      staleTime: 0,
      gcTime: 0,
      refetchOnMount: 'always',
      refetchInterval: 5000,
      refetchIntervalForError: () => false,
      cancelWhenInactive: true,
    },
  );
}

export function useReportGroupResultQuery(
  scope: Scope,
  member: { groupId: string; seatId: string; invocationId: string },
  enabled: boolean,
) {
  return useApiQuery(
    [
      'report-group-result',
      scope.apiBase,
      scope.authorityKey,
      member.groupId,
      member.seatId,
      member.invocationId,
    ],
    async (signal) => {
      let text = '';
      let identity: { modelId: string; usage: ReportGroupAmounts } | undefined;
      // Assemble bounded UTF-16 pages before rendering, including split surrogate pairs.
      for (let pageNumber = 0; pageNumber < 64; pageNumber++) {
        if (!scope.isCurrent()) throw new StationRequestAuthorityError();
        const page = await readReportGroupResult(
          scope.apiBase,
          member.groupId,
          member.seatId,
          member.invocationId,
          text.length,
          { signal, requestScope: scope },
        );
        if (!scope.isCurrent()) throw new StationRequestAuthorityError();
        if (page.kind === 'failure') return page;
        if (
          identity &&
          (identity.modelId !== page.modelId ||
            identity.usage.inputTokens !== page.usage.inputTokens ||
            identity.usage.outputTokens !== page.usage.outputTokens ||
            identity.usage.costMicros !== page.usage.costMicros)
        )
          throw new Error('Report identity changed.');
        identity = { modelId: page.modelId, usage: page.usage };
        text += page.text;
        if (!page.hasMore)
          return { kind: 'result' as const, ...identity, text };
      }
      throw new Error('Report exceeds the display bound.');
    },
    {
      enabled: enabled && scope.isCurrent(),
      retry: false,
      staleTime: 0,
      gcTime: 0,
      refetchOnMount: 'always',
      cancelWhenInactive: true,
    },
  );
}
