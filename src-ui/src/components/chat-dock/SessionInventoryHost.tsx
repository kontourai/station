import type { SessionInventoryScope } from '@kontourai/station-contracts/session-inventory';
import { useCallback, useEffect, useState } from 'react';
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

type FullBasisTrigger = HTMLElement & {
  focusFullBasis?: () => boolean;
};

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
  const [focusFullHost, setFocusFullHost] = useState<(() => boolean) | null>(
    null,
  );
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
  const close = useCallback(
    (restoreFocus = true) => {
      if (restoreFocus && trigger?.isConnected) trigger.focus();
      onClose();
    },
    [onClose, trigger],
  );
  const onHostOpened = useCallback((focus: () => boolean) => {
    setFocusFullHost(() => focus);
  }, []);
  const onFullFallbackClose = useCallback(() => {
    setFocusFullHost(null);
    setFullTrigger(null);
    close();
  }, [close]);
  useEffect(() => {
    const fullBasisTrigger = trigger as FullBasisTrigger | null;
    if (!fullBasisTrigger || !focusFullHost) return;
    fullBasisTrigger.focusFullBasis = focusFullHost;
    return () => {
      if (fullBasisTrigger.focusFullBasis === focusFullHost)
        delete fullBasisTrigger.focusFullBasis;
    };
  }, [focusFullHost, trigger]);
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
        chatStoreId={chatStoreId}
        hostId={hostId}
        forceFallback
        onClose={() => {
          setFullTrigger(null);
          close();
        }}
      />
    );
  return fullTrigger ? (
    <SessionInventoryFullFallback
      scope={scope}
      projectId={projectId}
      trigger={fullTrigger.trigger}
      chatStoreId={chatStoreId}
      hostId={hostId}
      onHostOpened={onHostOpened}
      onClose={onFullFallbackClose}
    />
  ) : (
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
  );
}
