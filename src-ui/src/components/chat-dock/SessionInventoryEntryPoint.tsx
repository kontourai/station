import type { SessionInventoryScope } from '@kontourai/station-contracts/session-inventory';
import { useEffect } from 'react';
import type { DockMode } from '../../types';
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
  if (!valid || !sessionId) return null;
  return (
    <div id={controlsId}>
      <SessionInventoryHost
        scope={launch.requestedScope ?? { kind: 'whole-session', sessionId }}
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
