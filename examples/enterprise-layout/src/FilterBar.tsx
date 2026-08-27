interface FilterBarProps {
  geos: string[];
  sizes: string[];
  selectedGeos: string[];
  selectedSizes: string[];
  nameFilter: string;
  expanded: boolean;
  activeFilters: string[];
  onNameChange: (v: string) => void;
  onGeoToggle: (geo: string) => void;
  onSizeToggle: (size: string) => void;
  onRemoveFilter: (filter: string) => void;
  onClearAll: () => void;
  onToggleExpanded: () => void;
}

export function FilterBar({
  geos,
  sizes,
  selectedGeos,
  selectedSizes,
  nameFilter,
  expanded,
  activeFilters,
  onNameChange,
  onGeoToggle,
  onSizeToggle,
  onRemoveFilter,
  onClearAll,
  onToggleExpanded,
}: FilterBarProps) {
  return (
    <div className="filter-bar">
      {/* Active filter chips */}
      {activeFilters.length > 0 && (
        <div className="filter-bar-chips">
          {activeFilters.map((f) => (
            <span key={f} className="filter-chip">
              {f}
              <button
                type="button"
                className="filter-chip-remove"
                onClick={() => onRemoveFilter(f)}
                aria-label={`Remove filter ${f}`}
              >
                ✕
              </button>
            </span>
          ))}
          <button
            type="button"
            className="filter-chip-clear-all"
            onClick={onClearAll}
          >
            Clear all
          </button>
        </div>
      )}

      {/* Name search */}
      <div className="filter-bar-search">
        <input
          type="text"
          className="filter-bar-input"
          placeholder="Filter by name…"
          value={nameFilter}
          onChange={(e) => onNameChange(e.target.value)}
        />
        <button
          type="button"
          className={`filter-bar-toggle-btn ${expanded ? 'filter-bar-toggle-btn--active' : ''}`}
          onClick={onToggleExpanded}
          aria-expanded={expanded}
        >
          Filters {activeFilters.length > 0 ? `(${activeFilters.length})` : ''}
          <span className="filter-bar-toggle-icon">{expanded ? '▲' : '▼'}</span>
        </button>
      </div>

      {/* Expanded filter panels */}
      {expanded && (
        <div className="filter-bar-panels">
          {geos.length > 0 && (
            <div className="filter-bar-panel">
              <div className="filter-bar-panel-title">Geography</div>
              <div className="filter-bar-panel-options">
                {geos.map((geo) => (
                  <label key={geo} className="filter-bar-option">
                    <input
                      type="checkbox"
                      checked={selectedGeos.includes(geo)}
                      onChange={() => onGeoToggle(geo)}
                    />
                    <span>{geo}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {sizes.length > 0 && (
            <div className="filter-bar-panel">
              <div className="filter-bar-panel-title">Segment</div>
              <div className="filter-bar-panel-options">
                {sizes.map((size) => (
                  <label key={size} className="filter-bar-option">
                    <input
                      type="checkbox"
                      checked={selectedSizes.includes(size)}
                      onChange={() => onSizeToggle(size)}
                    />
                    <span>{size}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
