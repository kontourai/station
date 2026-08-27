import type { ReactNode } from 'react';
import { Empty } from './Empty';
import './FilteredEmpty.css';

export function FilteredEmpty({
  query,
  noun = 'items',
  title,
  description = 'Clear the filter to see everything again.',
  icon,
  variant = 'compact',
  onClear,
}: {
  query: string;
  noun?: string;
  title?: string;
  description?: string;
  icon?: ReactNode;
  variant?: 'compact' | 'prominent';
  onClear: () => void;
}) {
  const visibleQuery = query.trim();
  return (
    <Empty
      variant={variant}
      icon={icon}
      label={title ?? `Nothing in ${noun} matches “${visibleQuery}”`}
      description={description}
      action={
        <button
          type="button"
          className="filtered-empty__clear"
          onClick={onClear}
        >
          Clear filter
        </button>
      }
    />
  );
}
