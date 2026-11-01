import {
  closeProjectTerminal,
  type TerminalSessionRecord,
} from '@kontourai/station-sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useProject } from '../../contexts/ProjectsContext';
import {
  type ACPConnectionInfo,
  useACPConnections,
} from '../../hooks/useACPConnections';
import { Button } from '../Button';
import { ErrorState, SkeletonBlock } from '../state';
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
 * What this browser tab remembers about a server session's tab: its React
 * key (so the view that opened it keeps its renderer), a rename, and an agent
 * tab's chat/terminal choice. Everything else is the server's.
 */
type TabPresentation = {
  tabId?: string;
  label?: string;
  mode?: TerminalTab['mode'];
  agentSlug?: string;
};
type Presentation = Readonly<Record<string, TabPresentation>>;

const presentationKey = (projectSlug: string) =>
  `coding-terminal-tab-presentation:v1:${projectSlug}`;

function readSaved(projectSlug: string): {
  local: TerminalTab[];
  presentation: Presentation;
  active: string;
} {
  const { tabs, active } = readSavedTabs(projectSlug);
  let presentation: Record<string, TabPresentation> = {};
  try {
    presentation = JSON.parse(
      sessionStorage.getItem(presentationKey(projectSlug)) ?? '{}',
    );
  } catch {
    /* Storage is optional presentation state. */
  }
  const local: TerminalTab[] = [];
  for (const tab of tabs) {
    if (!tab.terminalId) local.push(tab);
    else
      presentation[tab.terminalId] ??= {
        tabId: tab.id,
        label: tab.label,
        ...(tab.mode && { mode: tab.mode }),
        ...(tab.agentSlug && { agentSlug: tab.agentSlug }),
      };
  }
  return { local, presentation, active };
}

/**
 * The binding's running sessions as tabs. Default names come from the
 * server's list, which keeps ended sessions, so every view and device names a
 * shell alike and closing one renames no other: the Nth shell this binding
 * opened is "Shell N".
 */
function sessionTabs(
  records: readonly TerminalSessionRecord[],
  presentation: Presentation,
): TerminalTab[] {
  let shells = 0;
  return records.flatMap((record): TerminalTab[] => {
    const agent = record.launch?.kind === 'agent' ? record.launch : undefined;
    if (!agent) shells += 1;
    if (record.status !== 'running' && record.status !== 'starting') return [];
    const shown = presentation[record.terminalId] ?? {};
    const id = shown.tabId ?? `term-${record.terminalId}`;
    if (agent)
      return [
        {
          id,
          type: 'agent',
          label: shown.label ?? `Agent: ${agent.mode}`,
          mode: shown.mode ?? 'terminal',
          agentMode: agent.mode,
          connectionId: agent.connectionId,
          terminalId: record.terminalId,
          ...(shown.agentSlug && { agentSlug: shown.agentSlug }),
        },
      ];
    return [
      {
        id,
        type: 'shell',
        label: shown.label ?? `Shell ${shells}`,
        terminalId: record.terminalId,
      },
    ];
  });
}

/**
 * The terminal's tab/session actions remain domain-owned while
 * WorkspacePaneHost controls placement. The server's session list for the
 * Project binding is the tab source, read through one shared query so every
 * view of it on this page shows the same tabs: a tab names a server session
 * id, and sessions opened on another of the operator's devices appear here
 * too. Only a tab whose session is not open yet (or a chat-only agent tab) is
 * this view's own.
 */
