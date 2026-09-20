import {
  type CodingFileEntry,
  useCodingFileMentionCandidatesQuery,
} from '@kontourai/station-sdk/coding-file-mentions-query';
import { useEffect, useMemo, useRef, useState } from 'react';

function flatten(entries: readonly CodingFileEntry[]): CodingFileEntry[] {
  return entries.flatMap((entry) => [entry, ...flatten(entry.children ?? [])]);
}

export function FileMentionAutocomplete({
  workingDirectory,
  requestScope,
  query,
  keyboardController,
  onSelect,
}: {
  workingDirectory: string;
  requestScope: {
    apiBase: string;
    authorityKey: string;
    isCurrent: () => boolean;
  };
  query: string;
  keyboardController: React.MutableRefObject<
    ((key: 'ArrowDown' | 'ArrowUp' | 'Enter') => boolean) | null
  >;
  onSelect: (entry: CodingFileEntry) => void;
}) {
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  const pendingNavigationRef = useRef(0);
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    selectedRef.current = 0;
    pendingNavigationRef.current = 0;
    setSelected(0);
    const timer = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(timer);
  }, [query]);
  const querySettling = debouncedQuery !== query;
  const { data, isLoading, isError } = useCodingFileMentionCandidatesQuery(
    workingDirectory,
    debouncedQuery,
    requestScope,
  );
  const suggestions = useMemo(() => {
    if (querySettling || isError || !data) return [];
    const needle = query.toLocaleLowerCase();
    return flatten(data.entries)
      .filter(
        (entry) => !needle || entry.path.toLocaleLowerCase().includes(needle),
      )
      .sort((a, b) => {
        const ai = a.path.toLocaleLowerCase().indexOf(needle);
        const bi = b.path.toLocaleLowerCase().indexOf(needle);
        return (
          ai - bi ||
          a.path.length - b.path.length ||
          a.path.localeCompare(b.path)
        );
      })
      .slice(0, 8);
  }, [data, isError, query, querySettling]);
  useEffect(() => {
    if (suggestions.length === 0 || pendingNavigationRef.current === 0) return;
    selectedRef.current = Math.max(
      0,
      Math.min(pendingNavigationRef.current, suggestions.length - 1),
    );
    pendingNavigationRef.current = 0;
    setSelected(selectedRef.current);
  }, [suggestions]);
  const active = Math.min(selected, Math.max(0, suggestions.length - 1));
  keyboardController.current = (key) => {
    if (key === 'Enter') {
      if (suggestions[selectedRef.current]) {
        onSelect(suggestions[selectedRef.current]);
        return true;
      }
      return false;
    }
    const delta = key === 'ArrowDown' ? 1 : -1;
    if (suggestions.length === 0) {
      pendingNavigationRef.current = Math.max(
        0,
        pendingNavigationRef.current + delta,
      );
      return true;
    }
    selectedRef.current = Math.max(
      0,
      Math.min(selectedRef.current + delta, suggestions.length - 1),
    );
    setSelected(selectedRef.current);
    return true;
  };
  useEffect(() => {
    return () => {
      keyboardController.current = null;
    };
  }, [keyboardController]);

  return (
    <div
      className="file-mention-picker"
      role="listbox"
      aria-label="Files and folders"
    >
      {isLoading || querySettling ? (
        <div className="file-mention-picker__status">Finding files…</div>
      ) : null}
      {isError ? (
        <div className="file-mention-picker__status" role="status">
          Files unavailable
        </div>
      ) : null}
      {!isLoading && !querySettling && !isError && suggestions.length === 0 ? (
        <div className="file-mention-picker__status">Nothing found</div>
      ) : null}
      {!isLoading && !querySettling && !isError && data?.partial ? (
        <div className="file-mention-picker__status" role="status">
          Results are incomplete; refine the path
        </div>
      ) : null}
      {suggestions.map((entry, index) => (
        <button
          key={`${entry.type}:${entry.path}`}
          data-mention-key={`${entry.type}:${entry.path}`}
          type="button"
          role="option"
          aria-selected={index === active}
          className="file-mention-picker__option"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onSelect(entry)}
        >
          <span aria-hidden="true">
            {entry.type === 'directory' ? '▸' : '·'}
          </span>
          <span>{entry.path}</span>
        </button>
      ))}
    </div>
  );
}
