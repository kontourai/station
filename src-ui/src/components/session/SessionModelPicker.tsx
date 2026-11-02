import { curatedModelIdentityByCanonicalId } from '@kontourai/station-contracts/model-inventory';
import {
  type KeyboardEvent,
  type ReactNode,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  updateModelPickerPreferences,
  useModelPickerPreferences,
} from '../../settings/modelPickerPreferences';
import {
  chooseModelRoute,
  modelChoiceKey,
  visibleModelChoices,
} from '../../settings/modelPickerSelection';
import {
  groupModelsByCanonicalIdentity,
  type ModelProviderOption,
  type SelectableModel,
} from '../../utils/modelCapabilities';
import { Button } from '../Button';
import {
  BrainGlyph,
  CheckGlyph,
  DashboardGlyph,
  EngineGlyph,
  glyph,
  SearchGlyph,
  TimeGlyph,
} from '../icons/Glyph';
import { ModelIcon } from '../icons/ModelIcon';
import { ModelRuntimeOptionFields } from '../ModelRuntimeOptionFields';
import { Empty, FilteredEmpty, SkeletonList } from '../state';
import { ModelCatalogUnavailableState } from './ModelCatalogUnavailableState';
import { ModelPickerDialogFrame } from './ModelPickerDialogFrame';
import './SessionModelPicker.css';

const FavoriteGlyph = glyph(
  'm8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6L8 1.8Z',
);

