import { closeProjectTerminal } from '@kontourai/station-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import {
  type ACPConnectionInfo,
  useACPConnections,
} from '../../hooks/useACPConnections';
import { CodingTerminalPanel } from './CodingTerminalPanel';
import './CodingLayout.css';
import { userFacingErrorMessage } from '../../utils/errorText';
import { NewTerminalModal } from './NewTerminalModal';
import type { TerminalTab } from './types';
import { buildNewTerminalItems } from './utils';

export interface CodingTerminalPaneProps {
  id?: string;
  role?: React.AriaRole;
  'aria-labelledby'?: string;
  hidden?: boolean;
  /** `pane` delegates placement and visibility to Workspace Pane host. */
  presentation?: 'layout' | 'pane';
  terminalOpen?: boolean;
  onDragStart?: (event: React.MouseEvent) => void;
  onDragStartToOpen?: (event: React.MouseEvent) => void;
  onToggleOpen?: () => void;
  projectSlug: string;
  workingDir: string;
}

/**
 * "The reader closed the last terminal", per Project: closing Project A's
 * last shell says nothing about Project B, whose empty panel still opens one.
 */
function closedLastTerminalKey(projectSlug: string): string {
  return `coding-terminal-closed-last:${projectSlug}`;
}
function readClosedLastTerminal(projectSlug: string): boolean {
  try {
    return sessionStorage.getItem(closedLastTerminalKey(projectSlug)) === '1';
  } catch {
    return false;
  }
}
function writeClosedLastTerminal(projectSlug: string, closed: boolean) {
  const key = closedLastTerminalKey(projectSlug);
  try {
    if (closed) sessionStorage.setItem(key, '1');
    else sessionStorage.removeItem(key);
  } catch {
    /* Storage is optional presentation state. */
  }
}

/**
 * The terminal's tab/session actions remain domain-owned while
 * WorkspacePaneHost controls placement. Neither owns PTY identity.
 */
