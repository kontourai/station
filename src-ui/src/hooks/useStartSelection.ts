import { useCallback, useState } from 'react';
import { GLOBAL_CONTEXT } from '../components/modals/new-chat-modal-utils';
import type { AgentData } from '../contexts/AgentsContext';
import { useAuthorityPersistence } from '../contexts/AuthorityPersistenceContext';
import { useDeviceSettingsActions } from '../contexts/DeviceSettingsContext';
import type { NewChatStartSelection } from '../lib/newChatIntent';
import type {
  NewChatModelChoice,
  SelectableModel,
} from '../utils/modelCapabilities';
import { sanitizeRuntimeOptionsForModel } from '../utils/modelCapabilities';
import {
  buildLastChosenModelBindingKey,
  clearLastChosenModel,
  trackLastChosenModel,
} from './lastChosenModel';
import type { useNewChatSelectionModel } from './useNewChatSelectionModel';
import { trackContextAgent } from './useRecentAgents';

type SelectionModel = ReturnType<typeof useNewChatSelectionModel>;

/**
 * What the start composer's chips choose, on Home and in the dock's draft
 * alike. Both surfaces call this over their own `useNewChatSelectionModel`,
 * so a chip means the same thing on either and a choice is remembered the
 * same way:
 *
 * - **Agent**: shown at once (a per-context choice held here, so it shows
 *   even while access is unverified and memory is a no-op) and remembered
 *   with `trackContextAgent`, which `useContextAgent` reads live. The next
 *   start in this context, on either surface, opens on it.
 * - **Model**: held as this start's choice (provider and runtime options
 *   included) and its id remembered with `trackLastChosenModel`, the memory
 *   an accepted turn writes; Reset forgets it. Runtime options are this
 *   start's only: the memory has no field for them.
 *
 * The project is the context itself; `useBindStartProject` remembers it.
 */
export function useStartSelection(selection: SelectionModel, context: string) {
  const { namespace } = useAuthorityPersistence();
  const [chosen, setChosen] = useState<{
    context: string;
    slug: string;
  } | null>(null);
  const {
    viewModel,
    defaultSelection,
    modelChoices,
    setModelChoices,
    modelChoiceKey,
    defaultEffectiveModelForAgent,
    modelsForAgent,
  } = selection;
  const flatList = viewModel.flatList;
  const scopedAgents = viewModel.scopedAgents ?? [];
  const chosenSlug = chosen?.context === context ? chosen.slug : undefined;
  // A remembered Agent that needs setup is still the one shown: the composer
  // offers its repair rather than quietly starting another (the dock draft's
  // rule, now both surfaces').
  const agent: AgentData | undefined = chosenSlug
    ? (scopedAgents.find((candidate) => candidate.slug === chosenSlug) ??
      flatList.find((candidate) => candidate.slug === chosenSlug))
    : defaultSelection?.missingPreferredAgentSlug
      ? undefined
      : (defaultSelection?.preferredAgent ?? defaultSelection?.agent);

  const chooseAgent = useCallback(
    (slug: string) => {
      setChosen({ context, slug });
      try {
        trackContextAgent(namespace, context, slug);
      } catch {
        /* Choice memory must not block choosing. */
      }
    },
    [context, namespace],
  );

  const modelChoiceFor = (target: AgentData) =>
    modelChoices[modelChoiceKey(target)];

  const modelFor = (target: AgentData) => {
    const choice = modelChoiceFor(target);
    const effective = defaultEffectiveModelForAgent(target);
    const selected = choice?.modelId
      ? modelsForAgent(target).find(
          (model) =>
            model.id === choice.modelId &&
            (!choice.providerId || model.providerId === choice.providerId),
        )
      : undefined;
    return {
      id: choice?.modelId ?? effective.id ?? undefined,
      label: choice?.modelId
        ? (selected?.name ?? choice.modelId)
        : effective.label,
      source: choice?.modelId
        ? ('session override' as const)
        : effective.source,
    };
  };

  const updateModelChoice = (
    target: AgentData,
    update: (current: NewChatModelChoice) => NewChatModelChoice,
  ) => {
    const key = modelChoiceKey(target);
    setModelChoices((current) => ({
      ...current,
      [key]: update(current[key] ?? { providerOptions: {} }),
    }));
  };

  const chooseModel = (target: AgentData, model: SelectableModel) => {
    updateModelChoice(target, (current) => ({
      ...current,
      modelId: model.id,
      providerId: model.providerId,
      providerType: model.providerType,
      providerOptions: sanitizeRuntimeOptionsForModel(
        model,
        current.providerOptions,
      ),
    }));
    trackLastChosenModel(buildLastChosenModelBindingKey(target), model.id);
    // A Model picked on an Agent's row means that Agent.
    chooseAgent(target.slug);
  };

  const resetModel = (target: AgentData) => {
    const key = modelChoiceKey(target);
    setModelChoices((current) => {
      const { [key]: _removed, ...rest } = current;
      return rest;
    });
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
    resetModel,
    setRuntimeOption,
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
