import { useMemo, useState } from 'react';
import type { AccountVM } from './data/viewmodels';

const DEFAULT_LIMIT = 25;

export interface CRMFilters {
  activeFilters: string[];
  filterExpanded: boolean;
  selectedGeos: string[];
  selectedSizes: string[];
  nameFilter: string;
  displayLimit: number;
}

/**
 * Filter state for the CRM accounts list.
 */
export function useCRMFilters(accounts: AccountVM[]) {
  const [filterExpanded, setFilterExpanded] = useState(false);
  const [selectedGeos, setSelectedGeos] = useState<string[]>([]);
  const [selectedSizes, setSelectedSizes] = useState<string[]>([]);
  const [nameFilter, setNameFilter] = useState('');
  const [displayLimit, setDisplayLimit] = useState(DEFAULT_LIMIT);

  const allGeos = useMemo(
    () =>
      [
        ...new Set(
          accounts.map((a) => a.territory).filter(Boolean) as string[],
        ),
      ].sort(),
    [accounts],
  );

  const allSizes = useMemo(
    () =>
      [
        ...new Set(accounts.map((a) => a.segment).filter(Boolean) as string[]),
      ].sort(),
    [accounts],
  );

  const filteredAccounts = useMemo(() => {
    let result = accounts;
    if (nameFilter) {
      const q = nameFilter.toLowerCase();
      result = result.filter((a) => a.name.toLowerCase().includes(q));
    }
    if (selectedGeos.length) {
      result = result.filter(
        (a) => a.territory && selectedGeos.includes(a.territory),
      );
    }
    if (selectedSizes.length) {
      result = result.filter(
        (a) => a.segment && selectedSizes.includes(a.segment),
      );
    }
    return result;
  }, [accounts, nameFilter, selectedGeos, selectedSizes]);

  const activeFilters = useMemo(() => {
    const filters: string[] = [];
    if (nameFilter) filters.push(`name:${nameFilter}`);
    selectedGeos.forEach((g) => filters.push(`geo:${g}`));
    selectedSizes.forEach((s) => filters.push(`size:${s}`));
    return filters;
  }, [nameFilter, selectedGeos, selectedSizes]);

  function removeFilter(filter: string) {
    if (filter.startsWith('name:')) setNameFilter('');
    else if (filter.startsWith('geo:'))
      setSelectedGeos((prev) => prev.filter((g) => `geo:${g}` !== filter));
    else if (filter.startsWith('size:'))
      setSelectedSizes((prev) => prev.filter((s) => `size:${s}` !== filter));
  }

  function clearFilters() {
    setNameFilter('');
    setSelectedGeos([]);
    setSelectedSizes([]);
  }

  return {
    activeFilters,
    filterExpanded,
    setFilterExpanded,
    selectedGeos,
    setSelectedGeos,
    selectedSizes,
    setSelectedSizes,
    nameFilter,
    setNameFilter,
    displayLimit,
    setDisplayLimit,
    allGeos,
    allSizes,
    filteredAccounts,
    removeFilter,
    clearFilters,
  };
}
