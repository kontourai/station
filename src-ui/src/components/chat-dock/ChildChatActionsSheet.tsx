import { useOrchestrationSessionsQuery } from '@kontourai/station-sdk';
import { useState } from 'react';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { Button } from '../Button';
import { LazyBoundary } from '../LazyBoundary';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import type { ChildChatTarget } from './ChildChatNavigationContext';
import { MobileSheetPending } from './MobileSheetPending';

const loadInventory = () =>
  import('./SessionInventoryEntryPoint').then((module) => ({
    default: module.SessionInventoryEntryPoint,
  }));

export function ChildChatActionsSheet({
  entry,
  trigger,
  fullscreen,
  onNewChat,
  onInbox,
  onClose,
}: {
  entry: ChildChatTarget;
  trigger: HTMLElement | null;
  fullscreen: boolean;
  onNewChat(): void;
  onInbox(): void;
  onClose(): void;
}) {
  const [inventory, setInventory] = useState(false);
  const host = useHostRequestAuthorityScope();
  const { connection, threadId } = entry;
  const local =
    host &&
    connection.requestScope?.authorityKey === host.authorityKey &&
    connection.apiBase === host.apiBase &&
    host.isCurrent() &&
    connection.requestScope.isCurrent() &&
    (!connection.station || connection.station.routeKind === 'host');
  const sessions = useOrchestrationSessionsQuery(
    {
      readTarget: connection.station,
      enabled: !!local && !entry.childId,
      retry: false,
    },
    connection.requestScope,
  );
  const canReadInventory =
    local &&
    !entry.childId &&
    sessions.isSuccess &&
    sessions.data.some((session) => session.threadId === threadId);
  if (inventory && canReadInventory)
    return (
      <LazyBoundary
        load={loadInventory}
        pending={
          <MobileSheetPending
            label="Chat inventory"
            onClose={onClose}
            returnFocusTarget={trigger}
          />
        }
        componentProps={{
          launch: {
            activeSessionId: threadId,
            executionSessionId: threadId,
            executionRead: 'present',
            trigger,
            full: true,
          },
          isMobile: true,
          dockMode: 'bottom',
          fullscreen,
          onClose,
        }}
      />
    );
  return (
    <ResponsiveDialogSurface
      layer="popover"
      ariaLabel="Chat actions"
      onClose={onClose}
      historyMode="entry"
      returnFocusTarget={trigger}
      overlayClassName="composer-popover-overlay composer-popover-overlay--end"
      panelClassName="composer-popover-panel chat-dock__mobile-overflow-panel"
    >
      <ResponsiveDialogHeader
        title="Chat actions"
        onClose={onClose}
        closeLabel="Close actions menu"
      />
      <div
        role="menu"
        aria-label="Chat actions"
        className="composer-actions-menu__list"
      >
        <Button
          variant="ghost"
          role="menuitem"
          className="composer-actions-menu__item"
          disabled={!canReadInventory}
          onClick={() => setInventory(true)}
        >
          Chat inventory
        </Button>
        {!canReadInventory && (
          <small>
            {entry.childId
              ? 'This subagent reports a transcript only.'
              : sessions.isFetching
                ? 'Checking this session…'
                : 'Inventory unavailable for this session.'}
          </small>
        )}
        <Button
          variant="ghost"
          role="menuitem"
          className="composer-actions-menu__item"
          onClick={() => {
            onClose();
            onInbox();
          }}
        >
          Chats
        </Button>
        <Button
          variant="ghost"
          role="menuitem"
          className="composer-actions-menu__item"
          onClick={() => {
            onClose();
            onNewChat();
          }}
        >
          New chat
        </Button>
      </div>
    </ResponsiveDialogSurface>
  );
}
