interface AgentEditorReadStateArgs {
  hasLoadedAgent: boolean;
  loadError: unknown;
  isLoading: boolean;
  isFetching: boolean;
  isCreating: boolean;
}

export function resolveAgentEditorReadState({
  hasLoadedAgent,
  loadError,
  isLoading,
  isFetching,
  isCreating,
}: AgentEditorReadStateArgs) {
  const loadErrorMessage =
    loadError instanceof Error
      ? loadError.message
      : loadError
        ? String(loadError)
        : null;
  const initialLoadError =
    !isCreating && !hasLoadedAgent ? loadErrorMessage : null;
  const notFound = initialLoadError === 'Agent not found';

  return {
    blockingLoadError: notFound ? null : initialLoadError,
    notFound,
    visibleRefreshError: hasLoadedAgent ? loadErrorMessage : null,
    editorIsLoading:
      !isCreating &&
      (isLoading || (!!initialLoadError && isFetching && !hasLoadedAgent)),
  };
}
