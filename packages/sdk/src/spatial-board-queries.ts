import type { SpatialBoardResolved } from '@kontourai/station-contracts';
import { apiErrorMessage } from './api-core';
import { authenticatedFetch } from './client/http';
import { resolveApiBase } from './query-core';

type SpatialBoardApiResult = {
  success: boolean;
  data?: SpatialBoardResolved;
  error?: string;
  code?: string;
  message?: string;
};

export class SpatialBoardRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SpatialBoardRequestError';
  }

  get conflict() {
    return this.status === 409 || this.code === 'spatial_board_conflict';
  }
}

/**
 * The board's query factory is intentionally a spatial-board subpath concern.
 * The Workspace Pane is lazy, so placing it in the root SDK query catalogue
 * would charge an unopened board to the first-paint bundle.
 */
export const spatialBoardQueries = {
  resolved: (apiBase?: string) => ({
    queryKey: ['spatial-board', 'resolved'] as Array<string | number>,
    staleTime: 15_000,
    queryFn: async (): Promise<SpatialBoardResolved> => {
      const response = await authenticatedFetch(
        `${await resolveApiBase(apiBase)}/api/spatial-board/resolved`,
      );
      const body = (await response.json()) as SpatialBoardApiResult;
      if (!response.ok || !body.success || body.data === undefined) {
        throw new SpatialBoardRequestError(
          apiErrorMessage(body, `HTTP ${response.status}`),
          response.status,
          body.code,
        );
      }
      return body.data;
    },
  }),
};
