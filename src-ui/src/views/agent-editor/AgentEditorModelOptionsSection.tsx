import type { ModelOption } from '@kontourai/station-contracts/tool';
import { ModelRuntimeOptionFields } from '../../components/ModelRuntimeOptionFields';
import { DefaultModelField } from '../provider-settings/ProviderConnectionForm';
import type { AgentEditorFormProps } from './types';

/**
 * DESIGN.md §3.4 — Model options for an installed CLI engine: "only the knobs
 * the capability matrix says the engine delivers … If the matrix delivers
 * none, the section does not render".
 *
 * `deliversModelOptions` below is that predicate, and it is the reason this
 * file exports one: the section's heading in `AgentEditorForm` must not
 * render when the body would be empty, so the two decisions have to come from
 * the same function rather than from a heading that hopes.
 *
 * The engine's own option NAMES come from the server (`effortLabels`,
 * `fastModeLabel`), not from this file — see `ModelRuntimeOptionFields`.
 */
export function deliversModelOptions({
  modelSelectable,
  models,
  selectedModelId,
}: {
  modelSelectable: boolean;
  models: ModelOption[];
  selectedModelId: string;
}): boolean {
  if (modelSelectable && models.length > 0) return true;
  return hasKnobs(selectedModelCapabilities(models, selectedModelId));
}

function hasKnobs(
  capabilities: ModelOption['capabilities'] | undefined,
): boolean {
  return (
    (capabilities?.supportsEffort === true &&
      (capabilities.supportedEffortLevels?.length ?? 0) > 0) ||
    capabilities?.supportsAdaptiveThinking === true ||
    capabilities?.supportsFastMode === true ||
    capabilities?.supportsAutoMode === true
  );
}

/**
 * The knobs belong to the model that will run, which is the one this agent
 * pins — or, when it pins none, the engine's first catalogue entry, the same
 * fallback `SessionModelPicker` uses so a chat and this editor never offer
 * different controls for the same agent.
 */
function selectedModelCapabilities(
  models: ModelOption[],
  selectedModelId: string,
): ModelOption['capabilities'] | undefined {
  return (models.find((model) => model.id === selectedModelId) ?? models[0])
    ?.capabilities;
}

export function AgentEditorModelOptionsSection({
  form,
  setForm,
  locked,
  modelSelectable,
  models,
}: Pick<AgentEditorFormProps, 'form' | 'setForm' | 'locked'> & {
  /** `matrix.modelSelection.state !== 'unsupported'` — the engine's own cell. */
  modelSelectable: boolean;
  models: ModelOption[];
}) {
  return (
    <>
      {modelSelectable && models.length > 0 && (
        <DefaultModelField
          id="ae-model-id"
          label="Model"
          value={form.modelId}
          options={models}
          placeholder="Model id"
          hint="Leave blank to use the engine's own default."
          onChange={(modelId) =>
            setForm((current) => ({ ...current, modelId }))
          }
        />
      )}
      <ModelRuntimeOptionFields
        idPrefix="ae-model-options"
        className="editor-field editor-field--row"
        capabilities={selectedModelCapabilities(models, form.modelId)}
        runtimeOptions={form.execution.runtimeOptions}
        disabled={locked}
        onRuntimeOptionChange={(key, value) =>
          setForm((current) => ({
            ...current,
            execution: {
              ...current.execution,
              runtimeOptions:
                value === undefined
                  ? Object.fromEntries(
                      Object.entries(current.execution.runtimeOptions).filter(
                        ([entryKey]) => entryKey !== key,
                      ),
                    )
                  : { ...current.execution.runtimeOptions, [key]: value },
            },
          }))
        }
      />
    </>
  );
}
