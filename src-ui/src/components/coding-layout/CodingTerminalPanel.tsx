import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import { ACPChatPanel } from '../acp-connections/ACPChatPanel';
import { AgentGlyph, MessageGlyph } from '../icons/Glyph';
import { TerminalPanel } from './TerminalPanel';
import type { TerminalTab } from './types';

export function CodingTerminalPanel({
  id,
  role,
  'aria-labelledby': ariaLabelledBy,
  hidden,
  presentation = 'layout',
  terminalOpen,
  tabs,
  activeTabId,
  editingTabId,
  onDragStart,
  onDragStartToOpen,
  onToggleOpen,
  onSelectTab,
  onStartRename,
  onFinishRename,
  onCancelRename,
  onCloseTab,
  closingTabIds = new Set(),
  closeErrors = {},
  onToggleTabMode,
  canTogglePTY,
  onOpenNewTerminal,
  projectSlug,
  workingDir,
}: {
  id?: string;
  role?: React.AriaRole;
  'aria-labelledby'?: string;
  hidden?: boolean;
  presentation?: 'layout' | 'pane';
  terminalOpen: boolean;
  tabs: TerminalTab[];
  activeTabId: string;
  editingTabId: string | null;
  onDragStart?: (event: React.MouseEvent) => void;
  onDragStartToOpen?: (event: React.MouseEvent) => void;
  onToggleOpen?: () => void;
  onSelectTab: (id: string) => void;
  onStartRename: (id: string) => void;
  onFinishRename: (id: string, label: string) => void;
  onCancelRename: () => void;
  onCloseTab: (id: string) => void | Promise<void>;
  /** Terminal close is service-owned; tab state remains visible while pending. */
  closingTabIds?: ReadonlySet<string>;
  /** Per-tab close errors remain visible and can be retried. */
  closeErrors?: Readonly<Record<string, string>>;
  onToggleTabMode: (id: string) => void;
  canTogglePTY: (tab: TerminalTab) => boolean;
  onOpenNewTerminal: () => void;
  projectSlug: string;
  workingDir: string;
}) {
  const moveFocus = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const items = Array.from(
      event.currentTarget
        .closest('[role="tablist"]')
        ?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
    );
    if (items.length === 0) return;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = index === items.length - 1 ? 0 : index + 1;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = index === 0 ? items.length - 1 : index - 1;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = items.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const next = items[nextIndex]!;
    onSelectTab(next.dataset.terminalTabId!);
    next.focus();
  };

  return (
    <section
      id={id}
      role={role}
      aria-labelledby={ariaLabelledBy}
      hidden={hidden}
      className={`coding-layout__terminal${presentation === 'pane' ? ' coding-layout__terminal--pane' : ''}`}
    >
      {presentation === 'layout' && (
        <button
          type="button"
          className="coding-layout__drag-handle"
          aria-label="Resize terminal"
          onMouseDown={terminalOpen ? onDragStart : onDragStartToOpen}
          onDoubleClick={onToggleOpen}
        >
          <div className="coding-layout__drag-grip" />
        </button>
      )}
      <div className="coding-layout__terminal-bar">
        <div
          className="coding-layout__terminal-tabs"
          role="tablist"
          aria-label="Terminal tabs"
        >
          {tabs.map((tab, index) => {
            const selected = tab.id === activeTabId;
            const isClosing = closingTabIds.has(tab.id);
            const tabId = `coding-terminal-tab-${tab.id}`;
            const panelId = `coding-terminal-panel-${tab.id}`;
            return (
              <div className="coding-layout__terminal-tab-item" key={tab.id}>
                {editingTabId === tab.id ? (
                  <input
                    aria-label={`Rename ${tab.label}`}
                    className="coding-layout__terminal-tab-rename"
                    defaultValue={tab.label}
                    onBlur={(event) =>
                      onFinishRename(tab.id, event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (
                        event.key === 'Enter' &&
                        !isComposingKeyEvent(event)
                      ) {
                        onFinishRename(tab.id, event.currentTarget.value);
                      }
                      if (event.key === 'Escape') onCancelRename();
                    }}
                  />
                ) : (
                  <button
                    id={tabId}
                    type="button"
                    role="tab"
                    aria-label={tab.label}
                    aria-controls={panelId}
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    data-terminal-tab-id={tab.id}
                    className={`coding-layout__terminal-tab ${selected ? 'coding-layout__terminal-tab--active' : ''}`}
                    onClick={() => onSelectTab(tab.id)}
                    onDoubleClick={() => onStartRename(tab.id)}
                    onKeyDown={(event) => moveFocus(event, index)}
                  >
                    <span className="coding-layout__terminal-tab-icon">
                      {tab.type === 'agent' ? <AgentGlyph /> : '>'}
                    </span>
                    <span className="coding-layout__terminal-tab-label">
                      {tab.label}
                    </span>
                  </button>
                )}
                {tab.type === 'agent' && canTogglePTY(tab) && (
                  <button
                    type="button"
                    className="coding-layout__terminal-tab-toggle"
                    onClick={() => onToggleTabMode(tab.id)}
                    title={
                      tab.mode === 'terminal'
                        ? 'Switch to Chat UI'
                        : 'Switch to Terminal'
                    }
                    aria-label={
                      tab.mode === 'terminal'
                        ? `Switch ${tab.label} to Chat UI`
                        : `Switch ${tab.label} to Terminal`
                    }
                  >
                    {tab.mode === 'terminal' ? <MessageGlyph /> : '>_'}
                  </button>
                )}
                <button
                  type="button"
                  className="coding-layout__terminal-tab-close"
                  aria-label={
                    isClosing ? `Closing ${tab.label}` : `Close ${tab.label}`
                  }
                  disabled={isClosing}
                  onClick={() => onCloseTab(tab.id)}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="coding-layout__terminal-tab-add"
            onClick={onOpenNewTerminal}
            title="New terminal"
          >
            +
          </button>
        </div>
        {presentation === 'layout' && (
          <button
            type="button"
            className="coding-layout__terminal-toggle"
            onClick={onToggleOpen}
            // The chord this used to advertise (Ctrl+J) is handled nowhere —
            // the tooltip was fiction. If the shortcut ever gets registered,
            // withShortcutHint reports it from the registry instead of a
            // hardcoded string that can lie.
            title={`${terminalOpen ? 'Hide' : 'Show'} terminal`}
          >
            {terminalOpen ? '▾ Hide' : '▴ Show'}{' '}
            <span className="coding-layout__terminal-shortcut">⌃J</span>
          </button>
        )}
      </div>
      {tabs.map((tab) =>
        closeErrors[tab.id] ? (
          <div
            className="coding-layout__terminal-close-error"
            key={`close-error-${tab.id}`}
            role="alert"
          >
            <span>
              Unable to close {tab.label}: {closeErrors[tab.id]}
            </span>
            <button type="button" onClick={() => onCloseTab(tab.id)}>
              Retry close
            </button>
          </div>
        ) : null,
      )}
      <div
        className="coding-layout__terminal-body"
        style={terminalOpen ? undefined : { display: 'none' }}
      >
        {tabs.length === 0 ? (
          <div className="coding-layout__terminal-empty">
            <div className="coding-layout__terminal-empty-content">
              <span className="coding-layout__terminal-empty-icon">{'>_'}</span>
              <p>No active terminals</p>
              <button type="button" onClick={onOpenNewTerminal}>
                + New Terminal
              </button>
            </div>
          </div>
        ) : (
          tabs.map((tab) => (
            <div
              key={tab.id}
              id={`coding-terminal-panel-${tab.id}`}
              role="tabpanel"
              aria-labelledby={`coding-terminal-tab-${tab.id}`}
              style={{
                display: tab.id === activeTabId ? 'contents' : 'none',
              }}
            >
              {tab.type === 'agent' && tab.mode === 'chat' && tab.agentSlug ? (
                <ACPChatPanel
                  projectSlug={projectSlug}
                  agentSlug={tab.agentSlug}
                  tabId={tab.id}
                  isActive={tab.id === activeTabId}
                />
              ) : (
                <TerminalPanel
                  projectSlug={projectSlug}
                  workingDir={workingDir}
                  terminalId={tab.id}
                  shell={tab.shell}
                  shellArgs={tab.shellArgs}
                  isActive={tab.id === activeTabId}
                />
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