export function CodingTerminalPane({
  presentation = 'layout',
  terminalOpen = true,
  onDragStart,
  onDragStartToOpen,
  onToggleOpen,
  projectSlug,
  workingDir,
  ...panelProps
}: CodingTerminalPaneProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>(() => {
    try {
      const saved = sessionStorage.getItem('coding-terminal-tabs');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [activeTabId, setActiveTabId] = useState<string>(() => {
    try {
      return sessionStorage.getItem('coding-terminal-active-tab') || '';
    } catch {
      return '';
    }
  });
  const shellCounter = useRef(
    Math.max(
      0,
      ...tabs
        .filter((tab) => tab.type === 'shell')
        .map((tab) => {
          const match = tab.label.match(/^Shell\s*(\d*)$/);
          return match ? parseInt(match[1] || '1', 10) : 0;
        }),
    ),
  );
  const { data: acpConnections, isPending: connectionsPending } =
    useACPConnections();
  const { apiBase } = useApiBase();
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [showNewTerminal, setShowNewTerminal] = useState(false);
  // With the shell the only kind of terminal there is, "new terminal" is a
  // shell: no picker with one option (design audit U7). While the agent
  // connections are still loading the answer is not known, so the picker
  // stays the way until it is.
  const shellIsTheOnlyKind =
    !connectionsPending &&
    buildNewTerminalItems(acpConnections || [], '', []).every(
      (item) => item.type === 'shell',
    );
  const [closingTabIds, setClosingTabIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [closeErrors, setCloseErrors] = useState<
    Readonly<Record<string, string>>
  >({});

  useEffect(() => {
    try {
      sessionStorage.setItem('coding-terminal-tabs', JSON.stringify(tabs));
      sessionStorage.setItem('coding-terminal-active-tab', activeTabId);
    } catch {
      /* Storage is optional presentation state. */
    }
  }, [activeTabId, tabs]);

  const addTab = useCallback(
    (type: 'shell' | 'agent', agentSlug?: string, connectionId?: string) => {
      const id = `term-${Date.now()}`;
      const tab: TerminalTab = { id, type, label: '' };
      if (type === 'agent' && agentSlug) {
        const modeName =
          connectionId && agentSlug.startsWith(`${connectionId}-`)
            ? agentSlug.slice(connectionId.length + 1)
            : agentSlug;
        tab.label = `Agent: ${modeName}`;
        tab.agentSlug = agentSlug;
        tab.agentMode = modeName;
        tab.connectionId = connectionId;
        tab.mode = 'chat';
      } else {
        shellCounter.current += 1;
        tab.label = `Shell ${shellCounter.current}`;
      }
      setTabs((current) => [...current, tab]);
      setActiveTabId(id);
      writeClosedLastTerminal(projectSlug, false);
    },
    [projectSlug],
  );

  const openNewTerminal = () => {
    if (shellIsTheOnlyKind) addTab('shell');
    else setShowNewTerminal(true);
  };
  // An open, empty terminal is a shell waiting to be asked for; it opens
  // one (U7). Once per mount, and never while the panel is closed or the
  // kinds are still unknown: closing the last tab leaves it closed.
  const shellOpened = useRef(false);
  const open = presentation === 'pane' ? true : terminalOpen;
  useEffect(() => {
    if (shellOpened.current || !open || !shellIsTheOnlyKind) return;
    if (tabs.length > 0) {
      shellOpened.current = true;
      return;
    }
    shellOpened.current = true;
    // "The reader closed the last terminal" is remembered in the browser
    // tab's session storage, keyed by Project, so a remount — a reload, a
    // crossing of the layout's fold — does not open a shell they just
    // closed, while another Project's empty panel still opens one. Opening
    // one again forgets it.
    if (readClosedLastTerminal(projectSlug)) return;
    addTab('shell');
  }, [addTab, open, projectSlug, shellIsTheOnlyKind, tabs.length]);

  const removeClosedTab = (id: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id);
      if (id === activeTabId && next.length > 0) {
        const index = current.findIndex((tab) => tab.id === id);
        setActiveTabId(next[Math.max(0, index - 1)]?.id || next[0]!.id);
      }
      if (next.length === 0) {
        setActiveTabId('');
        writeClosedLastTerminal(projectSlug, true);
      }
      return next;
    });
  };

  const closeTab = async (id: string) => {
    if (closingTabIds.has(id)) return;
    // This user action is independent of whether the terminal renderer has
    // mounted or received a WebSocket snapshot. Keep the tab in view until
    // the project-bound service confirms the exact session was terminated.
    setClosingTabIds((current) => new Set(current).add(id));
    setCloseErrors((current) => {
      const { [id]: _cleared, ...remaining } = current;
      return remaining;
    });
    try {
      await closeProjectTerminal(apiBase, projectSlug, id);
      removeClosedTab(id);
    } catch (error) {
      setCloseErrors((current) => ({
        ...current,
        [id]:
          error instanceof Error
            ? userFacingErrorMessage(error)
            : 'Unable to close terminal',
      }));
    } finally {
      setClosingTabIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const toggleTabMode = (tabId: string) => {
    setTabs((current) =>
      current.map((tab) => {
        if (tab.id !== tabId || tab.type !== 'agent') return tab;
        const mode: NonNullable<TerminalTab['mode']> =
          tab.mode === 'terminal' ? 'chat' : 'terminal';
        const updated: TerminalTab = { ...tab, mode };
        if (mode === 'terminal' && tab.agentSlug) {
          const connection = (acpConnections || []).find(
            (candidate: ACPConnectionInfo) => candidate.id === tab.connectionId,
          );
          if (connection?.interactive?.args) {
            updated.shell = connection.command;
            updated.shellArgs = connection.interactive.args.map((arg) =>
              arg === '{agent}' ? tab.agentMode || tab.agentSlug! : arg,
            );
          }
        }
        return updated;
      }),
    );
  };

  const canTogglePTY = (tab: TerminalTab): boolean =>
    tab.type === 'agent' &&
    Boolean(
      (acpConnections || []).find(
        (connection: ACPConnectionInfo) => connection.id === tab.connectionId,
      )?.interactive,
    );

  return (
    <>
      <CodingTerminalPanel
        {...panelProps}
        presentation={presentation}
        terminalOpen={presentation === 'pane' ? true : terminalOpen}
        tabs={tabs}
        activeTabId={activeTabId}
        editingTabId={editingTabId}
        onDragStart={onDragStart}
        onDragStartToOpen={onDragStartToOpen}
        onToggleOpen={onToggleOpen}
        onSelectTab={setActiveTabId}
        onStartRename={setEditingTabId}
        onFinishRename={(id, label) => {
          if (label.trim()) {
            setTabs((current) =>
              current.map((tab) =>
                tab.id === id ? { ...tab, label: label.trim() } : tab,
              ),
            );
          }
          setEditingTabId(null);
        }}
        onCancelRename={() => setEditingTabId(null)}
        onCloseTab={closeTab}
        closingTabIds={closingTabIds}
        closeErrors={closeErrors}
        onToggleTabMode={toggleTabMode}
        canTogglePTY={canTogglePTY}
        onOpenNewTerminal={openNewTerminal}
        projectSlug={projectSlug}
        workingDir={workingDir}
      />
      {showNewTerminal && (
        <NewTerminalModal
          connections={acpConnections || []}
          onSelect={(type, slug, connectionId) => {
            addTab(type, slug, connectionId);
            setShowNewTerminal(false);
          }}
          onClose={() => setShowNewTerminal(false)}
        />
      )}
    </>
  );
}
