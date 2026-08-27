import { MS_PER_MINUTE } from '@kontourai/station-contracts/time';
import { useEffect, useRef, useState } from 'react';

export type RelativeTimeValue =
  | '5m'
  | '15m'
  | '1h'
  | '6h'
  | '24h'
  | '7d'
  | '30d';

export type MonitoringTimeMode = 'relative' | 'absolute';

interface MonitoringTimeLabelInput {
  clearTime: Date | null;
  timeMode: MonitoringTimeMode;
  absoluteStart: string;
  isLiveMode: boolean;
  elapsedLabel: string;
  relativeTime: RelativeTimeValue;
}

interface MonitoringTimeSublabelInput {
  clearTime: Date | null;
  timeMode: MonitoringTimeMode;
  absoluteStart: string;
  absoluteEnd: string;
  isLiveMode: boolean;
  relativeTime: RelativeTimeValue;
  now?: Date;
}

export function toLocalDateTimeInput(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * MS_PER_MINUTE)
    .toISOString()
    .slice(0, 16);
}

export function getMonitoringElapsedLabel(
  startTime: Date,
  now = new Date(),
): string {
  const elapsed = now.getTime() - startTime.getTime();
  const seconds = Math.floor(elapsed / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `Last ${days} day${days > 1 ? 's' : ''}`;
  }
  if (hours > 0) {
    return `Last ${hours} hour${hours > 1 ? 's' : ''}`;
  }
  if (minutes > 0) {
    return `Last ${minutes} min`;
  }
  return `Last ${seconds} sec`;
}

export function getMonitoringTimeLabel(
  input: MonitoringTimeLabelInput,
): string {
  if (
    (input.clearTime ||
      (input.timeMode === 'absolute' && input.absoluteStart)) &&
    input.isLiveMode
  ) {
    return input.elapsedLabel;
  }
  if (input.clearTime) {
    return 'Custom Range';
  }
  if (input.timeMode === 'relative') {
    const optionLabel =
      RELATIVE_TIME_LABELS[input.relativeTime] ?? input.relativeTime;
    return `Last ${optionLabel}`;
  }
  return 'Custom Range';
}

export function getMonitoringTimeSublabel(
  input: MonitoringTimeSublabelInput,
): string | null {
  const now = input.now ?? new Date();

  if (input.clearTime && !input.isLiveMode) {
    return `${formatMonitoringDate(input.clearTime)} -> ${formatMonitoringDate(
      now,
    )}`;
  }

  if (input.timeMode === 'relative' && !input.clearTime) {
    const start = new Date(now.getTime() - getRelativeMs(input.relativeTime));
    return `${formatMonitoringDate(start)} -> ${
      input.isLiveMode ? 'now' : formatMonitoringDate(now)
    }`;
  }

  if (
    input.timeMode === 'absolute' &&
    input.absoluteStart &&
    !input.clearTime
  ) {
    const start = new Date(input.absoluteStart);
    const end = input.absoluteEnd ? new Date(input.absoluteEnd) : now;
    return `${formatMonitoringDate(start)} -> ${formatMonitoringDate(end)}`;
  }

  return null;
}

