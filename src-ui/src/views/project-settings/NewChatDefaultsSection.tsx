import type {
  ProjectChatDefaultSelection,
  ProjectChatDefaultsView,
} from '@kontourai/station-contracts/project-chat-defaults';
import { PageRow } from '../../components/PageRow';
import { PageSection } from '../../components/PageSection';
import { useAgents } from '../../contexts/AgentsContext';
import { approvalModeLabel } from '../../utils/approvalMode';
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
}: {
  form: ProjectForm;
  setField: SetField;
  /** `undefined` while the read is in flight or failed. */
  chatDefaults: ProjectChatDefaultsView | undefined;
  /** `AppConfig.defaultApprovalMode`. */
  stationApprovalDefault: string | undefined;
  /** Whether the Station config has been read; until then no value is named. */
  stationConfigLoaded: boolean;
}) {
  const agents = useAgents();
  const lastModel = chatDefaults?.model.lastUsed[0];
  const lastModelAgent = lastModel
    ? (agents.find((agent) => agent.slug === lastModel.agentSlug)?.name ??
      lastModel.agentSlug)
    : undefined;
  const lastApproval = chatDefaults?.approvalMode.lastUsed;
  const stationApprovalLabel =
    stationApprovalDefault === 'ask' ||
    stationApprovalDefault === 'auto' ||
    stationApprovalDefault === 'never'
      ? approvalModeLabel(stationApprovalDefault)
      : 'the engine’s own settings';

  const modelDescription =
    form.defaultModelSelection === 'last-used'
      ? lastModel
        ? `A new chat starts on the model your last chat here started with, for the same Agent (last: ${lastModel.modelId} with ${lastModelAgent}). If that model is no longer offered, the AI model above applies.`
        : 'No chat started here has been recorded yet, so the AI model above applies until you start one.'
      : 'A new chat starts on the AI model above.';

  const approvalDescription =
    form.defaultApprovalModeSelection === 'last-used'
      ? lastApproval
        ? `A new chat starts in the approval mode your last chat here started in (last: ${approvalModeLabel(lastApproval.approvalMode)}). Full access is only reused when you can grant it; otherwise the mode below applies.`
        : 'No chat started here has been recorded yet, so the mode below applies until you start one.'
      : 'A new chat starts in the mode below.';

  return (
    <PageSection
      id="section-new-chat"
      className="project-settings__section"
      eyebrow="New chat default"
      title="New chats"
      description="Choose whether a new chat in this project starts from the settings here or from what your last chat here started with. An Agent's own approval mode still applies first, and a choice you make in the composer always wins."
    >
      <PageRow
        label="Starting model"
        description={modelDescription}
        control={
          <select
            id="project-default-model-selection"
            className="editor-input"
            aria-label="Starting model"
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
          </select>
        }
      />
      <PageRow
        label="Starting approval mode"
        description={approvalDescription}
        control={
          <select
            id="project-default-approval-selection"
            className="editor-input"
            aria-label="Starting approval mode"
            value={form.defaultApprovalModeSelection}
            onChange={(event) =>
              setField(
                'defaultApprovalModeSelection',
                event.target.value as ProjectChatDefaultSelection,
              )
            }
          >
            <option value="fixed">Use the mode below</option>
            <option value="last-used">Last mode used in this project</option>
          </select>
        }
      />
      <PageRow
        label="Approval mode"
        description="Full access needs your full-access permission to save. Without a full-access grant at start, Station applies a narrower setting."
        control={
          <select
            id="project-default-approval-mode"
            className="editor-input"
            aria-label="Approval mode"
            value={form.defaultApprovalMode}
            onChange={(event) =>
              setField(
                'defaultApprovalMode',
                event.target.value as ProjectForm['defaultApprovalMode'],
              )
            }
          >
            <option value="inherit">
              {!stationConfigLoaded
                ? 'Follow the Station approval default'
                : `Use the Station approval default (currently: ${stationApprovalLabel})`}
            </option>
            <option value="ask">{approvalModeLabel('ask')}</option>
            <option value="auto">{approvalModeLabel('auto')}</option>
            <option value="never">{approvalModeLabel('never')}</option>
          </select>
        }
      />
    </PageSection>
  );
}
