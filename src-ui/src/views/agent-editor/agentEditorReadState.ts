import { describeStationFailure } from '../../utils/stationFailure';

interface AgentEditorReadStateArgs {
  hasLoadedAgent: boolean;
  loadError: unknown;
  isPending: boolean;
  isFetching: boolean;
  isCreating: boolean;
}

export function resolveAgentEditorReadState({
  hasLoadedAgent,
  loadError,
  isPending,
  isFetching,
  isCreating,
}: AgentEditorReadStateArgs) {
  const loadErrorMessage =
    loadError instanceof Error
      ? describeStationFailure(loadError).body
      : loadError
        ? describeStationFailure(loadError).body
        : null;
  const initialLoadError =
    !isCreating && !hasLoadedAgent ? loadErrorMessage : null;
  const notFound =
    loadError instanceof Error && loadError.message === 'Agent not found';

  return {
    blockingLoadError: notFound ? null : initialLoadError,
    notFound,
    visibleRefreshError: hasLoadedAgent ? loadErrorMessage : null,
    editorIsLoading:
      !isCreating &&
      (isPending || (!!initialLoadError && isFetching && !hasLoadedAgent)),
  };
}
