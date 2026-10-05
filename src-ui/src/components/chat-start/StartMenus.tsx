import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import React, { type RefObject, useCallback, useRef, useState } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import type {
  NewChatModelChoice,
  SelectableModel,
} from '../../utils/modelCapabilities';
import { type AgentFixRoute, agentFixRoute } from '../AgentReadinessCell';
import { agentRunnability } from '../agent-runnability';
import { Button } from '../Button';
import { WarningGlyph } from '../icons/Glyph';
import {
  modelPickerProviders,
  type NewChatModalContextOption,
  type NewChatWorkspaceHint,
  resolveNewChatAgentEnable,
  scheduleSelectedAgentVisibility,
  workspaceHintText,
} from '../modals/new-chat-modal-utils';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import {
  describeReadFailure,
  Empty,
  ErrorState,
  FilteredEmpty,
  SkeletonList,
} from '../state';
import { AgentPickerGroups } from './AgentPickerRow';
import { ContextPickerOptions, CwdBreadcrumb } from './ContextPickerOptions';
// The menus reuse the composer popover shell (`.composer-popover-*`).
import '../chat/chat.css';
import './StartComposer.css';

const SessionModelPicker = React.lazy(() =>
  import('../session/SessionModelPicker').then((module) => ({
    default: module.SessionModelPicker,
  })),
);

/**
 * The layer a chip menu opens on. Home's menus belong to their trigger
 * (`popover`); the dock draft's sit on its dialog, and a popover layer is
 * below a dialog's, so they take the dialog layer and stack by order.
 */
type MenuLayer = 'popover' | 'dialog';

type AgentGroups = React.ComponentProps<typeof AgentPickerGroups>['groups'];

/**
 * The Agent chip's menu: every Agent this context offers, grouped, with each
 * row's readiness, its Model trigger (the Model picker and runtime options)
 * and its repair. Choosing a row chooses the Agent; nothing starts.
 */
