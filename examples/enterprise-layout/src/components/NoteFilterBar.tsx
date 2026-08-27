interface NoteFilterBarProps {
  query: string;
  territory: string;
  type: string;
  status: string;
  onQueryChange: (v: string) => void;
  onTerritoryChange: (v: string) => void;
  onTypeChange: (v: string) => void;
  onStatusChange: (v: string) => void;
  onClear: () => void;
}

export function NoteFilterBar({
  query,
  territory,
  type,
  status,
  onQueryChange,
  onTerritoryChange,
  onTypeChange,
  onStatusChange,
  onClear,
}: NoteFilterBarProps) {
  const hasFilters = !!(query || territory || type || status);

  return (
    <div className="note-filter-bar">
      <input
        type="text"
        className="note-filter-input note-filter-input--query"
        placeholder="Search notes…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      <input
        type="text"
        className="note-filter-input"
        placeholder="Territory"
        value={territory}
        onChange={(e) => onTerritoryChange(e.target.value)}
      />
      <select
        className="note-filter-select"
        value={type}
        onChange={(e) => onTypeChange(e.target.value)}
      >
        <option value="">All types</option>
        <option value="meeting">Meeting</option>
        <option value="account">Account</option>
        <option value="opportunity">Opportunity</option>
        <option value="general">General</option>
      </select>
      <select
        className="note-filter-select"
        value={status}
        onChange={(e) => onStatusChange(e.target.value)}
      >
        <option value="">All statuses</option>
        <option value="raw">Raw</option>
        <option value="enhanced">Enhanced</option>
      </select>
      {hasFilters && (
        <button
          type="button"
          className="note-filter-clear-btn"
          onClick={onClear}
          title="Clear filters"
        >
          ✕ Clear
        </button>
      )}
    </div>
  );
}
