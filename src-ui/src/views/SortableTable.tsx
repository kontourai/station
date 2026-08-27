import { useMemo, useState } from 'react';
import './SortableTable.css';

type SortDir = 'asc' | 'desc';

export function useSortableTable<T extends Record<string, any>>(
  data: T[],
  defaultKey: keyof T & string,
  defaultDir: SortDir = 'asc',
  filterKeys?: (keyof T & string)[],
) {
  const [sortKey, setSortKey] = useState<keyof T & string>(defaultKey);
  const [sortDir, setSortDir] = useState<SortDir>(defaultDir);
  const [filterText, setFilterText] = useState('');

  const toggle = (key: keyof T & string) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sorted = useMemo(() => {
    let items = [...data];
    if (filterText && filterKeys?.length) {
      const q = filterText.toLowerCase();
      items = items.filter((row) =>
        filterKeys.some((k) =>
          String(row[k] ?? '')
            .toLowerCase()
            .includes(q),
        ),
      );
    }
    items.sort((a, b) => {
      const av = a[sortKey],
        bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp =
        typeof av === 'number'
          ? av - (bv as number)
          : (av as unknown) instanceof Date
            ? av.getTime() - (bv as Date).getTime()
            : String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return items;
  }, [data, sortKey, sortDir, filterText, filterKeys]);

  return { sorted, sortKey, sortDir, toggle, filterText, setFilterText };
}

export function SortHeader({
  label,
  sortKey,
  active,
  dir,
  onClick,
  style,
}: {
  label: string;
  sortKey: string;
  active: boolean;
  dir: SortDir;
  onClick: (key: string) => void;
  style?: React.CSSProperties;
}) {
  return (
    <th
      className="sortable-table__th sortable-table__th--sortable"
      style={style}
      // Only the sorted column carries aria-sort. Writing "none" on every
      // other header makes each of them announce a sort state they do not
      // have, and leaves nothing for a screen reader to skip to.
      aria-sort={
        active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined
      }
    >
      <button
        type="button"
        className="sortable-table__sort-button"
        onClick={() => onClick(sortKey)}
      >
        {label} {active ? (dir === 'asc' ? '↑' : '↓') : ''}
      </button>
    </th>
  );
}

export function TableFilter({
  value,
  onChange,
  placeholder = 'Filter…',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="sortable-table__filter-input"
    />
  );
}
