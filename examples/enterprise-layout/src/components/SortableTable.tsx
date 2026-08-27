import { useMemo, useState } from 'react';

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
          : av instanceof Date
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
      onClick={() => onClick(sortKey)}
      style={{ ...style, cursor: 'pointer', userSelect: 'none' }}
    >
      {label} {active ? (dir === 'asc' ? '↑' : '↓') : ''}
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
      style={{
        padding: '0.35rem 0.6rem',
        fontSize: '0.8rem',
        borderRadius: '0.375rem',
        border: '1px solid var(--border-primary, var(--color-border, #333))',
        background: 'var(--bg-tertiary, var(--color-bg-hover, transparent))',
        color: 'var(--text-primary, var(--color-text-primary, inherit))',
        outline: 'none',
        width: '100%',
        maxWidth: '240px',
      }}
    />
  );
}
