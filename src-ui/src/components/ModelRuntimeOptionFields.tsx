import type { ModelOptionCapabilities } from '@kontourai/station-contracts/tool';
import { effortLabel } from '../utils/modelCapabilities';
import { Checkbox } from './Checkbox';

/**
 * The engine-owned model knobs — effort, adaptive thinking, fast mode, auto
 * mode — rendered from what the SERVER reported this model can do.
 *
 * DESIGN.md §3.4 asks for "only the knobs the capability matrix says the
 * engine delivers". The static `EngineCapabilityMatrix` has one cell that
 * bears on this (`modelSelection`, which gates whether a model is choosable
 * at all); it has no effort/thinking cells and should not grow them, because
 * the answer is not a property of the engine class: it is a property of the
 * selected MODEL, computed per connection by the adapter that will run it
 * (`codex-adapter.ts` derives `supportedEffortLevels`/`effortLabels`/
 * `supportsFastMode` from the live `codex model list`; `claude-adapter.ts`
 * reports its own) and projected onto the connection by
 * `connection-service-helpers.ts`. So the section's EXISTENCE is matrix-gated
 * and its CONTENTS are capability-gated, and neither is a per-engine branch
 * in the UI.
 *
 * The agent editor used to answer it with `connection.type === 'claude'` and
 * `connection.type === 'codex'` literals and hardcoded option lists — a
 * client-side guess at another process's capabilities that could only be
 * wrong (it offered Codex "Low/Medium/High/Highest" whatever the installed
 * codex reported, and offered Claude nothing that Claude's own catalogue
 * said). The Session model picker had already been doing it properly for one
 * surface; this is that same code, mounted by both.
 */
export function ModelRuntimeOptionFields({
  idPrefix,
  className,
  capabilities,
  runtimeOptions,
  disabled,
  onRuntimeOptionChange,
}: {
  /** Unique per mount — two pickers on one page must not share input ids. */
  idPrefix: string;
  /** The wrapper class each host uses for its own field rhythm. */
  className: string;
  capabilities: ModelOptionCapabilities | undefined;
  runtimeOptions: Record<string, unknown>;
  disabled?: boolean;
  onRuntimeOptionChange: (
    key: string,
    value: string | number | boolean | undefined,
  ) => void;
}) {
  const effortOptions =
    capabilities?.supportsEffort === true
      ? (capabilities.supportedEffortLevels ?? [])
      : [];
  return (
    <>
      {effortOptions.length > 0 && (
        <label className={className}>
          <span>Thinking effort</span>
          <select
            className="editor-select"
            aria-label="Thinking effort"
            disabled={disabled}
            value={
              typeof runtimeOptions.effort === 'string' &&
              effortOptions.includes(runtimeOptions.effort)
                ? runtimeOptions.effort
                : ''
            }
            onChange={(event) =>
              onRuntimeOptionChange('effort', event.target.value || undefined)
            }
          >
            <option value="">Use model default</option>
            {effortOptions.map((option) => (
              <option key={option} value={option}>
                {capabilities?.effortLabels?.[option] ?? effortLabel(option)}
              </option>
            ))}
          </select>
        </label>
      )}
      {capabilities?.supportsAdaptiveThinking === true && (
        <div className={className}>
          <label htmlFor={`${idPrefix}-adaptive-thinking`}>
            Adaptive thinking
          </label>
          <Checkbox
            id={`${idPrefix}-adaptive-thinking`}
            checked={runtimeOptions.thinking !== false}
            disabled={disabled}
            onChange={(checked) => onRuntimeOptionChange('thinking', checked)}
          />
        </div>
      )}
      {capabilities?.supportsFastMode === true && (
        <div className={className}>
          <label htmlFor={`${idPrefix}-fast-mode`}>
            {capabilities.fastModeLabel ?? 'Fast mode'}
          </label>
          <Checkbox
            id={`${idPrefix}-fast-mode`}
            checked={runtimeOptions.fastMode === true}
            disabled={disabled}
            onChange={(checked) => onRuntimeOptionChange('fastMode', checked)}
          />
        </div>
      )}
      {capabilities?.supportsAutoMode === true && (
        <div className={className}>
          <label htmlFor={`${idPrefix}-auto-mode`}>Auto mode</label>
          <Checkbox
            id={`${idPrefix}-auto-mode`}
            checked={runtimeOptions.autoMode !== false}
            disabled={disabled}
            onChange={(checked) => onRuntimeOptionChange('autoMode', checked)}
          />
        </div>
      )}
    </>
  );
}
