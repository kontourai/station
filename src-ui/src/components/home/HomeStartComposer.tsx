import React, { useEffect, useRef, useState } from 'react';
import { useAgents } from '../../contexts/AgentsContext';
import { useScopedProjectsQuery } from '../../contexts/ProjectsContext';
import { useDevicePresentation } from '../../hooks/useDevicePresentation';
import { useNewChatSelectionModel } from '../../hooks/useNewChatSelectionModel';
import { useNewChatStartContext } from '../../hooks/useNewChatStartContext';
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
} from '../modals/new-chat-modal-utils';
import { projectAccents } from '../project-sidebar/projectAccent';
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
 * A draft Home handed to the dock that came back undone (its dock draft was
 * closed, or the setup journey cancelled). Held at module scope because the
 * setup journey leaves the page, so the Home that sent it may have unmounted.
 */
let returnedHomeDraft: string | null = null;
const returnedHomeDraftListeners = new Set<() => void>();
function returnHomeDraft(text: string) {
  returnedHomeDraft = text;
  for (const listener of returnedHomeDraftListeners) listener();
}
function takeReturnedHomeDraft(): string | null {
  const text = returnedHomeDraft;
  returnedHomeDraft = null;
  return text;
}
function subscribeReturnedHomeDraft(listener: () => void) {
  returnedHomeDraftListeners.add(listener);
  return () => {
    returnedHomeDraftListeners.delete(listener);
  };
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
  // the dock read one value; folderless projects cannot be chosen.
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
  const [prompt, setPrompt] = useState('');
  /** What happened to a draft sent to the dock, in a sentence. */
  const [notice, setNotice] = useState<{
    text: string;
    tone: 'status' | 'alert';
  } | null>(null);
  // A draft handed to the dock and then dismissed there comes back here,
  // including to a Home that was remounted meanwhile (setup leaves the page).
  useEffect(() => {
    const take = () => {
      const text = takeReturnedHomeDraft();
      if (text === null) return;
      setPrompt(text);
      setNotice({
        text: 'Your draft is back from the chat dock.',
        tone: 'status',
      });
    };
    take();
    return subscribeReturnedHomeDraft(take);
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
      onClosed: (outcome) => {
        if (outcome === 'dismissed' && text.trim()) returnHomeDraft(text);
      },
    });
    if (!accepted) {
      noDock();
      return;
    }
    setPrompt('');
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
  // TODO(useProjectAccents): the sibling lane adds a shared hook; until then
  // the same set the sidebar colours (`useProjects`, this same query).
  const accents = projectAccents(projects.map((project) => project.slug));
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
        folder: workspaceHint.kind === 'home' ? '~' : workspaceHint.path,
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
          const accepted = dispatchNewChatIntent({
            startWithDefault: true,
            initialPrompt: prompt,
            // No Agent to offer: the dock prepares one (first run).
            selection: agent
              ? start.startSelection()
              : { context: start.startSelection().context },
            onClosed: (outcome) => {
              inFlight.current = false;
              if (!mounted.current) return;
              setPending(false);
              // Started: the message is in its chat now. Dismissed: it stays.
              if (outcome === 'started') setPrompt('');
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
              defaultSourceLabel={start.modelFor(chipMenuAgent).source}
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