interface SessionModelPickerProps {
  models: SelectableModel[];
  /** Keep dialog keyboard/focus behavior while its resolved catalog is pending. */
  loading?: boolean;
  stale?: boolean;
  providers?: ModelProviderOption[];
  currentProviderId?: string;
  currentExecutionAgentId?: string;
  stationControl?: ReactNode;
  bindingLabel?: string;
  catalogNotice?: string;
  currentModel?: string;
  defaultModel?: string;
  defaultSourceLabel?: string;
  runtimeOptions?: Record<string, unknown>;
  onSelect: (model: SelectableModel) => void;
  onReset: () => void;
  /**
   * Why the reset is refused right now. Set, the reset button is disabled
   * and states the reason the same way an unavailable model row does.
   */
  resetDisabledReason?: string;
  onRuntimeOptionChange: (
    key: string,
    value: string | number | boolean | undefined,
  ) => void;
  onClose: () => void;
  /** See `ModelPickerDialogFrame`'s `returnFocusTarget`. */
  returnFocusTarget?: HTMLElement | null;
  /** See `ModelPickerDialogFrame`'s `hostTitleId`. */
  hostTitleId?: string;
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
  currentExecutionAgentId,
  bindingLabel,
  stationControl,
  catalogNotice,
  currentModel,
  defaultModel,
  defaultSourceLabel = 'default model',
  runtimeOptions = {},
  onSelect,
  onReset,
  resetDisabledReason,
  onRuntimeOptionChange,
  onClose,
  returnFocusTarget,
  hostTitleId,
}: SessionModelPickerProps) {
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('all');
  const [capabilityFilters, setCapabilityFilters] = useState<string[]>([]);
  const preferences = useModelPickerPreferences();
  const favoriteKeys = useMemo(
    () => new Set(preferences.favorites),
    [preferences.favorites],
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const activeModel = currentModel || defaultModel;
  const matchingModels = models.filter(
    (model) =>
      model.id === activeModel &&
      model.executionAgentId === currentExecutionAgentId &&
      (!currentProviderId || model.providerId === currentProviderId),
  );
  const selectedModel =
    matchingModels.length === 1 ? matchingModels[0] : undefined;
  const capabilities = selectedModel?.capabilities;
  const hasRuntimeOptions = Boolean(
    (capabilities?.supportsEffort &&
      capabilities.supportedEffortLevels?.length) ||
      capabilities?.supportsAdaptiveThinking ||
      capabilities?.supportsFastMode ||
      capabilities?.supportsAutoMode,
  );
  const clearFilters = () => {
    setQuery('');
    setProviderFilter('all');
    setCapabilityFilters([]);
    searchRef.current?.focus();
  };
  const navigationChoices: (ModelProviderOption & { icon: ReactNode })[] = [
    {
      id: 'all',
      name: 'All models',
      icon: <DashboardGlyph />,
      available: true,
    },
    {
      id: 'favorites',
      name: 'Favorites',
      icon: <FavoriteGlyph />,
      available: true,
    },
    { id: 'recents', name: 'Recent', icon: <TimeGlyph />, available: true },
    ...(models.some((model) => model.engineName)
      ? [
          {
            id: 'current-engine',
            name: 'Current engine',
            icon: <EngineGlyph />,
            available: true,
          },
        ]
      : []),
    ...providers.map((provider) => {
      const model = models.find(
        (entry) =>
          entry.providerId === provider.id ||
          entry.executionAgentId === provider.id,
      );
      return {
        ...provider,
        icon: (
          <ModelIcon
            model={{
              id: provider.id,
              name: provider.name,
              providerType: model?.providerType,
            }}
            size={20}
          />
        ),
      };
    }),
  ];
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
    const choices = visibleModelChoices(
      models,
      preferences,
      query,
      providerFilter === 'current-engine' ? 'all' : providerFilter,
      currentProviderId,
    );
    return choices.filter(
      (model) =>
        (providerFilter !== 'current-engine' ||
          model.executionAgentId === currentExecutionAgentId) &&
        capabilityFilters.every((id) =>
          filters.find((filter) => filter.id === id)?.matches(model),
        ),
    );
  }, [
    models,
    preferences,
    query,
    providerFilter,
    currentProviderId,
    currentExecutionAgentId,
    capabilityFilters,
    filters,
  ]);
  const emptyFavorites =
    providerFilter === 'favorites' && preferences.favorites.length === 0;
  const emptyTitle = query.trim()
    ? 'Nothing matches your search.'
    : capabilityFilters.length > 0
      ? 'No models match these filters.'
      : emptyFavorites
        ? 'No favorite models yet.'
        : providerFilter === 'recents' && preferences.recents.length === 0
          ? 'No recent models yet.'
          : 'No models in this collection.';

  const selectModel = (model: SelectableModel) =>
    chooseModelRoute(model, onSelect, currentProviderId);

  const toggleFavorite = (model: SelectableModel) => {
    const key = modelChoiceKey(model, currentProviderId);
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
    const key = modelChoiceKey(model, currentProviderId);
    const active = model === selectedModel;
    const favorite = favoriteKeys.has(key);
    const favoriteTarget = model.providerName
      ? `${model.name} (${model.providerName})`
      : model.name;
    return (
      <div
        className="session-model-picker__model-row"
        key={JSON.stringify([model.executionAgentId, key])}
      >
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
          <ModelIcon model={model} />
          <span className="session-model-picker__model-name">{model.name}</span>
          <small>
            {[model.engineName, model.providerName, model.stationName]
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
                  ? `${formatContextWindow(model.capabilities.contextWindow)} context`
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
          <FavoriteGlyph />
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
    if (current === 0 && event.key === 'ArrowUp') {
      searchRef.current?.focus();
      return;
    }
    const next =
      direction === 'first'
        ? 0
        : direction === 'last'
          ? options.length - 1
          : (current + direction + options.length) % options.length;
    options[next]?.focus();
  };

  return (
    <ModelPickerDialogFrame
      onClose={onClose}
      returnFocusTarget={returnFocusTarget}
      hostTitleId={hostTitleId}
      title={
        stationControl || models.some((model) => model.executionAgentId)
          ? 'Engine & model'
          : 'Model'
      }
    >
      {stationControl}
      {catalogNotice && (
        <p className="session-model-picker__binding" role="alert">
          {catalogNotice}
        </p>
      )}
      {bindingLabel && (
        <p className="session-model-picker__binding">{bindingLabel}</p>
      )}
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
            <div className="session-model-picker__workspace">
              <nav
                className="session-model-picker__navigation"
                aria-label="Model collections"
              >
                {navigationChoices.map((choice) => (
                  <button
                    type="button"
                    key={choice.id}
                    aria-pressed={providerFilter === choice.id}
                    disabled={!choice.available}
                    title={choice.detail}
                    onClick={() => {
                      setProviderFilter(choice.id);
                      setQuery('');
                    }}
                  >
                    {choice.icon}
                    <span>{choice.name}</span>{' '}
                    {!choice.available && (
                      <small>{choice.detail ?? 'Unavailable'}</small>
                    )}
                  </button>
                ))}
              </nav>
              <div className="session-model-picker__catalog">
                <div className="session-model-picker__search-field">
                  <SearchGlyph />
                  <input
                    ref={searchRef}
                    aria-label="Search models"
                    className="session-model-picker__search"
                    type="search"
                    placeholder="Search models…"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setProviderFilter('all');
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowDown') {
                        const first = event.currentTarget
                          .closest('[role="dialog"]')
                          ?.querySelector<HTMLButtonElement>(
                            '[role="option"]:not(:disabled)',
                          );
                        if (first) {
                          event.preventDefault();
                          first.focus();
                        }
                      }
                    }}
                  />
                </div>
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
                <div className="session-model-picker__results-heading">
                  <span>
                    {query.trim()
                      ? 'Search results'
                      : (navigationChoices.find(
                          (choice) => choice.id === providerFilter,
                        )?.name ?? 'Models')}
                  </span>
                  <span role="status">
                    {visibleModels.length}{' '}
                    {visibleModels.length === 1 ? 'model' : 'models'}
                  </span>
                </div>
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
                    <FilteredEmpty
                      query={query}
                      noun="models"
                      onClear={clearFilters}
                      variant="compact"
                      title={emptyTitle}
                      description={
                        emptyFavorites && !query.trim()
                          ? 'Star a model to keep it here, or clear filters to browse.'
                          : 'Clear filters to see all models.'
                      }
                    />
                  )}
                </div>
              </div>
              {selectedModel && (
                <aside
                  className="session-model-picker__settings"
                  aria-label="Selected model settings"
                >
                  <div className="session-model-picker__selected-heading">
                    <ModelIcon model={selectedModel} size={28} />
                    <div>
                      <small>Current model</small>
                      <strong>{selectedModel.name}</strong>
                    </div>
                  </div>
                  {hasRuntimeOptions ? (
                    <ModelRuntimeOptionFields
                      idPrefix="session-model-picker"
                      className="session-model-picker__effort"
                      effortPresentation="choices"
                      capabilities={capabilities}
                      runtimeOptions={runtimeOptions}
                      disabled={selectedModel.available === false}
                      onRuntimeOptionChange={onRuntimeOptionChange}
                    />
                  ) : (
                    <p className="session-model-picker__settings-empty">
                      <BrainGlyph />
                      No adjustable settings reported.
                    </p>
                  )}
                </aside>
              )}
            </div>
          ) : catalogNotice ? null : (
            <ModelCatalogUnavailableState stale={stale} />
          )}
          {(currentModel || currentExecutionAgentId) && (
            <footer className="session-model-picker__footer">
              <Button
                variant="secondary"
                className="session-model-picker__reset"
                disabled={Boolean(resetDisabledReason)}
                onClick={onReset}
              >
                Use{' '}
                {currentExecutionAgentId
                  ? 'Agent defaults'
                  : defaultSourceLabel}
                {resetDisabledReason ? ` · ${resetDisabledReason}` : ''}
              </Button>
            </footer>
          )}
        </>
      )}
    </ModelPickerDialogFrame>
  );
}
