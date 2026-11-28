import { useCallback, useEffect, useRef, useState } from 'react';

export type BackgroundStatusOutcome =
  | 'settled'
  | 'pending'
  | boolean
  | undefined;

export interface BackgroundStatusReconciliationOptions {
  /** Only schedule timers and listen for recovery events while active. */
  active: boolean;
  /** Resets backoff and exhaustion state whenever the watched entity changes. */
  resetKey?: unknown;
  /**
   * Read-only status check. Never trigger or retry a write/mutation here.
   * Returning `true` or `'settled'` stops further scheduled checks.
   */
  check: () =>
    | Promise<BackgroundStatusOutcome>
    | Promise<void>
    | BackgroundStatusOutcome
    | void;
  /**
   * Delay before the first scheduled check. Pass `null` (or omit) to disable
   * timer-based polling and react only to browser visibility/online/focus
   * events.
   */
  initialDelayMs?: number | null;
  /** Subsequent backoff delays after the first scheduled check. */
  intervalsMs?: readonly number[];
  /** Trigger a coalesced check when the tab becomes visible. Default: `true`. */
  recheckOnVisible?: boolean;
  /** Trigger a coalesced check when the browser comes online. Default: `true`. */
  recheckOnOnline?: boolean;
  /**
   * Trigger a coalesced check when the window regains focus (for external CLI
   * install or sign-in flows). Default: `false`.
   */
  recheckOnFocus?: boolean;
  /** Minimum interval between visibility/focus-triggered checks. Default: `1000`. */
  eventDebounceMs?: number;
}

export interface BackgroundStatusReconciliationState {
  /** A read-only check triggered by this hook is currently running. */
  checking: boolean;
  /**
   * Scheduled background checks completed without settling (or no timer
   * schedule was configured). Callers use this to demote manual check buttons
   * to a late fallback.
   */
  exhausted: boolean;
  /** Run one coalesced read-only check immediately. */
  checkNow: () => Promise<void>;
}

const DEFAULT_INTERVALS_MS: readonly number[] = [2_000, 4_000, 8_000];

function isSettledOutcome(outcome: BackgroundStatusOutcome | void): boolean {
  return outcome === true || outcome === 'settled';
}

/**
 * Quiet, bounded, read-only background status reconciliation.
 *
 * Keeps normal waits and transient blips visually calm by checking status on a
 * bounded backoff schedule plus visibility/online/focus recovery instead of
 * flashing manual "Check status" buttons. Never retries uncertain writes.
 */
export function useBackgroundStatusReconciliation({
  active,
  resetKey,
  check,
  initialDelayMs = null,
  intervalsMs = DEFAULT_INTERVALS_MS,
  recheckOnVisible = true,
  recheckOnOnline = true,
  recheckOnFocus = false,
  eventDebounceMs = 1_000,
}: BackgroundStatusReconciliationOptions): BackgroundStatusReconciliationState {
  const hasSchedule =
    typeof initialDelayMs === 'number' &&
    Number.isFinite(initialDelayMs) &&
    initialDelayMs >= 0;
  const intervalsKey = intervalsMs.join(',');

  const [checking, setChecking] = useState(false);
  const [exhausted, setExhausted] = useState(!hasSchedule);

  const checkRef = useRef(check);
  checkRef.current = check;
  const activeRef = useRef(active);
  activeRef.current = active;
  const generationRef = useRef(0);
  const inFlightRef = useRef<{ gen: number; task: Promise<boolean> } | null>(
    null,
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEventCheckAtRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const runOnce = useCallback(async (expectedGen: number): Promise<boolean> => {
    const existing = inFlightRef.current;
    if (existing) {
      if (existing.gen === expectedGen) return existing.task;
      // Wait for the previous generation's read to finish so two checks never
      // overlap, then run a fresh check for the current generation if still live.
      await existing.task;
      if (generationRef.current !== expectedGen || !activeRef.current)
        return true;
      if (inFlightRef.current?.gen === expectedGen)
        return inFlightRef.current.task;
    }
    const entry: { gen: number; task: Promise<boolean> } = {
      gen: expectedGen,
      task: Promise.resolve(false),
    };
    const task = (async () => {
      if (generationRef.current !== expectedGen || !activeRef.current)
        return true;
      setChecking(true);
      try {
        const outcome = await checkRef.current();
        return isSettledOutcome(outcome);
      } catch {
        return false;
      } finally {
        if (generationRef.current === expectedGen) setChecking(false);
        if (inFlightRef.current === entry) inFlightRef.current = null;
      }
    })();
    entry.task = task;
    inFlightRef.current = entry;
    return task;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intervalsKey serializes intervalsMs so inline array literals do not restart timers on every render.
  useEffect(() => {
    generationRef.current += 1;
    const gen = generationRef.current;
    clearTimer();
    setChecking(false);

    if (!active) {
      setExhausted(!hasSchedule);
      return;
    }

    setExhausted(!hasSchedule);

    let cancelled = false;
    let settled = false;
    const delays = hasSchedule ? [initialDelayMs, ...intervalsMs] : [];

    const markSettled = () => {
      settled = true;
      clearTimer();
    };

    const scheduleStep = (index: number) => {
      if (cancelled || settled || generationRef.current !== gen) return;
      if (index >= delays.length) {
        setExhausted(true);
        return;
      }
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        if (cancelled || settled || generationRef.current !== gen) return;
        void runOnce(gen).then((didSettle) => {
          if (cancelled || settled || generationRef.current !== gen) return;
          if (didSettle) {
            markSettled();
            return;
          }
          scheduleStep(index + 1);
        });
      }, delays[index]);
    };

    if (hasSchedule) scheduleStep(0);

    const triggerFromEvent = () => {
      if (
        cancelled ||
        settled ||
        generationRef.current !== gen ||
        !activeRef.current
      )
        return;
      const now = Date.now();
      if (now - lastEventCheckAtRef.current < eventDebounceMs) return;
      lastEventCheckAtRef.current = now;
      void runOnce(gen).then((didSettle) => {
        if (didSettle && generationRef.current === gen) markSettled();
      });
    };

    const onVisibility = () => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible'
      ) {
        triggerFromEvent();
      }
    };
    const onOnline = () => {
      lastEventCheckAtRef.current = 0;
      triggerFromEvent();
    };
    const onFocus = () => {
      triggerFromEvent();
    };

    if (recheckOnVisible && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    if (recheckOnOnline && typeof window !== 'undefined') {
      window.addEventListener('online', onOnline);
    }
    if (recheckOnFocus && typeof window !== 'undefined') {
      window.addEventListener('focus', onFocus);
    }

    return () => {
      cancelled = true;
      generationRef.current += 1;
      clearTimer();
      if (recheckOnVisible && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      if (recheckOnOnline && typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
      }
      if (recheckOnFocus && typeof window !== 'undefined') {
        window.removeEventListener('focus', onFocus);
      }
    };
  }, [
    active,
    resetKey,
    hasSchedule,
    initialDelayMs,
    intervalsKey,
    recheckOnVisible,
    recheckOnOnline,
    recheckOnFocus,
    eventDebounceMs,
    clearTimer,
    runOnce,
  ]);

  const checkNow = useCallback(async () => {
    const gen = generationRef.current;
    const settled = await runOnce(gen);
    if (settled && generationRef.current === gen) clearTimer();
  }, [clearTimer, runOnce]);

  return { checking, exhausted, checkNow };
}
