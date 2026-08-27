import { useAvailableProjectLayoutsQuery } from '@kontourai/station-sdk';
import { useEffect, useState } from 'react';
import { mergeAvailableProjectLayouts } from '../components/registry/ProjectLayoutCatalog';
import { useReposQuery } from './useGitActions';
import { getRecentLayouts } from './useRecentLayouts';

interface UseNewProjectStarterOptions {
  isOpen: boolean;
  normalizedDirectory: string;
  directoryLikelyExists: boolean;
}

/** Owns the recommended/explicit starter choice and catalog browser state. */
export function useNewProjectStarter({
  isOpen,
  normalizedDirectory,
  directoryLikelyExists,
}: UseNewProjectStarterOptions) {
  const [selectedLayoutId, setSelectedLayoutId] = useState<string | null>(null);
  const [layoutChoiceExplicit, setLayoutChoiceExplicit] = useState(false);
  const [showLayoutBrowser, setShowLayoutBrowser] = useState(false);
  const {
    data: availableLayouts = [],
    isLoading: layoutsLoading,
    isError: layoutsError,
    error: layoutError,
    refetch: refetchLayouts,
  } = useAvailableProjectLayoutsQuery({ enabled: isOpen });
  const eligibleLayouts = mergeAvailableProjectLayouts(availableLayouts);
  const codingStarter = eligibleLayouts.find(
    (layout) => layout.id === 'builtin:coding',
  );
  const recentLayouts = getRecentLayouts(eligibleLayouts);
  const repoDiscovery = useReposQuery(normalizedDirectory || null, {
    enabled: isOpen && directoryLikelyExists,
  });
  const gitWorkspaceDetected = (repoDiscovery.data?.repos?.length ?? 0) > 0;

  useEffect(() => {
    if (!isOpen) {
      setSelectedLayoutId(null);
      setLayoutChoiceExplicit(false);
      setShowLayoutBrowser(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (
      !isOpen ||
      layoutChoiceExplicit ||
      !normalizedDirectory ||
      !gitWorkspaceDetected ||
      !codingStarter
    ) {
      return;
    }
    setSelectedLayoutId(codingStarter.id);
  }, [
    codingStarter,
    gitWorkspaceDetected,
    isOpen,
    layoutChoiceExplicit,
    normalizedDirectory,
  ]);

  function selectLayout(id: string | null) {
    setSelectedLayoutId(id);
    setLayoutChoiceExplicit(true);
  }

  function resetForDirectory() {
    setSelectedLayoutId(null);
    setLayoutChoiceExplicit(false);
  }

  async function resolveLayoutId(): Promise<string | null> {
    if (
      layoutChoiceExplicit ||
      selectedLayoutId ||
      !normalizedDirectory ||
      !codingStarter
    ) {
      return selectedLayoutId;
    }

    const discovery = repoDiscovery.data
      ? repoDiscovery
      : await repoDiscovery.refetch();
    return (discovery.data?.repos?.length ?? 0) > 0 ? codingStarter.id : null;
  }

  return {
    codingStarter,
    eligibleLayouts,
    gitWorkspaceDetected,
    layoutsError,
    layoutError,
    layoutsLoading,
    recentLayouts,
    refetchLayouts,
    resetForDirectory,
    resolveLayoutId,
    selectLayout,
    selectedLayoutId,
    setShowLayoutBrowser,
    showLayoutBrowser,
  };
}
