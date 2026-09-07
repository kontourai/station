import { curatedModelIdentityByCanonicalId } from '@kontourai/station-contracts/model-inventory';
import { type KeyboardEvent, useMemo, useRef, useState } from 'react';
import {
  modelPreferenceKey,
  updateModelPickerPreferences,
  useModelPickerPreferences,
} from '../../settings/modelPickerPreferences';
import {
  groupModelsByCanonicalIdentity,
  type ModelProviderOption,
  type SelectableModel,
} from '../../utils/modelCapabilities';
import { CheckGlyph } from '../icons/Glyph';
import { ModelRuntimeOptionFields } from '../ModelRuntimeOptionFields';
import { Empty, SkeletonList } from '../state';
import { ModelCatalogUnavailableState } from './ModelCatalogUnavailableState';
import { ModelPickerDialogFrame } from './ModelPickerDialogFrame';
import './SessionModelPicker.css';

interface SessionModelPickerProps {
  models: SelectableModel[];
  /** Keep dialog keyboard/focus behavior while its resolved catalog is pending. */
  loading?: boolean;
  stale?: boolean;
  providers?: ModelProviderOption[];
  currentProviderId?: string;
  currentModel?: string;
  defaultModel?: string;
  defaultSourceLabel?: string;
  runtimeOptions?: Record<string, unknown>;
  onSelect: (model: SelectableModel) => void;
  onReset: () => void;
  onRuntimeOptionChange: (
    key: string,
    value: string | number | boolean | undefined,
  ) => void;
  onClose: () => void;
}

export function formatContextWindow(tokens: number): string {
  return tokens >= 1_000_000
    ? `${tokens / 1_000_000}m`
    : `${Math.round(tokens / 1_000)}k`;
}

