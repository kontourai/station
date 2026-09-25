import {
  FOCUS_PRESENCE_LEASE_MS,
  FOCUS_PRESENCE_REPORT_PATH,
  type FocusState,
} from '@kontourai/station-contracts/presence';
import { authenticatedFetch } from '@kontourai/station-sdk';
import { CLIENT_DOCUMENT_SESSION_ID } from './clientDocumentSession';

/** Collapses a burst of focus/blur/visibility events into one report. */
export const FOCUS_REPORT_DEBOUNCE_MS = 1_000;
/** Keeps a focused surface's lease alive; the server lease is 120 s. */
export const FOCUS_HEARTBEAT_MS = 60_000;
/** A focused window nobody has touched for this long stops heartbeating. */
export const FOCUS_INPUT_RECENCY_MS = 120_000;

const INPUT_EVENTS = [
  'pointerdown',
  'pointermove',
  'keydown',
  'wheel',
  'touchstart',
] as const;

export interface FocusReporterEnvironment {
  readonly document: Document;
  readonly window: Window;
  readonly now: () => number;
}

function readFocusState(doc: Document, pageHidden = false): FocusState {
  if (pageHidden || doc.visibilityState === 'hidden') return 'hidden';
  return doc.hasFocus() ? 'focused' : 'visible';
}

/** The server's answer, as much of it as the reporter reads. */
export type FocusReportResponse = Pick<Response, 'status' | 'headers'>;

/** A report that has not answered by now is abandoned (and superseded). */
export const FOCUS_REPORT_TIMEOUT_MS = 10_000;
const RETRY_BASE_MS = 2_000;
const RETRY_BACKOFF_MAX_MS = 30_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 300_000;
const RATE_LIMIT_FALLBACK_MS = 60_000;

function clampRetry(ms: number): number {
  return Math.min(Math.max(ms, RETRY_MIN_MS), RETRY_MAX_MS);
}

/**
 * `Retry-After` in ms: delta-seconds when the value is only digits, an
 * HTTP-date when it contains a letter, otherwise the 60 s fallback. Always
 * clamped to [1 s, 5 min] — setTimeout overflows past 2^31-1 ms.
 */
export function retryAfterMs(value: string | null, now: number): number {
  const trimmed = value?.trim() ?? '';
  if (/^\d+$/.test(trimmed)) return clampRetry(Number(trimmed) * 1000);
  if (/[a-z]/i.test(trimmed)) {
    const date = Date.parse(trimmed);
    if (Number.isFinite(date)) return clampRetry(date - now);
  }
  return RATE_LIMIT_FALLBACK_MS;
}

/**
 * Reports this document's focus to Station (#2585) and returns a stop
 * function.
 *
 * Ordering is the server's job: every send carries the next value of a
 * per-document counter (`seq`), and the server ignores any report whose seq
 * is not above the last one it applied for this document. So a slow older
 * report that lands late can never overwrite a newer one, and this client
 * never has to repair order.
 *
 * - focus/blur/visibility changes are debounced by 1 s and sent when the
 *   state differs from the last one the server acknowledged;
 * - becoming hidden (visibility or `pagehide`) is sent at once with the next
 *   seq, not waiting for the debounce or for a report in flight: a
 *   backgrounded mobile webview may be frozen or unloaded before either
 *   finishes, and a stale `focused` would keep suppressing this person's
 *   notifications for the rest of the lease;
 * - after `pagehide` the page counts as hidden until `pageshow`, so nothing
 *   reports it focused while it is being unloaded or cached;
 * - every other report goes one at a time and is abandoned after 10 s;
 * - "acknowledged" means a 2xx for a seq higher than any acknowledged
 *   before. After a 2xx, if the page's state now differs from the
 *   acknowledged one, it is sent (this is how a change made while a report
 *   was in flight gets through);
 * - a failed send is retried by timer with a new seq: 429 after its
 *   Retry-After, a network error, timeout or 5xx with backoff (2 s doubling
 *   to 30 s). Every delay is clamped to [1 s, 5 min]. A network error,
 *   timeout or 5xx may still have landed, so it also forgets the
 *   acknowledged state and the retry sends the current state unconditionally;
 * - 400/403 are not retried. A 401 (not signed in yet) is retried on the
 *   next focus/visibility change, or by the next heartbeat tick after user
 *   input — so within a minute of signing in;
 * - while focused, a 60 s heartbeat renews the lease only if there was user
 *   input in the last 2 minutes, so an unattended focused window lapses; the
 *   first input after the lease lapsed renews it at once.
 *
 * Nothing here throws: presence is advisory and must never break the app.
 */
