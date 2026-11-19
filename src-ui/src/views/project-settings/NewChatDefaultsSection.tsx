import type {
  ProjectChatDefaultSelection,
  ProjectChatDefaultsView,
} from '@kontourai/station-contracts/project-chat-defaults';
import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import { useEngineConnectionsQuery } from '@kontourai/station-sdk';
import { Select } from '@kontourai/ui/react';
import { ManagedApprovalCeilingNote } from '../../components/managed/ManagedApprovalCeilingNote';
import { PageRow } from '../../components/PageRow';
import { PageSection } from '../../components/PageSection';
import { useAgents } from '../../contexts/AgentsContext';
import { useManagedApprovalCeiling } from '../../contexts/ManagedPolicyContext';
import { approvalModeLabel } from '../../utils/approvalMode';
import { runtimeCatalogVisibleModels } from '../../utils/execution';
import { modelDisplayLabel } from '../../utils/modelCapabilities';
import type { ProjectForm } from './types';

type SetField = <K extends keyof ProjectForm>(
  key: K,
  value: ProjectForm[K],
) => void;

/**
 * How a new chat in this Project picks its model and its approval mode: a set
 * value, or what the person's last chat here started with
 * (`@kontourai/station-contracts/project-chat-defaults`). The descriptions
 * name what `last-used` would pick right now, from the server's record, and
 * say plainly when there is nothing recorded yet.
 */
export function NewChatDefaultsSection({
  form,
  setField,
  chatDefaults,
  stationApprovalDefault,
  stationConfigLoaded,
  projectModelSet,
}: {
  form: ProjectForm;
  setField: SetField;
  /** `undefined` while the read is in flight or failed. */
  chatDefaults: ProjectChatDefaultsView | undefined;
  /** `AppConfig.defaultApprovalMode`. */
  stationApprovalDefault: string | undefined;
  /** Whether the Station config has been read; until then no value is named. */
  stationConfigLoaded: boolean;
  /** Whether the AI model above names both a connection and a model. */
  projectModelSet: boolean;
}) {
  const agents = useAgents();
  const { aboveCeiling } = useManagedApprovalCeiling();
  const { data: engineConnections = [] } = useEngineConnectionsQuery() as {
    data?: AgentConnectionView[];
  };
  const lastModel = chatDefaults?.model.lastUsed[0];
  const lastAgent = lastModel
    ? agents.find((agent) => agent.slug === lastModel.agentSlug)
    : undefined;
  const lastModelAgent = lastAgent?.name ?? lastModel?.agentSlug;
  // The model's display name from its engine's own catalog; the id when the
  // catalog does not know it.
  const lastModelLabel = lastModel
    ? modelDisplayLabel(
        lastModel.modelId,
        runtimeCatalogVisibleModels(
          engineConnections.find(
            (connection) =>
              connection.id === lastAgent?.execution?.agentConnectionId,
          ),
        ),
      )
    : undefined;
  const fixedModelText = projectModelSet
    ? 'the AI model above'
    : 'the Agent’s own model';
  const lastApproval = chatDefaults?.approvalMode.lastUsed;
  const stationApprovalLabel =
    stationApprovalDefault === 'ask' ||
    stationApprovalDefault === 'auto' ||
    stationApprovalDefault === 'never'
      ? approvalModeLabel(stationApprovalDefault)
      : 'engine settings';

  const modelDescription =
    form.defaultModelSelection === 'last-used'
      ? lastModel
        ? `Reuse the last starting model for the same Agent (last: ${lastModelLabel} with ${lastModelAgent}). If unavailable, use ${fixedModelText}.`
        : `No chat started here has been recorded yet. Use ${fixedModelText}.`
      : projectModelSet
        ? 'A new chat starts on the AI model above wherever its Agent offers that model, ahead of your last pick on this device.'
        : 'This project sets no AI model above, so a new chat starts on the Agent’s own model.';

  const approvalDescription =
    form.defaultApprovalModeSelection === 'last-used'
      ? lastApproval
        ? `Reuse the last starting approval mode (last: ${approvalModeLabel(lastApproval.approvalMode)}). Without permission for full access, use the set mode below.`
        : 'No chat started here has been recorded yet. Use the set approval mode below.'
      : 'A new chat starts in the set approval mode below.';

  return (
    <PageSection
      id="section-new-chat"
      className="project-settings__section page-section--choice-rows"
      title="New chats"
      description="Start from project defaults or your last chat. Agent approval settings take precedence; composer choices override defaults."
    >
      <PageRow
        className="page-row--choice"
        label={
          <label htmlFor="project-default-model-selection">
            Starting model
          </label>
        }
        description={
          <span id="project-default-model-selection-hint">
            {modelDescription}
          </span>
        }
        control={
          <Select
            id="project-default-model-selection"
            aria-describedby="project-default-model-selection-hint"
            value={form.defaultModelSelection}
            onChange={(event) =>
              setField(
                'defaultModelSelection',
                event.target.value as ProjectChatDefaultSelection,
              )
            }
          >
            <option value="fixed">Use the AI model above</option>
            <option value="last-used">Last model used in this project</option>
          </Select>
        }
      />
      <PageRow
        className="page-row--choice"
        label={
          <label htmlFor="project-default-approval-selection">
            Starting approval mode
          </label>
        }
        description={
          <span id="project-default-approval-selection-hint">
            {approvalDescription}
          </span>
        }
        control={
          <Select
            id="project-default-approval-selection"
            aria-describedby="project-default-approval-selection-hint"
            value={form.defaultApprovalModeSelection}
            onChange={(event) =>
              setField(
                'defaultApprovalModeSelection',
                event.target.value as ProjectChatDefaultSelection,
              )
            }
          >
            <option value="fixed">Use the set approval mode</option>
            <option value="last-used">Last mode used in this project</option>
          </Select>
        }
      />
      <PageRow
        className="page-row--choice"
        label={
          <label htmlFor="project-default-approval-mode">
            Set approval mode
          </label>
        }
        description={
          <span id="project-default-approval-mode-hint">
            Also used when there is no chat history. Full access requires
            permission; otherwise a narrower mode applies.
          </span>
        }
        control={
          <Select
            id="project-default-approval-mode"
            aria-describedby="project-default-approval-mode-hint"
            value={form.defaultApprovalMode}
            onChange={(event) =>
              setField(
                'defaultApprovalMode',
                event.target.value as ProjectForm['defaultApprovalMode'],
              )
            }
          >
            <option value="inherit">
              {stationConfigLoaded
                ? `Station default (${stationApprovalLabel})`
                : 'Station default'}
            </option>
            {(['ask', 'auto', 'never'] as const).map((mode) => {
              // #4518: above the managed ceiling, a mode is not offered unless
              // it is the saved value (resent unchanged on an unrelated save).
              const managed =
                aboveCeiling(mode) && mode !== form.defaultApprovalMode;
              return (
                <option key={mode} value={mode} disabled={managed}>
                  {managed
                    ? `${approvalModeLabel(mode)} (Managed)`
                    : approvalModeLabel(mode)}
                </option>
              );
            })}
          </Select>
        }
      />
      <ManagedApprovalCeilingNote className="editor-hint" />
    </PageSection>
  );
}
