import type {
  SpatialBoard,
  SpatialBoardPin,
  WorkReference,
} from '@kontourai/station-contracts';
import { apiErrorMessage } from './client/api-error-message';
import { authenticatedFetch } from './client/http';
import {
  resolveApiBase,
  useApiMutation,
  useApiQuery,
  useInvalidateQuery,
} from './query-core';
import {
  SpatialBoardRequestError,
  spatialBoardQueries,
} from './spatial-board-queries';

type ApiResult<T> = {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  message?: string;
  details?: { formErrors?: unknown; fieldErrors?: unknown };
};

export {
  SpatialBoardRequestError,
  spatialBoardQueries,
} from './spatial-board-queries';

async function result<T>(response: Response): Promise<T> {
  const body = (await response.json()) as ApiResult<T>;
  if (!response.ok || !body.success || body.data === undefined)
    throw new SpatialBoardRequestError(
      apiErrorMessage(body, `HTTP ${response.status}`),
      response.status,
      body.code,
    );
  return body.data;
}

async function mutate(
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body: unknown,
  apiBase?: string,
) {
  return result(
    await authenticatedFetch(
      `${await resolveApiBase(apiBase)}/api/spatial-board${path}`,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  );
}

const spatialBoardKeys = {
  all: ['spatial-board'] as Array<string | number>,
};

export async function getSpatialBoard(apiBase?: string) {
  return result<SpatialBoard>(
    await authenticatedFetch(
      `${await resolveApiBase(apiBase)}/api/spatial-board`,
    ),
  );
}

export async function getResolvedSpatialBoard(apiBase?: string) {
  return spatialBoardQueries.resolved(apiBase).queryFn();
}

export const createSpatialBoardPin = (input: {
  expectedRevision: number;
  pin: SpatialBoardPin;
  apiBase?: string;
}) => {
  const { apiBase, ...body } = input;
  return mutate('/pins', 'POST', body, apiBase);
};

export const replaceSpatialBoardPin = (input: {
  expectedRevision: number;
  pin: SpatialBoardPin;
  apiBase?: string;
}) => {
  const { apiBase, ...body } = input;
  return mutate(
    `/pins/${encodeURIComponent(input.pin.id)}`,
    'PUT',
    body,
    apiBase,
  );
};

export const removeSpatialBoardPin = (input: {
  expectedRevision: number;
  pinId: string;
  apiBase?: string;
}) => {
  const { apiBase, pinId, ...body } = input;
  return mutate(`/pins/${encodeURIComponent(pinId)}`, 'DELETE', body, apiBase);
};

export const setSpatialBoardTitle = (input: {
  expectedRevision: number;
  title: string;
  apiBase?: string;
}) => {
  const { apiBase, ...body } = input;
  return mutate('/title', 'PATCH', body, apiBase);
};

export const setSpatialBoardCamera = (input: {
  expectedRevision: number;
  camera: SpatialBoard['camera'];
  apiBase?: string;
}) => {
  const { apiBase, ...body } = input;
  return mutate('/camera', 'PATCH', body, apiBase);
};

export const cleanupSpatialBoardPins = (input: {
  expectedRevision: number;
  missingReferences: readonly WorkReference[];
  apiBase?: string;
}) => {
  const { apiBase, ...body } = input;
  return mutate('/cleanup', 'POST', body, apiBase);
};

export const undoSpatialBoard = (input: {
  expectedRevision: number;
  apiBase?: string;
}) => {
  const { apiBase, ...body } = input;
  return mutate('/undo', 'POST', body, apiBase);
};

export function useSpatialBoardQuery() {
  return useApiQuery(spatialBoardKeys.all, () => getSpatialBoard(), {
    staleTime: 15_000,
    refetchOnMount: 'always',
  });
}

/** Canonical board-bounded live owner projection query. */
export function useResolvedSpatialBoardQuery() {
  const query = spatialBoardQueries.resolved();
  return useApiQuery(query.queryKey, query.queryFn, {
    staleTime: query.staleTime,
    refetchOnMount: 'always',
  });
}

function useSpatialBoardMutation<T>(mutation: (input: T) => Promise<unknown>) {
  const invalidate = useInvalidateQuery();
  return useApiMutation(mutation, {
    invalidateKeys: [spatialBoardKeys.all],
    onError: (error) => {
      if (error instanceof SpatialBoardRequestError && error.conflict) {
        void invalidate(spatialBoardKeys.all);
      }
    },
  });
}

export function useCreateSpatialBoardPinMutation() {
  return useSpatialBoardMutation(createSpatialBoardPin);
}
export function useReplaceSpatialBoardPinMutation() {
  return useSpatialBoardMutation(replaceSpatialBoardPin);
}
export function useRemoveSpatialBoardPinMutation() {
  return useSpatialBoardMutation(removeSpatialBoardPin);
}
export function useSetSpatialBoardTitleMutation() {
  return useSpatialBoardMutation(setSpatialBoardTitle);
}
export function useSetSpatialBoardCameraMutation() {
  return useSpatialBoardMutation(setSpatialBoardCamera);
}
export function useCleanupSpatialBoardPinsMutation() {
  return useSpatialBoardMutation(cleanupSpatialBoardPins);
}
export function useUndoSpatialBoardMutation() {
  return useSpatialBoardMutation(undoSpatialBoard);
}
