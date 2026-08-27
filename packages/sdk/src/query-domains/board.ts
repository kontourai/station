/**
 * station#4079 slice 1 — the board face's `useQuery`/`useMutation` domain,
 * mirroring `query-domains/scheduler.ts`'s composition: the React-coupled
 * hooks wrap the canonical `client/board.ts` fetchers rather than
 * reimplementing the fetch, so station-control tools (which import
 * `client/board.ts` directly, no React) and the UI board face never define
 * "what a pin call does" twice.
 */
import type {
  Board,
  BoardReference,
  BoardWidgetSize,
} from '@kontourai/station-contracts/board';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import {
  getBoard,
  moveBoardWidget,
  type PinBoardWidgetInput,
  pinBoardWidget,
  unpinBoardWidget,
} from '../client/board';
import { type QueryConfig, useApiQuery } from '../query-core';

function boardReferenceKey(reference: BoardReference): string[] {
  return reference.kind === 'task'
    ? ['board', 'task', reference.projectId, reference.id]
    : ['board', 'session', reference.id];
}

export function useBoardQuery(
  reference: BoardReference | undefined,
  config?: QueryConfig<Board>,
) {
  return useApiQuery(
    reference ? boardReferenceKey(reference) : ['board', 'none'],
    async () => {
      if (!reference) throw new Error('Board reference is required.');
      return getBoard(await _getApiBase(), reference);
    },
    { ...config, enabled: !!reference && (config?.enabled ?? true) },
  );
}

export function usePinBoardWidget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: PinBoardWidgetInput) =>
      pinBoardWidget(await _getApiBase(), input),
    onSuccess: (_board, input) =>
      queryClient.invalidateQueries({
        queryKey: boardReferenceKey(input.reference),
      }),
  });
}

export function useUnpinBoardWidget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      reference,
      name,
    }: {
      reference: BoardReference;
      name: string;
    }) => unpinBoardWidget(await _getApiBase(), reference, name),
    onSuccess: (_board, { reference }) =>
      queryClient.invalidateQueries({ queryKey: boardReferenceKey(reference) }),
  });
}

export function useMoveBoardWidget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      reference: BoardReference;
      name: string;
      tabId?: string;
      after?: string;
    }) => moveBoardWidget(await _getApiBase(), input),
    onSuccess: (_board, input) =>
      queryClient.invalidateQueries({
        queryKey: boardReferenceKey(input.reference),
      }),
  });
}

export type { Board, BoardReference, BoardWidgetSize };
