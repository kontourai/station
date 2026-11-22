import { useEffect, useId, useMemo, useState } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import {
  type SelectableModel,
  sanitizeRuntimeOptionsForModel,
  updateModelRuntimeOption,
} from '../../utils/modelCapabilities';
import { Button } from '../Button';
import { DisclosureToggle } from '../DisclosureToggle';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../ResponsiveDialogSurface';
import { Empty } from '../state';
import {
  AgentChoiceList,
  ModelChoiceField,
  settledModelId,
  useChatReadyAgentChoice,
} from './AgentModelChoice';
import { HANDOFF_STARTS_FRESH_SUMMARY } from './ConversationHandoffDialog';

export interface ForkTargetChoice {
  modelOverride?: string;
  providerOptions?: Record<string, unknown>;
  providerId?: string;
  providerType?: string;
}

/** What a fork keeps, beside Switch agent's `HANDOFF_KEEPS_SUMMARY`. */
export const FORK_KEEPS_SUMMARY =
  'Messages up to this point, the workspace, and the agent and model you chose.';

/**
 * Fork from here (and its Regenerate / Edit and resend uses): pick the Agent
 * and model that continue from this turn in a new conversation. It is Switch
 * agent's picker (`AgentModelChoice`); the source chat stays as it is.
 */
export function ConversationForkDialog({
  title,
  sourceAgentId,
  sourceModel,
  projectSlug,
  agents,
  projects,
  pending,
  error,
  onFork,
  onClose,
}: {
  title: string;
  sourceAgentId: string;
  sourceModel?: string;
  projectSlug?: string;
  agents: AgentData[];
  projects: ProjectMetadata[];
  pending: boolean;
  error: string | null;
  onFork: (agent: AgentData, choice: ForkTargetChoice) => void;
  onClose: () => void;
}) {
  const { selection, chatReady } = useChatReadyAgentChoice({
    agents,
    projects,
    projectSlug,
  });
  // The source turn's Agent leads: forking to the same Agent is the usual case.
  const candidates = useMemo(
    () =>
      [...chatReady].sort(
        (left, right) =>
          Number(right.slug === sourceAgentId) -
          Number(left.slug === sourceAgentId),
      ),
    [chatReady, sourceAgentId],
  );
  const [targetId, setTargetId] = useState<string | undefined>(sourceAgentId);
  const target = candidates.find((candidate) => candidate.slug === targetId);
  const models = useMemo(
    () =>
      target
        ? selection
            .modelsForAgent(target)
            .filter((model) => model.available !== false)
        : [],
    [selection, target],
  );
  const defaultModel = target
    ? (selection.defaultEffectiveModelForAgent(target).id ?? undefined)
    : undefined;
  const [modelId, setModelId] = useState<string | undefined>(sourceModel);
  const [modelOptions, setModelOptions] = useState<Record<string, unknown>>({});
  useEffect(() => {
    if (!target) return;
    setModelId((current) => settledModelId(current, models, defaultModel));
  }, [target, models, defaultModel]);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const disclosureId = `${useId()}-carries`;
  const model: SelectableModel | undefined = models.find(
    (entry) => entry.id === modelId,
  );
  const targetName = target?.name ?? 'this agent';

  return (
    <ResponsiveDialogSurface
      layer="dialog"
      ariaLabel={title}
      panelClassName="conversation-handoff-dialog"
      overlayClassName="conversation-handoff-dialog__overlay"
      // Cancel stays available while forking: it aborts the request.
      onClose={onClose}
    >
      <div className="conversation-handoff-dialog__header">
        <h3>{title}</h3>
        <ResponsiveDialogCloseButton label="Cancel fork" onClick={onClose} />
      </div>

      {candidates.length === 0 ? (
        <Empty
          variant="compact"
          label="Nothing available"
          description="Connect an agent in this chat's environment to fork."
        />
      ) : (
        <AgentChoiceList
          candidates={candidates}
          value={targetId}
          disabled={pending}
          onChange={(candidate) => {
            setTargetId(candidate.slug);
            setModelId(undefined);
            setModelOptions({});
          }}
        />
      )}

      {target && (
        <div className="conversation-handoff-dialog__confirmation">
          {models.length > 0 && (
            <ModelChoiceField
              models={models}
              loading={selection.modelsLoading}
              modelConnections={selection.modelConnections ?? []}
              modelId={modelId}
              modelOptions={modelOptions}
              defaultModel={defaultModel}
              disabled={pending}
              onSelect={(next) => {
                setModelId(next.id);
                setModelOptions((current) =>
                  sanitizeRuntimeOptionsForModel(next, current),
                );
              }}
              onReset={() => {
                setModelId(undefined);
                setModelOptions({});
              }}
              onRuntimeOptionChange={(key, value) =>
                setModelOptions((current) =>
                  updateModelRuntimeOption(current, key, value),
                )
              }
            />
          )}
          <div className="conversation-handoff-dialog__note">
            <span>Opens a new chat from here. This chat stays as it is.</span>
            <DisclosureToggle
              expanded={disclosureOpen}
              onToggle={() => setDisclosureOpen((open) => !open)}
              controls={disclosureId}
            >
              Details
            </DisclosureToggle>
          </div>
          {disclosureOpen && (
            <dl
              id={disclosureId}
              className="conversation-handoff-dialog__disclosure"
            >
              <dt>Keeps</dt>
              <dd>{FORK_KEEPS_SUMMARY}</dd>
              <dt>Starts fresh</dt>
              <dd>{HANDOFF_STARTS_FRESH_SUMMARY}</dd>
            </dl>
          )}
          {error && (
            <div role="alert" className="conversation-handoff-dialog__feedback">
              {error}
            </div>
          )}
          <ResponsiveSurfaceActions className="conversation-handoff-dialog__actions">
            <Button
              variant="primary"
              disabled={pending}
              onClick={() =>
                onFork(target, {
                  ...(model
                    ? {
                        modelOverride: model.id,
                        providerId: model.providerId,
                        providerType: model.providerType,
                      }
                    : {}),
                  ...(Object.keys(modelOptions).length > 0
                    ? { providerOptions: modelOptions }
                    : {}),
                })
              }
            >
              {pending ? 'Forking…' : `Fork with ${targetName}`}
            </Button>
          </ResponsiveSurfaceActions>
        </div>
      )}
    </ResponsiveDialogSurface>
  );
}
