import {
  useAgentsQuery,
  useMessageSearchQuery,
  useProjectsQuery,
  useSkillsQuery,
} from '@kontourai/station-sdk';
import {
  captureReturnFocus,
  restoreReturnFocus,
} from '@kontourai/station-shared/return-focus';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { APP_SURFACE_REGISTRY } from '../app-shell/surface-registry';
import {
  evaluateShortcutWhen,
  useShortcutRegistry,
} from '../contexts/KeyboardShortcutsContext';
import { useNavigation } from '../contexts/NavigationContext';
import {
  openChatIdentitiesSnapshot,
  openChatsStore,
} from '../contexts/open-chats-store';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';
import { useSurfaceVisibilityFlags } from '../hooks/useSurfaceVisibilityFlags';
import { useLocale } from '../i18n/LocaleContext';
import { isComposingKeyEvent } from '../lib/isComposingKeyEvent';
import { usePlatformProfile } from '../platform/PlatformProfileContext';
import { useResolvedWorkspacePaneCatalog } from '../workspace-panes/resolvedWorkspacePaneCatalog';
import { presentWorkspacePaneAvailability } from '../workspace-panes/workspacePaneAvailabilityPresentation';
import {
  workspacePaneDirectRoute,
  workspacePaneRequiresLayoutIdentity,
} from '../workspace-panes/workspacePaneDirectRoute';
import { requestFirstRunTour } from './first-run/first-run-store';
import { Empty, SkeletonBlock } from './state';
import './CommandPalette.css';
import type {
  formatSettingsMessage,
  localizedSettingsTargetLabel,
  SettingsPaletteCommand,
} from '../views/settings/settings-catalog';
import { commandFrecencyStorage } from './command-frecency-storage';
import {
  groupRanked,
  isFrecencyEligible,
  type PaletteCommand,
  rankCommands,
} from './command-palette-utils';

/** `dock.session1` … `dock.session9` — the ⌘1–⌘9 chat-switch bindings. */
const SESSION_SWITCH_SHORTCUT = /^dock\.session[1-9]$/;

function settingsScopeDetail(
  scope: SettingsPaletteCommand['scope'],
  locale: Parameters<typeof formatSettingsMessage>[1],
  formatMessage: typeof formatSettingsMessage,
) {
  switch (scope) {
    case 'station':
      return formatMessage('scopeStation', locale);
    case 'defaults':
      return formatMessage('scopeDefaults', locale);
    case 'device':
      return formatMessage('scopeDevice', locale);
    case 'mixed':
      return formatMessage('scopeMixed', locale);
    case 'temporary':
      return formatMessage('scopeTemporary', locale);
    case 'informational':
      return formatMessage('scopeInformational', locale);
  }
}

type SettingsLocaleFormatter = {
  formatMessage: typeof formatSettingsMessage;
  targetLabel: typeof localizedSettingsTargetLabel;
};
type SettingsCatalogModule = Pick<
  typeof import('../views/settings/settings-catalog'),
  | 'formatSettingsMessage'
  | 'localizedSettingsTargetLabel'
  | 'settingsPaletteCommands'
>;

