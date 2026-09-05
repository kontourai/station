import type { AttentionItem } from '@kontourai/station-contracts/attention';
import type { Notification } from '@kontourai/station-contracts/notification';
import { attentionKindLabel } from '../utils/attention';

export interface NotificationHistoryFilters {
  query: string;
  categories: string[];
  from: string;
  to: string;
}

export const EMPTY_NOTIFICATION_HISTORY_FILTERS: NotificationHistoryFilters = {
  query: '',
  categories: [],
  from: '',
  to: '',
};

export function readNotificationHistoryFilters(
  params: URLSearchParams,
): NotificationHistoryFilters {
  return {
    query: params.get('q') ?? '',
    categories: [...new Set(params.getAll('category').filter(Boolean))].sort(),
    from: validDate(params.get('from')),
    to: validDate(params.get('to')),
  };
}

export function writeNotificationHistoryFilters(
  params: URLSearchParams,
  filters: NotificationHistoryFilters,
): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of ['q', 'category', 'from', 'to']) next.delete(key);

  if (filters.query.trim()) next.set('q', filters.query.trim());
  for (const category of [...new Set(filters.categories)].sort()) {
    next.append('category', category);
  }
  if (filters.from) next.set('from', filters.from);
  if (filters.to) next.set('to', filters.to);
  return next;
}

export function hasNotificationHistoryFilters(
  filters: NotificationHistoryFilters,
): boolean {
  return Boolean(
    filters.query.trim() ||
      filters.categories.length ||
      filters.from ||
      filters.to,
  );
}

export function isNotificationHistoryDateRangeValid(
  filters: NotificationHistoryFilters,
): boolean {
  return !filters.from || !filters.to || filters.from <= filters.to;
}

export function filterNotificationHistory(
  items: AttentionItem[],
  notifications: Notification[],
  filters: NotificationHistoryFilters,
) {
  if (!isNotificationHistoryDateRangeValid(filters))
    return { items: [], notifications: [] };
  const terms = filters.query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const matches = (entry: FilterableHistoryEntry) => {
    if (
      !matchesCategory(entry.category, filters.categories) ||
      !matchesDate(entry.timestamp, filters)
    )
      return false;
    if (terms.length === 0) return true;
    const haystack = entry.searchText.toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  };

  return {
    items: items.filter((item) =>
      matches({
        category: item.kind,
        timestamp: item.updatedAt || item.createdAt,
        searchText:
          terms.length === 0
            ? ''
            : [
                attentionKindLabel(item.kind),
                item.kind,
                item.title,
                item.body,
                'requestType' in item ? item.requestType : undefined,
              ].join(' '),
      }),
    ),
    notifications: notifications.filter((notification) =>
      matches({
        category: notification.category,
        timestamp: notification.updatedAt || notification.createdAt,
        searchText:
          terms.length === 0
            ? ''
            : [
                notification.category,
                notification.source,
                notification.title,
                notification.body,
              ].join(' '),
      }),
    ),
  };
}

export function notificationHistoryCategories(
  items: AttentionItem[],
  notifications: Notification[],
  selected: string[],
): string[] {
  return [
    ...new Set([
      ...items.map((item) => item.kind),
      ...notifications.map((notification) => notification.category),
      ...selected,
    ]),
  ].sort();
}

interface FilterableHistoryEntry {
  category: string;
  timestamp: string;
  searchText: string;
}

function matchesCategory(category: string, selected: string[]): boolean {
  return selected.length === 0 || selected.includes(category);
}

function matchesDate(
  timestamp: string,
  filters: NotificationHistoryFilters,
): boolean {
  const date = localDate(timestamp);
  if (!date) return false;
  return (
    (!filters.from || date >= filters.from) &&
    (!filters.to || date <= filters.to)
  );
}

function validDate(value: string | null): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
    ? value
    : '';
}

function localDate(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