export function startFocusReporter(
  send: (
    state: FocusState,
    seq: number,
    signal: AbortSignal,
  ) => Promise<FocusReportResponse>,
  env: FocusReporterEnvironment = {
    document,
    window,
    now: () => Date.now(),
  },
): () => void {
  const { document: doc, window: win, now } = env;
  let stopped = false;
  let nextSeq = 1;
  let acked: FocusState | undefined;
  let ackedSeq = 0;
  let ackedAt = Number.NEGATIVE_INFINITY;
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  let flushQueued = false;
  let authBlocked = false;
  let backoffMs = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  /** Between `pagehide` and `pageshow` the page is hidden whatever it reads. */
  let pageHidden = false;
  const currentState = () => readFocusState(doc, pageHidden);

  const clearDebounce = () => {
    if (debounce !== undefined) clearTimeout(debounce);
    debounce = undefined;
  };
  const retryIn = (ms: number) => {
    if (retry !== undefined) clearTimeout(retry);
    retry = setTimeout(() => {
      retry = undefined;
      flush();
    }, clampRetry(ms));
  };

  const transmit = async (
    state: FocusState,
  ): Promise<{ seq: number; response: FocusReportResponse | undefined }> => {
    const seq = nextSeq;
    nextSeq += 1;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(undefined);
      }, FOCUS_REPORT_TIMEOUT_MS);
    });
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => send(state, seq, controller.signal)),
        timeout,
      ]);
      return { seq, response };
    } catch {
      return { seq, response: undefined };
    } finally {
      clearTimeout(timer);
    }
  };

  /** Records one settled send; returns whether it was a 2xx. */
  const settle = (
    state: FocusState,
    seq: number,
    response: FocusReportResponse | undefined,
  ): boolean => {
    const status = response?.status ?? 0;
    if (status >= 200 && status < 300) {
      if (seq > ackedSeq) {
        acked = state;
        ackedSeq = seq;
        ackedAt = now();
      }
      authBlocked = false;
      backoffMs = 0;
      return true;
    }
    if (response && status === 429) {
      retryIn(retryAfterMs(response.headers.get('retry-after'), now()));
    } else if (status === 401) {
      authBlocked = true;
    } else if (status !== 400 && status !== 403) {
      // A network error, timeout or 5xx may still have landed. The server's
      // state is unknown, so the retry sends the current state whatever it
      // is (with a new seq, which also outranks the uncertain one).
      acked = undefined;
      backoffMs = Math.min(
        Math.max(backoffMs * 2, RETRY_BASE_MS),
        RETRY_BACKOFF_MAX_MS,
      );
      retryIn(backoffMs);
    }
    return false;
  };

  const afterSettle = (succeeded: boolean) => {
    if (stopped || inFlight) return;
    const queued = flushQueued;
    flushQueued = false;
    if (queued || (succeeded && currentState() !== acked)) flush();
  };

  const sendHiddenNow = async () => {
    if (stopped) return;
    const { seq, response } = await transmit('hidden');
    if (stopped) return;
    afterSettle(settle('hidden', seq, response));
  };

  const deliver = async (state: FocusState) => {
    if (stopped) return;
    if (inFlight) {
      flushQueued = true;
      return;
    }
    inFlight = true;
    const { seq, response } = await transmit(state);
    inFlight = false;
    if (stopped) return;
    afterSettle(settle(state, seq, response));
  };
  function flush() {
    debounce = undefined;
    if (stopped) return;
    if (inFlight) {
      flushQueued = true;
      return;
    }
    const state = currentState();
    if (state !== acked) void deliver(state);
  }
  const schedule = () => {
    if (stopped) return;
    clearDebounce();
    debounce = setTimeout(flush, FOCUS_REPORT_DEBOUNCE_MS);
  };
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') {
      clearDebounce();
      if (acked !== 'hidden' || inFlight) void sendHiddenNow();
      return;
    }
    schedule();
  };
  // The page is going away (or into the back/forward cache) and may already
  // read as visible; nothing after this runs, so say hidden now.
  const onPageHide = () => {
    pageHidden = true;
    clearDebounce();
    if (!stopped && (acked !== 'hidden' || inFlight)) void sendHiddenNow();
  };
  // Restored from the back/forward cache: report whatever it reads now.
  const onPageShow = () => {
    pageHidden = false;
    schedule();
  };
  const onFocus = () => {
    lastInputAt = now();
    schedule();
  };
  const onInput = () => {
    lastInputAt = now();
    // A focused document whose lease lapsed while nobody touched it is
    // absent on the server; the person is back, so say so now rather than
    // at the next heartbeat.
    if (
      !authBlocked &&
      !inFlight &&
      acked === 'focused' &&
      now() - ackedAt >= FOCUS_PRESENCE_LEASE_MS &&
      currentState() === 'focused'
    ) {
      void deliver('focused');
    }
  };
  const heartbeat = setInterval(() => {
    if (stopped || inFlight) return;
    if (now() - lastInputAt > FOCUS_INPUT_RECENCY_MS) return;
    if (currentState() === 'focused') {
      void deliver('focused');
    } else if (authBlocked) {
      flush();
    }
  }, FOCUS_HEARTBEAT_MS);

  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', onPageHide);
  win.addEventListener('pageshow', onPageShow);
  win.addEventListener('focus', onFocus);
  win.addEventListener('blur', schedule);
  for (const type of INPUT_EVENTS) {
    win.addEventListener(type, onInput, { passive: true, capture: true });
  }
  schedule();

  return () => {
    stopped = true;
    clearDebounce();
    if (retry !== undefined) clearTimeout(retry);
    clearInterval(heartbeat);
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pagehide', onPageHide);
    win.removeEventListener('pageshow', onPageShow);
    win.removeEventListener('focus', onFocus);
    win.removeEventListener('blur', schedule);
    for (const type of INPUT_EVENTS) {
      win.removeEventListener(type, onInput, { capture: true });
    }
  };
}

/** Starts reporting this document's focus to the Station at `apiBase`. */
export function startStationFocusReporter(apiBase: string): () => void {
  const url = `${apiBase}${FOCUS_PRESENCE_REPORT_PATH}`;
  return startFocusReporter((state, seq, signal) =>
    authenticatedFetch(url, {
      signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Station-Client-Session': CLIENT_DOCUMENT_SESSION_ID,
      },
      body: JSON.stringify({
        clientSessionId: CLIENT_DOCUMENT_SESSION_ID,
        state,
        seq,
      }),
      keepalive: true,
    }),
  );
}
