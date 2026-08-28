import { requiresAuthoredAgentPrompt } from '@kontourai/station-contracts/agent-validation';
import { resolveEngineCapabilityMatrix } from '@kontourai/station-contracts/engine-capability-matrix';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import {
  isAgentToolsActivatingError,
  useAgentConnectionsQuery,
  useAgentQuery,
  useAgentToolsQuery,
  useIntegrationsQuery,
  useMaterializeEngineAgentMutation,
  useModelConnectionsQuery,
  useProjectsQuery,
  useSkillsQuery,
} from '@kontourai/station-sdk';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { AgentFixRoute } from '../../components/AgentReadinessCell';
import {
  type AgentRunnability,
  agentRunnability,
} from '../../components/agent-runnability';
import {
  type AgentData,
  useAgentActions,
  useAgentCatalogReconciling,
  useAgents,
} from '../../contexts/AgentsContext';
import { useConfig } from '../../contexts/ConfigContext';
import { navigationStore } from '../../contexts/navigation-store';
import { useAIEnrich } from '../../hooks/useAIEnrich';
import { useDegradedQueryState } from '../../hooks/useDegradedQueryState';
import { useDevicePresentation } from '../../hooks/useDevicePresentation';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { useUrlSelection } from '../../hooks/useUrlSelection';
import type { NavigationView, Tool } from '../../types';
import {
  defaultSelectableManagedRuntimeConnection,
  isAgentConnectionSelectable,
} from '../../utils/execution';
import type { EngineKind } from './AgentEditorEngineSelection';
import { resolveAgentEditorReadState } from './agentEditorReadState';
import {
  buildAgentsViewEmptyContent,
  buildAgentsViewItems,
} from './agentsViewHelpers';
import {
  buildAgentPayload,
  cloneableAgentFields,
  createEmptyAgentForm,
  createEngineIsReady,
  createIsBlocked,
  createNewAgentForm,
  formFromAgent,
  groupAgentToolsByServer,
  isAgentFormDirty,
  resolveStationModelBinding,
  validateAgentForm,
} from './agentsViewUtils';
import type { AgentFormData } from './types';

interface UseAgentsViewModelArgs {
  agents: AgentData[];
  onNavigate: (view: NavigationView) => void;
}

/**
 * One route table for the row's single fixing verb, shared by the list, the
 * copy picker and anything else that offers the repair — the label and the
 * destination must not be decided in two places.
 */
function navigateFix(route: AgentFixRoute) {
  if (route === 'models') {
    navigationStore.navigate('/connections?section=models');
    return;
  }
  if (route === 'engines') {
    navigationStore.navigate('/connections?section=engines');
    return;
  }
  navigationStore.navigate('/connections');
}

