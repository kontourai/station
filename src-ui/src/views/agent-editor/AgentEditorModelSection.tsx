import { DEFAULT_GUARDRAILS } from '@kontourai/station-contracts/agent';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import { useModelConnectionsQuery } from '@kontourai/station-sdk';
import { navigationStore } from '../../contexts/navigation-store';
import {
  connectionStatusLabel,
  runtimeCatalogVisibleModels,
} from '../../utils/execution';
import {
  DefaultModelField,
  ProviderRegionField,
} from '../provider-settings/ProviderConnectionForm';
import { resolveStationModelBinding } from './agentsViewUtils';
import type { AgentEditorFormProps } from './types';

/**
 * Clearing every guardrail must clear the OBJECT, not leave `{}` behind: an
 * empty object is a saved value, and `buildAgentPayload` would ship it. This
 * is what the retired "Remove Guardrails" button did explicitly, done by
 * emptying the inputs instead.
 */
function normalizeGuardrails(
  next: NonNullable<AgentEditorFormProps['form']['guardrails']>,
) {
  return Object.values(next).some((value) => value !== undefined) ? next : null;
}

/**
 * DESIGN.md §3.3 — Model. Renders ONLY for "Use a model connection", which is
 * why nothing in it can contradict a CLI agent's engine (Y2): the whole
 * section, including the "needs a model connection" prerequisite, is inside
 * the one branch that is about Station's engine.
 *
 * Its controls are the PROVIDER's, not copies of them (P3/X6):
 * `DefaultModelField` and `ProviderRegionField` are the components the
 * Connections provider form renders, imported rather than reimplemented.
 *
 * The three remaining controls are Station-engine run limits with no provider
 * form to belong to, so §3.3's rule applies — plainly named, proof recorded:
 *   • Temperature / Max tokens — `AgentSpec.guardrails`, read by the VoltAgent
 *     adapter when it builds the generation call (`voltagent-adapter.ts`
 *     `guardrails.temperature`/`maxTokens`).
 *   • Max steps — `AgentSpec.maxSteps`, the adapter's `maxSteps` bound on one
 *     turn's tool loop.
 * All three round-trip through `buildAgentPayload`. The heading they used to
 * sit under ("Advanced", then "Provider options") is gone: it described where
 * the developer put them, not what they do.
 */
