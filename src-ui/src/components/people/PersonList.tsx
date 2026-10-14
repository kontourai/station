import { Fragment, type ReactNode, useId } from 'react';
import { Empty } from '../state';
import './people.css';

/** At this many people the list offers a filter. */
const PEOPLE_FILTER_THRESHOLD = 6;

/** The list's filter: shown at `PEOPLE_FILTER_THRESHOLD` people or more. */
export interface PersonListFilter<T> {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  matches: (item: T, needle: string) => boolean;
  /**
   * Rows never filtered away, such as one holding an unshown secret or an
   * open form: hiding them would hide work the reader has not finished.
   */
  pinned?: (item: T) => boolean;
}

/**
 * A divided list of `PersonRow`s, with the empty state, the filter once the
 * list is long, and the filter's own "nothing matches" state. Without
 * `filter` every item is always shown.
 */
export function PersonList<T>({
  items,
  itemKey,
  renderItem,
  label,
  empty,
  filter,
  busy,
}: {
  items: readonly T[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  /** The list's accessible name. */
  label?: string;
  /** Shown instead of the list when there is nobody at all. */
  empty?: ReactNode;
  filter?: PersonListFilter<T>;
  busy?: boolean;
}) {
  const filterId = useId();
  if (items.length === 0 && empty !== undefined) return <>{empty}</>;
  const filtering =
    filter !== undefined && items.length >= PEOPLE_FILTER_THRESHOLD;
  const needle = filtering ? filter.value.trim().toLowerCase() : '';
  const visible = filtering
    ? items.filter(
        (item) =>
          !needle || filter.matches(item, needle) || filter.pinned?.(item),
      )
    : items;
  return (
    <>
      {filtering && (
        <label className="person-list__filter" htmlFor={filterId}>
          <span className="person-list__filter-label">Filter</span>
          <input
            id={filterId}
            type="search"
            className="person-list__filter-input"
            placeholder={filter.placeholder}
            value={filter.value}
            onChange={(event) => filter.onChange(event.target.value)}
          />
        </label>
      )}
      {visible.length === 0 && filtering ? (
        <Empty
          className="person-list__none"
          label="Nobody matches that filter."
        />
      ) : (
        <ul className="person-list" aria-label={label} aria-busy={busy}>
          {visible.map((item) => (
            <Fragment key={itemKey(item)}>{renderItem(item)}</Fragment>
          ))}
        </ul>
      )}
    </>
  );
}
