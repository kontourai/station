import type { SessionInventoryScope } from '@kontourai/station-contracts/session-inventory';
import { useEffect, useLayoutEffect, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import type { DockMode } from '../../types';
import {
  commitSessionInventorySelection,
  readSessionInventorySelection,
} from '../../workspace-panes/sessionInventorySelection';
import { SessionInventoryHost } from './SessionInventoryHost';

export type SessionInventoryLaunch = {
  hostId?: string;
  authorityKey?: string;
  requestedScope?: Extract<SessionInventoryScope, { kind: 'current-answer' }>;
  activeSessionId?: string;
  executionSessionId?: string;
  projectId?: string;
  executionRead: 'present' | string;
  trigger: HTMLElement | null;
};

/** Converts a click-time identity snapshot into a host only after activation. */
export function SessionInventoryEntryPoint({
  launch,
  isMobile,
  dockMode,
  fullscreen,
  controlsId,
  onClose,
}: {
  launch: SessionInventoryLaunch;
  isMobile: boolean;
  dockMode: DockMode;
  fullscreen: boolean;
  controlsId: string;
  onClose(): void;
}) {
  const authority = useHostRequestAuthorityScope();
  const [preparedKey, setPreparedKey] = useState<string | null>(null);
  const sessionId =
    launch.requestedScope?.sessionId ??
    launch.executionSessionId ??
    launch.activeSessionId;
  const valid = Boolean(
    sessionId && (launch.requestedScope || launch.executionRead === 'present'),
  );
  useEffect(() => {
    if (!valid) onClose();
  }, [onClose, valid]);
  const scope =
    launch.requestedScope ??
    (sessionId ? { kind: 'whole-session' as const, sessionId } : undefined);
  const preparationKey =
    authority && scope
      ? JSON.stringify([authority.apiBase, authority.authorityKey, scope])
      : null;
  useLayoutEffect(() => {
    if (!valid || !sessionId || !authority) return;
    const scope = launch.requestedScope ?? {
      kind: 'whole-session' as const,
      sessionId,
    };
    const key = { ...authority, sessionId };
    const current = readSessionInventorySelection(key);
    if (JSON.stringify(current?.scope) !== JSON.stringify(scope))
      commitSessionInventorySelection(key, { scope, groupId: 'inputs' });
    setPreparedKey(preparationKey);
  }, [authority, launch.requestedScope, preparationKey, sessionId, valid]);
  if (!valid || !sessionId || !scope || preparedKey !== preparationKey)
    return null;
  return (
    <div id={controlsId}>
      <SessionInventoryHost
        scope={scope}
        projectId={launch.projectId}
        chatStoreId={launch.activeSessionId ?? sessionId}
        hostId={launch.hostId}
        trigger={launch.trigger}
        isMobile={isMobile}
        dockMode={dockMode}
        fullscreen={fullscreen}
        onClose={onClose}
      />
    </div>
  );
}
