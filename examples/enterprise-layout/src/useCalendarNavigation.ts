import { useLayoutNavigation } from '@kontourai/station-sdk';
import { useCallback, useState } from 'react';

const TAB = 'calendar';

function today(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Calendar navigation state with tab persistence via useLayoutNavigation.
 */
export function useCalendarNavigation() {
  const { getTabState, setTabState } = useLayoutNavigation();
  const saved = getTabState(TAB);

  const [selectedDate, setSelectedDateState] = useState<Date>(() => {
    const raw = saved?.get('date');
    return raw ? new Date(raw) : today();
  });
  const [viewMonth, setViewMonthState] = useState<Date>(() => {
    const raw = saved?.get('month');
    return raw ? new Date(raw) : today();
  });
  const [selectedEventId, setSelectedEventIdState] = useState<string | null>(
    saved?.get('eventId') ?? null,
  );
  const [isUserSelected, setIsUserSelected] = useState(false);
  const [selectedCategories, setSelectedCategoriesState] = useState<string[]>(
    () => {
      const raw = saved?.get('categories');
      return raw ? JSON.parse(raw) : [];
    },
  );
  const [filterExpanded, setFilterExpanded] = useState(false);
  const [allDayExpanded, setAllDayExpanded] = useState(false);

  const persist = useCallback(
    (overrides: Record<string, string>) => {
      const params = new URLSearchParams(saved ?? undefined);
      for (const [k, v] of Object.entries(overrides)) params.set(k, v);
      setTabState(TAB, params);
    },
    [saved, setTabState],
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

  const setSelectedEventId = useCallback(
    (id: string | null) => {
      setSelectedEventIdState(id);
      persist({ eventId: id ?? '' });
    },
    [persist],
  );

  const setSelectedCategories = useCallback(
    (cats: string[]) => {
      setSelectedCategoriesState(cats);
      persist({ categories: JSON.stringify(cats) });
    },
    [persist],
  );

  return {
    selectedDate,
    setSelectedDate,
    viewMonth,
    setViewMonth,
    selectedEventId,
    setSelectedEventId,
    isUserSelected,
    selectedCategories,
    setSelectedCategories,
    filterExpanded,
    setFilterExpanded,
    allDayExpanded,
    setAllDayExpanded,
  };
}
