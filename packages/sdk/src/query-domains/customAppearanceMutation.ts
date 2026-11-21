import type {
  CustomAppearance,
  CustomAppearanceDocument,
  CustomAppearanceRenderReport,
} from '@kontourai/station-contracts/custom-appearance';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  dismissCustomAppearanceProposal,
  keepCustomAppearanceProposal,
  reportCustomAppearanceRender,
  saveCustomAppearance,
} from '../client/custom-appearance-mutations';
import {
  type ApiRequestScope,
  StationRequestAuthorityError,
} from '../client/http';
import { customAppearanceKey } from './customAppearance';

export type CustomAppearanceAction =
  | { kind: 'save'; revision: string; appearance: CustomAppearance | null }
  | { kind: 'keep'; revision: string; proposalId: string }
  | { kind: 'dismiss'; revision: string }
  | {
      kind: 'report';
      report: Omit<CustomAppearanceRenderReport, 'reportedAt'>;
    };

/** The person's own steps. The server refuses every one of them to an agent. */
export function useCustomAppearanceMutation(scope?: ApiRequestScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (
      action: CustomAppearanceAction,
    ): Promise<CustomAppearanceDocument> => {
      if (!scope) throw new StationRequestAuthorityError();
      const opts = { requestScope: scope };
      switch (action.kind) {
        case 'save':
          return saveCustomAppearance(
            scope.apiBase,
            { revision: action.revision, appearance: action.appearance },
            opts,
          );
        case 'keep':
          return keepCustomAppearanceProposal(
            scope.apiBase,
            { revision: action.revision, proposalId: action.proposalId },
            opts,
          );
        case 'dismiss':
          return dismissCustomAppearanceProposal(
            scope.apiBase,
            action.revision,
            opts,
          );
        case 'report':
          return reportCustomAppearanceRender(
            scope.apiBase,
            action.report,
            opts,
          );
      }
    },
    onSuccess: (data) => client.setQueryData(customAppearanceKey(scope), data),
    retry: false,
  });
}
