import type { AgentData } from '../../contexts/AgentsContext';
import {
  effectiveExecutionStationId,
  useExecutionStations,
} from '../../hooks/useExecutionStationCatalog';
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
  StartStationMenu,
} from './StartMenus';

export type StartPickerMenu = {
  kind: 'agents' | 'project' | 'model' | 'station';
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
  if (menu.kind === 'station')
    return (
      <StationMenu
        anchor={menu.trigger}
        layer={layer}
        selectedId={effectiveExecutionStationId(
          start.modelChoiceFor(agent)?.environmentId,
          viewModel.selectedProject?.defaultEnvironment,
        )}
        projectSelected={Boolean(viewModel.selectedProject)}
        onChoose={(environmentId) => {
          start.setExecutionEnvironment(agent, environmentId);
          // Another Station runs its own engines: choosing one continues
          // straight to that Station's engine and model, which Start needs.
          if (environmentId === 'current') close();
          else
            setMenu({
              kind: 'model',
              trigger: menu.trigger,
              agentSlug: agent.slug,
            });
        }}
        onClose={close}
      />
    );
  return (
    <StartModelPicker
      profile={agent}
      projectSelected={Boolean(viewModel.selectedProject)}
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

function StationMenu({
  anchor,
  layer,
  selectedId,
  projectSelected,
  onChoose,
  onClose,
}: {
  anchor: HTMLElement | null;
  layer: 'popover' | 'dialog';
  selectedId: string;
  projectSelected: boolean;
  onChoose: (environmentId: string) => void;
  onClose: () => void;
}) {
  const { stations, stationsUnavailable } = useExecutionStations({
    projectSelected,
  });
  return (
    <StartStationMenu
      anchor={anchor}
      layer={layer}
      stations={stations}
      selectedId={selectedId}
      stationsUnavailable={stationsUnavailable}
      onChoose={(station) => {
        // Re-choosing where it already runs changes nothing (and keeps the
        // chosen Model, which a Station change resets).
        if (station.id === selectedId) onClose();
        else onChoose(station.id);
      }}
      onClose={onClose}
    />
  );
}