export function useAgentsViewModel({
  agents,
  onNavigate,
}: UseAgentsViewModelArgs) {
  const liveAgents = useAgents();
/**
* archive#3751: whether the readiness words on these rows describe the
* runtime as it is NOW. `/api/agents` serves the last stable catalog while
* the runtime is mid-reconciliation and says so (`catalogState`), which the
* SDK used to drop.
*/
  const readinessKnown = useAgentCatalogReconciling() !== true;
  const appConfig = useConfig();
  const { createAgent, updateAgent, deleteAgent } = useAgentActions();
  const { enrich, isEnriching } = useAIEnrich();
  const {
    selectedId: urlSlug,
    select: urlSelect,
    deselect: urlDeselect,
  } = useUrlSelection('/agents');

  const selectedSlug = urlSlug === 'new' ? null : urlSlug;
  const selectedAgentSlug = selectedSlug ?? undefined;
  const [isCreating, setIsCreating] = useState(urlSlug === 'new');
/**
 * DESIGN.md §4 — creation is a two-beat flow: choose a starting point, then
* fill the form it prepared. `startingPointChosen` is beat two, and
* `copyPicking` is the "Copy an existing agent" detour between them.
*/
  const [startingPointChosen, setStartingPointChosen] = useState(false);
  const [copyPicking, setCopyPicking] = useState(false);
/**
 * §4's "one-line success notice" lives in the URL, not in state. Navigating
* from `/agents/new` to `/agents/<slug>` re-mounts this hook, so a
* `useState` notice was set and then discarded before it could render
* (`notice: false` in this lane's live capture, on a create that otherwise
* worked end to end). `?created=1` survives the remount and is cleared for
* free: `navigationStore` strips non-shell params on any route change, so
* selecting another agent drops it without anyone remembering to.
*/
  const createdParam =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('created') === '1';
/**
 * §3.2's engine question when the ANSWER is not derivable from the binding
* "an installed agent CLI" chosen with none named yet. `null` means
* "derive it", which is every persisted agent.
*/
  const [engineKindOverride, setEngineKindOverride] =
    useState<EngineKind | null>(null);
/** A created Agent waiting for the form to read clean before we open it. */
  const [pendingCreatedSlug, setPendingCreatedSlug] = useState<string | null>(
    null,
  );
  const [search, setSearch] = useState('');
  const { data: agentConnections = [] } = useAgentConnectionsQuery() as {
    data?: ConnectionConfig[];
  };
  const { data: modelConnections = [] } = useModelConnectionsQuery() as {
    data?: ConnectionConfig[];
  };
// Do not bind a fresh agent to a managed engine that is merely present.
// Backend readiness includes provider prerequisites such as Bedrock
// credentials and configuration.
  const defaultManagedRuntimeId =
    defaultSelectableManagedRuntimeConnection(agentConnections)?.id ?? '';
  const [form, setForm] = useState<AgentFormData>(() =>
    createEmptyAgentForm(defaultManagedRuntimeId),
  );
  const [savedForm, setSavedForm] = useState<AgentFormData>(() =>
    createEmptyAgentForm(defaultManagedRuntimeId),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isLocked, setIsLocked] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});
  const previousUrlSlugRef = useRef(urlSlug);
  const createNavigationRef = useRef(false);

  const { data: availableTools = [] } = useIntegrationsQuery() as {
    data?: Tool[];
  };
  const { data: availableSkills = [] } = useSkillsQuery() as {
    data?: any[];
  };
  const {
    data: loadedAgent,
    isLoading,
    isFetching,
    error: loadError,
    refetch: refetchAgent,
  } = useAgentQuery(selectedAgentSlug, {
    enabled: !!selectedAgentSlug && !isCreating,
  });
  const selectedCatalogAgent = agents.find(
    (agent) => agent.slug === selectedAgentSlug,
  );
  const exposesStationTools =
    selectedCatalogAgent?.engineId === 'station' ||
    !selectedCatalogAgent?.execution?.agentConnectionId;
 // a create now returns as soon as its write is durable, so the first
// tools read after one legitimately lands while the Agent is still
// activating. The SDK retries that case (and only that case) inside a
// bounded window; this exposes the two outcomes the pane has to tell apart —
// still activating, or activation is not coming.
  const {
    data: agentTools = [],
    isError: agentToolsFailed,
    error: agentToolsError,
    failureReason: agentToolsFailureReason,
    refetch: refetchAgentTools,
  } = useAgentToolsQuery(selectedAgentSlug, {
    enabled: !!selectedAgentSlug && !isCreating && exposesStationTools,
  }) as {
    data?: Tool[];
    isError?: boolean;
    error?: unknown;
/**
* The last attempt's error WHILE the query is still retrying. `error`
* stays null until the retries are spent, so this is the only signal that
* distinguishes "still becoming available" from "it never arrived".
*/
    failureReason?: unknown;
    refetch?: () => unknown;
  };
  const toolsActivating =
    !agentToolsFailed && isAgentToolsActivatingError(agentToolsFailureReason);
  const toolsActivationTimedOut =
    !!agentToolsFailed && isAgentToolsActivatingError(agentToolsError);
  const [integrationTools, setIntegrationTools] = useState<
    Record<string, Tool[]>
  >({});

  const allAgents = liveAgents.length > 0 ? liveAgents : agents;
  const filteredAgents = useMemo(() => {
    const q = search.toLowerCase();
    return allAgents.filter(
      (agent) =>
        !q ||
        agent.name.toLowerCase().includes(q) ||
        agent.slug.toLowerCase().includes(q),
    );
  }, [allAgents, search]);

  const { data: knownProjects = [] } = useProjectsQuery() as {
    data?: Array<{ slug: string }>;
  };
