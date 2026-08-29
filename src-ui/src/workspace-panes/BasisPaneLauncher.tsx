import type { StationBasisPaneScope } from '@kontourai/station-basis-pane/station-basis-pane';
import type { SessionInventoryScope } from '@kontourai/station-contracts/session-inventory';
import type { WorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import { lazy, type ReactNode, Suspense, useCallback, useState } from 'react';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../components/ResponsiveDialogSurface';
import { SkeletonBlock } from '../components/state';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import {
  commitSessionInventorySelection,
  readSessionInventorySelection,
} from './sessionInventorySelection';
import { useWorkspacePaneHostOpenAction } from './WorkspacePaneHostOpenContext';
import './BasisPaneLauncher.css';

const LazyConnectedBasisFallbackPane = lazy(() =>
  import('./BasisPaneFallbackContent').then(
    ({ ConnectedBasisFallbackPane }) => ({
      default: ConnectedBasisFallbackPane,
    }),
  ),
);
export type BasisPaneHostScope =
  | StationBasisPaneScope
  | {
      kind: 'session-inventory';
      sessionId: string;
      /** Exact occurrence intent, never reconstructed from the latest turn. */
      initialScope?: SessionInventoryScope;
    };

interface FallbackState {
  scope: BasisPaneHostScope;
  currentProjectId?: string;
  returnFocusTarget: HTMLElement | null;
  onClose?: () => void;
}

export function useBasisPaneLauncher(): {
  openBasis(
    instance: WorkspacePaneInstance | null,
    scope: BasisPaneHostScope,
    trigger: HTMLElement | null,
    onFallbackClose?: () => void,
  ): 'host' | 'fallback';
  fallback: ReactNode;
} {
  const host = useWorkspacePaneHostOpenAction();
  const authority = useHostRequestAuthorityScope();
  const [fallbackState, setFallbackState] = useState<FallbackState | null>(
    null,
  );
  const openBasis = useCallback(
    (
      instance: WorkspacePaneInstance | null,
      scope: BasisPaneHostScope,
      trigger: HTMLElement | null,
      onFallbackClose?: () => void,
    ) => {
      if (
        scope.kind === 'session-inventory' &&
        scope.initialScope &&
        authority
      ) {
        const key = { ...authority, sessionId: scope.sessionId };
        const current = readSessionInventorySelection(key);
        if (
          JSON.stringify(current?.scope) !== JSON.stringify(scope.initialScope)
        )
          commitSessionInventorySelection(key, {
            scope: scope.initialScope,
            groupId: 'inputs',
          });
      }
      if (instance && host?.open(instance)) return 'host';
      setFallbackState({
        scope: { ...scope },
        currentProjectId: instance?.boundContext?.projectId,
        returnFocusTarget: trigger,
        onClose: onFallbackClose,
      });
      return 'fallback';
    },
    [authority, host],
  );
  const closeFallback = useCallback(() => {
    const closing = fallbackState;
    setFallbackState(null);
    closing?.onClose?.();
  }, [fallbackState]);
  const fallback = fallbackState ? (
    <ResponsiveDialogSurface
      ariaLabel="Basis"
      overlayClassName="basis-pane-fallback-overlay"
      panelClassName="basis-pane-fallback"
      returnFocusTarget={fallbackState.returnFocusTarget}
      onClose={closeFallback}
    >
      <ResponsiveDialogHeader
        title="Basis"
        closeLabel="Close Basis"
        onClose={closeFallback}
      />
      <Suspense fallback={<SkeletonBlock count={3} label="Loading Basis" />}>
        <LazyConnectedBasisFallbackPane
          scope={fallbackState.scope}
          currentProjectId={fallbackState.currentProjectId}
        />
      </Suspense>
    </ResponsiveDialogSurface>
  ) : null;
  return { openBasis, fallback };
}
