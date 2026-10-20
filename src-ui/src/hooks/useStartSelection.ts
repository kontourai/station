import { useCallback, useSyncExternalStore } from 'react';
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
const startChoices = {
  agents: new Map<string, string>(),
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
 *   the selection model's default. Choosing also remembers it.
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
  const chosenSlug = startChoices.agents.get(agentKey) ?? remembered;
  // A chosen or remembered Agent that needs setup is still the one shown:
  // the composer offers its repair rather than quietly starting another
  // (the dock draft's rule, now both surfaces'). Searched by scope, not by
  // the Agent list's search box, so typing a search never empties the chip.
  // One the scope no longer has is not shown.
  const agent: AgentData | undefined = chosenSlug
    ? (scopedAgents.find((candidate) => candidate.slug === chosenSlug) ??
      flatList.find((candidate) => candidate.slug === chosenSlug))
    : defaultSelection?.missingPreferredAgentSlug
      ? undefined
      : (defaultSelection?.preferredAgent ?? defaultSelection?.agent);

  const chooseAgent = useCallback(
    (slug: string) => {
      changeStartChoices(() => startChoices.agents.set(agentKey, slug));
      try {
        trackContextAgent(namespace, context, slug);
      } catch {
        /* Choice memory must not block choosing. */
      }
    },
    [agentKey, context, namespace],
  );

  const modelKey = (target: AgentData) =>
    JSON.stringify([namespace, modelChoiceKey(target)]);
  const modelChoiceFor = (target: AgentData) =>
    startChoices.models.get(modelKey(target));

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
      providerOptions: { ...current.providerOptions, [key]: value },
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
