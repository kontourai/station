import { useEffect, useState } from 'react';

interface FilterConfig {
  key: string;
  type: 'agent' | 'conversation' | 'tool' | 'trace';
  getOptions: () => string[];
}

interface AutocompleteOption {
  type: string;
  value: string;
  label: string;
  isEmpty?: boolean;
  emptyMessage?: string;
}

export function useSearchAutocomplete(
  searchQuery: string,
  filters: FilterConfig[],
) {
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteOptions, setAutocompleteOptions] = useState<
    AutocompleteOption[]
  >([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    setSelectedIndex(0);
  }, []);

  useEffect(() => {
    const query = searchQuery.toLowerCase();
    const lastWord = query.split(/\s+/).pop() || '';

    // Check if typing a complete filter
    for (const filter of filters) {
      const filterKey = `${filter.key}:`;
      if (lastWord.startsWith(filterKey)) {
        const prefix = lastWord.substring(filterKey.length);
        const options = filter
          .getOptions()
          .filter((opt) => !prefix || opt.toLowerCase().includes(prefix))
          .map((opt) => ({
            type: filter.type,
            value: opt,
            label: `${filterKey}${opt}`,
          }));

        if (options.length === 0 && prefix.length === 0) {
          // Show empty state message
          setAutocompleteOptions([
            {
              type: filter.type,
              value: '',
              label: `No ${filter.key}s available`,
              isEmpty: true,
              emptyMessage: 'Try expanding the date range to see more results',
            },
          ]);
          setShowAutocomplete(true);
        } else {
          setAutocompleteOptions(options.slice(0, 10));
          setShowAutocomplete(options.length > 0);
        }
        return;
      }
    }

    // Check if typing partial filter keyword
    if (lastWord) {
      const matchingFilters = filters
        .filter((f) => `${f.key}:`.startsWith(lastWord))
        .filter((f) => f.getOptions().length > 0); // Only show if options available
      if (matchingFilters.length > 0) {
        const options = matchingFilters.map((f) => ({
          type: f.type,
          value: `${f.key}:`,
          label: `${f.key}:`,
        }));
        setAutocompleteOptions(options);
        setShowAutocomplete(true);
        return;
      }
    }

    setShowAutocomplete(false);
  }, [searchQuery, filters]);

  const handleSelect = (option: AutocompleteOption) => {
    const words = searchQuery.split(/\s+/);
    words[words.length - 1] = option.label;
    // Only add space if it's a complete selection (not just the keyword)
    const addSpace =
      option.label.includes(':') && option.label.split(':')[1].length > 0;
    return words.join(' ') + (addSpace ? ' ' : '');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showAutocomplete || autocompleteOptions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % autocompleteOptions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(
        (prev) =>
          (prev - 1 + autocompleteOptions.length) % autocompleteOptions.length,
      );
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      const option = autocompleteOptions[selectedIndex];
      if (!option.isEmpty) {
        e.preventDefault();
        return handleSelect(option);
      }
    } else if (e.key === 'Escape') {
      setShowAutocomplete(false);
    }
    return null;
  };

  return {
    showAutocomplete,
    autocompleteOptions,
    selectedIndex,
    handleSelect,
    handleKeyDown,
  };
}

export function parseSearchQuery(query: string, filterKeys: string[]) {
  const filters: Record<string, string[]> = {};
  let textQuery = query;

  for (const key of filterKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?:^|\\s)(${escaped}:(\\S+))`, 'g');
    const matches = [...query.matchAll(regex)];
    if (matches.length > 0) {
      filters[key] = matches.map((m) => m[2]);
      // Remove the matched filter from text query
      matches.forEach((m) => {
        textQuery = textQuery.replace(m[1], '').trim();
      });
    }
  }

  return { filters, text: textQuery };
}