const SearchIcon = (
  <svg
    className="command-palette__search-icon"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [debouncedMessageQuery, setDebouncedMessageQuery] = useState('');
  const [paneNotice, setPaneNotice] = useState<{
    label: string;
    stateLabel: string;
    reasonLabel: string;
    actionLabel?: string;
  } | null>(null);
  const [frecencyNotice, setFrecencyNotice] = useState<string | null>(null);
  // Settings has a broad registry and contracts dependency. Keep it out of
  // the shell entry chunk: this projection is useful only while the palette
  // is open, and the actual Settings route stays independently lazy.
  const [settingsCatalog, setSettingsCatalog] =
    useState<SettingsCatalogModule | null>(null);
  const [settingsCatalogLoadState, setSettingsCatalogLoadState] = useState<
    'idle' | 'loading' | 'failed'
  >('idle');

  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement[]>([]);
  // archive#3313: previewFlag-gated surfaces (Developer, enabled previews)
  // appear here iff their flag is on — same set the sidebar filters with.
  const surfaceVisibilityFlags = useSurfaceVisibilityFlags();

  const {
    navigate,
    setProject,
    setDockState,
    selectedProject,
    selectedProjectLayout,
  } = useNavigation();
  const { getAllShortcuts } = useShortcutRegistry();
  const { isMobile } = usePlatformProfile();
  const { locale } = useLocale();

  useEffect(() => {
    // The initial palette list stays its inexpensive shell projection. Load
    // this large, route-owned inventory only once someone starts searching;
    // that also avoids unrelated live-chat updates rebuilding the index.
    if (!open || query.trim().length === 0 || settingsCatalog) return;
    let cancelled = false;
    setSettingsCatalogLoadState('loading');
    void import('../views/settings/settings-catalog').then(
      ({
        formatSettingsMessage,
        localizedSettingsTargetLabel,
        settingsPaletteCommands,
      }) => {
        if (cancelled) return;
        setSettingsCatalog({
          formatSettingsMessage,
          localizedSettingsTargetLabel,
          settingsPaletteCommands,
        });
        setSettingsCatalogLoadState('idle');
      },
      () => {
        if (cancelled) return;
        // The rest of the palette remains usable if its optional Settings
        // projection cannot arrive. Show that partial result explicitly
        // instead of leaving a misleading empty search state.
        setSettingsCatalogLoadState('failed');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, query, settingsCatalog]);

  const settingsCommands = useMemo(
    () => settingsCatalog?.settingsPaletteCommands({ isMobile }) ?? [],
    [isMobile, settingsCatalog],
  );
  const settingsLocaleFormatter: SettingsLocaleFormatter | null =
    settingsCatalog
      ? {
          formatMessage: settingsCatalog.formatSettingsMessage,
          targetLabel: settingsCatalog.localizedSettingsTargetLabel,
        }
      : null;

  useEffect(() => {
    if (settingsCommands.length === 0) return;
    commandFrecencyStorage.reconcileSettings(
      new Set(settingsCommands.map((command) => command.id)),
    );
  }, [settingsCommands]);

  // Command sources. Palette is global, so these queries are always mounted;
  // they share react-query cache with the views that own them.
  const { data: agents = [] } = useAgentsQuery();
  const { data: projects = [] } = useProjectsQuery();
  const { data: skills = [] } = useSkillsQuery();
  // the palette used to advertise "Switch to session 1" … "Switch to
  // session 9" as nine static commands whatever the truth was — there was one
  // session, and eight of those rows ran a handler that returns without doing
  // anything. These are the live open chats, so a row exists iff a chat does.
  //
  // Two deliberate narrowings, both about cost. The projection is identity and
  // label only and keeps its reference when neither changed, so a streaming
  // chat's per-token store notification no longer rebuilds and reranks this
  // whole command index. And the subscription is mounted only while the
  // palette is open: a closed palette renders `null`, so it has no reason to
  // re-render for anything at all.
  const subscribeToOpenChats = useCallback(
    (onStoreChange: () => void) =>
      open ? openChatsStore.subscribe(onStoreChange) : () => {},
    [open],
  );
  const openChats = useSyncExternalStore(
    subscribeToOpenChats,
    openChatIdentitiesSnapshot,
    openChatIdentitiesSnapshot,
  );
  const frecency = useSyncExternalStore(
    commandFrecencyStorage.subscribe,
    commandFrecencyStorage.read,
    commandFrecencyStorage.read,
  );
  // A palette keystroke must not start a transcript request. The deferred
  // value both debounces dispatch (200ms) and changes the react-query key, so
  // TanStack Query receives the previous request's AbortSignal on replacement.
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedMessageQuery(query), 200);
    return () => window.clearTimeout(timer);
  }, [query]);
  const { data: messageSearch } = useMessageSearchQuery(debouncedMessageQuery);
  const messageMatches = messageSearch?.matches ?? [];
  const remoteSearchStates =
    messageSearch?.instances.filter(
      (instance) => instance.instanceId !== 'local',
    ) ?? [];
  const deferredRemoteInstanceCount = messageSearch?.deferredInstanceCount ?? 0;
  const paneCatalog = useResolvedWorkspacePaneCatalog(selectedProject ?? '');

  // Capture the return target at the moment the palette is *asked* for, not in
  // the effect that reacts to `open`. The input carries `autoFocus`, which
  // React applies while committing the palette's DOM — before any effect runs
  // so an effect-time `document.activeElement` reads the palette's own input
  // and the restore has nothing outside the palette to return to.
  const openPalette = useCallback(() => {
    returnFocusRef.current = captureReturnFocus();
    setOpen(true);
  }, []);

  useKeyboardShortcut(
    'command-palette',
    'k',
    ['cmd'],
    'Open command palette',
    openPalette,
  );

  // Allow non-keyboard surfaces (e.g. the status bar) to open the palette.
  useEffect(() => {
    window.addEventListener('open-command-palette', openPalette);
    return () =>
      window.removeEventListener('open-command-palette', openPalette);
  }, [openPalette]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
    setPaneNotice(null);
    setFrecencyNotice(null);
  }, []);

  const runCommand = useCallback(
    (command: PaletteCommand) => {
      // The shortcut registry is authoritative about disabled and contextual
      // availability. The palette may have indexed a row before focus changed,
      // so consult its live guard here — the one execution choke point — before
      // closing, invoking a raw handler, or recording frecency.
      if (command.canExecute && !command.canExecute()) return;
      if (command.closeOnRun !== false) close();
      command.run();
      if (isFrecencyEligible(command)) {
        commandFrecencyStorage.record(command.id);
      }
    },
    [close],
  );

  const commands = useMemo<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = [];

    // The shortcut editor and command palette consume the same live command
    // registry. A customized binding changes how a command is invoked, never
    // whether the command exists.
    for (const shortcut of getAllShortcuts()) {
      if (shortcut.id === 'command-palette') continue;
      // The ⌘1–⌘9 bindings stay registered (and stay listed in the shortcuts
      // cheatsheet, which is a keyboard reference); what they must not do is
      // masquerade as nine navigable destinations here. The Chats group below
      // carries the ones that exist.
      if (SESSION_SWITCH_SHORTCUT.test(shortcut.id)) continue;
      const canExecute = () =>
        !shortcut.disabled &&
        (!shortcut.when || evaluateShortcutWhen(shortcut.when));
      list.push({
        id: `command:${shortcut.id}`,
        label: shortcut.description,
        group: 'Commands',
        keywords: ['command', 'shortcut', shortcut.id],
        disabled: !canExecute(),
        canExecute,
        run: shortcut.handler,
      });
    }

    // Actions
    // "New chat" appeared twice — once from the ⌘T shortcut, which
    // starts one, and once here as an Action whose `run` was byte-identical to
    // "Open chat dock" below. Two labels for one behaviour, one of them a
    // promise the handler did not keep; the shortcut-derived row is the one
    // that actually opens a new chat, so this duplicate is gone.
    list.push({
      id: 'action:open-dock',
      label: 'Open chat dock',
      group: 'Actions',
      keywords: ['chat', 'dock', 'open', 'new'],
      run: () => setDockState(true),
    });
    // archive#2652: the tour is re-triggerable from here, which is also what
    // its last step tells the user. `requestFirstRunTour` dispatches the same
    // event `FirstRunFlow` listens on, so the resume rule
    // (`resolveResumePoint`) is shared with the automatic first run rather
    // than duplicated for the manual one.
    list.push({
      id: 'action:first-run-tour',
      label: 'Take the tour',
      group: 'Actions',
      keywords: [
        'tour',
        'first run',
        'onboarding',
        'walkthrough',
        'evidence',
        'receipts',
        'guide',
      ],
      run: () => requestFirstRunTour(),
    });
    list.push({
      id: 'action:reset-command-history',
      label: 'Reset command history',
      group: 'Actions',
      keywords: ['history', 'frecency', 'recent', 'privacy', 'device'],
      closeOnRun: false,
      run: () => {
        setFrecencyNotice(
          commandFrecencyStorage.reset()
            ? 'Command history reset on this device.'
            : 'Command history could not be reset on this device.',
        );
      },
    });

    // Navigation (static)
    for (const surface of APP_SURFACE_REGISTRY.getPalette(
      surfaceVisibilityFlags,
    )) {
      const params = surface.palette?.params;
      list.push({
        id: `nav:${surface.id}`,
        label: surface.label(),
        group: 'Navigation',
        keywords: surface.keywords ? [...surface.keywords] : undefined,
        run: () =>
          params
            ? navigate(surface.route, { ...params })
            : navigate(surface.route),
      });
    }

    // Generated from the rendered-settings catalog, never DOM text or a
    // second parallel list. An unavailable row remains an explanation rather
    // than a disabled navigation that silently does nothing.
    for (const setting of settingsCommands) {
      list.push({
        id: setting.id,
        label: settingsLocaleFormatter
          ? settingsLocaleFormatter.formatMessage('paletteTitle', locale, {
              target: settingsLocaleFormatter.targetLabel(
                setting.highlight,
                locale,
              ),
            })
          : setting.label,
        group: settingsLocaleFormatter
          ? settingsLocaleFormatter.formatMessage('paletteGroup', locale)
          : 'Settings',
        keywords: [...setting.keywords],
        detail: settingsLocaleFormatter
          ? setting.unavailable
            ? settingsLocaleFormatter.formatMessage('unavailableMobile', locale)
            : settingsScopeDetail(
                setting.scope,
                locale,
                settingsLocaleFormatter.formatMessage,
              )
          : '',
        closeOnRun: !setting.unavailable,
        disabled: setting.unavailable,
        run: () => {
          if (setting.unavailable) {
            setPaneNotice({
              label:
                settingsLocaleFormatter?.targetLabel(
                  setting.highlight,
                  locale,
                ) ?? setting.label,
              stateLabel:
                settingsLocaleFormatter?.formatMessage(
                  'unavailableStatus',
                  locale,
                ) ?? 'Unavailable',
              reasonLabel:
                settingsLocaleFormatter?.formatMessage(
                  'unavailableMobile',
                  locale,
                ) ?? '',
            });
            return;
          }
          navigate('/settings', {
            view: setting.view,
            highlight: setting.highlight,
          });
        },
      });
    }

    // Chats — one row per open chat, from the store the dock renders.
    for (const chat of openChats) {
      list.push({
        id: `chat:${chat.sessionId}`,
        label: chat.label,
        group: 'Chats',
        keywords: [
          'chat',
          'session',
          'switch',
          ...(chat.agentSlug ? [chat.agentSlug] : []),
          ...(chat.projectSlug ? [chat.projectSlug] : []),
        ],
        run: () => openChatsStore.focus({ sessionId: chat.sessionId }),
      });
    }

    // Projects
    for (const project of projects as Array<{ slug: string; name?: string }>) {
      if (!project?.slug) continue;
      list.push({
        id: `project:${project.slug}`,
        label: project.name || project.slug,
        group: 'Projects',
        keywords: ['project', project.slug],
        run: () => setProject(project.slug),
      });
    }

    // Workspace Pane options remain in the same ranking and listbox model as
    // all other commands. An unavailable pane reveals its resolver-backed
    // state and bounded action without trying to mount a renderer.
    for (const entry of paneCatalog.entries) {
      const presentation = presentWorkspacePaneAvailability(entry.availability);
      const route =
        entry.instance && selectedProject
          ? workspacePaneDirectRoute(
              selectedProject,
              entry.descriptor,
              entry.instance,
              selectedProjectLayout,
            )
          : null;
      const available = presentation.state === 'available' && route !== null;
      const needsSelectedLayout =
        workspacePaneRequiresLayoutIdentity(entry.descriptor) && route === null;
      list.push({
        id: `workspace-pane:${entry.instance?.instanceId ?? entry.descriptor.id}`,
        label: entry.descriptor.name,
        group: 'Workspace panes',
        keywords: [
          'workspace',
          'pane',
          entry.descriptor.id,
          presentation.state,
          presentation.reasonCode,
        ],
        detail: needsSelectedLayout
          ? 'Layout needed: Open this Project layout before using this pane.'
          : `${presentation.stateLabel}: ${presentation.reasonLabel}`,
        closeOnRun: available,
        disabled: needsSelectedLayout,
        run: () => {
          if (available && route) {
            navigate(route);
            return;
          }
          setPaneNotice(
            needsSelectedLayout
              ? {
                  label: entry.descriptor.name,
                  stateLabel: 'Layout needed',
                  reasonLabel:
                    'Open this Project layout before using this pane.',
                }
              : {
                  label: entry.descriptor.name,
                  stateLabel: presentation.stateLabel,
                  reasonLabel: presentation.reasonLabel,
                  actionLabel: presentation.actionLabel,
                },
          );
        },
      });
    }

    // Agents → /agents/{slug}
    for (const agent of agents as Array<{ slug: string; name?: string }>) {
      if (!agent?.slug) continue;
      list.push({
        id: `agent:${agent.slug}`,
        label: agent.name || agent.slug,
        group: 'Agents',
        keywords: ['agent', agent.slug],
        run: () => navigate(`/agents/${encodeURIComponent(agent.slug)}`),
      });
    }

    // Skills → /skills/{name}
    for (const skill of skills as Array<{ id?: string; name?: string }>) {
      const name = skill?.name || skill?.id;
      if (!name) continue;
      list.push({
        id: `skill:${name}`,
        label: name,
        group: 'Skills',
        keywords: ['skill', 'guidance'],
        run: () => navigate(`/skills/${encodeURIComponent(name)}`),
      });
    }

    // Transcript content is deliberately its own result group. Excerpts are
    // plain React text children below; no HTML string or innerHTML path exists
    // for model output, including when it contains markup-looking characters.
    if (query.trim().length >= 2) {
      for (const match of messageMatches) {
        if (!match.agentSlug) continue;
        const remote =
          match.sourceInstanceId && match.sourceInstanceName
            ? {
                sourceInstanceId: match.sourceInstanceId,
                sourceInstanceName: match.sourceInstanceName,
              }
            : undefined;
        list.push({
          id: `message:${match.sourceInstanceId ?? 'local'}:${match.conversationId}:${match.messageId}`,
          label: match.excerpt,
          group: 'Messages',
          detail: remote
            ? `${match.role === 'user' ? 'You' : 'Agent'} · On ${remote.sourceInstanceName} · Remote opening is not available here; review its connection.`
            : `${match.role === 'user' ? 'You' : 'Agent'} · Project: ${match.projectSlug ?? 'No project'} · Engine: ${match.engine ?? 'Unknown'}`,
          closeOnRun: !remote,
          run: () =>
            openChatsStore.focus({
              conversationId: match.conversationId,
              agentSlug: match.agentSlug,
              projectSlug: match.projectSlug,
              messageId: match.messageId,
              ...remote,
            }),
        });
      }
    }

    return list;
  }, [
    agents,
    projects,
    skills,
    navigate,
    setProject,
    setDockState,
    getAllShortcuts,
    paneCatalog.entries,
    selectedProject,
    selectedProjectLayout,
    messageMatches,
    openChats,
    query,
    surfaceVisibilityFlags,
    settingsCommands,
    settingsLocaleFormatter,
    locale,
  ]);

  const ranked = useMemo(
    () => rankCommands(query, commands, frecency),
    [query, commands, frecency],
  );
  const groups = useMemo(() => groupRanked(ranked), [ranked]);

  // Clamp the highlight whenever the result set changes.
  useEffect(() => {
    setActiveIndex((i) => {
      if (ranked.length === 0) return 0;
      return Math.min(i, ranked.length - 1);
    });
  }, [ranked.length]);

  // Manage focus: remember what was focused before, focus the input on open,
  // and restore on close through the shared return-focus module (archive#1245).
  //
  // The palette's own restore used to be `previouslyFocused.current.focus?.`
  // with no `isConnected` guard at all — worse than the archive#1126 shape the guard
  // was added for, and the palette is where it bites hardest: every command
  // navigates, so the element that opened the palette is routinely unmounted
  // by the command the palette just ran. `.focus` on a detached node is a
  // silent no-op and focus lands on `<body>`.
  //
  // Restoring on the next frame rather than synchronously is deliberate: the
  // command's `navigate` has to commit first, or the chain is still attached
  // and we would focus a node that is about to be torn down. Deferring also
  // lets the destination view's own initial focus win — the shared module
  // leaves an already-claimed focus alone (gap 1).
  useEffect(() => {
    if (open) {
      // Defer so the input is mounted.
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    const chain = returnFocusRef.current;
    if (chain.length === 0) return;
    returnFocusRef.current = [];
    const frame = restoreReturnFocus(chain);
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => (ranked.length ? (i + 1) % ranked.length : 0));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) =>
          ranked.length ? (i - 1 + ranked.length) % ranked.length : 0,
        );
        return;
      }
      if (e.key === 'Enter' && !isComposingKeyEvent(e)) {
        e.preventDefault();
        const selected = ranked[activeIndex];
        if (selected) runCommand(selected);
      }
    },
    [ranked, activeIndex, close, runCommand],
  );

  if (!open) return null;

  // Flat index across groups for aria-selected / highlight tracking.
  let flatIndex = -1;

  return (
    // A click-outside backdrop, not a control. Escape already closes the
    // palette (see onKeyDown below), so giving this a role and a tab stop
    // would add a second, unlabelled way to do the same thing and put a stop
    // between the user and the input.
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop dismiss; keyboard path is Escape.
    <div
      className="command-palette-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <div className="command-palette__input-row">
          {SearchIcon}
          <input
            ref={inputRef}
            // The palette is a modal the user explicitly summoned to type
            // into; landing anywhere else would be the surprise. Focus is
            // returned to the opener on close (restoreReturnFocus above).
            // biome-ignore lint/a11y/noAutofocus: user-invoked modal whose sole purpose is this input.
            autoFocus
            className="command-palette__input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-listbox"
            aria-autocomplete="list"
            aria-label="Search commands and indexed conversation messages"
            // Focus stays in the input while the arrows move `activeIndex`,
            // so without this a screen reader announces nothing at all as the
            // user arrows through results. The option ids already existed and
            // nothing pointed at them. Undefined — never a dangling id — when
            // there are no results to point at. Clamped inline, not just via
            // the post-render effect above: a background query refresh can
            // shrink `ranked` while the palette is open, and the effect only
            // corrects `activeIndex` one render AFTER the attribute would
            // have pointed at a removed option
            aria-activedescendant={
              ranked.length
                ? `command-palette-option-${Math.min(
                    activeIndex,
                    ranked.length - 1,
                  )}`
                : undefined
            }
            placeholder="Search commands, projects, agents, indexed conversation messages…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
          />
        </div>

        {paneNotice && (
          <div className="command-palette__pane-notice" role="status">
            <strong>
              {paneNotice.label}: {paneNotice.stateLabel}
            </strong>
            <span>{paneNotice.reasonLabel}</span>
            {paneNotice.actionLabel && (
              <span>
                {paneNotice.actionLabel} is required. Open the Project pane
                catalog to review this bounded next step.
              </span>
            )}
          </div>
        )}

        {frecencyNotice && (
          <div className="command-palette__pane-notice" role="status">
            {frecencyNotice}
          </div>
        )}

        {settingsCatalogLoadState === 'loading' && query.trim() && (
          <SkeletonBlock count={1} label="Loading additional commands" />
        )}

        {settingsCatalogLoadState === 'failed' && query.trim() && (
          <div className="command-palette__pane-notice" role="status">
            <strong>Additional commands are unavailable.</strong>
            <span>The rest of command search is still available.</span>
          </div>
        )}

        {query.trim().length >= 2 &&
          (remoteSearchStates.length > 0 ||
            deferredRemoteInstanceCount > 0) && (
            <div className="command-palette__search-state" role="status">
              {remoteSearchStates.map((instance) => (
                <span key={instance.instanceId}>
                  {instance.instanceName}:{' '}
                  {instance.status === 'empty'
                    ? 'no matching messages'
                    : instance.status === 'available'
                      ? 'searched'
                      : instance.status === 'timed_out'
                        ? 'search timed out'
                        : instance.status === 'refused'
                          ? 'connection refused'
                          : instance.status === 'authentication_required'
                            ? 'access needs repair'
                            : instance.status === 'deferred'
                              ? 'not searched (capacity limit)'
                              : 'unreachable'}
                </span>
              ))}
              {deferredRemoteInstanceCount > 0 && (
                <span>
                  {deferredRemoteInstanceCount} more instance
                  {deferredRemoteInstanceCount === 1 ? '' : 's'} deferred by
                  capacity limit
                </span>
              )}
            </div>
          )}

        {ranked.length === 0 ? (
          <Empty variant="compact" label="No matching commands" />
        ) : (
          <ul
            className="command-palette__results"
            id="command-palette-listbox"
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ul/li IS the canonical listbox/option markup.
            role="listbox"
            aria-label="Command results"
          >
            {groups.map((group) => (
              <li key={group.label} role="presentation">
                <div className="command-palette__group-label">
                  {group.label}
                </div>
                <ul role="presentation">
                  {group.commands.map((cmd) => {
                    flatIndex += 1;
                    const index = flatIndex;
                    const isActive = index === activeIndex;
                    return (
                      // An ARIA listbox option. The listbox pattern keeps
                      // keyboard support on the combobox input above (arrows
                      // move activeIndex, Enter runs it) with focus never
                      // leaving that input, and announces the highlighted row
                      // through the input's aria-activedescendant. Giving the
                      // option its own tabIndex would break that focus model.
                      // Valid only because aria-activedescendant is wired —
                      // without it these warnings point at a real defect.
                      // biome-ignore lint/a11y/useKeyWithClickEvents: listbox option; keys handled on the combobox input.
                      // biome-ignore lint/a11y/useFocusableInteractive: aria-activedescendant pattern, focus stays in the input.
                      <li
                        key={cmd.id}
                        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: ul/li IS the canonical listbox/option markup.
                        role="option"
                        id={`command-palette-option-${index}`}
                        aria-selected={isActive}
                        aria-disabled={cmd.disabled || undefined}
                        className={`command-palette__option${
                          isActive ? ' command-palette__option--active' : ''
                        }`}
                        onMouseMove={() => setActiveIndex(index)}
                        onClick={() => runCommand(cmd)}
                      >
                        {(cmd.icon as ReactNode) ? (
                          <span className="command-palette__option-icon">
                            {cmd.icon as ReactNode}
                          </span>
                        ) : null}
                        <span className="command-palette__option-label">
                          {cmd.label}
                          {cmd.detail && (
                            <small className="command-palette__option-detail">
                              {cmd.detail}
                            </small>
                          )}
                        </span>
                        <span className="command-palette__option-group">
                          {cmd.group}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