// archive#3843: the rail's one fixing verb names the machine an engine would be
// set up on. Read from the same status query the rest of the app uses.
  const devicePresentation = useDevicePresentation();
  const knownProjectSlugs = useMemo(
    () => new Set(knownProjects.map((project) => project.slug)),
    [knownProjects],
  );
  const listItems = useMemo(
    () =>
      buildAgentsViewItems(
        filteredAgents,
        [],
        knownProjectSlugs,
        {
          onChat: (agent) =>
            window.dispatchEvent(
              new CustomEvent('station:open-new-chat', {
                detail: { agentSlug: agent.slug },
              }),
            ),
          onFix: (_agent, route) => navigateFix(route),
        },
        { readinessKnown, devicePresentation },
      ),
    [devicePresentation, filteredAgents, knownProjectSlugs, readinessKnown],
  );

/*
 * DESIGN.md §2's empty state is about having no AGENTS, and this slot is the
* detail pane with nothing selected. Rendering it unconditionally printed
* "No agents of your own yet" beside a rail listing four, so
* it renders only when the claim is true; otherwise SplitPaneLayout's own
* "Select an agent to edit" stands.
*/
  const authoredAgents = allAgents.filter((agent) => !agent.engineDefault);
  const emptyContent =
    authoredAgents.length === 0
      ? buildAgentsViewEmptyContent({
          agentsCount: authoredAgents.length,
          onCreateBlank: () => {
            handleNew();
          },
        })
      : undefined;

// The selection is URL-driven, so browser navigation must restore the
// editor state as well as its mode. Entering /agents/new outside handleNew
// (for example via browser Back) must not retain the previously selected
// agent's form. handleNew already supplies its intended form, including a
// selected template, so preserve that deliberate transition.
  useEffect(() => {
    if (previousUrlSlugRef.current === urlSlug) {
      return;
    }

    previousUrlSlugRef.current = urlSlug;
    if (urlSlug !== 'new') {
      setIsCreating(false);
      return;
    }

    setIsCreating(true);
    if (createNavigationRef.current) {
      createNavigationRef.current = false;
      return;
    }

    const base = createNewAgentForm(undefined, defaultManagedRuntimeId);
    setStartingPointChosen(false);
    setCopyPicking(false);
    setEngineKindOverride(null);
    setForm(base);
    setSavedForm(base);
    setActionError(null);
    setValidationErrors({});
  }, [defaultManagedRuntimeId, urlSlug]);

  useEffect(() => {
    if (!loadedAgent || isCreating) {
      return;
    }

    const nextForm = formFromAgent(loadedAgent);
    setForm(nextForm);
    setSavedForm(nextForm);
    setIsLocked(true);
  }, [loadedAgent, isCreating]);

// archive#3662: CREATE ONLY. A new Agent's form is built
// before the connections query resolves, so it legitimately picks up the
// managed runtime once it does. Applying the same fill to a LOADED Agent
// re-created the binding the heal had just removed — an absent binding on a
// persisted record is Station's own engine, not a form that has not loaded
// yet, and the two are indistinguishable from inside this effect.
  useEffect(() => {
    if (!isCreating || !defaultManagedRuntimeId) {
      return;
    }
    setForm((current) =>
      current.execution.agentConnectionId
        ? current
        : {
            ...current,
            execution: {
              ...current.execution,
              agentConnectionId: defaultManagedRuntimeId,
            },
          },
    );
    setSavedForm((current) =>
      current.execution.agentConnectionId
        ? current
        : {
            ...current,
            execution: {
              ...current.execution,
              agentConnectionId: defaultManagedRuntimeId,
            },
          },
    );
  }, [defaultManagedRuntimeId, isCreating]);

  useEffect(() => {
    setIntegrationTools(groupAgentToolsByServer(agentTools));
  }, [agentTools]);

