import { createSessionInventoryBasisPaneInstance } from '@kontourai/station-basis-pane/workspace-basis-pane';
import type { SessionInventoryScope } from '@kontourai/station-contracts/session-inventory';
import { useEffect } from 'react';
import { useBasisPaneLauncher } from '../../workspace-panes/BasisPaneLauncher';

/** Lazy full/fallback handoff keeps Basis implementation out of ChatDock. */
export function SessionInventoryFullFallback({
  scope,
  projectId,
  trigger,
  forceFallback = false,
  onClose,
  onHostOpened,
}: {
  scope: SessionInventoryScope;
  projectId?: string;
  trigger: HTMLElement | null;
  forceFallback?: boolean;
  onClose?(): void;
  onHostOpened?(): void;
}) {
  const { openBasis, fallback } = useBasisPaneLauncher();
  useEffect(() => {
    const result = openBasis(
      !forceFallback && projectId
        ? createSessionInventoryBasisPaneInstance(projectId, scope.sessionId)
        : null,
      {
        kind: 'session-inventory',
        sessionId: scope.sessionId,
        initialScope: scope,
      },
      trigger,
      onClose,
    );
    if (result === 'host') onHostOpened?.();
  }, [
    forceFallback,
    onClose,
    onHostOpened,
    openBasis,
    projectId,
    scope,
    trigger,
  ]);
  return <>{fallback}</>;
}
