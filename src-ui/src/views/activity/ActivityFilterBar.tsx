import { ArrowDownGlyph } from '../../components/icons/Glyph';
import {
  ACTIVITY_KIND_OPTIONS,
  type ActivityFilterOption,
  type ActivityFilters,
  type ActivityKindFilter,
  hasActiveActivityFilters,
} from './activity-list-model';

const ALL = '';

function FilterSelect({
  label,
  value,
  allLabel,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  allLabel: string;
  options: readonly ActivityFilterOption[];
  onChange: (value: string | null) => void;
}) {
  // A selected value no longer present in the data (its last session was
  // discarded) stays listed so the select never silently shows "All" while a
  // filter is still applied.
  const listed =
    value !== null && !options.some((option) => option.value === value)
      ? [...options, { value, label: value, count: 0 }]
      : options;
  return (
    <label className="activity-filter">
      <span className="activity-filter__label">{label}</span>
      <span className="activity-filter__control">
        <select
          className="choice-trigger activity-filter__select"
          value={value ?? ALL}
          onChange={(event) =>
            onChange(event.target.value === ALL ? null : event.target.value)
          }
        >
          <option value={ALL}>{allLabel}</option>
          {listed.map((option) => (
            <option key={option.value} value={option.value}>
              {`${option.label} (${option.count})`}
            </option>
          ))}
        </select>
        <ArrowDownGlyph className="choice-caret activity-filter__caret" />
      </span>
    </label>
  );
}

/**
 * Activity's compact filter bar: Kind, Project and Started from, each a
 * native select in the shared `.choice-trigger` treatment (the BrowserPane
 * viewport picker's shape). Filters compose with each other and with the
 * search box; the active ones repeat as removable chips with "Clear all".
 */
export function ActivityFilterBar({
  filters,
  projectOptions,
  originOptions,
  onChange,
  onClearAll,
  searchActive,
  resultsEmpty,
}: {
  filters: ActivityFilters;
  projectOptions: readonly ActivityFilterOption[];
  originOptions: readonly ActivityFilterOption[];
  onChange: (next: ActivityFilters) => void;
  onClearAll: () => void;
  /** A search query is typed; the reset then clears it too. */
  searchActive: boolean;
  /** The composed search + filters match nothing. */
  resultsEmpty: boolean;
}) {
  const filtersActive = hasActiveActivityFilters(filters);
  // The reset appears whenever a filter is set, and — so a filtered-empty
  // list always has its way out — when a search alone matched nothing.
  const showReset = filtersActive || (searchActive && resultsEmpty);
  const resetLabel = searchActive ? 'Clear search and filters' : 'Clear all';
  const kindLabel =
    ACTIVITY_KIND_OPTIONS.find((option) => option.value === filters.kind)
      ?.label ?? 'All';
  const chips: Array<{ id: string; text: string; clear: () => void }> = [];
  if (filters.kind !== 'all')
    chips.push({
      id: 'kind',
      text: `Kind: ${kindLabel}`,
      clear: () => onChange({ ...filters, kind: 'all' }),
    });
  if (filters.project !== null)
    chips.push({
      id: 'project',
      text: `Project: ${filters.project}`,
      clear: () => onChange({ ...filters, project: null }),
    });
  if (filters.origin !== null)
    chips.push({
      id: 'origin',
      text: `Started from: ${filters.origin}`,
      clear: () => onChange({ ...filters, origin: null }),
    });

  return (
    <div className="activity-filters">
      <fieldset className="activity-filters__row">
        <legend className="sr-only">Filter activity</legend>
        <label className="activity-filter">
          <span className="activity-filter__label">Kind</span>
          <span className="activity-filter__control">
            <select
              className="choice-trigger activity-filter__select"
              value={filters.kind}
              onChange={(event) =>
                onChange({
                  ...filters,
                  kind: event.target.value as ActivityKindFilter,
                })
              }
            >
              {ACTIVITY_KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <ArrowDownGlyph className="choice-caret activity-filter__caret" />
          </span>
        </label>
        <FilterSelect
          label="Project"
          allLabel="All projects"
          value={filters.project}
          options={projectOptions}
          onChange={(project) => onChange({ ...filters, project })}
        />
        <FilterSelect
          label="Started from"
          allLabel="Anywhere"
          value={filters.origin}
          options={originOptions}
          onChange={(origin) => onChange({ ...filters, origin })}
        />
      </fieldset>
      {showReset ? (
        // `responsive-surface-actions` is the shared action-row primitive: it
        // wraps, and gives its direct controls the 44px touch floor.
        <fieldset className="activity-filters__chips responsive-surface-actions">
          <legend className="sr-only">Active filters</legend>
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className="activity-filters__chip"
              aria-label={`Remove filter ${chip.text}`}
              onClick={chip.clear}
            >
              <span>{chip.text}</span>
              <span aria-hidden="true">✕</span>
            </button>
          ))}
          <button
            type="button"
            className="activity-filters__clear"
            onClick={onClearAll}
          >
            {resetLabel}
          </button>
        </fieldset>
      ) : null}
    </div>
  );
}
