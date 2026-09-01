import { createSessionInventoryBasisPaneInstance } from '@kontourai/station-basis-pane/workspace-basis-pane';
import type { SessionInventoryScope } from '@kontourai/station-contracts/session-inventory';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useEffect, useRef } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useBasisPaneLauncher } from '../../workspace-panes/BasisPaneLauncher';
import {
  commitSessionInventorySelection,
  readSessionInventorySelection,
} from '../../workspace-panes/sessionInventorySelection';
import { registerSessionInventoryLiveBinding } from './sessionInventoryLiveBinding';

/** Lazy full/fallback handoff keeps Basis implementation out of ChatDock. */
export function SessionInventoryFullFallback({
  scope,
  projectId,
  trigger,
  forceFallback = false,
  chatStoreId,
  hostId,
  onClose,
  onHostOpened,
}: {
  scope: SessionInventoryScope;
  projectId?: string;
  trigger: HTMLElement | null;
  forceFallback?: boolean;
  chatStoreId?: string;
  hostId?: string;
  onClose?(): void;
  /** Re-focuses the exact already-opened Workspace Pane without recreating it. */
  onHostOpened?(focus: () => boolean): void;
}) {
  const { openBasis, focusBasis, fallback } = useBasisPaneLauncher();
  const authority = useHostRequestAuthorityScope();
  const mobileBindingId = useRef(`mobile:${randomCorrelationId()}`).current;
  useEffect(
    () =>
      forceFallback && authority && chatStoreId
        ? registerSessionInventoryLiveBinding(
            authority.apiBase,
            authority.authorityKey,
            scope.sessionId,
            { hostId: mobileBindingId, chatStoreId },
          )
        : undefined,
    [authority, chatStoreId, forceFallback, mobileBindingId, scope.sessionId],
  );
  useEffect(() => {
    // A workspace-pane instance only names Project and Session. Commit the
    // exact captured scope before host admission, so a synchronous host.open
    // cannot observe the old whole-session selection and lose this answer.
    if (authority) {
      const key = { ...authority, sessionId: scope.sessionId };
      const current = readSessionInventorySelection(key);
      if (JSON.stringify(current?.scope) !== JSON.stringify(scope))
        commitSessionInventorySelection(key, { scope, groupId: 'inputs' });
    }
    const instance =
      !forceFallback && projectId
        ? createSessionInventoryBasisPaneInstance(projectId, scope.sessionId)
        : null;
    const result = openBasis(
      instance,
      {
        kind: 'session-inventory',
        sessionId: scope.sessionId,
        initialScope: scope,
      },
      trigger,
      onClose,
    );
    if (result === 'host') {
      if (authority && chatStoreId)
        registerSessionInventoryLiveBinding(
          authority.apiBase,
          authority.authorityKey,
          scope.sessionId,
          {
            hostId: `hosted:${hostId ?? randomCorrelationId()}`,
            chatStoreId,
          },
        );
      onHostOpened?.(() => (instance ? focusBasis(instance) : false));
    }
  }, [
    forceFallback,
    authority,
    chatStoreId,
    hostId,
    onClose,
    onHostOpened,
    openBasis,
    focusBasis,
    projectId,
    scope,
    trigger,
  ]);
  return <>{fallback}</>;
}