export function SessionModelPicker({
  models,
  loading = false,
  stale = false,
  providers = [],
  currentProviderId,
  currentModel,
  defaultModel,
  defaultSourceLabel = 'default model',
  runtimeOptions = {},
  onSelect,
  onReset,
  onRuntimeOptionChange,
  onClose,
}: SessionModelPickerProps) {
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState(
    currentProviderId ?? 'all',
  );
  const [capabilityFilters, setCapabilityFilters] = useState<string[]>([]);
  const preferences = useModelPickerPreferences();
  const favoriteKeys = useMemo(
    () => new Set(preferences.favorites),
    [preferences.favorites],
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const activeModel = currentModel || defaultModel;
  const selectedModel =
    models.find(
      (model) =>
        model.id === activeModel &&
        (!currentProviderId || model.providerId === currentProviderId),
    ) ??
    models.find((model) => model.id === activeModel) ??
    models[0];
  const capabilities = selectedModel?.capabilities;
  const filters = useMemo(
    () => [
      {
        id: 'reasoning',
        label: 'Reasoning',
        matches: (model: SelectableModel) =>
          model.capabilities?.supportsEffort === true ||
          model.capabilities?.supportsAdaptiveThinking === true,
      },
      {
        id: 'vision',
        label: 'Vision',
        matches: (model: SelectableModel) => model.supportsVision === true,
      },
      {
        id: 'tools',
        label: 'Tool calling',
        matches: (model: SelectableModel) =>
          model.toolSurface?.includes('tool-calls') === true,
      },
      {
        id: 'fast',
        label: 'Fast',
        matches: (model: SelectableModel) =>
          model.capabilities?.supportsFastMode === true,
      },
    ],
    [],
  );
  const availableFilters = useMemo(
    () => filters.filter((filter) => models.some(filter.matches)),
    [filters, models],
  );
  const visibleModels = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const preferenceKeys = new Map(
      models.map((model) => [
        model,
        modelPreferenceKey(
          model.providerId ?? currentProviderId ?? 'current',
          model.id,
        ),
      ]),
    );
    const hiddenKeys = new Set(preferences.hidden);
    const selectedFilters = capabilityFilters.map((id) =>
      filters.find((filter) => filter.id === id),
    );
    const orderIndex = new Map(
      preferences.order.map((key, index) => [key, index]),
    );
    const recentIndex = new Map(
      preferences.recents.map((key, index) => [key, index]),
    );
    return models
      .filter((model) => !hiddenKeys.has(preferenceKeys.get(model)!))
      .filter(
        (model) =>
          needle.length > 0 ||
          providerFilter === 'all' ||
          (providerFilter === 'favorites'
            ? favoriteKeys.has(preferenceKeys.get(model)!)
            : model.providerId === providerFilter),
      )
      .filter((model) =>
        selectedFilters.every((filter) => filter?.matches(model)),
      )
      .filter(
        (model) =>
          !needle ||
          model.name.toLowerCase().includes(needle) ||
          model.id.toLowerCase().includes(needle) ||
          model.providerName?.toLowerCase().includes(needle),
      )
      .sort((a, b) => {
        const aKey = preferenceKeys.get(a)!;
        const bKey = preferenceKeys.get(b)!;
        const aOrder = orderIndex.get(aKey);
        const bOrder = orderIndex.get(bKey);
        if (aOrder !== undefined || bOrder !== undefined) {
          return (
            (aOrder ?? Number.MAX_SAFE_INTEGER) -
            (bOrder ?? Number.MAX_SAFE_INTEGER)
          );
        }
        const aRecent = recentIndex.get(aKey);
        const bRecent = recentIndex.get(bKey);
        if (aRecent !== undefined || bRecent !== undefined) {
          return (
            (aRecent ?? Number.MAX_SAFE_INTEGER) -
            (bRecent ?? Number.MAX_SAFE_INTEGER)
          );
        }
        return 0;
      });
  }, [
    currentProviderId,
    capabilityFilters,
    filters,
    models,
    favoriteKeys,
    preferences.hidden,
    preferences.order,
    preferences.recents,
    providerFilter,
    query,
  ]);

  const selectModel = (model: SelectableModel) => {
    const key = modelPreferenceKey(
      model.providerId ?? currentProviderId ?? 'current',
      model.id,
    );
    updateModelPickerPreferences((current) => ({
      ...current,
      recents: [key, ...current.recents.filter((entry) => entry !== key)],
    }));
    onSelect(model);
  };

  const toggleFavorite = (model: SelectableModel) => {
    const key = modelPreferenceKey(
      model.providerId ?? currentProviderId ?? 'current',
      model.id,
    );
    updateModelPickerPreferences((current) => ({
      ...current,
      favorites: current.favorites.includes(key)
        ? current.favorites.filter((entry) => entry !== key)
        : [...current.favorites, key],
    }));
  };

  const modelSections = useMemo(
    () =>
      groupModelsByCanonicalIdentity(visibleModels, (canonicalId) => {
        const reviewed = curatedModelIdentityByCanonicalId(canonicalId);
        return reviewed
          ? {
              displayName: reviewed.displayName,
              verifiedAgainst: reviewed.verifiedAgainst,
            }
          : undefined;
      }),
    [visibleModels],
  );

  const renderModelRow = (model: SelectableModel) => {
    const key = modelPreferenceKey(
      model.providerId ?? currentProviderId ?? 'current',
      model.id,
    );
    const active =
      model.id === activeModel &&
      (!currentProviderId ||
        !model.providerId ||
        model.providerId === currentProviderId);
    const favorite = favoriteKeys.has(key);
    const favoriteTarget = model.providerName
      ? `${model.name} (${model.providerName})`
      : model.name;
    return (
      <div className="session-model-picker__model-row" key={key}>
        <button
          type="button"
          role="option"
          aria-selected={active}
          disabled={model.available === false}
          className={active ? 'session-model-picker__model--active' : ''}
          onClick={() => selectModel(model)}
          onKeyDown={(event) =>
            moveOptionFocus(
              event,
              event.key === 'Home'
                ? 'first'
                : event.key === 'End'
                  ? 'last'
                  : event.key === 'ArrowUp'
                    ? -1
                    : 1,
            )
          }
        >
          <span>{model.name}</span>
          <small>
            {[model.providerName, model.id]
              .filter(Boolean)
              .filter((value, index, values) => values.indexOf(value) === index)
              .join(' · ')}
            {model.available === false
              ? ` · ${model.unavailableReason ?? 'Unavailable'}`
              : ''}
          </small>
          {(model.capabilities?.contextWindow ||
            model.supportsVision === true ||
            model.description) && (
            <small className="session-model-picker__model-metadata">
              {[
                model.capabilities?.contextWindow
                  ? formatContextWindow(model.capabilities.contextWindow)
                  : undefined,
                model.supportsVision === true ? 'Vision' : undefined,
                model.description,
              ]
                .filter(Boolean)
                .join(' · ')}
            </small>
          )}
          {active && (
            <span
              className="session-model-picker__model-check"
              aria-hidden="true"
            >
              <CheckGlyph />
            </span>
          )}
        </button>
        <button
          type="button"
          className="session-model-picker__favorite"
          aria-label={`${favorite ? 'Remove' : 'Add'} ${favoriteTarget} ${favorite ? 'from' : 'to'} favorites`}
          aria-pressed={favorite}
          disabled={model.available === false}
          onClick={() => toggleFavorite(model)}
        >
          {favorite ? '★' : '☆'}
        </button>
      </div>
    );
  };
  const moveOptionFocus = (
    event: KeyboardEvent<HTMLButtonElement>,
    direction: -1 | 1 | 'first' | 'last',
  ) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const options = Array.from(
      event.currentTarget
        .closest<HTMLElement>('[role="dialog"]')
        ?.querySelectorAll<HTMLButtonElement>(
          '[role="option"]:not(:disabled)',
        ) ?? [],
    );
    if (options.length === 0) return;
    const current = options.indexOf(event.currentTarget);
    const next =
      direction === 'first'
        ? 0
        : direction === 'last'
          ? options.length - 1
          : (current + direction + options.length) % options.length;
    options[next]?.focus();
  };

  return (
    <ModelPickerDialogFrame onClose={onClose}>
      {loading ? (
        <SkeletonList count={3} label="Loading models" />
      ) : (
        <>
          {stale && models.length > 0 && (
            <Empty
              className="session-model-picker__state"
              variant="compact"
              label="Model data could not be refreshed"
              description="Existing models, if shown, may be out of date."
            />
          )}
          {models.length > 0 ? (
            <>
              <input
                ref={searchRef}
                className="session-model-picker__search"
                type="search"
                placeholder="Search models…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {providers.length > 1 && (
                <fieldset
                  className="session-model-picker__providers"
                  aria-label="Providers"
                >
                  <button
                    type="button"
                    aria-pressed={providerFilter === 'favorites'}
                    onClick={() => setProviderFilter('favorites')}
                  >
                    ★ Favorites
                  </button>
                  <button
                    type="button"
                    aria-pressed={providerFilter === 'all'}
                    onClick={() => setProviderFilter('all')}
                  >
                    All
                  </button>
                  {providers.map((provider) => (
                    <button
                      type="button"
                      key={provider.id}
                      aria-label={provider.name}
                      aria-pressed={providerFilter === provider.id}
                      disabled={!provider.available}
                      title={
                        provider.available
                          ? provider.name
                          : `${provider.name}: ${provider.detail ?? 'Unavailable'}`
                      }
                      onClick={() => setProviderFilter(provider.id)}
                    >
                      {provider.name}
                      {!provider.available && (
                        <small>{provider.detail ?? 'Unavailable'}</small>
                      )}
                    </button>
                  ))}
                </fieldset>
              )}
              {availableFilters.length > 0 && (
                <fieldset
                  className="session-model-picker__filters"
                  aria-label="Capabilities"
                >
                  {availableFilters.map((filter) => (
                    <button
                      type="button"
                      key={filter.id}
                      aria-pressed={capabilityFilters.includes(filter.id)}
                      onClick={() =>
                        setCapabilityFilters((current) =>
                          current.includes(filter.id)
                            ? current.filter((id) => id !== filter.id)
                            : [...current, filter.id],
                        )
                      }
                    >
                      {filter.label}
                    </button>
                  ))}
                </fieldset>
              )}
              <div
                className="session-model-picker__models"
                role="listbox"
                aria-label="Models"
              >
                {modelSections.map((section) =>
                  section.kind === 'model' ? (
                    // A fieldset IS role="group", which is what a listbox
                    // accepts around its options; the legend names the model
                    // whose routes these are.
                    <fieldset
                      key={`model:${section.canonicalId}`}
                      className="session-model-picker__model-group"
                    >
                      <legend className="session-model-picker__model-group-name">
                        {section.displayName}
                      </legend>
                      {section.routes.map(renderModelRow)}
                    </fieldset>
                  ) : (
                    renderModelRow(section.model)
                  ),
                )}
                {visibleModels.length === 0 && (
                  <Empty
                    className="session-model-picker__state"
                    variant="compact"
                    label={
                      providerFilter === 'favorites' && !query
                        ? 'No favorite models yet.'
                        : 'Nothing matches your search.'
                    }
                  />
                )}
              </div>
            </>
          ) : (
            <ModelCatalogUnavailableState stale={stale} />
          )}
          <ModelRuntimeOptionFields
            idPrefix="session-model-picker"
            className="session-model-picker__effort"
            capabilities={capabilities}
            runtimeOptions={runtimeOptions}
            onRuntimeOptionChange={onRuntimeOptionChange}
          />
          {currentModel && (
            <button
              type="button"
              className="session-model-picker__reset"
              onClick={onReset}
            >
              Use {defaultSourceLabel}
            </button>
          )}
        </>
      )}
    </ModelPickerDialogFrame>
  );
}
