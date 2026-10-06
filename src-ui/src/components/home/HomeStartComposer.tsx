import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useAgents } from '../../contexts/AgentsContext';
import { useScopedProjectsQuery } from '../../contexts/ProjectsContext';
import { useDevicePresentation } from '../../hooks/useDevicePresentation';
import { useNewChatSelectionModel } from '../../hooks/useNewChatSelectionModel';
import { useNewChatStartContext } from '../../hooks/useNewChatStartContext';
import { useProjectAccents } from '../../hooks/useProjectAccents';
import { useProjectIcons } from '../../hooks/useProjectIcons';
import {
  useBindStartProject,
  useStartSelection,
} from '../../hooks/useStartSelection';
import {
  dispatchNewChatIntent,
  type NewChatHandoff,
} from '../../lib/newChatIntent';
import { userFacingErrorMessage } from '../../utils/errorText';
import type { AgentFixRoute } from '../AgentReadinessCell';
import { agentFixRoute } from '../AgentReadinessCell';
import { agentRunnability } from '../agent-runnability';
import { Button } from '../Button';
import {
  type StartAgentChip,
  StartComposer,
  type StartProjectChip,
} from '../chat-start/StartComposer';
import { useAgentEnable } from '../chat-start/useAgentEnable';
import {
  GLOBAL_CONTEXT,
  NO_PROJECT_LABEL,
  resolveNewChatAgentEnable,
  resolveNewChatWorkspaceHint,
  workspaceHintText,
} from '../modals/new-chat-modal-utils';
import { describeReadFailure, SkeletonList } from '../state';

// The pickers and setup guidance load on first use, outside Home's bundle.
const StartAgentMenu = React.lazy(() =>
  import('../chat-start/StartMenus').then((module) => ({
    default: module.StartAgentMenu,
  })),
);
const StartProjectMenu = React.lazy(() =>
  import('../chat-start/StartMenus').then((module) => ({
    default: module.StartProjectMenu,
  })),
);
const StartModelPicker = React.lazy(() =>
  import('../chat-start/StartMenus').then((module) => ({
    default: module.StartModelPicker,
  })),
);
const ChatSetupHelper = React.lazy(() =>
  import('../chat-start/ChatSetupHelper').then((module) => ({
    default: module.ChatSetupHelper,
  })),
);

/**
 * The setup guidance, reading the device projection only when it shows (the
 * projection needs the connection directory, which Home's start must not
 * wait on).
 */
function HomeChatSetupHelper(
  props: Omit<
    React.ComponentProps<typeof ChatSetupHelper>,
    'devicePresentation'
  >,
) {
  const devicePresentation = useDevicePresentation();
  return <ChatSetupHelper {...props} devicePresentation={devicePresentation} />;
}

/**
 * Drafts Home handed to the dock that came back undone (the dock's draft was
 * closed, or its setup journey cancelled), as the dock last held them. Kept
 * at module scope because the setup journey leaves the page, so the Home
 * that sent one may have unmounted, and mirrored to this tab's
 * sessionStorage so a reload keeps them. A draft leaves this list only when
 * it is restored into the field or explicitly discarded. Closing the tab (or
 * a browser with storage blocked, then a reload) still drops them.
 */
