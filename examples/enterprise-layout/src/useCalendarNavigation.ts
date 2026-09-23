import { useLayoutNavigation } from '@kontourai/station-sdk';
import { useCallback, useState } from 'react';

const TAB = 'calendar';

function today(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** `YYYY-MM-DD` in local time (toISOString would give the UTC date). */
export function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseCategories(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((c): c is string => typeof c === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}

/**
 * Calendar navigation state with tab persistence via useLayoutNavigation.
 *
 * The SDK stores a tab's state as one string; this hook keeps it as URL
 * search params. A selection the person makes (selectEvent) is persisted and
 * marked user-selected; one the calendar makes for them (autoSelectEvent) is
 * neither, so it does not overwrite the saved state or scroll the list.
 */
export function useCalendarNavigation() {
  const { getTabState, setTabState } = useLayoutNavigation();

  const [initial] = useState(() => new URLSearchParams(getTabState(TAB)));
  const [selectedDate, setSelectedDateState] = useState<Date>(() => {
    const raw = initial.get('date');
    return raw ? new Date(raw) : today();
  });
  const [viewMonth, setViewMonthState] = useState<Date>(() => {
    const raw = initial.get('month');
    return raw ? new Date(raw) : today();
  });
  const [selectedEventId, setSelectedEventIdState] = useState<string | null>(
    () => initial.get('eventId') || null,
  );
  const [isUserSelected, setIsUserSelected] = useState(false);
  const [selectedCategories, setSelectedCategoriesState] = useState<
    Set<string>
  >(() => parseCategories(initial.get('categories')));
  const [filterExpanded, setFilterExpanded] = useState(false);
  const [allDayExpanded, setAllDayExpanded] = useState(false);

  const persist = useCallback(
    (overrides: Record<string, string>) => {
      // Read the stored state at write time, so each write merges into the
      // latest one rather than a copy captured at an earlier render.
      const params = new URLSearchParams(getTabState(TAB));
      for (const [k, v] of Object.entries(overrides)) params.set(k, v);
      setTabState(TAB, params.toString());
    },
    [getTabState, setTabState],
  );

  const setSelectedDate = useCallback(
    (date: Date) => {
      setSelectedDateState(date);
      setIsUserSelected(true);
      persist({ date: date.toISOString() });
    },
    [persist],
  );

  const setViewMonth = useCallback(
    (month: Date) => {
      setViewMonthState(month);
      persist({ month: month.toISOString() });
    },
    [persist],
  );

  const selectEvent = useCallback(
    (id: string) => {
      setSelectedEventIdState(id);
      setIsUserSelected(true);
      persist({ eventId: id });
    },
    [persist],
  );

  const autoSelectEvent = useCallback((id: string) => {
    setSelectedEventIdState(id);
    setIsUserSelected(false);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedEventIdState(null);
    setIsUserSelected(false);
    persist({ eventId: '' });
  }, [persist]);

  const setSelectedCategories = useCallback(
    (cats: Set<string>) => {
      setSelectedCategoriesState(cats);
      persist({ categories: JSON.stringify([...cats]) });
    },
    [persist],
  );

  return {
    selectedDate,
    setSelectedDate,
    viewMonth,
    setViewMonth,
    selectedEventId,
    isUserSelected,
    selectEvent,
    autoSelectEvent,
    clearSelection,
    selectedCategories,
    setSelectedCategories,
    filterExpanded,
    setFilterExpanded,
    allDayExpanded,
    setAllDayExpanded,
    formatLocalDate,
  };
}
