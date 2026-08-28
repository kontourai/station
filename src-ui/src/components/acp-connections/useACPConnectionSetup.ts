import { useCallback, useEffect, useReducer } from 'react';
import type {
  ACPConnectionInfo,
  ACPConnectionRegistryEntry,
} from '../../hooks/useACPConnections';
import type { ACPConnectionDraft } from './types';

export type ACPConnectionSetupStage =
  | 'catalog'
  | 'custom'
/**
* a hub card reading "Cursor — Found, not connected — Connect this
* provider" reads as informational, and one click used to create a
* persistent connection outright. A provider arriving from that card stops
* here first, so the durable write follows an explicit yes.
*/
  | 'confirm'
  | 'checking'
  | 'result'
  | 'error';

export interface ACPConnectionSetupState {
  stage: ACPConnectionSetupStage;
  selectedEntry: ACPConnectionRegistryEntry | null;
  resultConnectionId: string | null;
  mutationComplete: boolean;
  error: string | null;
  errorKind: ACPConnectionSetupErrorKind | null;
  advancedOpen: boolean;
  draft: ACPConnectionDraft;
}

export type ACPConnectionSetupErrorKind = 'mutation' | 'refresh';

type SetupAction =
  | { type: 'custom' }
  | { type: 'catalog' }
  | { type: 'confirm'; entry: ACPConnectionRegistryEntry }
  | { type: 'advanced'; open: boolean }
  | { type: 'draft'; field: keyof ACPConnectionDraft; value: string }
  | { type: 'submit'; entry: ACPConnectionRegistryEntry | null; id: string }
  | { type: 'refresh' }
  | { type: 'complete' }
  | { type: 'result' }
  | { type: 'error'; message: string; kind: ACPConnectionSetupErrorKind };

const EMPTY_DRAFT: ACPConnectionDraft = {
  id: '',
  name: '',
  command: '',
  args: '',
  icon: '',
  cwd: '',
};

export function getACPConnectionDraftId(
  id: string,
  command: string,
  name: string,
) {
  const candidate = id || command.split('/').at(-1) || name;
  return candidate
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function reduceACPConnectionSetup(
  state: ACPConnectionSetupState,
  action: SetupAction,
): ACPConnectionSetupState {
  switch (action.type) {
    case 'custom':
      return {
        ...state,
        stage: 'custom',
        selectedEntry: null,
        error: null,
        errorKind: null,
      };
    case 'catalog':
      return { ...state, stage: 'catalog', error: null, errorKind: null };
    case 'confirm':
      return {
        ...state,
        stage: 'confirm',
        selectedEntry: action.entry,
        error: null,
        errorKind: null,
      };
    case 'advanced':
      return { ...state, advancedOpen: action.open };
    case 'draft':
      return {
        ...state,
        draft: { ...state.draft, [action.field]: action.value },
      };
    case 'submit':
      return {
        ...state,
        stage: 'checking',
        selectedEntry: action.entry,
        resultConnectionId: action.id,
        mutationComplete: false,
        error: null,
        errorKind: null,
      };
    case 'refresh':
      return {
        ...state,
        stage: 'checking',
        mutationComplete: true,
        error: null,
        errorKind: null,
      };
    case 'complete':
      return { ...state, mutationComplete: true };
    case 'result':
      return { ...state, stage: 'result' };
    case 'error':
      return {
        ...state,
        stage: 'error',
        error: action.message,
        errorKind: action.kind,
      };
  }
}

function initialState(entries: ACPConnectionRegistryEntry[]) {
  return {
    stage: entries.length === 0 ? ('custom' as const) : ('catalog' as const),
    selectedEntry: null,
    resultConnectionId: null,
    mutationComplete: false,
    error: null,
    errorKind: null,
    advancedOpen: false,
    draft: EMPTY_DRAFT,
  };
}

function setupError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function useSetupResult(
  state: ACPConnectionSetupState,
  resultConnection: ACPConnectionInfo | null,
  queryError: unknown,
  queryFetching: boolean | undefined,
  dispatch: (action: SetupAction) => void,
) {
  useEffect(() => {
    if (state.stage !== 'checking' || !state.mutationComplete) return;
    if (resultConnection) dispatch({ type: 'result' });
    else if (queryError && !queryFetching) {
      dispatch({
        type: 'error',
        message: 'Could not refresh this provider status.',
        kind: 'refresh',
      });
    }
  }, [queryError, queryFetching, resultConnection, state, dispatch]);
}

function useSetupSubmit(
  state: ACPConnectionSetupState,
  dispatch: (action: SetupAction) => void,
  onAdd: (draft: ACPConnectionDraft) => unknown,
  onInstallRegistryEntry: ((id: string) => unknown) | undefined,
) {
  return useCallback(
    async (entry = state.selectedEntry) => {
      const id =
        entry?.id ??
        getACPConnectionDraftId(
          state.draft.id,
          state.draft.command,
          state.draft.name,
        );
      dispatch({ type: 'submit', entry, id });
      try {
        if (entry) await onInstallRegistryEntry?.(entry.id);
        else await onAdd({ ...state.draft, id });
        dispatch({ type: 'complete' });
      } catch (error) {
        dispatch({
          type: 'error',
          message: setupError(error, 'Could not check this engine.'),
          kind: 'mutation',
        });
      }
    },
    [dispatch, onAdd, onInstallRegistryEntry, state],
  );
}

function useRefreshRetry(
  dispatch: (action: SetupAction) => void,
  onRefreshConnections: (() => unknown) | undefined,
) {
  return useCallback(async () => {
    dispatch({ type: 'refresh' });
    try {
      await onRefreshConnections?.();
    } catch (error) {
      dispatch({
        type: 'error',
        message: setupError(error, 'Could not refresh this provider status.'),
        kind: 'refresh',
      });
    }
  }, [dispatch, onRefreshConnections]);
}

export function useACPConnectionSetup({
  registryEntries,
  connections,
  queryError,
  queryFetching,
  onAdd,
  onInstallRegistryEntry,
  onRefreshConnections,
}: {
  registryEntries: ACPConnectionRegistryEntry[];
  connections: ACPConnectionInfo[];
  queryError?: unknown;
  queryFetching?: boolean;
  onAdd: (draft: ACPConnectionDraft) => unknown;
  onInstallRegistryEntry?: (id: string) => unknown;
  onRefreshConnections?: () => unknown;
}) {
  const [state, dispatch] = useReducer(
    reduceACPConnectionSetup,
    registryEntries,
    initialState,
  );
  const resultConnection = state.resultConnectionId
    ? (connections.find(
        (connection) => connection.id === state.resultConnectionId,
      ) ?? null)
    : null;

  useSetupResult(state, resultConnection, queryError, queryFetching, dispatch);
  const submit = useSetupSubmit(state, dispatch, onAdd, onInstallRegistryEntry);
  const retryRefresh = useRefreshRetry(dispatch, onRefreshConnections);

  return {
    state,
    dispatch,
    resultConnection,
    submit,
    retryMutation: () => submit(),
    retryRefresh,
  };
}