const HELD_HOME_DRAFTS_KEY = 'station-home-held-drafts-v1';
function readStoredHeldDrafts(): readonly string[] {
  try {
    const raw = window.sessionStorage.getItem(HELD_HOME_DRAFTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // Anything but a list of strings is not ours to restore.
    return Array.isArray(parsed) &&
      parsed.every((entry) => typeof entry === 'string')
      ? parsed
      : [];
  } catch {
    return [];
  }
}
function writeStoredHeldDrafts(next: readonly string[]) {
  try {
    if (next.length === 0)
      window.sessionStorage.removeItem(HELD_HOME_DRAFTS_KEY);
    else
      window.sessionStorage.setItem(HELD_HOME_DRAFTS_KEY, JSON.stringify(next));
  } catch {
    // The write failed (quota, blocked storage): an older list left behind
    // would bring back a discarded draft and miss a newer one on reload, so
    // leave nothing. The drafts still live for this page's life.
    try {
      window.sessionStorage.removeItem(HELD_HOME_DRAFTS_KEY);
    } catch {
      // Storage is unreachable altogether; nothing stale can be read back.
    }
  }
}
let heldHomeDrafts: readonly string[] = readStoredHeldDrafts();
const heldHomeDraftListeners = new Set<() => void>();
function setHeldHomeDrafts(next: readonly string[]) {
  heldHomeDrafts = next;
  writeStoredHeldDrafts(next);
  for (const listener of heldHomeDraftListeners) listener();
}
function holdHomeDraft(text: string) {
  if (!text.trim() || heldHomeDrafts.includes(text)) return;
  setHeldHomeDrafts([...heldHomeDrafts, text]);
}
function subscribeHeldHomeDrafts(listener: () => void) {
  heldHomeDraftListeners.add(listener);
  return () => {
    heldHomeDraftListeners.delete(listener);
  };
}
const heldHomeDraftsSnapshot = () => heldHomeDrafts;

/** Test seam: a fresh tab. */
export function resetHeldHomeDraftsForTests() {
  setHeldHomeDrafts([]);
}

/** Test seam: what a reload does, reading the drafts back from storage. */
export function reloadHeldHomeDraftsForTests() {
  heldHomeDrafts = readStoredHeldDrafts();
}

type ChipMenu = {
  kind: 'agents' | 'project' | 'model';
  trigger: HTMLElement | null;
  agentSlug?: string;
};

/**
 * Home's start: the same `StartComposer`, chips and memory as the dock's
 * draft (`NewChatModal`), over the same start context
 * (`useNewChatStartContext`, the dock's remembered project).
 *
 * Start hands the dock exactly what the chips show (context, Agent, Model
 * and runtime options) and the dock starts it through the same path its own
 * composer uses. Work that leaves the page is handed to the dock's composer
 * with the draft, because only the dock survives the page change and brings
 * the draft back: a setup journey, and visual skills (choosing one needs the
 * Registry). Enable needs no page change and runs here.
 *
 * With no Agent to offer at all (a fresh install), Start still goes: the
 * dock's automatic start prepares an engine, as Home's Start always did.
 */
export function HomeStartComposer({ compact = false }: { compact?: boolean }) {
  const agents = useAgents();
  const projectsQuery = useScopedProjectsQuery();
  const projects = projectsQuery.data ?? [];
  // Loaded means a real, successful list: the pending AND the errored shape
  // both read as `[]`, and an errored list must not resolve a bound project
  // to a guessed No project (`useProjects().isConfirmedLoaded`'s rule). A
  // failed read is said by the setup alert below.
  const projectsLoaded =
    projectsQuery.isSuccess &&
    !projectsQuery.isPlaceholderData &&
    projectsQuery.data !== undefined;
  // The chip IS the dock's binding (the project chip writes it), so Home and
  // the dock read one value; a folderless project runs in the home folder.
  const startContext = useNewChatStartContext(projects, projectsLoaded);
  const context = startContext ?? GLOBAL_CONTEXT;
  const contextPending = !startContext;
  const [agentSearch, setAgentSearch] = useState('');
  const selection = useNewChatSelectionModel({
    agents,
    projects,
    selectedContext: context,
    agentSearch,
    revalidateSelection: true,
  });
  const {
    viewModel,
    defaultSelection,
    acpConnections,
    runtimeLoading,
    modelsLoading,
    runtimeFetching,
    modelsFetching,
    setupFetching,
    setupError,
    refreshSetup,
    agentConnections,
    modelConnections,
    modelsForAgent,
    defaultEffectiveModelForAgent,
    selectedContextResolved,
  } = selection;
  const start = useStartSelection(selection, context);
  const bindProject = useBindStartProject();
  const [prompt, setPromptState] = useState('');
  // The field's current text, readable synchronously by a draft that comes
  // back while a dispatch is still running.
  const promptRef = useRef('');
  const setPrompt = (next: string | ((current: string) => string)): void => {
    // Written now, not in the updater: inside a dispatch React may defer the
    // updater, and a clearSent in the same tick must see a restored draft.
    if (typeof next === 'string') promptRef.current = next;
    setPromptState((current) => {
      const value = typeof next === 'function' ? next(current) : next;
      promptRef.current = value;
      return value;
    });
  };
  const held = useSyncExternalStore(
    subscribeHeldHomeDrafts,
    heldHomeDraftsSnapshot,
    heldHomeDraftsSnapshot,
  );
  const [heldAnnouncement, setHeldAnnouncement] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** What happened to a draft sent to the dock, in a sentence. */
  const [notice, setNotice] = useState<{
    text: string;
    tone: 'status' | 'alert';
  } | null>(null);
  // A draft that comes back goes into the field only while the field is
  // empty; otherwise it waits behind "Restore your earlier draft", so the
  // text being typed is never overwritten. On mount (a Home remounted after
  // setup left the page) an empty field takes the oldest one back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setPrompt only writes a stable state setter and a ref; the subscription is for the component's life.
  useEffect(() => {
    let heldCount = heldHomeDrafts.length;
    const restoreIfEmpty = () => {
      const grew = heldHomeDrafts.length > heldCount;
      heldCount = heldHomeDrafts.length;
      const [first, ...rest] = heldHomeDrafts;
      if (first === undefined) {
        setHeldAnnouncement('');
        return;
      }
      if (promptRef.current.trim()) {
        // The Earlier draft group appears while someone is typing: say so.
        if (grew)
          setHeldAnnouncement(
            'An earlier draft came back from the chat dock. Restore or discard it below the message.',
          );
        return;
      }
      setHeldHomeDrafts(rest);
      setPrompt(first);
      setNotice({
        text: 'Your draft is back from the chat dock.',
        tone: 'status',
      });
    };
    restoreIfEmpty();
    return subscribeHeldHomeDrafts(restoreIfEmpty);
  }, []);
  const [pending, setPending] = useState(false);
  const [menu, setMenu] = useState<ChipMenu | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const agent = start.agent;
  const enabler = useAgentEnable({
    scopedAgents: viewModel.scopedAgents ?? [],
    selectedProjectSlug: viewModel.selectedProject?.slug,
    isCurrent: () => mounted.current,
    onFeedback: setFeedback,
    refreshSetup,
    onReady: (ready, created) => {
      start.chooseAgent(ready.slug);
      setMenu(null);
      if (created) void refreshSetup().catch(() => undefined);
    },
  });

  /**
   * Empty the field of `sent` only if it still holds exactly that; then an
   * earlier draft waiting to come back takes the empty field.
   */
  const clearSent = (sent: string) => {
    if (promptRef.current !== sent) return;
    const [first, ...rest] = heldHomeDrafts;
    if (first === undefined) {
      setPrompt('');
      return;
    }
    setHeldHomeDrafts(rest);
    setPrompt(first);
    setNotice({
      text: 'Your draft is back from the chat dock.',
      tone: 'status',
    });
  };

  const noDock = () =>
    setNotice({
      text: 'No chat dock is open to take this. Open the chat dock and try again; your message is kept here.',
      tone: 'alert',
    });

  /**
   * Hand the draft to the dock's composer and let it finish there. Only a
   * dock that took it may empty this field; if the dock's draft is then
   * dismissed (closed, or its setup journey cancelled), the text comes back.
   */
  const handOff = (handoff: NewChatHandoff, agentSlug = agent?.slug) => {
    const target = agentSlug
      ? viewModel.flatList.find((candidate) => candidate.slug === agentSlug)
      : undefined;
    setMenu(null);
    const text = prompt;
    const accepted = dispatchNewChatIntent({
      initialPrompt: text,
      selection: start.startSelection(target ?? agent),
      handoff,
      // Dismissed: the dock's draft as it last read (edits included) comes
      // back; started: it lives in its chat now.
      onClosed: (outcome, dockDraft) => {
        if (outcome === 'dismissed') holdHomeDraft(dockDraft ?? text);
      },
    });
    if (!accepted) {
      noDock();
      return;
    }
    // Only the text that was sent leaves the field. An earlier draft that
    // came back during this dispatch (its dock draft dismissed by this one)
    // then takes the emptied field.
    clearSent(text);
    setNotice({
      text: 'Your draft moved to the chat dock to finish there.',
      tone: 'status',
    });
  };

  const repair = (target: typeof agent & object, route: AgentFixRoute) => {
    if (route === 'enable' && resolveNewChatAgentEnable(target)) {
      void enabler.enable(target);
      return;
    }
    handOff({ kind: 'repair', agentSlug: target.slug, route }, target.slug);
  };

  const loading =
    runtimeLoading ||
    modelsLoading ||
    contextPending ||
    !selectedContextResolved;
  const modelLabel = agent ? start.modelFor(agent).label : undefined;
  const agentChip: StartAgentChip = loading
    ? { status: 'loading' }
    : {
        status: 'ready',
        agent,
        modelLabel,
        needsSetup: agent ? !agentRunnability(agent).runnable : false,
      };
  // The sidebar's colours, from the one project list it shows.
  const accents = useProjectAccents();
  const icons = useProjectIcons();
  const option = viewModel.currentContextOption;
  const isGlobal = context === GLOBAL_CONTEXT;
  const workspaceHint = resolveNewChatWorkspaceHint({
    agent,
    project: viewModel.selectedProject,
    acpConnections,
  });
  const projectChip: StartProjectChip = contextPending
    ? { status: 'loading' }
    : {
        status: 'ready',
        // A project the list no longer has keeps its own name (its slug),
        // never a No project the start would not use.
        label: option?.label ?? (isGlobal ? NO_PROJECT_LABEL : context),
        isGlobal,
        accent: isGlobal ? undefined : accents.get(context),
        icon: isGlobal ? undefined : icons.get(context),
        folder: workspaceHintText(workspaceHint),
      };
  const noAgentToOffer = !agent && !defaultSelection?.missingPreferredAgentSlug;
  const canStart =
    Boolean(prompt.trim()) &&
    !loading &&
    !setupError &&
    !setupFetching &&
    !runtimeFetching &&
    !modelsFetching &&
    (agent ? agentRunnability(agent).runnable : noAgentToOffer);
  const chipMenuAgent =
    menu?.kind === 'model'
      ? (viewModel.flatList.find((entry) => entry.slug === menu.agentSlug) ??
        agent)
      : undefined;

  return (
    <>
      <StartComposer
        compact={compact}
        textareaRef={textareaRef}
        prompt={prompt}
        onPromptChange={(value) => {
          setPrompt(value);
          if (feedback && !pending) setFeedback(null);
          if (notice) setNotice(null);
        }}
        agent={agentChip}
        onOpenAgents={(trigger) => {
          setAgentSearch('');
          setMenu({ kind: 'agents', trigger });
        }}
        project={projectChip}
        onOpenProject={(trigger) => setMenu({ kind: 'project', trigger })}
        overflowActions={[
          {
            key: 'skills',
            label: 'Use a visual skill',
            haspopup: 'dialog',
            onSelect: () => handOff({ kind: 'skills' }),
          },
        ]}
        canStart={canStart}
        pending={pending}
        onStart={() => {
          if (inFlight.current) return;
          const sentText = prompt;
          const accepted = dispatchNewChatIntent({
            startWithDefault: true,
            initialPrompt: prompt,
            // No Agent to offer: the dock prepares one (first run).
            selection: agent
              ? start.startSelection()
              : { context: start.startSelection().context },
            onClosed: (outcome, dockDraft) => {
              inFlight.current = false;
              if (outcome === 'dismissed') {
                const returned = dockDraft ?? sentText;
                // The field moved on (or Home is gone): the dock's draft
                // waits behind Restore rather than being dropped.
                if (!mounted.current || promptRef.current !== sentText)
                  holdHomeDraft(returned);
                // Untouched here: the dock's edits replace what was sent.
                else if (returned.trim() && returned !== sentText)
                  setPrompt(returned);
              }
              if (!mounted.current) return;
              setPending(false);
              // Started: the message is in its chat now, so the text that was
              // sent leaves the field (anything else there stays).
              if (outcome === 'started') clearSent(sentText);
            },
          });
          if (!accepted) {
            noDock();
            return;
          }
          inFlight.current = true;
          setPending(true);
          setNotice(null);
        }}
      >
        {defaultSelection?.missingPreferredAgentSlug && !agent && (
          <p role="alert">
            Your previous Agent is no longer available in this workspace. Choose
            an Agent to continue.
          </p>
        )}
        {notice && <p role={notice.tone}>{notice.text}</p>}
        <p className="sr-only" aria-live="polite">
          {held.length > 0 ? heldAnnouncement : ''}
        </p>
        {held.length > 0 && (
          <fieldset className="start-composer__held" aria-label="Earlier draft">
            <p className="start-composer__note">
              Earlier draft: “
              {held[0].length > 60 ? `${held[0].slice(0, 60)}…` : held[0]}”
            </p>
            <div className="start-composer__held-actions">
              <Button
                variant="secondary"
                onClick={() => {
                  // A swap, never a loss: the field's text waits in its place.
                  const [first, ...rest] = heldHomeDrafts;
                  if (first === undefined) return;
                  const current = promptRef.current;
                  const next = current.trim() ? [current, ...rest] : rest;
                  setHeldHomeDrafts(next);
                  setPrompt(first);
                  // The group (and this button) goes away: keep focus.
                  if (next.length === 0) textareaRef.current?.focus();
                }}
              >
                Restore your earlier draft
              </Button>
              <Button
                variant="link"
                onClick={() => {
                  const next = heldHomeDrafts.slice(1);
                  setHeldHomeDrafts(next);
                  if (next.length === 0) textareaRef.current?.focus();
                }}
              >
                Discard it
              </Button>
            </div>
          </fieldset>
        )}
        {(feedback || setupError) && (
          <p role="alert">{feedback ?? describeReadFailure(setupError)}</p>
        )}
        {!loading && agent && !agentRunnability(agent).runnable && (
          <React.Suspense
            fallback={<SkeletonList count={1} label="Loading setup options" />}
          >
            <HomeChatSetupHelper
              agents={[agent]}
              connections={agentConnections}
              busy={enabler.inFlight || setupFetching}
              onRepair={repair}
              onSetup={(target) =>
                target
                  ? handOff(
                      {
                        kind: 'repair',
                        agentSlug: target.slug,
                        route: 'engines',
                      },
                      target.slug,
                    )
                  : handOff({ kind: 'connections' })
              }
              onModels={() =>
                handOff({
                  kind: 'repair',
                  agentSlug: agent.slug,
                  route: 'models',
                })
              }
              onCheck={() =>
                void refreshSetup().catch((error) =>
                  setFeedback(userFacingErrorMessage(error)),
                )
              }
            />
          </React.Suspense>
        )}
      </StartComposer>
      {menu && (
        <React.Suspense fallback={null}>
          {menu.kind === 'agents' ? (
            <StartAgentMenu
              anchor={menu.trigger}
              layer="popover"
              groups={viewModel.groups}
              flatList={viewModel.flatList}
              selectedSlug={agent?.slug}
              loading={runtimeLoading || modelsLoading}
              error={setupError}
              onRetry={() => void refreshSetup().catch(() => undefined)}
              onSetUpConnections={() => handOff({ kind: 'connections' })}
              modelLabelFor={(entry) => start.modelFor(entry).label}
              modelUnavailableFor={(entry) =>
                modelsForAgent(entry).length === 0 && !modelsLoading
              }
              // The Agent list closes for the Model picker, so the picker
              // anchors to (and returns focus to) the Agent chip.
              onOpenModel={(entry) =>
                setMenu({
                  kind: 'model',
                  trigger: menu.trigger,
                  agentSlug: entry.slug,
                })
              }
              onChoose={(entry) => {
                start.chooseAgent(entry.slug);
                setFeedback(null);
                setAgentSearch('');
                setMenu(null);
              }}
              onFix={repair}
              fixDisabledFor={(entry) =>
                agentFixRoute(entry) === 'enable' &&
                resolveNewChatAgentEnable(entry)
                  ? enabler.inFlight
                  : undefined
              }
              search={agentSearch}
              onSearch={setAgentSearch}
              notice={viewModel.compatibilityMessage}
              onClose={() => {
                setAgentSearch('');
                setMenu(null);
              }}
            />
          ) : menu.kind === 'project' ? (
            <StartProjectMenu
              anchor={menu.trigger}
              layer="popover"
              options={viewModel.contextOptions}
              selectedContext={context}
              workspaceHint={workspaceHint}
              icons={icons}
              accents={accents}
              folderlessHint={resolveNewChatWorkspaceHint({
                agent,
                project: undefined,
                acpConnections,
              })}
              onChoose={(value) => {
                bindProject(value);
                setMenu(null);
              }}
              onClose={() => setMenu(null)}
            />
          ) : chipMenuAgent ? (
            <StartModelPicker
              anchor={menu.trigger}
              layer="popover"
              models={modelsForAgent(chipMenuAgent)}
              loading={modelsLoading}
              modelConnections={modelConnections}
              choice={start.modelChoiceFor(chipMenuAgent)}
              defaultModel={defaultEffectiveModelForAgent(chipMenuAgent)}
              onSelect={(model) => start.chooseModel(chipMenuAgent, model)}
              onReset={() => start.resetModel(chipMenuAgent)}
              onRuntimeOptionChange={(key, value) =>
                start.setRuntimeOption(chipMenuAgent, key, value)
              }
              onClose={() => setMenu(null)}
            />
          ) : null}
        </React.Suspense>
      )}
    </>
  );
}
