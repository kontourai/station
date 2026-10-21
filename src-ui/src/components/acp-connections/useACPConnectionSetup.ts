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
   * CI-R8: a hub card reading "Cursor — Found, not connected — Connect this
   * provider" reads as informational, and one click used to create a
   * persistent connection outright. A provider arriving from that card stops
   * here first, so the durable write follows an explicit yes.
   */
  | 'confirm'
  | 'checking'
  | 'result'
  | 'error';

interface ACPConnectionSetupState {
  stage: ACPConnectionSetupStage;
  selectedEntry: ACPConnectionRegistryEntry | null;
  resultConnectionId: string | null;
  /**
   * The connection as the add/install response projected it. A first add
   * whose probe failed registers no identity, so the connection list never
   * serves it; this is then the only result the dialog can show.
   */
  addedConnection: ACPConnectionInfo | null;
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
  | { type: 'complete'; connection: ACPConnectionInfo | null }
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

function getACPConnectionDraftId(id: string, command: string, name: string) {
  const candidate = id || command.split('/').at(-1) || name;
  return candidate
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function reduceACPConnectionSetup(
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
        addedConnection: null,
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
      return {
        ...state,
        mutationComplete: true,
        addedConnection: action.connection,
      };
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
    addedConnection: null,
    mutationComplete: false,
    error: null,
    errorKind: null,
    advancedOpen: false,
    draft: EMPTY_DRAFT,
  };
}

/** The add response's connection projection, when it is one for `id`. */
function addedConnectionFor(
  response: unknown,
  id: string,
): ACPConnectionInfo | null {
  if (!response || typeof response !== 'object') return null;
  const candidate = response as Partial<ACPConnectionInfo>;
  return candidate.id === id && typeof candidate.status === 'string'
    ? (candidate as ACPConnectionInfo)
    : null;
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
        message: 'Could not refresh this engine’s status.',
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
        const response = entry
          ? await onInstallRegistryEntry?.(entry.id)
          : await onAdd({ ...state.draft, id });
        dispatch({
          type: 'complete',
          connection: addedConnectionFor(response, id),
        });
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
        message: setupError(error, 'Could not refresh this engine’s status.'),
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
  // The listed connection is fresher when it exists; the add response stands
  // in when it is not listed (a failed first add).
  const resultConnection = state.resultConnectionId
    ? (connections.find(
        (connection) => connection.id === state.resultConnectionId,
      ) ?? state.addedConnection)
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
