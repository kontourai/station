import type { ModelOptionCapabilities } from '@kontourai/station-contracts/tool';
import { useId } from 'react';
import { effortLabel } from '../utils/modelCapabilities';
import { Checkbox } from './Checkbox';

/** Shared model controls use adapter-reported capabilities, not engine-name guesses. */
export function ModelRuntimeOptionFields({
  idPrefix,
  className,
  capabilities,
  runtimeOptions,
  disabled,
  effortPresentation = 'select',
  onRuntimeOptionChange,
}: {
  /** Unique per mount — two pickers on one page must not share input ids. */
  idPrefix: string;
  /** The wrapper class each host uses for its own field rhythm. */
  className: string;
  capabilities: ModelOptionCapabilities | undefined;
  runtimeOptions: Record<string, unknown>;
  disabled?: boolean;
  /** The picker exposes choices; compact editors retain their native select. */
  effortPresentation?: 'select' | 'choices';
  onRuntimeOptionChange: (
    key: string,
    value: string | number | boolean | null | undefined,
  ) => void;
}) {
  const effortGroup = useId();
  const tierGroup = useId();
  const serviceTiers = capabilities?.serviceTiers ?? [];
  const selectedTier =
    serviceTiers.find((tier) => tier.id === runtimeOptions.serviceTier) ??
    (runtimeOptions.serviceTier === undefined &&
    runtimeOptions.fastMode === true
      ? serviceTiers.find(
          (tier) => tier.id === 'fast' || tier.id === 'priority',
        )
      : undefined);
  const defaultTier = serviceTiers.find(
    (tier) => tier.id === capabilities?.defaultServiceTier,
  );
  const tierDescription =
    selectedTier?.description ??
    (!selectedTier && defaultTier
      ? `Model default: ${defaultTier.name}.${defaultTier.description ? ` ${defaultTier.description}` : ''}`
      : undefined);
  const effortOptions =
    capabilities?.supportsEffort === true
      ? (capabilities.supportedEffortLevels ?? [])
      : [];
  const requestedEffort =
    runtimeOptions.effort ?? runtimeOptions.reasoningEffort;
  const selectedEffort =
    typeof requestedEffort === 'string' &&
    effortOptions.includes(requestedEffort)
      ? requestedEffort
      : '';
  const effortName = (value: string) => {
    const label = capabilities?.effortLabels?.[value];
    return label && label.length <= 48 ? label : effortLabel(value);
  };
  const effortDescription = capabilities?.effortLabels?.[selectedEffort];
  const showEffortDescription =
    effortDescription && effortDescription.length > 48;
  return (
    <>
      {effortOptions.length > 0 && effortPresentation === 'choices' && (
        <fieldset
          className={`${className} model-runtime-choices`}
          disabled={disabled}
          aria-describedby={
            showEffortDescription ? `${effortGroup}-description` : undefined
          }
        >
          <legend>Thinking effort</legend>
          {['', ...effortOptions].map((option) => (
            <label key={option}>
              <input
                type="radio"
                name={effortGroup}
                value={option}
                checked={selectedEffort === option}
                onChange={() =>
                  onRuntimeOptionChange('effort', option || undefined)
                }
              />
              <span title={capabilities?.effortLabels?.[option]}>
                {option ? effortName(option) : 'Model default'}
              </span>
            </label>
          ))}
          {showEffortDescription && (
            <p
              id={`${effortGroup}-description`}
              className="model-runtime-tier-description"
            >
              {effortDescription}
            </p>
          )}
        </fieldset>
      )}
      {effortOptions.length > 0 && effortPresentation === 'select' && (
        <label className={className}>
          <span>Thinking effort</span>
          <select
            className="editor-select"
            aria-label="Thinking effort"
            disabled={disabled}
            value={selectedEffort}
            onChange={(event) =>
              onRuntimeOptionChange('effort', event.target.value || undefined)
            }
          >
            <option value="">Model default</option>
            {effortOptions.map((option) => (
              <option
                key={option}
                value={option}
                title={capabilities?.effortLabels?.[option]}
              >
                {effortName(option)}
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
      {serviceTiers.length > 0 && effortPresentation === 'choices' && (
        <fieldset
          className={`${className} model-runtime-choices model-runtime-speed-choices`}
          disabled={disabled}
          aria-describedby={
            tierDescription ? `${tierGroup}-description` : undefined
          }
        >
          <legend>Speed</legend>
          {[{ id: '', name: 'Model default' }, ...serviceTiers].map((tier) => (
            <label key={tier.id}>
              <input
                type="radio"
                name={tierGroup}
                value={tier.id}
                checked={(selectedTier?.id ?? '') === tier.id}
                onChange={() =>
                  onRuntimeOptionChange('serviceTier', tier.id || null)
                }
              />
              <span>{tier.name}</span>
            </label>
          ))}
          {tierDescription && (
            <p
              id={`${tierGroup}-description`}
              className="model-runtime-tier-description"
            >
              {tierDescription}
            </p>
          )}
        </fieldset>
      )}
      {serviceTiers.length > 0 && effortPresentation === 'select' && (
        <div className={className}>
          <label htmlFor={`${tierGroup}-select`}>Speed</label>
          <select
            id={`${tierGroup}-select`}
            className="editor-select"
            disabled={disabled}
            value={selectedTier?.id ?? ''}
            title={tierDescription}
            onChange={(event) =>
              onRuntimeOptionChange('serviceTier', event.target.value || null)
            }
          >
            <option value="">Model default</option>
            {serviceTiers.map((tier) => (
              <option key={tier.id} value={tier.id}>
                {tier.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {serviceTiers.length === 0 && capabilities?.supportsFastMode === true && (
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
