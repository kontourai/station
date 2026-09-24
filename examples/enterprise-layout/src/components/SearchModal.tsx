import { useEffect, useRef, useState } from 'react';
import { useTopmostModal } from './useTopmostModal';

/** What the modal can search. No CRM provider serves campaigns (#2402). */
export type SearchType = 'account' | 'opportunity';

export interface SearchResult {
  id: string;
  name: string;
  /**
   * What this result is. The person can switch type while a search is in
   * flight, so a result says what it is rather than inheriting the type the
   * modal was opened with (#2402).
   */
  kind: SearchType;
  website?: string;
  /** Shown as `Type: …` under the name. */
  type?: string;
}

export interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (item: SearchResult) => void;
  type: SearchType;
  /** Called to perform the search; returns matching results */
  onSearch: (query: string, type: SearchType) => Promise<SearchResult[]>;
}

export function SearchModal({
  isOpen,
  onClose,
  onSelect,
  type: initialType,
  onSearch,
}: SearchModalProps) {
  const [type, setType] = useState<SearchType>(initialType);
  const [searchInput, setSearchInput] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { dialogRef, onKeyDown } = useTopmostModal({
    isOpen,
    onClose,
    initialFocusRef: searchInputRef,
  });

  useEffect(() => {
    setType(initialType);
  }, [initialType]);

  // Debounced search
  useEffect(() => {
    if (!searchInput.trim() || !isOpen) {
      setSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const results = await onSearch(searchInput, type);
        setSearchResults(results);
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchInput, type, isOpen, onSearch]);

  const handleSelect = (item: SearchResult) => {
    onSelect(item);
    setSearchInput('');
    setSearchResults([]);
  };

  const getTypeLabel = (t: SearchType) =>
    t === 'opportunity' ? 'Opportunities' : 'Accounts';

  const switchType = (t: SearchType) => {
    setType(t);
    setSearchResults([]);
    setSearchInput('');
  };

  if (!isOpen) return null;

  return (
    <>
      <button
        type="button"
        className="search-modal-overlay enterprise-modal-backdrop"
        tabIndex={-1}
        aria-label="Close search"
        onClick={onClose}
      />
      <div
        className="search-modal-content"
        ref={dialogRef}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="search-modal-title"
      >
        <div className="search-modal-header">
          <h3 className="search-modal-title" id="search-modal-title">
            Search
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="search-modal-close-btn"
          >
            ✕
          </button>
        </div>
        <div className="search-modal-body">
          <div className="search-modal-type-toggle">
            {(['account', 'opportunity'] as SearchType[]).map((t) => (
              <button
                type="button"
                key={t}
                onClick={() => switchType(t)}
                className={`search-modal-type-btn ${
                  type === t
                    ? 'search-modal-type-btn--active'
                    : 'search-modal-type-btn--inactive'
                }`}
              >
                {getTypeLabel(t)}
              </button>
            ))}
          </div>
          <input
            ref={searchInputRef}
            type="text"
            placeholder={`Search ${getTypeLabel(type).toLowerCase()}...`}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="search-modal-input"
          />
          {searchLoading && (
            <div className="search-modal-loading">Searching...</div>
          )}
        </div>
        {searchResults.length > 0 && (
          <div className="search-modal-results">
            {searchResults.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => handleSelect(item)}
                className="search-modal-result-item"
              >
                <span className="search-modal-result-name">{item.name}</span>
                {item.website && (
                  <span className="search-modal-result-meta">
                    {item.website}
                  </span>
                )}
                {item.type && (
                  <span className="search-modal-result-meta">
                    Type: {item.type}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
