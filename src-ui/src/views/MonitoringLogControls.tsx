import type { KeyboardEvent } from 'react';
import { EVENT_TYPE_GROUPS } from './monitoring-utils';

interface MonitoringAutocompleteOption {
  type: string;
  value: string;
  label: string;
  isEmpty?: boolean;
  emptyMessage?: string;
}

interface MonitoringLogControlsProps {
  eventTypeFilter: string[];
  onToggleEventType: (group: string) => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onSearchBlur: () => void;
  showAutocomplete: boolean;
  autocompleteOptions: MonitoringAutocompleteOption[];
  selectedIndex: number;
  onAutocompleteSelect: (option: MonitoringAutocompleteOption) => void;
  actions?: React.ReactNode;
}

export function MonitoringLogControls(props: MonitoringLogControlsProps) {
  return (
    <div className="log-controls">
      <div className="log-controls-row">
        <div className="event-filters">
          {Object.keys(EVENT_TYPE_GROUPS).map((group) => {
            const groupTypes =
              EVENT_TYPE_GROUPS[group as keyof typeof EVENT_TYPE_GROUPS];
            const allSelected = groupTypes.every((type) =>
              props.eventTypeFilter.includes(type),
            );
            return (
              <button
                type="button"
                key={group}
                onClick={() => props.onToggleEventType(group)}
                className={`event-filter ${allSelected ? 'active' : ''}`}
                // 6-OPS-34: same derivation the `active` class already reads,
                // now also exposed to assistive technology rather than being
                // carried by colour alone.
                aria-pressed={allSelected}
                data-type={group.toLowerCase()}
              >
                {group.toUpperCase()}
              </button>
            );
          })}
        </div>

        <div className="search-wrapper">
          <input
            type="text"
            placeholder="Search logs... (try: agent:name or conversation:id)"
            value={props.searchQuery}
            onChange={(event) => props.onSearchQueryChange(event.target.value)}
            onKeyDown={props.onSearchKeyDown}
            onBlur={props.onSearchBlur}
            className="search-input"
          />
          {props.searchQuery && (
            <button
              type="button"
              className="search-clear"
              onClick={() => props.onSearchQueryChange('')}
              title="Clear search"
            >
              ×
            </button>
          )}

          {props.showAutocomplete && (
            <div className="autocomplete-dropdown">
              {props.autocompleteOptions.map((option, idx) => (
                // biome-ignore lint/a11y/noStaticElementInteractions: mouse-only convenience; ArrowUp/ArrowDown/Enter navigate and select via the search input's onSearchKeyDown handler above.
                // biome-ignore lint/a11y/useKeyWithClickEvents: same — the combobox input owns the keyboard path, so an option must not become its own tab stop.
                <div
                  key={idx}
                  className={`autocomplete-item ${idx === props.selectedIndex ? 'selected' : ''} ${option.isEmpty ? 'empty' : ''}`}
                  data-type={option.type}
                  onClick={() =>
                    !option.isEmpty && props.onAutocompleteSelect(option)
                  }
                >
                  {option.isEmpty ? (
                    <div className="autocomplete-empty">
                      <div>{option.label}</div>
                      {option.emptyMessage && (
                        <div className="autocomplete-hint">
                          {option.emptyMessage}
                        </div>
                      )}
                    </div>
                  ) : (
                    <>
                      <span className="autocomplete-type">{option.type}</span>
                      {option.value}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {props.actions ? (
          <div className="log-controls-actions">{props.actions}</div>
        ) : null}
      </div>
    </div>
  );
}
