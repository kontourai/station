import { type ComponentProps, useId, useMemo, useRef, useState } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import { useNewChatSelectionModel } from '../../hooks/useNewChatSelectionModel';
import { agentEngineDescriptor } from '../../utils/engine';
import type { EffectiveModelSource } from '../../utils/execution';
import type { SelectableModel } from '../../utils/modelCapabilities';
import { selectChatReadyAgents } from '../agent-selection-policy';
import { Button } from '../Button';
import { engineChipLabel } from '../badges/EngineChip';
import { normalizedDisplayLabel } from '../chat/message-bubble/MessageAttribution';
import { StartModelPicker } from '../chat-start/StartMenus';
import { AgentIcon } from '../icons/AgentIcon';
import { ArrowDownGlyph } from '../icons/Glyph';
import { GLOBAL_CONTEXT } from '../modals/new-chat-modal-utils';
import '../chat/ConversationHandoff.css';

/**
 * The Agent and model choice shared by the conversation's two "carry this
 * conversation to an Agent" dialogs: Switch agent (the same conversation
 * continues) and Fork from here (a new conversation from a turn). Both list
 * the same chat-ready Agents for the chat's workspace and pick a model the
 * same way; only what Continue does differs.
 */
export function useChatReadyAgentChoice({
  agents,
  projects,
  projectSlug,
}: {
  agents: AgentData[];
  projects: ProjectMetadata[];
  projectSlug?: string;
}) {
  const selection = useNewChatSelectionModel({
    agents,
    projects,
    selectedContext: projectSlug ?? GLOBAL_CONTEXT,
  });
  const chatReady = useMemo(
    () =>
      selectChatReadyAgents({
        agents,
        agentConnections: selection.agentConnections,
        selectedProjectSlug: projectSlug,
        selectedProjectAgentFilter: selection.selectedProjectConfig?.agents,
      }),
    [
      agents,
      projectSlug,
      selection.agentConnections,
      selection.selectedProjectConfig?.agents,
    ],
  );
  return { selection, chatReady };
}

/**
 * The model a target settles on: the current choice while the target still
 * offers it, else its default when offered, else its first model.
 */
export function settledModelId(
  current: string | undefined,
  models: readonly SelectableModel[],
  defaultModel: string | null | undefined,
): string | undefined {
  if (current && models.some((model) => model.id === current)) return current;
  if (defaultModel && models.some((model) => model.id === defaultModel))
    return defaultModel;
  return models[0]?.id;
}

export function AgentChoiceList({
  candidates,
  value,
  disabled,
  onChange,
}: {
  candidates: readonly AgentData[];
  value?: string;
  disabled?: boolean;
  onChange: (agent: AgentData) => void;
}) {
  const name = useId();
  return (
    <div
      className="conversation-handoff-dialog__agents"
      role="radiogroup"
      aria-label="Agent"
    >
      {candidates.map((candidate) => {
        const engineName =
          engineChipLabel(agentEngineDescriptor(candidate)) ||
          'Engine unavailable';
        const repeatsAgent =
          normalizedDisplayLabel(candidate.name) ===
          normalizedDisplayLabel(engineName);
        return (
          <label
            key={candidate.slug}
            className="conversation-handoff-dialog__agent"
          >
            <input
              type="radio"
              name={name}
              value={candidate.slug}
              checked={candidate.slug === value}
              disabled={disabled}
              onChange={() => onChange(candidate)}
            />
            <AgentIcon agent={candidate} size="small" />
            <span>{candidate.name}</span>
            {!repeatsAgent && <small>{engineName}</small>}
          </label>
        );
      })}
    </div>
  );
}

const DEFAULT_SOURCE: EffectiveModelSource = 'agent default';

export function ModelChoiceField({
  models,
  loading,
  modelConnections,
  modelId,
  modelOptions,
  defaultModel,
  disabled,
  onSelect,
  onReset,
  onRuntimeOptionChange,
}: {
  models: SelectableModel[];
  loading: boolean;
  modelConnections: ComponentProps<typeof StartModelPicker>['modelConnections'];
  modelId?: string;
  modelOptions: Record<string, unknown>;
  defaultModel?: string;
  disabled?: boolean;
  onSelect: (model: SelectableModel) => void;
  onReset: () => void;
  onRuntimeOptionChange: (key: string, value: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const labelId = `${id}-model`;
  const valueId = `${id}-model-value`;
  const current = models.find((model) => model.id === modelId);
  return (
    <div className="conversation-handoff-dialog__model">
      <span className="editor-label" id={labelId}>
        Model
      </span>
      <Button
        ref={triggerRef}
        className="choice-trigger"
        aria-labelledby={`${labelId} ${valueId}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <span id={valueId}>{current?.name ?? 'Agent default'}</span>
        <ArrowDownGlyph className="choice-caret" />
      </Button>
      {open && (
        <StartModelPicker
          anchor={triggerRef.current}
          layer="dialog"
          models={models}
          loading={loading}
          modelConnections={modelConnections}
          choice={{ modelId, providerOptions: modelOptions }}
          defaultModel={{ id: defaultModel, source: DEFAULT_SOURCE }}
          onSelect={(model) => {
            onSelect(model);
            setOpen(false);
          }}
          onReset={() => {
            onReset();
            setOpen(false);
          }}
          onRuntimeOptionChange={onRuntimeOptionChange}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