export function CodingTerminalPane({
  presentation: placement = 'layout',
  terminalOpen = true,
  onDragStart,
  onDragStartToOpen,
  onToggleOpen,
  projectSlug,
  workingDir,
  ...panelProps
}: CodingTerminalPaneProps) {
  const [initial] = useState(() => readSaved(projectSlug));
  const [localTabs, setLocalTabs] = useState<TerminalTab[]>(initial.local);
  const [presentation, setPresentation] = useState<Presentation>(
    initial.presentation,
  );
  const [activeTabId, setActiveTabId] = useState<string>(initial.active);
  const { project } = useProject(projectSlug);
  const projectId = project?.id;
  const store = useTerminalSessionStore();
  const { apiBase, connectionId } = useApiBase();
  const queryClient = useQueryClient();
  const sessionsKey = useMemo(
    () => [
      'coding-terminal-sessions',
      apiBase,
      connectionId ?? '',
      projectId ?? '',
      'project',
    ],
    [apiBase, connectionId, projectId],
  );
  const sessions = useQuery({
    queryKey: sessionsKey,
    queryFn: () => store.list({ projectId: projectId!, bindingKey: 'project' }),
    enabled: Boolean(projectId),
    retry: false,
  });
  const listed = sessions.isSuccess;
  const records = sessions.data ?? [];
  const serverTabs = sessionTabs(records, presentation);
  const shellsOpened = records.filter(
    (record) => record.launch?.kind !== 'agent',
  ).length;
  let pendingShells = 0;
  const tabs = [
    ...serverTabs,
    ...localTabs
      .filter((tab) => !serverTabs.some((shown) => shown.id === tab.id))
      .map((tab) =>
        tab.type === 'shell' && !tab.label
          ? { ...tab, label: `Shell ${shellsOpened + ++pendingShells}` }
          : tab,
      ),
  ];
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const localTabsRef = useRef(localTabs);
  localTabsRef.current = localTabs;
  const shownTabId = tabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : (tabs.at(-1)?.id ?? '');

  const { data: acpConnections, isPending: connectionsPending } =
    useACPConnections();
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
      sessionStorage.setItem(tabsKey(projectSlug), JSON.stringify(localTabs));
      sessionStorage.setItem(
        presentationKey(projectSlug),
        JSON.stringify(presentation),
      );
      sessionStorage.setItem(activeKey(projectSlug), activeTabId);
    } catch {
      /* Storage is optional presentation state. */
    }
  }, [activeTabId, localTabs, presentation, projectSlug]);

  // A session the server no longer retains takes its presentation with it.
  useEffect(() => {
    if (!sessions.data) return;
    const known = new Set(sessions.data.map((record) => record.terminalId));
    setPresentation((current) =>
      Object.keys(current).every((terminalId) => known.has(terminalId))
        ? current
        : Object.fromEntries(
            Object.entries(current).filter(([terminalId]) =>
              known.has(terminalId),
            ),
          ),
    );
  }, [sessions.data]);

  const recordOpened = useCallback(
    (tabId: string, terminalId: string) => {
      const tab = localTabsRef.current.find((local) => local.id === tabId);
      if (!tab || !projectId) return;
      setPresentation((current) => ({
        ...current,
        [terminalId]: {
          tabId,
          ...(tab.label && { label: tab.label }),
          ...(tab.mode && { mode: tab.mode }),
          ...(tab.agentSlug && { agentSlug: tab.agentSlug }),
        },
      }));
      queryClient.setQueryData<TerminalSessionRecord[]>(
        sessionsKey,
        (current = []) =>
          current.some((record) => record.terminalId === terminalId)
            ? current
            : [
                ...current,
                {
                  terminalId,
                  projectId,
                  bindingKey: 'project',
                  status: 'running',
                  createdAt: Date.now(),
                  launch:
                    tab.type === 'agent' && tab.connectionId
                      ? {
                          kind: 'agent',
                          connectionId: tab.connectionId,
                          mode: tab.agentMode || tab.agentSlug || '',
                        }
                      : { kind: 'shell' },
                },
              ],
      );
      setLocalTabs((current) => current.filter((local) => local.id !== tabId));
      void queryClient.invalidateQueries({ queryKey: sessionsKey });
    },
    [projectId, queryClient, sessionsKey],
  );

  const addTab = useCallback(
    (type: 'shell' | 'agent', agentSlug?: string, connectionId?: string) => {
      const id = `term-${Date.now()}`;
      // A shell's name is its place in the server's list, given in render.
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
      }
      setLocalTabs((current) => [...current, tab]);
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
  // one (U7). Once per mount, and never while the panel is closed, the
  // kinds are still unknown, or the server has not yet said which sessions
  // this binding already has: a second device or browser tab adopts those
  // rather than adding one. Closing the last tab leaves it closed.
  const shellOpened = useRef(false);
  const open = placement === 'pane' ? true : terminalOpen;
  useEffect(() => {
    if (shellOpened.current || !open || !shellIsTheOnlyKind || !listed) return;
    shellOpened.current = true;
    // "The reader closed the last terminal" is remembered in the browser
    // tab's session storage, keyed by Project, so a remount — a reload, a
    // crossing of the layout's fold — does not open a shell they just
    // closed, while another Project's empty panel still opens one. Opening
    // one again forgets it.
    if (tabs.length > 0 || readClosedLastTerminal(projectSlug)) return;
    addTab('shell');
  }, [addTab, listed, open, projectSlug, shellIsTheOnlyKind, tabs.length]);

  const removeClosedTab = (tab: TerminalTab) => {
    const current = tabsRef.current;
    const index = current.findIndex((candidate) => candidate.id === tab.id);
    const remaining = current.filter((candidate) => candidate.id !== tab.id);
    if (tab.terminalId) {
      // Ended, not removed: the list keeps it, so no other shell is renamed.
      queryClient.setQueryData<TerminalSessionRecord[]>(sessionsKey, (list) =>
        list?.map((record) =>
          record.terminalId === tab.terminalId
            ? { ...record, status: 'exited' }
            : record,
        ),
      );
      void queryClient.invalidateQueries({ queryKey: sessionsKey });
    }
    setLocalTabs((local) =>
      local.filter((candidate) => candidate.id !== tab.id),
    );
    if (remaining.length === 0) {
      setActiveTabId('');
      writeClosedLastTerminal(projectSlug, true);
    } else if (tab.id === shownTabId) {
      setActiveTabId(remaining[Math.max(0, index - 1)]!.id);
    }
  };

  const closeTab = async (id: string) => {
    if (closingTabIds.has(id)) return;
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab) return;
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
      if (tab.terminalId)
        await closeProjectTerminal(apiBase, projectSlug, tab.terminalId);
      removeClosedTab(tab);
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

  /** A server tab's presentation, or a local tab itself, changed in place. */
  const updateTab = (tab: TerminalTab, patch: TabPresentation) => {
    if (tab.terminalId) {
      const terminalId = tab.terminalId;
      setPresentation((current) => ({
        ...current,
        [terminalId]: { ...current[terminalId], tabId: tab.id, ...patch },
      }));
    } else {
      setLocalTabs((current) =>
        current.map((local) =>
          local.id === tab.id ? { ...local, ...patch } : local,
        ),
      );
    }
  };

  const toggleTabMode = (tabId: string) => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (tab?.type !== 'agent') return;
    // The terminal mode names the connection and mode; the server resolves
    // its program and arguments (#3994). An open session is kept, and
    // reattached when the tab returns to its terminal.
    updateTab(tab, { mode: tab.mode === 'terminal' ? 'chat' : 'terminal' });
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
        presentation={placement}
        terminalOpen={open}
        tabs={tabs}
        activeTabId={shownTabId}
        editingTabId={editingTabId}
        onDragStart={onDragStart}
        onDragStartToOpen={onDragStartToOpen}
        onToggleOpen={onToggleOpen}
        onSelectTab={setActiveTabId}
        onStartRename={setEditingTabId}
        onFinishRename={(id, label) => {
          const tab = tabs.find((candidate) => candidate.id === id);
          if (tab && label.trim()) updateTab(tab, { label: label.trim() });
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
        emptyStatus={
          sessions.isError ? (
            <ErrorState
              variant="compact"
              title="Terminals could not be listed"
              description={userFacingErrorMessage(sessions.error)}
              action={
                <Button size="sm" onClick={() => void sessions.refetch()}>
                  Retry
                </Button>
              }
            />
          ) : !listed ? (
            <SkeletonBlock count={2} label="Loading terminals" />
          ) : undefined
        }
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
