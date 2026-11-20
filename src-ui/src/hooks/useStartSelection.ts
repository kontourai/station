import { useCallback, useSyncExternalStore } from 'react';
import { agentRunnability } from '../components/agent-runnability';
import { GLOBAL_CONTEXT } from '../components/modals/new-chat-modal-utils';
import type { AgentData } from '../contexts/AgentsContext';
import { useAuthorityPersistence } from '../contexts/AuthorityPersistenceContext';
import { useDeviceSettingsActions } from '../contexts/DeviceSettingsContext';
import type { NewChatStartSelection } from '../lib/newChatIntent';
import type {
  NewChatModelChoice,
  SelectableModel,
} from '../utils/modelCapabilities';
import {
  resolveModelChoice,
  sanitizeRuntimeOptionsForModel,
  updateModelRuntimeOption,
} from '../utils/modelCapabilities';
import {
  buildLastChosenModelBindingKey,
  clearLastChosenModel,
  trackLastChosenModel,
} from './lastChosenModel';
import type { useNewChatSelectionModel } from './useNewChatSelectionModel';
import { trackContextAgent, useContextAgent } from './useRecentAgents';

type SelectionModel = ReturnType<typeof useNewChatSelectionModel>;

/**
 * This tab's start choices, shared by every mounted composer: the Agent
 * chosen per context and the Model choice (provider and runtime options)
 * per context, binding and Agent. Home and the dock's draft read and write
 * the same entries, so a chip changed on either is the chip on both, and a
 * Reset on either is a Reset on both.
 *
 * Kept apart from the persisted memory on purpose. Memory (`trackContext
 * Agent`, `trackLastChosenModel`) is the default for the next session and
 * is also written by other chats' accepted turns; a choice the person made
 * in this tab outranks it until they change or reset it here. Memory stays
 * the source when nothing was chosen in this tab.
 */
type StartAgentChoice = {
  slug: string;
  /**
   * Picked as a step toward setup (or handed over with one), not picked to
   * start with: shown only once it can start.
   */
  untilReady?: boolean;
};
const startChoices = {
  agents: new Map<string, StartAgentChoice>(),
  models: new Map<string, NewChatModelChoice>(),
  version: 0,
};
const startChoiceListeners = new Set<() => void>();
function changeStartChoices(change: () => void) {
  change();
  startChoices.version += 1;
  for (const listener of startChoiceListeners) listener();
}
function subscribeStartChoices(listener: () => void) {
  startChoiceListeners.add(listener);
  return () => {
    startChoiceListeners.delete(listener);
  };
}
const startChoicesVersion = () => startChoices.version;

/** Test seam: a fresh tab. */
export function resetStartChoicesForTests() {
  changeStartChoices(() => {
    startChoices.agents.clear();
    startChoices.models.clear();
  });
}

/**
 * What the start composer's chips choose, on Home and in the dock's draft
 * alike. Both surfaces call this over their own `useNewChatSelectionModel`,
 * so a chip means the same thing on either:
 *
 * - **Agent**: this tab's choice for the context (shared, see
 *   `startChoices`), else the remembered one (`useContextAgent`, live), else
 *   the selection model's default. Only a pick from the Agent menu may be an
 *   Agent that cannot start; the remembered one and the default always can.
 *   Choosing an Agent that can start also remembers it.
 * - **Model**: this tab's choice for the Agent (provider and runtime
 *   options included), else the default, which already reads the
 *   remembered Model. Choosing remembers its id with `trackLastChosenModel`;
 *   Reset forgets both. Runtime options are not remembered across sessions:
 *   the memory has no field for them.
 *
 * The project is the context itself; `useBindStartProject` remembers it.
 */
