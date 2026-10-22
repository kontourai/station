import { joinACPArgs } from '@kontourai/station-sdk';
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
  /** When the add answered (epoch ms); polls fetched before it are stale. */
  completedAt: number | null;
  /** What the running check is: a first add, a re-check, or a saved edit. */
  attempt: ACPConnectionSetupAttempt;
  mutationComplete: boolean;
  error: string | null;
  errorKind: ACPConnectionSetupErrorKind | null;
  advancedOpen: boolean;
  draft: ACPConnectionDraft;
}

export type ACPConnectionSetupErrorKind = 'mutation' | 'refresh';

export type ACPConnectionSetupAttempt = 'add' | 'recheck' | 'edit';

/** `confirmCommand` is passed for a public registry listing only. */
export type InstallRegistryEntry = (
  id: string,
  confirmCommand?: { command: string; args: string[] },
) => unknown;

type SetupAction =
  | { type: 'custom' }
  | { type: 'catalog' }
  | { type: 'confirm'; entry: ACPConnectionRegistryEntry }
  | { type: 'advanced'; open: boolean }
  | { type: 'draft'; field: keyof ACPConnectionDraft; value: string }
  | {
      type: 'submit';
      entry: ACPConnectionRegistryEntry | null;
      id: string;
      attempt: ACPConnectionSetupAttempt;
    }
  | { type: 'refresh' }
  | {
      type: 'complete';
      connection: ACPConnectionInfo | null;
      completedAt: number;
    }
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
        completedAt: null,
        attempt: action.attempt,
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
        completedAt: action.completedAt,
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

function sameDraft(a: ACPConnectionDraft, b: ACPConnectionDraft) {
  return (Object.keys(a) as Array<keyof ACPConnectionDraft>).every(
    (field) => a[field] === b[field],
  );
}

/** The setup form filled with a saved connection's values (Edit setup). */
function draftFor(connection: ACPConnectionInfo): ACPConnectionDraft {
  return {
    id: connection.id,
    name: connection.name ?? '',
    command: connection.command ?? '',
    args: joinACPArgs(connection.args ?? []),
    icon: connection.icon ?? '',
    cwd: connection.cwd ?? '',
  };
}