export function useMonitoringTimeRange(
  clearEvents: () => void,
  setTimeRange: (start: Date, end: Date, live: boolean) => void,
) {
  const setTimeRangeRef = useRef(setTimeRange);
  const [timeMode, setTimeMode] = useState<MonitoringTimeMode>('absolute');
  const [relativeTime, setRelativeTime] = useState<RelativeTimeValue>('5m');
  const [absoluteStart, setAbsoluteStart] = useState('');
  const [absoluteEnd, setAbsoluteEnd] = useState('');
  const [isLiveMode, setIsLiveMode] = useState(true);
  const [clearTime, setClearTime] = useState<Date | null>(null);
  const [elapsedLabel, setElapsedLabel] = useState('');
  const [showTimeControls, setShowTimeControls] = useState(false);

  useEffect(() => {
    setTimeRangeRef.current = setTimeRange;
  }, [setTimeRange]);

  const handleClearAll = () => {
    clearEvents();
    const now = new Date();
    setClearTime(now);
    setTimeRange(now, now, true);
    setIsLiveMode(true);
    setTimeMode('absolute');
    const localDateTime = toLocalDateTimeInput(now);
    setAbsoluteStart(localDateTime);
    setAbsoluteEnd(localDateTime);
  };

  useEffect(() => {
    if (!isLiveMode) return;

    const updateEndTime = () => {
      setAbsoluteEnd(toLocalDateTimeInput(new Date()));
    };

    updateEndTime();
    const interval = setInterval(updateEndTime, 1000);
    return () => clearInterval(interval);
  }, [isLiveMode]);

  useEffect(() => {
    const startTime =
      clearTime ||
      (timeMode === 'absolute' && absoluteStart
        ? new Date(absoluteStart)
        : null);
    if (!startTime || !isLiveMode) return;

    const updateLabel = () => {
      setElapsedLabel(getMonitoringElapsedLabel(startTime));
    };

    updateLabel();
    const interval = setInterval(updateLabel, 1000);
    return () => clearInterval(interval);
  }, [clearTime, timeMode, absoluteStart, isLiveMode]);

  useEffect(() => {
    const now = new Date();
    const start = new Date(now.getTime() - 5 * 60 * 1000);
    setTimeRangeRef.current(start, now, true);
    setAbsoluteStart(toLocalDateTimeInput(start));
    setAbsoluteEnd(toLocalDateTimeInput(now));
    setTimeMode('relative');
  }, []);

  useEffect(() => {
    if (timeMode === 'relative') {
      const ms = getRelativeMs(relativeTime);
      const now = new Date();
      const start = new Date(now.getTime() - ms);
      setTimeRange(start, now, isLiveMode);
    } else if (absoluteStart) {
      const start = new Date(absoluteStart);
      const end = absoluteEnd ? new Date(absoluteEnd) : new Date();
      setTimeRange(start, end, isLiveMode);
    }
  }, [
    absoluteEnd,
    absoluteStart,
    isLiveMode,
    relativeTime,
    setTimeRange,
    timeMode,
  ]);

  const handleTimeModeChange = (mode: MonitoringTimeMode) => {
    if (mode === 'absolute' && !absoluteStart) {
      const start = new Date(Date.now() - getRelativeMs(relativeTime));
      setAbsoluteStart(toLocalDateTimeInput(start));
    }
    setTimeMode(mode);
  };

  const applyAbsoluteRange = () => {
    if (absoluteStart) {
      const start = new Date(absoluteStart);
      const end = absoluteEnd ? new Date(absoluteEnd) : new Date();
      setTimeRange(start, end, isLiveMode);
      setClearTime(null);
    }
    setShowTimeControls(false);
  };

  const selectRelativeTime = (value: RelativeTimeValue) => {
    setRelativeTime(value);
    setTimeMode('relative');
    setClearTime(null);
    setShowTimeControls(false);
  };

  const setAbsoluteEndValue = (value: string) => {
    setAbsoluteEnd(value);
    if (isLiveMode) setIsLiveMode(false);
  };

  const setAbsoluteEndToNow = () => {
    setAbsoluteEnd(toLocalDateTimeInput(new Date()));
    if (isLiveMode) setIsLiveMode(false);
  };

  return {
    timeMode,
    relativeTime,
    absoluteStart,
    absoluteEnd,
    isLiveMode,
    clearTime,
    elapsedLabel,
    showTimeControls,
    setAbsoluteStart,
    setIsLiveMode,
    setShowTimeControls,
    handleClearAll,
    handleTimeModeChange,
    applyAbsoluteRange,
    selectRelativeTime,
    setAbsoluteEndValue,
    setAbsoluteEndToNow,
  };
}

function formatMonitoringDate(date: Date): string {
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const RELATIVE_TIME_LABELS: Record<RelativeTimeValue, string> = {
  '5m': '5 min',
  '15m': '15 min',
  '1h': '1 hour',
  '6h': '6 hours',
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
};

function getRelativeMs(value: RelativeTimeValue): number {
  return RELATIVE_TIME_MS[value];
}

const RELATIVE_TIME_MS: Record<RelativeTimeValue, number> = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};
