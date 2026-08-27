import { useAwsProfilesQuery } from '@kontourai/station-sdk';
import { Fragment, useId, useMemo } from 'react';
import { CheckGlyph, CloseGlyph } from '../../components/icons/Glyph';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import {
  modelPreferenceKey,
  updateModelPickerPreferences,
  useModelPickerPreferences,
} from '../../settings/modelPickerPreferences';
import { PROVIDER_TYPES, resolveProviderPresentation } from './providerCatalog';
import type { ProviderConnection } from './types';

/**
 * The connection's default model (#3652, #3654, and their review's M1).
 *
 * One component rather than a copy per provider block: the chat probe reads
 * `config.defaultModel` for EVERY model provider, so every provider whose
 * catalogue can come back empty or unsupported is told to set it — and a form
 * that cannot set it turns Station's own instruction into a dead end. A picker
 * when a catalogue loaded, a plain input when it did not, because the case
 * that produces the instruction is exactly the one with nothing to pick from.
 */
export function DefaultModelField({
  id,
  label = 'Default model',
  value,
  options,
  placeholder,
  hint,
  onChange,
}: {
  id: string;
  /**
   * The connection form calls this the connection's DEFAULT model; an agent
   * page renting the same control is naming one model for one agent, and
   * "Default model" there is a different claim. Same control, host's noun.
   */
  label?: string;
  value: string;
  options: Array<{ id: string; name: string }>;
  placeholder: string;
  hint: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="editor-field">
      <label className="editor-label" htmlFor={id}>
        {label}
      </label>
      {options.length > 0 ? (
        <select
          id={id}
          className="editor-select"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Choose a model…</option>
          {options.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          className="editor-input"
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <div className="editor-field-hint">{hint}</div>
    </div>
  );
}

/**
 * The provider's OWN region control (#3654's Bedrock block, DESIGN.md §3.3).
 *
 * Exported because the agent editor renders the same setting for a
 * Station-engine agent's per-agent override (`runtime-provider-resolution.ts`
 * reads `agent.region` ahead of the connection's), and it used to do that
 * with a hand-copied input under a heading called "Advanced". A second copy of
 * a provider control is a second place for its label, placeholder and
 * validation to drift — P3/X6: engine-owned settings render through the
 * provider form's components, wherever they are shown.
 */
export function ProviderRegionField({
  id,
  value,
  hint,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  hint?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="editor-field">
      <label className="editor-label" htmlFor={id}>
        Region
      </label>
      <input
        id={id}
        className="editor-input"
        type="text"
        value={value}
        placeholder="us-east-1"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <div className="editor-hint">{hint}</div> : null}
    </div>
  );
}

export function ProviderConnectionForm({
  form,
  isNew,
  selectedProviderId,
  testResult,
  testError,
  isTesting,
  isLoadingModels = false,
  onSetField,
  onSetConfigField,
  onTypeChange,
  onTestConnection,
  onLoadModels,
}: {
  form: Omit<ProviderConnection, 'id'>;
  isNew: boolean;
  selectedProviderId?: string;
  testResult: { healthy: boolean; reason?: string } | null;
  testError: string | null;
  isTesting: boolean;
  isLoadingModels?: boolean;
  onSetField: <K extends keyof Omit<ProviderConnection, 'id'>>(
    key: K,
    value: Omit<ProviderConnection, 'id'>[K],
  ) => void;
  onSetConfigField: (key: string, value: unknown) => void;
  onTypeChange: (type: string) => void;
  onTestConnection: (id: string) => void;
  /** RT-18: what "Check to load" only ever named. */
  onLoadModels?: () => void;
}) {
  const fieldId = useId();
  const nameId = `${fieldId}-name`;
  const serverUrlId = `${fieldId}-server-url`;
  const apiKeyId = `${fieldId}-api-key`;
  const defaultModelId = `${fieldId}-default-model`;
  const regionId = `${fieldId}-region`;
  const providerTypeId = `${fieldId}-provider-type`;
  const modelOptions = Array.isArray(form.config.modelOptions)
    ? (form.config.modelOptions as Array<{ id: string; name: string }>)
    : [];
  const modelPreferences = useModelPickerPreferences();
  const orderedModels = useMemo(() => {
    if (!selectedProviderId) return modelOptions;
    const order = new Map(
      modelPreferences.order.map((key, index) => [key, index]),
    );
    return [...modelOptions].sort(
      (a, b) =>
        (order.get(modelPreferenceKey(selectedProviderId, a.id)) ??
          Number.MAX_SAFE_INTEGER) -
        (order.get(modelPreferenceKey(selectedProviderId, b.id)) ??
          Number.MAX_SAFE_INTEGER),
    );
  }, [modelOptions, modelPreferences.order, selectedProviderId]);
  const apiKeyConfigured = form.config.apiKeyConfigured === true;

  /*
   * RT-06 — "Ready" used to come from `form.status`, which for a model
   * connection is `statusFromPrerequisites` and whose only required
   * prerequisite is "a non-empty string is saved in the key box". A
   * knowingly-invalid key therefore read Ready, and clicking Test Connection
   * printed "✗ Connection failed" while Status still said Ready and Last
   * check still said Not checked. This is the same resolver the hub cards and
   * the list rail read, fed the server's own readiness evidence.
   */
  const presentation = resolveProviderPresentation({
    id: selectedProviderId ?? 'new',
    kind: 'model',
    type: form.type,
    name: form.name,
    enabled: form.enabled,
    status: form.status,
    prerequisites: form.prerequisites,
    ...(form.readinessEvidence
      ? { readinessEvidence: form.readinessEvidence }
      : {}),
    setup: null,
    href: '',
  });
  const verified = !isNew && presentation.readiness === 'Ready';
  /*
   * RT-18 — the rail was three static spans with the first hardcoded
   * complete, so it read "Choose" forever no matter what the user did. Each
   * step is now the fact it names: the connection exists on the server, and
   * something has actually reached the provider.
   */
  const steps = [
    { label: 'Choose', complete: true },
    { label: 'Connect', complete: !isNew },
    { label: 'Ready', complete: verified },
  ];

  const bedrockAuthMode =
    (form.config.authMode as string | undefined) ?? 'chain';
  const awsProfilesQuery = useAwsProfilesQuery({
    enabled: form.type === 'bedrock' && bedrockAuthMode === 'profile',
  });

  function handleBedrockAuthModeChange(mode: string) {
    onSetConfigField('authMode', mode);
    if (mode !== 'profile') onSetConfigField('profile', '');
    if (mode !== 'api-key') {
      onSetConfigField('apiKey', '');
      if (apiKeyConfigured) {
        onSetConfigField('apiKeyConfigured', false);
        onSetConfigField('apiKeyClearRequested', true);
      }
    }
  }

  function clearSavedApiKey() {
    onSetConfigField('apiKey', '');
    onSetConfigField('apiKeyConfigured', false);
    onSetConfigField('apiKeyClearRequested', true);
  }

  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
      }}
    >
      <nav className="provider-detail__progress" aria-label="Provider setup">
        {steps.map((step, index) => (
          <Fragment key={step.label}>
            {index > 0 && <span aria-hidden="true">→</span>}
            <span
              className={`provider-detail__progress-step${
                step.complete ? ' provider-detail__progress-step--complete' : ''
              }`}
              // The step the connection is actually on, announced rather than
              // left to a colour and a private class name (review test-gap
              // note). Exactly one step carries it: the first incomplete one.
              aria-current={
                !step.complete && steps.slice(0, index).every((s) => s.complete)
                  ? 'step'
                  : undefined
              }
            >
              {step.label}
            </span>
          </Fragment>
        ))}
      </nav>

      <div className="editor-field">
        <label className="editor-label" htmlFor={nameId}>
          Name
        </label>
        <input
          id={nameId}
          className="editor-input"
          type="text"
          value={form.name}
          placeholder="Work, Personal, or Local"
          onChange={(event) => onSetField('name', event.target.value)}
        />
      </div>

      <div className="provider-detail__summary" aria-live="polite">
        <div>
          <span className="provider-detail__summary-label">Status</span>
          <strong>{isNew ? 'Setup required' : presentation.readiness}</strong>
        </div>
        <div>
          <span className="provider-detail__summary-label">Models</span>
          {modelOptions.length > 0 ? (
            <strong>{modelOptions.length}</strong>
          ) : (
            /*
             * RT-18: "Check to load" was instruction-shaped copy with no
             * control anywhere near it, and Test Connection neither populated
             * this nor changed the label. The catalogue load is a real
             * request; this is the button that makes it.
             */
            <button
              type="button"
              className="editor-btn"
              onClick={onLoadModels}
              disabled={!onLoadModels || isNew || isLoadingModels}
            >
              {isLoadingModels ? 'Loading…' : 'Load models'}
            </button>
          )}
        </div>
        <div>
          <span className="provider-detail__summary-label">Last check</span>
          <strong>
            {form.lastCheckedAt
              ? new Date(form.lastCheckedAt).toLocaleString()
              : 'Not checked'}
          </strong>
        </div>
      </div>

      {/* Delta2 review M1: an unreachable endpoint carries a reason the
          operator needs just as much as a refusal does — "Station could not
          reach this provider" with what it tried, not a silent card. */}
      {!isNew &&
        (form.readinessEvidence?.check?.status === 'failed' ||
          form.readinessEvidence?.check?.status === 'unreachable') && (
          <div className="provider-detail__notice" role="status">
            <strong>{presentation.readiness}</strong>
            <span>{form.readinessEvidence.summary}</span>
            {form.readinessEvidence.action && (
              <span>{form.readinessEvidence.action}</span>
            )}
          </div>
        )}

      {selectedProviderId && orderedModels.length > 0 && (
        <section className="provider-detail__models">
          <div>
            <h3>Models</h3>
            <p>Choose favorites, order, and visibility for this device.</p>
          </div>
          <div className="provider-detail__model-list">
            {orderedModels.map((model, index) => {
              const key = modelPreferenceKey(selectedProviderId, model.id);
              const favorite = modelPreferences.favorites.includes(key);
              const hidden = modelPreferences.hidden.includes(key);
              const updateList = (
                field: 'favorites' | 'hidden',
                enabled: boolean,
              ) =>
                updateModelPickerPreferences((current) => ({
                  ...current,
                  [field]: enabled
                    ? [...current[field], key]
                    : current[field].filter((entry) => entry !== key),
                }));
              const move = (direction: -1 | 1) => {
                const next = [...orderedModels];
                const target = index + direction;
                if (target < 0 || target >= next.length) return;
                [next[index], next[target]] = [next[target], next[index]];
                const providerKeys = new Set(
                  orderedModels.map((entry) =>
                    modelPreferenceKey(selectedProviderId, entry.id),
                  ),
                );
                updateModelPickerPreferences((current) => ({
                  ...current,
                  order: [
                    ...current.order.filter(
                      (entry) => !providerKeys.has(entry),
                    ),
                    ...next.map((entry) =>
                      modelPreferenceKey(selectedProviderId, entry.id),
                    ),
                  ],
                }));
              };
              return (
                <div className="provider-detail__model-row" key={model.id}>
                  <span>
                    <strong>{model.name}</strong>
                    <small>{model.id}</small>
                  </span>
                  <span className="provider-detail__model-actions">
                    <button
                      type="button"
                      className="button button--ghost"
                      aria-label={`${favorite ? 'Remove' : 'Add'} ${model.name} ${favorite ? 'from' : 'to'} favorites`}
                      aria-pressed={favorite}
                      onClick={() => updateList('favorites', !favorite)}
                    >
                      {favorite ? '★' : '☆'}
                    </button>
                    <button
                      type="button"
                      className="button button--ghost"
                      aria-label={`Move ${model.name} up`}
                      disabled={index === 0}
                      onClick={() => move(-1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="button button--ghost"
                      aria-label={`Move ${model.name} down`}
                      disabled={index === orderedModels.length - 1}
                      onClick={() => move(1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="button button--ghost"
                      aria-label={`${hidden ? 'Show' : 'Hide'} ${model.name}`}
                      aria-pressed={hidden}
                      onClick={() => updateList('hidden', !hidden)}
                    >
                      {hidden ? 'Show' : 'Hide'}
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {form.type === 'ollama' && (
        <>
          <div className="editor-field">
            <label className="editor-label" htmlFor="ollama-base-url">
              Base URL
            </label>
            <input
              id="ollama-base-url"
              className="editor-input"
              type="text"
              value={(form.config.baseUrl as string) ?? ''}
              placeholder="http://localhost:11434"
              onChange={(event) =>
                onSetConfigField('baseUrl', event.target.value)
              }
            />
          </div>
          <div className="editor-field">
            <label className="editor-label" htmlFor="ollama-default-model">
              Default model
            </label>
            {modelOptions.length > 0 ? (
              <select
                id="ollama-default-model"
                className="editor-select"
                value={(form.config.defaultModel as string) ?? ''}
                onChange={(event) =>
                  onSetConfigField('defaultModel', event.target.value)
                }
              >
                <option value="">Choose an installed model…</option>
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="ollama-default-model"
                className="editor-input"
                type="text"
                value={(form.config.defaultModel as string) ?? ''}
                placeholder="Auto-select when one model is installed"
                onChange={(event) =>
                  onSetConfigField('defaultModel', event.target.value)
                }
              />
            )}
            <div
              style={{
                color: 'var(--text-muted)',
                fontSize: '12px',
                marginTop: '6px',
              }}
            >
              Station selects it automatically when Ollama reports exactly one
              installed model.
            </div>
          </div>
        </>
      )}

      {form.type === 'openai-compat' && (
        <>
          <div className="editor-field">
            <label className="editor-label" htmlFor={serverUrlId}>
              Server URL
            </label>
            <input
              id={serverUrlId}
              className="editor-input"
              type="text"
              value={(form.config.baseUrl as string) ?? ''}
              placeholder="https://api.openai.com/v1"
              onChange={(event) =>
                onSetConfigField('baseUrl', event.target.value)
              }
            />
          </div>
          <div className="editor-field">
            <label className="editor-label" htmlFor={apiKeyId}>
              API key
            </label>
            <input
              id={apiKeyId}
              className="editor-input"
              type="password"
              value={(form.config.apiKey as string) ?? ''}
              placeholder={
                apiKeyConfigured
                  ? 'Saved secret — enter a new value to replace it'
                  : 'Paste an API key if this server requires one'
              }
              onChange={(event) =>
                onSetConfigField('apiKey', event.target.value)
              }
            />
            {apiKeyConfigured && (
              <div className="editor-field-hint">
                A secret is saved. Station never sends it back to this device.
                <button type="button" onClick={clearSavedApiKey}>
                  Remove saved key
                </button>
              </div>
            )}
          </div>
          {/*
           * #3652 — the check's own failure text asks for a default model
           * ("Set a default model on this connection … so Station can verify
           * chat directly"), and this form had nowhere to set one: the field
           * was API-only. A server with no `/models` route is exactly the
           * connection that needs it, because the one-token chat request is
           * the ONLY evidence that can take it past "Reachable — no model
           * catalog".
           */}
          <DefaultModelField
            id={defaultModelId}
            value={(form.config.defaultModel as string) ?? ''}
            options={modelOptions}
            placeholder="The model id this server accepts"
            hint="Used when an agent names no model of its own, and it is the model Test Connection sends its one minimal chat request to — the only check a server that offers no model list can pass."
            onChange={(next) => onSetConfigField('defaultModel', next)}
          />
        </>
      )}

      {(form.type === 'anthropic' || form.type === 'google') && (
        <div className="editor-field">
          <label className="editor-label" htmlFor={apiKeyId}>
            API key
          </label>
          <input
            id={apiKeyId}
            className="editor-input"
            type="password"
            value={(form.config.apiKey as string) ?? ''}
            placeholder={
              apiKeyConfigured
                ? 'Saved secret — enter a new value to replace it'
                : form.type === 'anthropic'
                  ? 'sk-ant-…'
                  : 'AIza…'
            }
            onChange={(event) => onSetConfigField('apiKey', event.target.value)}
          />
          {apiKeyConfigured && (
            <div className="editor-field-hint">
              A secret is saved. Station never sends it back to this device.
              <button type="button" onClick={clearSavedApiKey}>
                Remove saved key
              </button>
            </div>
          )}
          {/*
           * Review M1: the chat probe reads `config.defaultModel` for every
           * model provider, so an Anthropic or Google connection whose
           * catalogue comes back empty or unsupported is told to set a default
           * model too — and this form could only set an API key, which made
           * that instruction another API-only remediation.
           */}
          <DefaultModelField
            id={defaultModelId}
            value={(form.config.defaultModel as string) ?? ''}
            options={modelOptions}
            placeholder="The model id to use when an agent names none"
            hint="Used when an agent names no model of its own, and it is the model Test Connection sends its one minimal chat request to if this provider returns no model list."
            onChange={(next) => onSetConfigField('defaultModel', next)}
          />
        </div>
      )}

      {form.type === 'bedrock' && (
        <>
          <ProviderRegionField
            id={regionId}
            value={(form.config.region as string) ?? ''}
            onChange={(next) => onSetConfigField('region', next)}
          />

          <div className="editor-field">
            <label className="editor-label" htmlFor="bedrock-auth-mode">
              Authentication
            </label>
            <select
              id="bedrock-auth-mode"
              className="editor-select"
              value={bedrockAuthMode}
              onChange={(event) =>
                handleBedrockAuthModeChange(event.target.value)
              }
            >
              <option value="chain">
                Default AWS credentials (recommended)
              </option>
              <option value="profile">Named AWS profile</option>
              <option value="api-key">Bedrock API key</option>
            </select>
          </div>

          {bedrockAuthMode === 'profile' && (
            <div className="editor-field">
              <label className="editor-label" htmlFor="bedrock-profile">
                AWS profile
              </label>
              {awsProfilesQuery.isLoading ? (
                <SkeletonBlock count={1} label="Loading AWS profiles" />
              ) : awsProfilesQuery.isError ? (
                <ErrorState
                  variant="compact"
                  title="Couldn't load AWS profiles"
                  description={
                    awsProfilesQuery.error instanceof Error
                      ? awsProfilesQuery.error.message
                      : 'Failed to load AWS profiles.'
                  }
                />
              ) : awsProfilesQuery.data?.profiles.length ? (
                <select
                  id="bedrock-profile"
                  className="editor-select"
                  value={(form.config.profile as string) ?? ''}
                  onChange={(event) =>
                    onSetConfigField('profile', event.target.value)
                  }
                >
                  <option value="">Choose a profile…</option>
                  {awsProfilesQuery.data.profiles.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              ) : (
                <Empty
                  variant="compact"
                  label="AWS profiles will appear here"
                  description={
                    awsProfilesQuery.data?.available === false
                      ? "An AWS config file wasn't found on this computer."
                      : 'Add named profiles to ~/.aws/config on this computer to choose one.'
                  }
                />
              )}
              {!!awsProfilesQuery.data?.profiles.length &&
                !(form.config.profile as string)?.trim() && (
                  <div className="editor-error">
                    A named AWS profile is required to save this connection.
                  </div>
                )}
            </div>
          )}

          {bedrockAuthMode === 'api-key' && (
            <div className="editor-field">
              <label className="editor-label" htmlFor="bedrock-api-key">
                Bedrock API key
              </label>
              <input
                id="bedrock-api-key"
                className="editor-input"
                type="password"
                value={(form.config.apiKey as string) ?? ''}
                placeholder={
                  apiKeyConfigured
                    ? 'Saved secret — enter a new value to replace it'
                    : 'ABSK…'
                }
                onChange={(event) =>
                  onSetConfigField('apiKey', event.target.value)
                }
              />
              {apiKeyConfigured && (
                <div className="editor-field-hint">
                  A secret is saved. Station never sends it back to this device.
                  <button type="button" onClick={clearSavedApiKey}>
                    Remove saved key
                  </button>
                </div>
              )}
              {!apiKeyConfigured && !(form.config.apiKey as string)?.trim() && (
                <div className="editor-error">
                  A Bedrock API key is required to save this connection.
                </div>
              )}
            </div>
          )}

          {/*
           * #3654 — an IAM policy may grant bedrock:InvokeModel and withhold
           * bedrock:ListFoundationModels, which is classified as "reachable,
           * no catalog" so the explicit test can go on to the one minimal chat
           * request that could still prove the connection works. That request
           * needs a model, and it is the same field the runtime already
           * resolves a model from when an agent names none.
           */}
          <DefaultModelField
            id={defaultModelId}
            value={(form.config.defaultModel as string) ?? ''}
            options={modelOptions}
            placeholder="A model or inference-profile id this account can invoke"
            hint="Used when an agent names no model of its own, and it is the model Test Connection sends its one minimal chat request to when this account cannot list Bedrock models."
            onChange={(next) => onSetConfigField('defaultModel', next)}
          />
        </>
      )}

      <div className="editor-field">
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'pointer',
            fontSize: '13px',
            color: 'var(--text-primary)',
          }}
        >
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) => onSetField('enabled', event.target.checked)}
          />
          Enabled
        </label>
      </div>

      {!isNew && selectedProviderId && (
        <div
          style={{
            paddingTop: '8px',
            borderTop: '1px solid var(--border-primary)',
          }}
        >
          <button
            type="button"
            className="editor-btn"
            onClick={() => onTestConnection(selectedProviderId)}
            disabled={isTesting}
            aria-describedby="provider-test-disclosure"
          >
            {isTesting ? 'Testing…' : 'Test Connection'}
          </button>
          {/* Delta2 review M2: the contract used to call this non-billable,
              and the button said nothing at all. It asks the provider for its
              model list, and when there is no list to ask for it sends one
              minimal chat request — which some providers bill. Say so before
              the press, not in a changelog. */}
          <p
            id="provider-test-disclosure"
            className="provider-detail__disclosure"
          >
            Asks this provider for its model list. If it offers none, Station
            sends one minimal chat request (max_tokens 1) using the default
            model — the only way to prove it can run work. Some providers bill
            for that request.
          </p>
          {testResult && (
            <div
              style={{
                fontSize: '13px',
                color: testResult.healthy
                  ? 'var(--success-text, #22c55e)'
                  : 'var(--error-text)',
                marginTop: '6px',
              }}
            >
              {testResult.healthy ? (
                <>
                  <CheckGlyph /> Connection healthy
                </>
              ) : (
                <>
                  {/* RT-06: "✗ Connection failed" with no reason, no HTTP
                      code and no remediation. The provider's own refusal
                      comes back with the result. */}
                  <CloseGlyph /> Connection failed
                  {testResult.reason ? ` — ${testResult.reason}` : ''}
                </>
              )}
            </div>
          )}
          {testError && (
            <div
              style={{
                fontSize: '13px',
                color: 'var(--error-text)',
                marginTop: '6px',
              }}
            >
              <CloseGlyph /> {testError}
            </div>
          )}
        </div>
      )}

      <details className="provider-detail__advanced">
        <summary>Advanced</summary>
        <div className="provider-detail__advanced-fields">
          <div className="editor-field">
            <label className="editor-label" htmlFor={providerTypeId}>
              Provider type
            </label>
            <select
              id={providerTypeId}
              className="editor-select"
              value={form.type}
              onChange={(event) => onTypeChange(event.target.value)}
            >
              {PROVIDER_TYPES.map((option) => (
                <option key={option.type} value={option.type}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>
          <div className="editor-field">
            <span className="editor-label">Capabilities</span>
            <div className="provider-detail__capabilities">
              {form.capabilities
                .filter((capability) => capability !== 'vectordb')
                .map((capability) => (
                  <span key={capability}>{capability}</span>
                ))}
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}