/**
* Whether THIS engine delivers a system prompt of its own — the matrix
* answer `validateAgentForm` needs. Hoisted out of `validate` because the
* form has to say the field is required BEFORE the button is pressed
* (archive#3741), and the button has to be gated on the same answer.
*/
  const engineDeliversNativePrompt =
    resolveEngineCapabilityMatrix(
      form.execution.agentConnectionId,
      agentConnections.find(
        (connection) => connection.id === form.execution.agentConnectionId,
      ),
    ).systemPrompt.state === 'native';
/**
*.and whether this particular agent must author one. The reserved
* `station` Agent runs on Station's own prompt, so the same predicate the
* save applies is the one the asterisk reads.
*/
  const promptIsRequired = requiresAuthoredAgentPrompt(
    form.slug,
    engineDeliversNativePrompt,
  );

  const formErrors = validateAgentForm(form, isCreating, {
    requiresPrompt: engineDeliversNativePrompt,
  });

  const validate = (): boolean => {
 // DESIGN.md §4: engine readiness is NOT a post-submit validation any
// more. Create is disabled until an engine is chosen and that engine is
// Ready (`createEngineReady` below), with the fixing action shown inline
// beside the unready engine — so the state this error described can no
// longer be reached by pressing the button. Since archive#3741 the same
// holds for the required fields: Create is disabled while any of them is
// empty, so these messages are reachable only from Save on a loaded
// agent, never as the answer to pressing Create.
    setValidationErrors(formErrors);
    return Object.keys(formErrors).length === 0;
  };

  const dirty = isAgentFormDirty(form, savedForm);
  const { guard, DiscardModal } = useUnsavedGuard(dirty);

// See `handleSave`: navigate to the created Agent only once the guard has
// nothing to guard.
  useEffect(() => {
    if (!pendingCreatedSlug || dirty) return;
    setPendingCreatedSlug(null);
    navigationStore.navigate(
      `/agents/${encodeURIComponent(pendingCreatedSlug)}`,
      { created: '1' },
    );
  }, [dirty, pendingCreatedSlug]);

  function handleSelect(slug: string) {
    guard(() => {
      urlSelect(slug);
      setIsCreating(false);
      setEngineKindOverride(null);
      setActionError(null);
      setValidationErrors({});
    });
  }

  function handleNew(initialForm?: Partial<AgentFormData>) {
    guard(() => {
// When this action changes the URL, the URL effect must retain the form
// prepared below instead of replacing the starting point just chosen.
      createNavigationRef.current = urlSlug !== 'new';
      urlSelect('new');
      setIsCreating(true);
      setStartingPointChosen(false);
      setCopyPicking(false);
      setEngineKindOverride(null);
      const base = createNewAgentForm(initialForm, defaultManagedRuntimeId);
      setForm(base);
      setSavedForm(base);
      setActionError(null);
      setValidationErrors({});
    });
  }

 /** §4 "Chat with a model": Station's engine, Basics + §3.3 + Instructions. */
  function handleStartWithModel() {
    setEngineKindOverride('model');
    setForm((current) => ({
      ...current,
      execution: {
        ...current.execution,
        agentConnectionId: defaultManagedRuntimeId,
 // Deliberately unset: "use the app default", the §3.3 picker's own
// default option. This used to capture whichever connection was ready
// AT THIS INSTANT, which wrote an empty id whenever the connections
// query had not resolved yet and left Create permanently disabled
// beside a picker listing a Ready connection (archive#3743).
// `resolveStationModelBinding` reads the live list instead.
        modelConnectionId: '',
        runtimeOptions: {},
        modelOptions: {},
      },
    }));
    setStartingPointChosen(true);
  }

