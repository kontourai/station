import type { AgentData } from '../../contexts/AgentsContext';
import type { useNewChatSelectionModel } from '../../hooks/useNewChatSelectionModel';
import type { useStartSelection } from '../../hooks/useStartSelection';
import type { AgentFixRoute } from '../AgentReadinessCell';
import { agentFixRoute } from '../AgentReadinessCell';
import {
  resolveNewChatAgentEnable,
  resolveNewChatWorkspaceHint,
} from '../modals/new-chat-modal-utils';
import {
  StartAgentMenu,
  StartModelPicker,
  StartProjectMenu,
} from './StartMenus';

export type StartPickerMenu = {
  kind: 'agents' | 'project' | 'model';
  trigger: HTMLElement | null;
  agentSlug?: string;
};

export function StartPickerMenus({
  menu,
  setMenu,
  layer,
  selection,
  start,
  context,
  search,
  onSearch,
  onFeedbackClear,
  onSetup,
  onRepair,
  enablePending,
  interactionDisabled,
  onChooseProject,
  icons,
  accents,
}: {
  menu: StartPickerMenu;
  setMenu: (menu: StartPickerMenu | null) => void;
  layer: 'popover' | 'dialog';
  selection: ReturnType<typeof useNewChatSelectionModel>;
  start: ReturnType<typeof useStartSelection>;
  context: string;
  search: string;
  onSearch: (search: string) => void;
  onFeedbackClear: () => void;
  onSetup: () => void;
  onRepair: (agent: AgentData, route: AgentFixRoute) => void;
  enablePending: boolean;
  interactionDisabled?: boolean;
  onChooseProject: (context: string) => void;
  icons: ReadonlyMap<string, string>;
  accents: ReadonlyMap<string, string>;
}) {
  const {
    viewModel,
    modelsLoading,
    runtimeLoading,
    setupError,
    refreshSetup,
    modelsForAgent,
    executionModelsForAgent,
    defaultEffectiveModelForAgent,
    modelConnections,
    acpConnections,
  } = selection;
  const close = () => {
    onSearch('');
    setMenu(null);
  };
  if (menu.kind === 'agents')
    return (
      <StartAgentMenu
        anchor={menu.trigger}
        layer={layer}
        groups={viewModel.groups}
        flatList={viewModel.flatList}
        selectedSlug={start.agent?.slug}
        loading={runtimeLoading || modelsLoading}
        error={setupError}
        onRetry={() => void refreshSetup().catch(() => undefined)}
        onSetUpConnections={onSetup}
        modelLabelFor={(agent) => start.modelFor(agent).label}
        modelUnavailableFor={(agent) =>
          modelsForAgent(agent).length === 0 && !modelsLoading
        }
        onOpenModel={(agent) =>
          setMenu({
            kind: 'model',
            trigger: menu.trigger,
            agentSlug: agent.slug,
          })
        }
        onChoose={(agent) => {
          start.chooseAgent(agent.slug);
          onFeedbackClear();
          close();
        }}
        onFix={onRepair}
        fixDisabledFor={(agent) =>
          agentFixRoute(agent) === 'enable' && resolveNewChatAgentEnable(agent)
            ? enablePending
            : undefined
        }
        interactionDisabled={interactionDisabled}
        search={search}
        onSearch={onSearch}
        notice={viewModel.compatibilityMessage}
        onClose={close}
      />
    );
  const workspaceHint = resolveNewChatWorkspaceHint({
    agent: start.agent,
    project: viewModel.selectedProject,
    acpConnections,
  });
  if (menu.kind === 'project')
    return (
      <StartProjectMenu
        anchor={menu.trigger}
        layer={layer}
        options={viewModel.contextOptions}
        selectedContext={context}
        workspaceHint={workspaceHint}
        folderlessHint={resolveNewChatWorkspaceHint({
          agent: start.agent,
          project: undefined,
          acpConnections,
        })}
        icons={icons}
        accents={accents}
        onChoose={(value) => {
          onChooseProject(value);
          close();
        }}
        onClose={close}
      />
    );
  const agent = viewModel.scopedAgents.find(
    (entry) => entry.slug === menu.agentSlug,
  );
  if (!agent) return null;
  return (
    <StartModelPicker
      profile={agent}
      onEnvironmentChange={(environmentId) =>
        start.setExecutionEnvironment(agent, environmentId)
      }
      anchor={menu.trigger}
      layer={layer}
      models={executionModelsForAgent(agent)}
      loading={modelsLoading}
      modelConnections={modelConnections}
      choice={start.modelChoiceFor(agent)}
      defaultModel={defaultEffectiveModelForAgent(agent)}
      onSelect={(model) => start.chooseModel(agent, model)}
      onReset={() => start.resetModel(agent)}
      onRuntimeOptionChange={(key, value) =>
        start.setRuntimeOption(agent, key, value)
      }
      onClose={close}
    />
  );
}