export function useStartSelection(selection: SelectionModel, context: string) {
  const { namespace } = useAuthorityPersistence();
  useSyncExternalStore(
    subscribeStartChoices,
    startChoicesVersion,
    startChoicesVersion,
  );
  const {
    viewModel,
    defaultSelection,
    modelChoiceKey,
    defaultEffectiveModelForAgent,
    executionModelsForAgent,
  } = selection;
  const flatList = viewModel.flatList;
  const scopedAgents = viewModel.scopedAgents ?? [];
  const agentKey = JSON.stringify([namespace, context]);
  const remembered = useContextAgent(namespace, context);
  const tabChoice = startChoices.agents.get(agentKey);
  const modelKey = (target: AgentData) =>
    JSON.stringify([namespace, modelChoiceKey(target)]);
  const modelChoiceFor = (target: AgentData) =>
    startChoices.models.get(modelKey(target));
  const findAgent = (slug: string) =>
    scopedAgents.find((candidate) => candidate.slug === slug) ??
    flatList.find((candidate) => candidate.slug === slug);
  /** It runs, or this tab picked a Model that runs it through another engine. */
  const canStart = (target: AgentData) =>
    agentRunnability(target).runnable ||
    Boolean(modelChoiceFor(target)?.executionAgentId);
  // An Agent picked from the menu in this tab is shown even when it cannot
  // start here: the person can still run it on another Station or fix it.
  // Every other source (a choice made on the way to setup, the remembered
  // Agent, the default) yields only an Agent that can start, so a broken or
  // never-set-up Agent is never selected for the person. Searched by scope,
  // not by the Agent list's search box, so typing a search never empties the
  // chip.
  const picked = tabChoice ? findAgent(tabChoice.slug) : undefined;
  const rememberedAgent = remembered ? findAgent(remembered) : undefined;
  const agent: AgentData | undefined =
    picked && (!tabChoice?.untilReady || canStart(picked))
      ? picked
      : rememberedAgent && canStart(rememberedAgent)
        ? rememberedAgent
        : defaultSelection?.agent;

  // This tab keeps the choice, but only an Agent that can start becomes the
  // next session's default: opening setup and backing out must not leave a
  // broken Agent remembered.
  const chooseAgent = (slug: string, options?: { untilReady?: boolean }) => {
    changeStartChoices(() =>
      startChoices.agents.set(agentKey, {
        slug,
        ...(options?.untilReady ? { untilReady: true } : {}),
      }),
    );
    const target = findAgent(slug);
    if (!target || !canStart(target)) return;
    try {
      trackContextAgent(namespace, context, slug);
    } catch {
      /* Choice memory must not block choosing. */
    }
  };

  const modelFor = (target: AgentData) =>
    resolveModelChoice(
      modelChoiceFor(target),
      defaultEffectiveModelForAgent(target),
      executionModelsForAgent(target),
    );

  const updateModelChoice = (
    target: AgentData,
    update: (current: NewChatModelChoice) => NewChatModelChoice,
  ) => {
    const key = modelKey(target);
    changeStartChoices(() =>
      startChoices.models.set(
        key,
        update(startChoices.models.get(key) ?? { providerOptions: {} }),
      ),
    );
  };

  const chooseModel = (target: AgentData, model: SelectableModel) => {
    updateModelChoice(target, (current) => ({
      ...current,
      modelId: model.id,
      executionAgentId: model.executionAgentId,
      environmentId: model.environmentId,
      expectedDefinitionFingerprint: model.expectedDefinitionFingerprint,
      providerId: model.providerId,
      providerType: model.providerType,
      providerOptions: sanitizeRuntimeOptionsForModel(
        model,
        current.providerOptions,
      ),
    }));
    if (!model.executionAgentId)
      trackLastChosenModel(buildLastChosenModelBindingKey(target), model.id);
    // A Model picked on an Agent's row means that Agent.
    chooseAgent(target.slug);
  };

  /** A choice handed over from another surface, as it was made there. */
  const seedModelChoice = (target: AgentData, choice: NewChatModelChoice) =>
    updateModelChoice(target, () => choice);

  const setExecutionEnvironment = (target: AgentData, environmentId: string) =>
    updateModelChoice(target, () => ({ environmentId, providerOptions: {} }));

  const resetModel = (target: AgentData) => {
    const key = modelKey(target);
    changeStartChoices(() => startChoices.models.delete(key));
    clearLastChosenModel(buildLastChosenModelBindingKey(target));
  };

  const setRuntimeOption = (target: AgentData, key: string, value: unknown) =>
    updateModelChoice(target, (current) => ({
      ...current,
      providerOptions: updateModelRuntimeOption(
        current.providerOptions,
        key,
        value,
      ),
    }));

  /** The selection a start carries, exactly as the chips show it. */
  const startSelection = (
    target: AgentData | undefined = agent,
  ): NewChatStartSelection => ({
    context,
    ...(target ? { agentSlug: target.slug } : {}),
    ...(target && modelChoiceFor(target)
      ? { model: modelChoiceFor(target) }
      : {}),
  });

  return {
    agent,
    chooseAgent,
    modelFor,
    modelChoiceFor,
    chooseModel,
    seedModelChoice,
    resetModel,
    setRuntimeOption,
    setExecutionEnvironment,
    startSelection,
  };
}

/**
 * Remember the project chip: it rebinds the dock (`chatDockProjectSlug`),
 * the setting the dock's project switcher writes and that both surfaces'
 * start context (`resolveNewChatStartContext`) reads, so Home and the dock
 * always open on the same project.
 *
 * "No workspace" stores `null`, the binding's own "no project bound" value,
 * which the start context reads back as No workspace. A project with no
 * folder is bound like any other; the start context then reads it as No
 * workspace, exactly as it does for a binding the switcher made, because a
 * chat cannot run in a project without a folder by default
 * (`resolveNewChatInitialContext`). The draft that picked it still starts in
 * it, in the home folder, as the chip says.
 */
export function useBindStartProject(): (context: string) => void {
  const { setDeviceSetting } = useDeviceSettingsActions();
  return useCallback(
    (context: string) =>
      setDeviceSetting(
        'chatDockProjectSlug',
        context === GLOBAL_CONTEXT ? null : context,
      ),
    [setDeviceSetting],
  );
}