function initialState({
  entries,
  editConnection,
}: {
  entries: ACPConnectionRegistryEntry[];
  editConnection?: ACPConnectionInfo;
}): ACPConnectionSetupState {
  if (editConnection) {
    return {
      ...initialState({ entries }),
      stage: 'custom',
      draft: draftFor(editConnection),
    };
  }
  return {
    stage: entries.length === 0 ? ('custom' as const) : ('catalog' as const),
    selectedEntry: null,
    resultConnectionId: null,
    addedConnection: null,
    completedAt: null,
    attempt: 'add',
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

/**
 * How long the dialog waits on an engine's first start before it stops
 * saying "Checking". The server's cold first-contact probe is bounded at
 * about 72s (60s handshake plus cleanup); this outlasts it with room for the
 * registration that follows a success.
 */
export const FIRST_CONTACT_WAIT_MS = 90_000;
const FIRST_CONTACT_LIST_REFRESH_MS = 2_000;

function useSetupResult(
  state: ACPConnectionSetupState,
  listed: ACPConnectionInfo | null,
  firstContactStatus: string | undefined,
  queryError: unknown,
  queryFetching: boolean | undefined,
  dispatch: (action: SetupAction) => void,
) {
  useEffect(() => {
    if (state.stage !== 'checking' || !state.mutationComplete) return;
    if (listed) dispatch({ type: 'result' });
    else if (state.addedConnection?.status === 'probing') {
      // A first start still running in the background. Unavailable is a
      // result now; available is not yet: the engine registers through the
      // configuration queue, and Ready waits for the listed connection.
      if (firstContactStatus === 'unavailable') dispatch({ type: 'result' });
    } else if (state.addedConnection) dispatch({ type: 'result' });
    else if (queryError && !queryFetching) {
      dispatch({
        type: 'error',
        message: 'Could not refresh this engine’s status.',
        kind: 'refresh',
      });
    }
  }, [queryError, queryFetching, listed, firstContactStatus, state, dispatch]);
}

/** Bounds the first-start wait and refreshes the list once it connects. */
function useFirstContactWait(
  awaiting: boolean,
  connected: boolean,
  dispatch: (action: SetupAction) => void,
  onRefreshConnections: (() => unknown) | undefined,
) {
  useEffect(() => {
    if (!awaiting) return;
    const timer = setTimeout(
      () =>
        dispatch({
          type: 'error',
          message:
            'This engine has not finished its first start. Station keeps checking it while Station is running; if Station restarts first, add it again.',
          kind: 'refresh',
        }),
      FIRST_CONTACT_WAIT_MS,
    );
    return () => clearTimeout(timer);
  }, [awaiting, dispatch]);
  useEffect(() => {
    if (!awaiting || !connected) return;
    const refresh = () => {
      void Promise.resolve(onRefreshConnections?.()).catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, FIRST_CONTACT_LIST_REFRESH_MS);
    return () => clearInterval(timer);
  }, [awaiting, connected, onRefreshConnections]);
}

function useSetupSubmit(
  state: ACPConnectionSetupState,
  dispatch: (action: SetupAction) => void,
  onAdd: (draft: ACPConnectionDraft) => unknown,
  onInstallRegistryEntry: InstallRegistryEntry | undefined,
  editConnection: ACPConnectionInfo | undefined,
  onUpdate: ((id: string, draft: ACPConnectionDraft) => unknown) | undefined,
  onCheck: ((id: string) => unknown) | undefined,
) {
  return useCallback(
    async (
      entry = state.selectedEntry,
      { recheck = false }: { recheck?: boolean } = {},
    ) => {
      const id =
        entry?.id ??
        editConnection?.id ??
        getACPConnectionDraftId(
          state.draft.id,
          state.draft.command,
          state.draft.name,
        );
      // Editing: an unchanged form, or Retry check, re-checks the saved
      // engine. The update would save nothing and probe nothing.
      const recheckSaved =
        editConnection &&
        onCheck &&
        (recheck || sameDraft(state.draft, draftFor(editConnection)));
      dispatch({
        type: 'submit',
        entry,
        id,
        attempt:
          recheck || recheckSaved ? 'recheck' : editConnection ? 'edit' : 'add',
      });
      try {
        const response =
          entry?.source === 'registry'
            ? await onInstallRegistryEntry?.(entry.id, {
                command: entry.command,
                args: entry.args ?? [],
              })
            : entry
              ? await onInstallRegistryEntry?.(entry.id)
              : recheckSaved
                ? await onCheck(id)
                : editConnection && onUpdate
                  ? await onUpdate(id, { ...state.draft, id })
                  : await onAdd({ ...state.draft, id });
        dispatch({
          type: 'complete',
          connection: addedConnectionFor(response, id),
          completedAt: Date.now(),
        });
      } catch (error) {
        dispatch({
          type: 'error',
          message: setupError(error, 'Could not check this engine.'),
          kind: 'mutation',
        });
      }
    },
    [
      dispatch,
      onAdd,
      onInstallRegistryEntry,
      editConnection,
      onUpdate,
      onCheck,
      state,
    ],
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
  probeStatuses,
  probeStatusesUpdatedAt,
  editConnection,
  onUpdate,
  onCheck,
}: {
  registryEntries: ACPConnectionRegistryEntry[];
  connections: ACPConnectionInfo[];
  queryError?: unknown;
  queryFetching?: boolean;
  /** Live probe status, polled while a first start runs (GET /acp/status). */
  probeStatuses?: Array<{
    id: string;
    status: string;
    lastError?: { message: string; phase: string };
  }>;
  /** When `probeStatuses` was fetched (epoch ms). */
  probeStatusesUpdatedAt?: number;
  /** Edit setup: start on the form with this saved connection's values. */
  editConnection?: ACPConnectionInfo;
  /** Saves an edit (PUT); used instead of `onAdd` while editing. */
  onUpdate?: (id: string, draft: ACPConnectionDraft) => unknown;
  /** Re-checks the saved connection (POST /:id/check) while editing. */
  onCheck?: (id: string) => unknown;
  onAdd: (draft: ACPConnectionDraft) => unknown;
  onInstallRegistryEntry?: InstallRegistryEntry;
  onRefreshConnections?: () => unknown;
}) {
  const [state, dispatch] = useReducer(
    reduceACPConnectionSetup,
    { entries: registryEntries, editConnection },
    initialState,
  );
  // The listed connection is fresher when it exists. A first add that is not
  // listed answers with its own projection, updated by the polled probe
  // status while its first start runs.
  const listed = state.resultConnectionId
    ? (connections.find(
        (connection) => connection.id === state.resultConnectionId,
      ) ?? null)
    : null;
  const added = state.addedConnection;
  // A poll fetched before this add answered describes an earlier attempt
  // (Retry check reuses the id), so only a newer poll may end the wait.
  const pollIsCurrent =
    probeStatusesUpdatedAt !== undefined &&
    state.completedAt !== null &&
    probeStatusesUpdatedAt >= state.completedAt;
  const polled =
    added?.status === 'probing' && pollIsCurrent
      ? probeStatuses?.find((entry) => entry.id === added.id)
      : undefined;
  const resultConnection =
    listed ??
    (added && polled
      ? { ...added, status: polled.status, lastError: polled.lastError }
      : added);
  const awaitingFirstContact =
    state.stage === 'checking' &&
    state.mutationComplete &&
    !listed &&
    added?.status === 'probing';

  useSetupResult(
    state,
    listed,
    polled?.status,
    queryError,
    queryFetching,
    dispatch,
  );
  useFirstContactWait(
    awaitingFirstContact,
    polled?.status === 'available',
    dispatch,
    onRefreshConnections,
  );
  const submit = useSetupSubmit(
    state,
    dispatch,
    onAdd,
    onInstallRegistryEntry,
    editConnection,
    onUpdate,
    onCheck,
  );
  const retryRefresh = useRefreshRetry(dispatch, onRefreshConnections);

  return {
    state,
    dispatch,
    resultConnection,
    awaitingFirstContact,
    submit,
    retryMutation: () => submit(),
    retryCheck: () => submit(undefined, { recheck: true }),
    retryRefresh,
  };
}
