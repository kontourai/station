import { closeProjectTerminal } from '@kontourai/station-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useProject } from '../../contexts/ProjectsContext';
import {
  type ACPConnectionInfo,
  useACPConnections,
} from '../../hooks/useACPConnections';
import { CodingTerminalPanel } from './CodingTerminalPanel';
import './CodingLayout.css';
import { userFacingErrorMessage } from '../../utils/errorText';
import { NewTerminalModal } from './NewTerminalModal';
import { useTerminalSessionStore } from './terminalSessionStore';
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

const LEGACY_TABS_KEY = 'coding-terminal-tabs';
const LEGACY_ACTIVE_KEY = 'coding-terminal-active-tab';
const tabsKey = (projectSlug: string) =>
  `coding-terminal-tabs:v2:${projectSlug}`;
const activeKey = (projectSlug: string) =>
  `coding-terminal-active-tab:v2:${projectSlug}`;

/**
 * Tabs saved before the terminal socket (#3994) named a client-chosen id and,
 * for agent tabs, a client-chosen program. They are read once, into the first
 * Project that opens its terminal, then removed: each keeps its label and its
 * old id, whose owned history the next open imports, and never a program.
 */
function readSavedTabs(projectSlug: string): {
  tabs: TerminalTab[];
  active: string;
} {
  try {
    const saved = sessionStorage.getItem(tabsKey(projectSlug));
    if (saved !== null)
      return {
        tabs: JSON.parse(saved),
        active: sessionStorage.getItem(activeKey(projectSlug)) ?? '',
      };
    const legacy = sessionStorage.getItem(LEGACY_TABS_KEY);
    const active = sessionStorage.getItem(LEGACY_ACTIVE_KEY) ?? '';
    sessionStorage.removeItem(LEGACY_TABS_KEY);
    sessionStorage.removeItem(LEGACY_ACTIVE_KEY);
    if (!legacy) return { tabs: [], active: '' };
    const tabs = (
      JSON.parse(legacy) as (TerminalTab & {
        shell?: unknown;
        shellArgs?: unknown;
      })[]
    )
      .filter((tab) => typeof tab?.id === 'string' && tab.id)
      .map(({ shell: _shell, shellArgs: _shellArgs, ...tab }) => ({
        ...tab,
        ...((tab.type === 'shell' || tab.mode === 'terminal') && {
          legacyTerminalId: tab.id,
        }),
      }));
    return { tabs, active };
  } catch {
    return { tabs: [], active: '' };
  }
}

/**
 * The terminal's tab/session actions remain domain-owned while
 * WorkspacePaneHost controls placement. The server's session list is the
 * tab source: a tab names a server session id, and sessions opened on another
 * of the operator's devices appear here too.
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
  const [initial] = useState(() => readSavedTabs(projectSlug));
  const [tabs, setTabs] = useState<TerminalTab[]>(initial.tabs);
  const [activeTabId, setActiveTabId] = useState<string>(initial.active);
  const { project } = useProject(projectSlug);
  const projectId = project?.id;
  const store = useTerminalSessionStore();
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
      sessionStorage.setItem(tabsKey(projectSlug), JSON.stringify(tabs));
      sessionStorage.setItem(activeKey(projectSlug), activeTabId);
    } catch {
      /* Storage is optional presentation state. */
    }
  }, [activeTabId, projectSlug, tabs]);

  // Reconcile with the server's list for this Project: a session another of
  // the operator's devices opened gains a tab; a tab whose session the
  // server no longer retains is dropped. Labels stay presentation state.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    store
      .list({ projectId, bindingKey: 'project' })
      .then((records) => {
        if (cancelled) return;
        const known = new Set(records.map((record) => record.terminalId));
        setTabs((current) => {
          const kept = current.filter(
            (tab) => !tab.terminalId || known.has(tab.terminalId),
          );
          const shown = new Set(kept.map((tab) => tab.terminalId));
          const added = records
            .filter(
              (record) =>
                record.status === 'running' && !shown.has(record.terminalId),
            )
            .map((record): TerminalTab => {
              if (record.launch?.kind === 'agent')
                return {
                  id: `term-${record.terminalId}`,
                  type: 'agent',
                  label: `Agent: ${record.launch.mode}`,
                  mode: 'terminal',
                  agentMode: record.launch.mode,
                  connectionId: record.launch.connectionId,
                  terminalId: record.terminalId,
                };
              shellCounter.current += 1;
              return {
                id: `term-${record.terminalId}`,
                type: 'shell',
                label: `Shell ${shellCounter.current}`,
                terminalId: record.terminalId,
              };
            });
          return added.length || kept.length !== current.length
            ? [...kept, ...added]
            : current;
        });
      })
      .catch(() => {
        /* Each terminal view reports its own connection state. */
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, store]);

  const recordOpened = useCallback((tabId: string, terminalId: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId
          ? { ...tab, terminalId, legacyTerminalId: undefined }
          : tab,
      ),
    );
  }, []);

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
      // A tab that never opened a session (or a chat-mode agent tab) has
      // nothing on the server to end.
      const terminalId = tabs.find((tab) => tab.id === id)?.terminalId;
      if (terminalId)
        await closeProjectTerminal(apiBase, projectSlug, terminalId);
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
        // The terminal mode names the connection and mode; the server
        // resolves its program and arguments (#3994). An open session is
        // kept, and reattached when the tab returns to its terminal.
        return { ...tab, mode };
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
        onTerminalOpened={recordOpened}
        projectSlug={projectSlug}
        projectId={projectId}
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