export function StartAgentMenu({
  anchor,
  layer,
  groups,
  flatList,
  selectedSlug,
  loading,
  error,
  onRetry,
  onSetUpConnections,
  modelLabelFor,
  modelUnavailableFor,
  onOpenModel,
  onChoose,
  onFix,
  fixDisabledFor,
  interactionDisabled,
  search,
  onSearch,
  notice,
  onClose,
}: {
  anchor: HTMLElement | null;
  layer: MenuLayer;
  /** The catalog's compatibility warning for this context, when it has one. */
  notice?: string;
  groups: AgentGroups;
  flatList: AgentData[];
  selectedSlug?: string;
  loading: boolean;
  error?: unknown;
  onRetry: () => void;
  onSetUpConnections: () => void;
  modelLabelFor: (agent: AgentData) => string;
  modelUnavailableFor: (agent: AgentData) => boolean;
  onOpenModel: (agent: AgentData, trigger: HTMLElement) => void;
  onChoose: (agent: AgentData) => void;
  onFix: (agent: AgentData, route: AgentFixRoute) => void;
  fixDisabledFor: (agent: AgentData) => boolean | undefined;
  interactionDisabled?: boolean;
  search: string;
  onSearch: (value: string) => void;
  onClose: () => void;
}) {
  const anchorRef = useRef<HTMLElement | null>(anchor);
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = flatList.findIndex((agent) => agent.slug === selectedSlug);
  const [activeIndex, setActiveIndex] = useState(Math.max(0, selected));
  const selectedRef = useCallback((element: HTMLButtonElement | null) => {
    scheduleSelectedAgentVisibility(element);
  }, []);
  return (
    <ResponsiveDialogSurface
      layer={layer}
      ariaLabel="Choose agent"
      onClose={onClose}
      historyMode="entry"
      anchorRef={anchorRef}
      returnFocusTarget={anchor}
      initialFocusRef={searchRef}
      initialFocusPolicy="desktop"
      overlayClassName="composer-popover-overlay composer-popover-overlay--start"
      panelClassName="composer-popover-panel start-menu__panel"
    >
      <ResponsiveDialogHeader
        title="Agent"
        closeLabel="Close agent list"
        onClose={onClose}
      />
      <input
        ref={searchRef}
        type="text"
        className="new-chat-modal__search start-menu__search"
        aria-label="Search agents"
        placeholder="Search agents..."
        value={search}
        onChange={(event) => {
          onSearch(event.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIndex((index) => Math.min(index + 1, flatList.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
          } else if (
            event.key === 'Enter' &&
            !isComposingKeyEvent(event) &&
            flatList[activeIndex]
          ) {
            event.preventDefault();
            const row = flatList[activeIndex];
            // The row's own button is disabled when it cannot start; Enter
            // does what that row offers instead: Enable, or nothing.
            if (agentRunnability(row).runnable) onChoose(row);
            else if (
              resolveNewChatAgentEnable(row) &&
              agentFixRoute(row) === 'enable'
            )
              onFix(row, 'enable');
          }
        }}
      />
      <div className="new-chat-modal__list start-menu__list">
        {notice && (
          <div className="new-chat-modal__compat-warning" role="note">
            <WarningGlyph /> {notice}
          </div>
        )}
        {flatList.length === 0 &&
          (loading ? (
            <SkeletonList count={3} label="Loading agents" />
          ) : error ? (
            <ErrorState
              variant="compact"
              title="Couldn't load engines or models"
              description={describeReadFailure(error)}
              action={<Button onClick={onRetry}>Retry</Button>}
            />
          ) : search ? (
            <FilteredEmpty
              query={search}
              noun="Agents"
              onClear={() => onSearch('')}
            />
          ) : (
            <Empty
              variant="compact"
              label="Nothing to chat with yet"
              description="Connect an engine (Claude Code, Codex, OpenCode…) or add a Model connection, and new chats appear here automatically."
              action={
                <Button onClick={onSetUpConnections}>Set up Connections</Button>
              }
            />
          ))}
        <AgentPickerGroups
          groups={groups}
          flatList={flatList}
          selectedIndex={activeIndex}
          selectedRef={selectedRef}
          onChoose={onChoose}
          onHover={setActiveIndex}
          modelLabelFor={modelLabelFor}
          modelUnavailableFor={modelUnavailableFor}
          onOpenModel={onOpenModel}
          interactionDisabled={interactionDisabled}
          fixDisabledFor={fixDisabledFor}
          onFix={onFix}
        />
      </div>
    </ResponsiveDialogSurface>
  );
}

/**
 * The project chip's menu: No project and every project, each with the
 * folder it runs in, and the folder this start will actually use (an
 * engine's own Working Directory outranks home for a folderless project).
 */
export function StartProjectMenu({
  anchor,
  layer,
  options,
  selectedContext,
  workspaceHint,
  folderlessHint,
  onChoose,
  onClose,
}: {
  anchor: HTMLElement | null;
  layer: MenuLayer;
  options: NewChatModalContextOption[];
  selectedContext: string;
  workspaceHint: NewChatWorkspaceHint;
  /** Where a project with no folder runs with the chosen Agent. */
  folderlessHint: NewChatWorkspaceHint;
  onChoose: (context: string) => void;
  onClose: () => void;
}) {
  const anchorRef = useRef<HTMLElement | null>(anchor);
  const [search, setSearch] = useState('');
  const query = search.toLowerCase();
  // TODO(project-icons): render `ProjectIcon` once feat/project-icons
  // lands. Until then no raw `project.icon` reaches LayoutIcon here (it
  // would hotlink a remote or path icon); every project shows the folder.
  const safeOptions = options.map((option) =>
    option.icon
      ? { ...option, icon: undefined, glyph: 'folder' as const }
      : option,
  );
  const filtered = query
    ? safeOptions.filter((option) => option.label.toLowerCase().includes(query))
    : safeOptions;
  return (
    <ResponsiveDialogSurface
      layer={layer}
      ariaLabel="Choose project"
      onClose={onClose}
      historyMode="entry"
      anchorRef={anchorRef}
      returnFocusTarget={anchor}
      initialFocusPolicy="desktop"
      overlayClassName="composer-popover-overlay composer-popover-overlay--start"
      panelClassName="composer-popover-panel start-menu__panel"
    >
      <ResponsiveDialogHeader
        title="Project"
        closeLabel="Close project list"
        onClose={onClose}
      />
      <p className="start-menu__hint">
        {'path' in workspaceHint ? (
          <>
            Runs in <CwdBreadcrumb path={workspaceHint.path} />
          </>
        ) : (
          workspaceHintText(workspaceHint)
        )}
      </p>
      <div className="start-menu__list">
        <ContextPickerOptions
          folderlessHint={folderlessHint}
          contextSearch={search}
          onContextSearchChange={setSearch}
          autoFocusFilter={false}
          onEscape={onClose}
          filteredContextOptions={filtered}
          selectedContext={selectedContext}
          onSelectContext={onChoose}
        />
      </div>
    </ResponsiveDialogSurface>
  );
}

/**
 * The Model picker for one Agent, with its runtime options (reasoning effort
 * and the rest). Runtime options apply to this start only; the Model is
 * remembered (see `useStartSelection`).
 */
export function StartModelPicker({
  anchor,
  layer,
  models,
  loading,
  modelConnections,
  choice,
  defaultModel,
  defaultSourceLabel,
  onSelect,
  onReset,
  onRuntimeOptionChange,
  onClose,
}: {
  anchor: HTMLElement | null;
  layer: MenuLayer;
  models: SelectableModel[];
  loading: boolean;
  modelConnections: ConnectionConfig[];
  choice?: NewChatModelChoice;
  defaultModel?: { id?: string | null; providerId?: string };
  defaultSourceLabel: string;
  onSelect: (model: SelectableModel) => void;
  onReset: () => void;
  onRuntimeOptionChange: (key: string, value: unknown) => void;
  onClose: () => void;
}) {
  const anchorRef: RefObject<HTMLElement | null> = useRef(anchor);
  const loadingFrame = (
    <div className="session-model-picker__loading">
      <SkeletonList count={3} withIcon={false} label="Loading models" />
    </div>
  );
  return (
    <ResponsiveDialogSurface
      layer={layer}
      ariaLabel="Model"
      onClose={onClose}
      historyMode="entry"
      anchorRef={anchorRef}
      returnFocusTarget={anchor}
      overlayClassName="composer-popover-overlay composer-popover-overlay--start"
      panelClassName="composer-popover-panel chat-input__model-popover-panel"
    >
      {loading && models.length === 0 ? (
        loadingFrame
      ) : (
        <React.Suspense fallback={loadingFrame}>
          <SessionModelPicker
            returnFocusTarget={anchor}
            models={models}
            providers={modelPickerProviders(models, modelConnections)}
            currentProviderId={choice?.providerId ?? defaultModel?.providerId}
            currentModel={choice?.modelId}
            defaultModel={defaultModel?.id ?? undefined}
            defaultSourceLabel={defaultSourceLabel}
            runtimeOptions={choice?.providerOptions}
            onSelect={onSelect}
            onReset={onReset}
            onRuntimeOptionChange={onRuntimeOptionChange}
            onClose={onClose}
          />
        </React.Suspense>
      )}
    </ResponsiveDialogSurface>
  );
}
