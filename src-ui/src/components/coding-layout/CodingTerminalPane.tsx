import { closeProjectTerminal } from '@kontourai/station-sdk';
import { useEffect, useRef, useState } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import {
  type ACPConnectionInfo,
  useACPConnections,
} from '../../hooks/useACPConnections';
import { CodingTerminalPanel } from './CodingTerminalPanel';
import './CodingLayout.css';
import { NewTerminalModal } from './NewTerminalModal';
import type { TerminalTab } from './types';

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
  const { data: acpConnections } = useACPConnections();
  const { apiBase } = useApiBase();
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [showNewTerminal, setShowNewTerminal] = useState(false);
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

  const addTab = (
    type: 'shell' | 'agent',
    agentSlug?: string,
    connectionId?: string,
  ) => {
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
  };

  const removeClosedTab = (id: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id);
      if (id === activeTabId && next.length > 0) {
        const index = current.findIndex((tab) => tab.id === id);
        setActiveTabId(next[Math.max(0, index - 1)]?.id || next[0]!.id);
      }
      if (next.length === 0) setActiveTabId('');
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
          error instanceof Error ? error.message : 'Unable to close terminal',
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
        onOpenNewTerminal={() => setShowNewTerminal(true)}
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
