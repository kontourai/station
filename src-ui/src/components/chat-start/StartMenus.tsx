import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import React, { type RefObject, useCallback, useRef, useState } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import { useExecutionStationCatalog } from '../../hooks/useExecutionStationCatalog';
import { isComposingKeyEvent } from '../../lib/isComposingKeyEvent';
import {
  type EffectiveModelSource,
  modelSourceLabel,
} from '../../utils/execution';
import type {
  NewChatModelChoice,
  SelectableModel,
} from '../../utils/modelCapabilities';
import { type AgentFixRoute, agentFixRoute } from '../AgentReadinessCell';
import { agentRunnability } from '../agent-runnability';
import { Button } from '../Button';
import { WarningGlyph } from '../icons/Glyph';
import { ProjectIcon } from '../icons/ProjectIcon';
import {
  GLOBAL_CONTEXT,
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
  icons,
  accents,
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
  /** The sidebar's project icons (`useProjectIcons`), from the caller. */
  icons: ReadonlyMap<string, string>;
  /** The sidebar's project colours (`useProjectAccents`), from the caller. */
  accents: ReadonlyMap<string, string>;
  onChoose: (context: string) => void;
  onClose: () => void;
}) {
  const anchorRef = useRef<HTMLElement | null>(anchor);
  const [search, setSearch] = useState('');
  const query = search.toLowerCase();
  // Only `ProjectIcon` draws a project here: it shows an icon the contracts
  // rule allows and never a raw `project.icon`, which `LayoutIcon` would
  // hotlink.
  const filtered = query
    ? options.filter((option) => option.label.toLowerCase().includes(query))
    : options;
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
      {'path' in workspaceHint ? (
        // One line: the folder's parent gives way, its leaf stays readable.
        <p className="start-menu__hint start-menu__hint--path">
          <span className="start-menu__hint-lead">Runs in</span>
          <CwdBreadcrumb path={workspaceHint.path} />
          {workspaceHint.kind === 'unverified' && (
            <span className="start-menu__hint-lead">(not checked yet)</span>
          )}
        </p>
      ) : (
        <p className="start-menu__hint">{workspaceHintText(workspaceHint)}</p>
      )}
      <div className="start-menu__list">
        <ContextPickerOptions
          folderlessHint={folderlessHint}
          renderMark={(option) =>
            option.value === GLOBAL_CONTEXT ? undefined : (
              <span className="start-menu__mark">
                <ProjectIcon
                  project={{
                    name: option.label,
                    icon: icons.get(option.value),
                  }}
                  size={24}
                  accent={accents.get(option.value)}
                />
              </span>
            )
          }
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
  onSelect,
  onReset,
  onRuntimeOptionChange,
  onClose,
  profile,
  onEnvironmentChange,
}: {
  profile?: AgentData;
  onEnvironmentChange?: (environmentId: string) => void;
  anchor: HTMLElement | null;
  layer: MenuLayer;
  models: SelectableModel[];
  loading: boolean;
  modelConnections: ConnectionConfig[];
  choice?: NewChatModelChoice;
  defaultModel?: {
    id?: string | null;
    providerId?: string;
    source?: EffectiveModelSource;
  };
  onSelect: (model: SelectableModel) => void;
  onReset: () => void;
  onRuntimeOptionChange: (key: string, value: unknown) => void;
  onClose: () => void;
}) {
  const anchorRef: RefObject<HTMLElement | null> = useRef(anchor);
  if (profile && onEnvironmentChange)
    return (
      <StationScopedModelPicker
        anchor={anchor}
        layer={layer}
        models={models}
        loading={loading}
        modelConnections={modelConnections}
        choice={choice}
        defaultModel={defaultModel}
        onSelect={onSelect}
        onReset={onReset}
        onRuntimeOptionChange={onRuntimeOptionChange}
        onClose={onClose}
        profile={profile}
        onEnvironmentChange={onEnvironmentChange}
      />
    );
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
            currentExecutionAgentId={choice?.executionAgentId}
            defaultModel={defaultModel?.id ?? undefined}
            // The reset names where the default comes from, never the
            // current choice: with a Model chosen that is always the
            // override itself ("Use session override").
            defaultSourceLabel={
              (defaultModel?.source &&
                modelSourceLabel(defaultModel.source).toLowerCase()) ||
              'default model'
            }
            runtimeOptions={choice?.providerOptions}
            // Choosing or resetting a Model finishes the picker, as it does
            // in a chat's composer; effort changes keep it open.
            onSelect={(model) => {
              onSelect(model);
              onClose();
            }}
            onReset={() => {
              onReset();
              onClose();
            }}
            onRuntimeOptionChange={onRuntimeOptionChange}
            onClose={onClose}
          />
        </React.Suspense>
      )}
    </ResponsiveDialogSurface>
  );
}