export function AgentEditorModelSection({
  form,
  setForm,
  appConfig,
  locked,
  isPlugin,
  isLocked,
  modelChoices,
}: Pick<
  AgentEditorFormProps,
  'form' | 'setForm' | 'appConfig' | 'locked' | 'isPlugin' | 'isLocked'
> & {
  modelChoices: Array<{ id: string; name: string }>;
}) {
  const { data: modelConnections = [] } = useModelConnectionsQuery() as {
    data?: ConnectionConfig[];
  };
  const disabled = locked || !!(isPlugin && isLocked);
  // station#3747: the inventory route is LLM-capable by contract; enabled is
  // the only question left for this list to ask.
  const modelConnectionOptions = modelConnections.filter(
    (connection) => connection.enabled,
  );
  /**
   * The SAME answer Create is gated on (station#3743). When this section says
   * a connection will serve the agent, Create is pressable; when it says why
   * one will not, that sentence is the reason Create is disabled. There is no
   * second opinion to drift from.
   */
  const binding = resolveStationModelBinding({
    modelConnectionId: form.execution.modelConnectionId,
    modelConnections,
    appConfig,
  });
  /**
   * The models to offer come from the MODEL connection that will serve them
   * when one is chosen — the engine connection's catalogue is only the
   * fallback for "use the app default". Reading the engine's catalogue in
   * both cases is how a Bedrock-only list appeared under a chosen OpenAI
   * connection.
   */
  const modelOptions =
    binding.kind === 'resolved' && binding.explicit
      ? runtimeCatalogVisibleModels(binding.connection)
      : modelChoices;

  return (
    <>
      <div className="editor-field">
        <label className="editor-label" htmlFor="ae-model-connection">
          Model connection
        </label>
        <select
          id="ae-model-connection"
          className="editor-select"
          value={form.execution.modelConnectionId}
          disabled={disabled}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              execution: {
                ...current.execution,
                modelConnectionId: event.target.value,
              },
            }))
          }
        >
          <option value="">
            {binding.kind === 'resolved' && !binding.explicit
              ? `Use the app default (${binding.connection.name})`
              : 'Use the app default'}
          </option>
          {modelConnectionOptions.map((connection) => (
            <option
              key={connection.id}
              value={connection.id}
              disabled={connection.status !== 'ready'}
            >
              {connection.name} — {connectionStatusLabel(connection.status)}
            </option>
          ))}
        </select>
        <span className="editor-hint">
          Which model connection Station&apos;s engine uses for this agent.
        </span>
      </div>

      {modelConnectionOptions
        .filter((connection) => connection.status !== 'ready')
        .map((connection) => (
          <div
            className="agent-editor__capability-banner"
            role="status"
            key={connection.id}
          >
            {connection.readinessEvidence?.summary ??
              `${connection.name} is ${connectionStatusLabel(connection.status)}.`}{' '}
            <button
              type="button"
              className="agent-editor__capability-banner-action"
              onClick={() =>
                navigationStore.navigate('/connections?section=models')
              }
            >
              Fix {connection.name}
            </button>
          </div>
        ))}

      {binding.kind === 'unresolved' && (
        <div className="agent-editor__capability-banner" role="status">
          {binding.reason}{' '}
          <button
            type="button"
            className="agent-editor__capability-banner-action"
            onClick={() =>
              navigationStore.navigate('/connections?section=models')
            }
          >
            {modelConnectionOptions.length === 0
              ? // station#4521 LOW-1: matches CONNECTION_SECTIONS' own
                // `addLabel` for the models section (connection-sections.ts)
                // — the canonical copy for this action, not a second wording
                // this file invented.
                'Add model connection'
              : 'Open model connections'}
          </button>
        </div>
      )}

      <DefaultModelField
        id="ae-model-id"
        label="Model"
        value={form.modelId}
        options={modelOptions}
        placeholder="Model id"
        hint="Leave blank to use the model connection's own default."
        onChange={(modelId) => setForm((current) => ({ ...current, modelId }))}
      />

      <ProviderRegionField
        id="ae-region"
        value={form.region}
        hint={
          appConfig?.region
            ? `Leave blank to use ${appConfig.region}.`
            : 'Leave blank to use the connection’s region.'
        }
        disabled={disabled}
        onChange={(region) => setForm((current) => ({ ...current, region }))}
      />

      <div className="editor-field">
        <label className="editor-label" htmlFor="ae-temperature">
          Temperature
        </label>
        <input
          id="ae-temperature"
          type="number"
          className="editor-input"
          min="0"
          max="1"
          step="0.1"
          value={form.guardrails?.temperature ?? ''}
          placeholder={String(DEFAULT_GUARDRAILS.temperature ?? 0.7)}
          disabled={disabled}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              guardrails: normalizeGuardrails({
                ...(current.guardrails ?? {}),
                temperature: event.target.value
                  ? parseFloat(event.target.value)
                  : undefined,
              }),
            }))
          }
        />
        <span className="editor-hint">
          How varied the replies are. Higher is more varied.
        </span>
      </div>

      <div className="editor-field">
        <label className="editor-label" htmlFor="ae-max-tokens">
          Longest reply
        </label>
        <input
          id="ae-max-tokens"
          type="number"
          className="editor-input"
          min="1"
          value={form.guardrails?.maxTokens ?? ''}
          placeholder={String(DEFAULT_GUARDRAILS.maxTokens)}
          disabled={disabled}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              guardrails: normalizeGuardrails({
                ...(current.guardrails ?? {}),
                maxTokens: event.target.value
                  ? parseInt(event.target.value, 10)
                  : undefined,
              }),
            }))
          }
        />
        <span className="editor-hint">The most tokens one reply may use.</span>
      </div>

      <div className="editor-field">
        <label className="editor-label" htmlFor="ae-maxsteps">
          Steps per turn
        </label>
        <input
          id="ae-maxsteps"
          type="number"
          min="0"
          max="100"
          className="editor-input"
          name="maxSteps"
          value={form.maxSteps}
          placeholder="0 (unlimited)"
          disabled={disabled}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              maxSteps: event.target.value,
            }))
          }
        />
        <span className="editor-hint">
          How many tool steps one turn may take before it stops.
        </span>
      </div>
    </>
  );
}
