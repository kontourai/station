import { useAvailableProjectLayoutsQuery } from '@kontourai/station-sdk';
import { useEffect, useState } from 'react';
import { looksLikeWorkspacePath } from '../components/modals/project-form-utils';
import { mergeAvailableProjectLayouts } from '../components/registry/ProjectLayoutCatalog';
import { useReposQuery } from './useGitActions';
import { getRecentLayouts } from './useRecentLayouts';

interface UseNewProjectStarterOptions {
  isOpen: boolean;
  normalizedDirectory: string;
}

/** How long typing has to stop before the directory becomes a repo question. */
const REPO_DISCOVERY_IDLE_MS = 400;

/**
 * The directory value once typing has settled.
 *
 * `useNewProjectDraft` holds the field in per-keystroke state and debounces
 * nothing, so widening the discovery gate from "ends with /" to "looks like a
 * path" would otherwise put one `GET /api/coding/repos` on every character.
 * This changes only WHEN the question is asked, never the answer: the value it
 * settles on is the value the field holds.
 */
function useSettledDirectory(value: string, delayMs: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value === settled) return;
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, settled, value]);
  return settled;
}

/**
 * Owns the recommended/explicit starter choice and catalog browser state.
 *
 * `selectedLayoutId` is the ONLY answer to "which layout does Create apply",
 * and it is the same value the picker renders as pressed. #1536 E4: there used
 * to be a second answer — a `resolveLayoutId` that, at submit, re-ran repo
 * discovery for a manually typed path and returned Coding when it found a repo.
 * Nothing on screen said so: "Start without a layout" reads pressed whenever
 * `selectedLayoutId` is null, which is exactly the state that fallback fired
 * in, so a project created with that option visibly selected still got a
 * Coding layout. The recommendation still exists, but only where the user can
 * see it: the effect below SELECTS Coding for a detected Git directory, and the
 * card it selects is on screen and can be unselected.
 */
export function useNewProjectStarter({
  isOpen,
  normalizedDirectory,
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
  // #1536 E4: this used to be gated on `directoryLikelyExists` — the typed
  // path ENDING IN "/" — which is also the icon-discovery gate. A user who
  // pastes `/Users/me/code/myrepo` and presses Create got no discovery, so no
  // recommendation, so no starter: the whole hint was reachable only by typing
  // a trailing slash nobody types. The gate is now the shape of the string,
  // and the idle settle above is what keeps it off the keystroke path.
  const settledDirectory = useSettledDirectory(
    normalizedDirectory,
    REPO_DISCOVERY_IDLE_MS,
  );
  const repoDiscovery = useReposQuery(settledDirectory || null, {
    enabled: isOpen && looksLikeWorkspacePath(settledDirectory),
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
    selectLayout,
    selectedLayoutId,
    setShowLayoutBrowser,
    showLayoutBrowser,
  };
}
