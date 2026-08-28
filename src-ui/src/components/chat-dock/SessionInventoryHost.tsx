import type { SessionInventoryScope } from '@kontourai/station-contracts/session-inventory';
import { useEffect, useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import type { DockMode } from '../../types';
import {
  commitSessionInventorySelection,
  type SessionInventorySelection,
} from '../../workspace-panes/sessionInventorySelection';
import { SessionInventoryCompact } from './SessionInventoryCompact';
import { SessionInventoryFullFallback } from './SessionInventoryFullFallback';
import { resolveSessionInventoryCompactHost } from './sessionInventoryCompactHost';
import './SessionInventoryCompact.css';
import { registerSessionInventoryLiveBinding } from './sessionInventoryLiveBinding';

/**
 * The activation-only inventory composition seam. ChatDock deliberately only
 * keeps a captured intent; all host placement, full handoff, and close
 * behavior live in this lazy module so activation is also the first possible
 * inventory query/subscription boundary.
 */
export function SessionInventoryHost({
  scope,
  projectId,
  chatStoreId,
  hostId,
  trigger,
  isMobile,
  dockMode,
  fullscreen,
  onClose,
}: {
  scope: SessionInventoryScope;
  projectId?: string;
  chatStoreId: string;
  hostId?: string;
  trigger: HTMLElement | null;
  isMobile: boolean;
  dockMode: DockMode;
  fullscreen: boolean;
  onClose(): void;
}) {
  const [fullTrigger, setFullTrigger] = useState<{
    trigger: HTMLElement;
    selection: SessionInventorySelection;
  } | null>(null);
  const authority = useHostRequestAuthorityScope();
  useEffect(
    () =>
      authority && hostId
        ? registerSessionInventoryLiveBinding(
            authority.apiBase,
            authority.authorityKey,
            scope.sessionId,
            { hostId, chatStoreId },
          )
        : undefined,
    [authority, chatStoreId, hostId, scope.sessionId],
  );
  const close = (restoreFocus = true) => {
    if (restoreFocus && trigger?.isConnected) trigger.focus();
    onClose();
  };
  const host = resolveSessionInventoryCompactHost({
    isMobile,
    dockMode,
    fullscreen,
  });
  // Phone inventory is always an unanchored full-height sheet. Passing null
  // prevents a desktop pane host or a detached header from becoming focus
  // origin; the concrete menu trigger remains the fallback focus target.
  if (host === 'full-fallback')
    return (
      <SessionInventoryFullFallback
        scope={scope}
        projectId={projectId}
        trigger={trigger}
        forceFallback
        onClose={() => {
          setFullTrigger(null);
          close();
        }}
      />
    );
  return (
    <>
      <SessionInventoryCompact
        scope={scope}
        density={host}
        chatStoreId={chatStoreId}
        onClose={close}
        onOpenFull={(nextTrigger, selection) => {
          if (authority)
            commitSessionInventorySelection(
              { ...authority, sessionId: scope.sessionId },
              selection,
            );
          setFullTrigger({ trigger: nextTrigger, selection });
        }}
      />
      {fullTrigger ? (
        <SessionInventoryFullFallback
          scope={scope}
          projectId={projectId}
          trigger={fullTrigger.trigger}
          onHostOpened={() => close(false)}
          onClose={() => {
            setFullTrigger(null);
            close();
          }}
        />
      ) : null}
    </>
  );
}