/**
 * §4 "Wrap an installed agent CLI": the CLI is chosen in §3.2's radio list,
* NOT here — binding the first enabled engine would create an agent on an
* engine nobody named, and Create is gated on the choice being made.
*/
  function handleStartWithCli() {
    setEngineKindOverride('cli');
    setForm((current) => ({
      ...current,
      execution: {
        ...current.execution,
        agentConnectionId: '',
        modelConnectionId: '',
        runtimeOptions: {},
        modelOptions: {},
      },
    }));
    setStartingPointChosen(true);
  }

 /** §4 "Copy an existing agent": every field, name "<original> copy". */
  function handleCopyAgent(source: AgentData) {
    const copied = cloneableAgentFields(source);
    const next: AgentFormData = {
      ...createEmptyAgentForm(defaultManagedRuntimeId),
      ...copied,
      name: `${source.name} copy`,
      slug: `${source.slug}-copy`,
    };
    setEngineKindOverride(null);
    setForm(next);
    setSavedForm(next);
    setCopyPicking(false);
    setStartingPointChosen(true);
  }

  function handleDuplicate(source: AgentData) {
    guard(() => {
      createNavigationRef.current = true;
      urlSelect('new');
      setIsCreating(true);
      setStartingPointChosen(true);
      setCopyPicking(false);
      handleCopyAgent(source);
    });
  }

  function handleDeselect() {
    urlDeselect();
    setIsCreating(false);
    setEngineKindOverride(null);
    setActionError(null);
  }

  async function handleSave() {
// Keyboard/form submission reaches this handler without consulting the
// disabled button. Do not create an Agent on an explicitly unready
// connection just because another connection happens to be ready.
    if (isCreating && !createEngineReady) return;
    if (!validate()) return;
    try {
      setIsSaving(true);
      setActionError(null);
      const savedSnapshot = structuredClone(form);
      const payload = buildAgentPayload(form, { isCreating });
      if (isCreating) {
// Select the slug the SERVER assigned, not the one typed into the
// form: the create response carries the persisted identity, and the
// mutation has already invalidated the agents query — so the list
// gains the row and this selects it, with no reload.
        const { data } = await createAgent(payload as any);
        const createdSlug = (data as { slug?: string })?.slug ?? form.slug;
        setSavedForm(savedSnapshot);
        setIsCreating(false);
 // §4: the editor opens on the new agent with one line saying so.

// NOT `urlSelect(createdSlug)` here. `useUnsavedGuard` has a live
// navigation guard registered for as long as the form reads dirty,
// and it is still dirty in THIS tick — `setSavedForm` has not
// rendered yet. `navigationStore.navigate` sees a guard, hands the
// navigation to the discard prompt, and returns: the write landed,
// the row appeared, and the app sat on `/agents/new` with the create
// form already torn down — a blank pane after a successful create.
// Caught live; the unit test could not see it because it does not
// mount the guard. The effect below navigates on the first render
// where the form is clean, so the guard has nothing to intercept.
        setPendingCreatedSlug(createdSlug);
      } else {
        await updateAgent(selectedSlug!, payload);
        setSavedForm(savedSnapshot);
      }
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    try {
      await deleteAgent(selectedSlug!);
      urlDeselect();
      setIsCreating(false);
    } catch (err: any) {
      setActionError(err.message);
    }
  }

  const selectedAgent = allAgents.find((agent) => agent.slug === selectedSlug);
  const isPlugin = !!selectedAgent?.plugin && !isCreating;
  const isAcp = selectedAgent?.engineConnectionType === 'acp';
 // (archive#3027 follow-up): `engineDefault` is NOT a lock any more.
// It used to be, and the result was a six-tab editor with every field
// disabled, a Delete that did nothing, and a Save styled as an active
// primary that could never save — for the only four agents a fresh install
// had. Engine agents are now materialized as ordinary files
// (`materializeEngineAgent`), so they are editable and deletable like any
// other Agent, and the Skills tab's `+ Add` (which keys off this same
// `locked`) is finally reachable on a fresh home.
//
// What remains: a PLUGIN-owned agent (unlockable, and it says so) and an
// ACP-connection-owned one (genuinely read-only — its configuration lives
// in the connection, and the pane renders the ownership sentence plus a
// "Configure in Connections" action rather than a dead primary).
  const locked = !!(isPlugin && isLocked) || !!isAcp;
// A failed initial read has no trustworthy entity to edit. A later refresh
// failure may retain a previously loaded entity, so keep that form visible
// with an honest banner instead of replacing in-progress edits.
  const { blockingLoadError, editorIsLoading, notFound, visibleRefreshError } =
    resolveAgentEditorReadState({
      hasLoadedAgent: !!loadedAgent,
      loadError,
      isLoading,
      isFetching,
      isCreating,
    });
// "Loading agent…" is BOUNDED. A detail read that never resolves used
// to leave that line on screen forever with nothing to press; past the
// shared degraded window it becomes the same load-failure state a real
// error produces, which at least offers Retry and Back.
  const [loadRetrySeq, bumpLoadRetry] = useReducer((n: number) => n + 1, 0);
  const detailReadState = useDegradedQueryState({
    isPending: editorIsLoading,
    resetKey: loadRetrySeq,
  });
  const detailReadStalled = detailReadState === 'degraded';
  const error = actionError ?? visibleRefreshError;
  const editorId = isCreating ? '__new__' : (selectedSlug ?? null);

 // one predicate, shared with the New Chat picker and Home's
// recommendation card. A row this pane calls Not set up is by construction
// the same row the picker calls Not set up.
// The runtime tried to activate this Agent and gave up, and said why. A
// different state from "still activating" and from a plain unavailable row:
// it has a cause and a retry, and the pane owes the user both.
  const activationFailure = !isCreating
    ? selectedAgent?.activationFailure
    : undefined;

  const selectedRunnability: AgentRunnability | undefined =
    !isCreating && selectedAgent ? agentRunnability(selectedAgent) : undefined;
// An engine identity with no file behind it has nothing to edit — the
// detail read 404s. Render its state and its ONE action instead of an
// "Agent not found" dead end.
  const selectedIsUnmaterializedEngine =
    !isCreating && selectedAgent?.engineDefault === true;
  const materializeEngineAgent = useMaterializeEngineAgentMutation();
  const [enableError, setEnableError] = useState<string | null>(null);

  async function handleEnableSelected() {
    const enable =
      selectedRunnability && !selectedRunnability.runnable
        ? selectedRunnability.enable
        : undefined;
    if (!enable) return;
    setEnableError(null);
    try {
      const { data } = await materializeEngineAgent.mutateAsync(
        enable.engineConnectionId,
      );
      const slug = (data as { slug?: string })?.slug;
      if (slug) urlSelect(slug);
    } catch (err: any) {
      setEnableError(err?.message ?? String(err));
    }
  }

/**
 * §3.2's engine answer. Derived from the binding for every persisted agent
* Station's own engine is an ABSENT binding, not a missing one — and
* taken from the explicit override only while creating, where "a CLI, not
* yet named" is a state the binding cannot represent.
*/
  const formBoundConnection = agentConnections.find(
    (connection) => connection.id === form.execution.agentConnectionId,
  );
  const stationModelBinding = resolveStationModelBinding({
    modelConnectionId: form.execution.modelConnectionId,
    modelConnections,
    appConfig,
  });
  const derivedEngineKind: EngineKind =
    resolveEngineCapabilityMatrix(
      form.execution.agentConnectionId,
      formBoundConnection,
    ).engineId === 'station'
      ? 'model'
      : 'cli';
  const engineKind: EngineKind = engineKindOverride ?? derivedEngineKind;

/**
 * DESIGN.md §4: Create is disabled until an engine is chosen AND that
* engine is Ready. Both halves are the SERVER's: a Station-engine agent
* needs a selectable managed runtime connection
* (`defaultSelectableManagedRuntimeConnection` reads `status`), a CLI agent
* needs its own chosen connection selectable. Nothing here re-derives
* readiness from anything the server did not compute.
*/
  const createEngineReady = createEngineIsReady({
    engineKind,
// Station's own engine runs on a MODEL connection — that, not the
// presence of a managed agent-runtime connection, is what decides whether
// it can answer. The first cut asked for the latter and disabled Create
// on a home with a perfectly ready model connection  It is
 // the same question §3.3's inline repair answers, and now literally the
 // same derivation: §3.3 renders `stationModelBinding.reason` when this is
// false, so the gate and the explanation beside it cannot disagree
// (archive#3743).
    stationEngineSelectable: stationModelBinding.kind === 'resolved',
    namedCliEngineSelectable: isAgentConnectionSelectable(formBoundConnection),
  });
/**
* archive#3741: Create refused with "System prompt is required" for a field
* the form never marked, on a section the person was not looking at. The
* field says it is required now, and pressing Create is not how you find
* out — the button is disabled while the form is incomplete, exactly as it
* already was for an unready engine.
*/
  const createBlocked = createIsBlocked({
    isCreating,
    engineReady: createEngineReady,
    formErrors,
  });

  function handleConfigureConnection() {
    const connectionId = selectedAgent?.execution?.agentConnectionId;
    if (!connectionId) return;
    navigationStore.navigate(
      `/connections/engines/${encodeURIComponent(connectionId)}`,
    );
  }

  return {
    DiscardModal,
 // the UNFILTERED collection — `listItems` is
// already search-narrowed — so a stale/typed query never gets blamed
// for an emptiness a genuinely-empty agent roster caused on its own.
    agentsCollectionEmpty: allAgents.length === 0,
    appConfig,
    availableSkills,
    availableTools,
    dirty,
    editorId,
    emptyContent,
    enrich,
    error,
    form,
    handleDelete,
    handleDeselect,
    handleNew,
    handleRetryLoad: () => {
      bumpLoadRetry();
      void refetchAgent();
    },
    handleSave,
    handleSelect,
    integrationTools,
    isAcp,
    isCreating,
    isEnriching,
    isLoading: editorIsLoading && !detailReadStalled,
    isLocked,
    isPlugin,
    isSaving,
    listItems,
    locked,
    loadError:
      blockingLoadError ??
      (detailReadStalled
        ? 'The request is taking longer than expected and has not returned yet.'
        : null),
    notFound: notFound && !selectedIsUnmaterializedEngine,
    enableError,
    enableInFlight: materializeEngineAgent.isPending,
    handleEnableSelected: () => void handleEnableSelected(),
    handleConfigureConnection,
    selectedRunnability,
    selectedIsUnmaterializedEngine,
    toolsActivating,
    toolsActivationTimedOut,
    activationFailure,
    onRetryActivation: () => {
      bumpLoadRetry();
      void refetchAgent();
      void refetchAgentTools?.();
    },
    onNavigate,
    search,
    selectedAgent,
    selectedSlug,
    setForm,
    setIsLocked,
    setSearch,
    setSavedForm,
    startingPointChosen,
    copyPicking,
    setCopyPicking,
    handleStartWithModel,
    handleStartWithCli,
    handleCopyAgent,
    handleDuplicate,
    handleFixAgent: (_agent: AgentData, route: AgentFixRoute) =>
      navigateFix(route),
    engineKind,
    setEngineKindOverride,
    createBlocked,
    promptIsRequired,
    createdNotice:
      createdParam && !isCreating && form.name ? `${form.name} created.` : null,
    stationConnectionId: defaultManagedRuntimeId,
    validationErrors,
  };
}