function StationScopedModelPicker(
  props: React.ComponentProps<typeof StartModelPicker> & {
    profile: AgentData;
    onEnvironmentChange: (id: string) => void;
  },
) {
  const environmentId = props.choice?.environmentId ?? 'current';
  const catalog = useExecutionStationCatalog(props.profile, environmentId);
  const remote = environmentId !== 'current';
  const models = remote
    ? catalog.models
    : props.models.map((model) => ({
        ...model,
        stationName: catalog.stationName,
        environmentId: 'current',
      }));
  const anchorRef = useRef(props.anchor);
  return (
    <ResponsiveDialogSurface
      layer={props.layer}
      ariaLabel="Engine & model"
      onClose={props.onClose}
      historyMode="entry"
      anchorRef={anchorRef}
      returnFocusTarget={props.anchor}
      overlayClassName="composer-popover-overlay composer-popover-overlay--start"
      panelClassName="composer-popover-panel chat-input__model-popover-panel"
    >
      <React.Suspense
        fallback={
          <SkeletonList count={3} withIcon={false} label="Loading models" />
        }
      >
        <SessionModelPicker
          stationControl={
            <>
              <label className="session-model-picker__station-control">
                Station
                <select
                  aria-label="Execution Station"
                  className="editor-select"
                  value={environmentId}
                  onChange={(event) =>
                    props.onEnvironmentChange(event.target.value)
                  }
                >
                  {!catalog.stations.some(
                    (station) => station.id === environmentId,
                  ) && (
                    <option value={environmentId}>
                      Selected Station · unavailable
                    </option>
                  )}
                  {catalog.stations.map((station) => (
                    <option key={station.id} value={station.id}>
                      {station.name}
                    </option>
                  ))}
                </select>
              </label>
              {catalog.stationsUnavailable && (
                <p role="status">Some Station choices could not be loaded.</p>
              )}
              {remote && (
                <p className="session-model-picker__binding">
                  Starts a task on {catalog.stationName}; this conversation
                  stays on its owning Station.
                </p>
              )}
            </>
          }
          models={models}
          loading={remote ? catalog.loading : props.loading}
          providers={modelPickerProviders(models, props.modelConnections)}
          currentProviderId={props.choice?.providerId}
          currentModel={props.choice?.modelId}
          currentExecutionAgentId={props.choice?.executionAgentId}
          defaultModel={props.defaultModel?.id ?? undefined}
          defaultSourceLabel={
            props.defaultModel?.source
              ? modelSourceLabel(props.defaultModel.source).toLowerCase()
              : 'Agent defaults'
          }
          runtimeOptions={props.choice?.providerOptions}
          returnFocusTarget={props.anchor}
          catalogNotice={
            catalog.error
              ? describeReadFailure(catalog.error)
              : catalog.unmatched
                ? 'This Agent definition cannot be verified on the selected Station. Choose another Station or manage its Agents.'
                : undefined
          }
          onSelect={(model) => {
            props.onSelect(model);
            props.onClose();
          }}
          onReset={() => {
            props.onReset();
            props.onClose();
          }}
          onRuntimeOptionChange={props.onRuntimeOptionChange}
          onClose={props.onClose}
        />
      </React.Suspense>
    </ResponsiveDialogSurface>
  );
}
