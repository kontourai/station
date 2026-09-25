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

function readFocusState(doc: Document): FocusState {
  if (doc.visibilityState === 'hidden') return 'hidden';
  return doc.hasFocus() ? 'focused' : 'visible';
}

/** The server's answer, as much of it as the reporter reads. */
export type FocusReportResponse = Pick<Response, 'status' | 'headers'>;

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;
const RATE_LIMIT_FALLBACK_MS = 60_000;
/** A report that has not answered by now is abandoned and retried. */
export const FOCUS_REPORT_TIMEOUT_MS = 10_000;

/** `Retry-After` as delta-seconds or an HTTP-date (RFC 9110 §10.2.3). */
function retryAfterMs(response: FocusReportResponse, now: number): number {
  const value = response.headers.get('retry-after')?.trim() ?? '';
  if (/^\d+$/.test(value) && Number(value) > 0) return Number(value) * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(date - now, 1_000);
  return RATE_LIMIT_FALLBACK_MS;
}

/**
 * Reports this document's focus to Station (#2585) and returns a stop
 * function.
 *
 * - focus/blur/visibility changes are debounced by 1 s and sent when the
 *   state differs from the last one the server ACCEPTED (a 2xx);
 * - becoming hidden (visibility or `pagehide`) is sent at once, bypassing
 *   the debounce AND any report still in flight: a backgrounded mobile
 *   webview may be frozen or unloaded before either finishes, and a stale
 *   `focused` would keep suppressing this person's notifications for the rest
 *   of the lease. Sending it out of order is safe because the server always
 *   accepts a lowering report; if an older raising report was overtaken and
 *   lands afterwards, hidden is sent again;
 * - while focused, a 60 s heartbeat renews the lease only if there was user
 *   input in the last 2 minutes, so an unattended focused window lapses; the
 *   first input after the lease lapsed renews it at once;
 * - a refused report is retried: 429 after its Retry-After, a network or
 *   server error with backoff (2 s doubling to 30 s), until the state that
 *   is current then has been accepted;
 * - 401/403/400 are not retried on a timer. A 401 (not signed in yet) is
 *   retried on the next focus/visibility change, or by the next heartbeat
 *   tick after user input — so within a minute of signing in.
 *
 * Other reports go one at a time, so the server sees them in order; each is
 * abandoned after 10 s so a hung request cannot block the ones behind it.
 * Nothing here throws: presence is advisory and must never break the app.
 */
export function startFocusReporter(
  send: (
    state: FocusState,
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
  let acked: FocusState | undefined;
  let ackedAt = Number.NEGATIVE_INFINITY;
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  /** Bumped by every send; a send whose number is stale was overtaken. */
  let sequence = 0;
  let queued: FocusState | 'current' | undefined;
  let authBlocked = false;
  let backoffMs = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const clearDebounce = () => {
    if (debounce !== undefined) clearTimeout(debounce);
    debounce = undefined;
  };
  const retryIn = (ms: number) => {
    if (retry !== undefined) clearTimeout(retry);
    retry = setTimeout(() => {
      retry = undefined;
      flush();
    }, ms);
  };

  const transmit = async (
    state: FocusState,
  ): Promise<FocusReportResponse | undefined> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(undefined);
      }, FOCUS_REPORT_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => send(state, controller.signal)),
        timeout,
      ]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
  const settle = (
    state: FocusState,
    response: FocusReportResponse | undefined,
  ) => {
    const status = response?.status ?? 0;
    if (status >= 200 && status < 300) {
      acked = state;
      ackedAt = now();
      authBlocked = false;
      backoffMs = 0;
    } else if (response && status === 429) {
      retryIn(retryAfterMs(response, now()));
    } else if (status === 401) {
      authBlocked = true;
    } else if (status !== 400 && status !== 403) {
      backoffMs = Math.min(
        Math.max(backoffMs * 2, RETRY_BASE_MS),
        RETRY_MAX_MS,
      );
      retryIn(backoffMs);
    }
  };
  const sendHiddenNow = async () => {
    if (stopped) return;
    queued = undefined;
    sequence += 1;
    const mine = sequence;
    const response = await transmit('hidden');
    if (!stopped && mine === sequence) settle('hidden', response);
  };
  const deliver = async (state: FocusState) => {
    if (stopped) return;
    if (inFlight) {
      queued = state;
      return;
    }
    inFlight = true;
    sequence += 1;
    const mine = sequence;
    const response = await transmit(state);
    inFlight = false;
    if (stopped) return;
    if (mine === sequence) {
      settle(state, response);
    } else if (
      state !== 'hidden' &&
      response !== undefined &&
      response.status >= 200 &&
      response.status < 300 &&
      readFocusState(doc) === 'hidden'
    ) {
      // A hidden overtook this report, which may have landed after it.
      void sendHiddenNow();
      return;
    }
    const next = queued;
    queued = undefined;
    if (next === 'current') flush();
    else if (next) void deliver(next);
  };
  function flush() {
    debounce = undefined;
    if (stopped) return;
    if (inFlight) {
      queued ??= 'current';
      return;
    }
    const state = readFocusState(doc);
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
    clearDebounce();
    if (!stopped && (acked !== 'hidden' || inFlight)) void sendHiddenNow();
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
      readFocusState(doc) === 'focused'
    ) {
      void deliver('focused');
    }
  };
  const heartbeat = setInterval(() => {
    if (stopped) return;
    if (now() - lastInputAt > FOCUS_INPUT_RECENCY_MS) return;
    if (readFocusState(doc) === 'focused') {
      void deliver('focused');
    } else if (authBlocked) {
      flush();
    }
  }, FOCUS_HEARTBEAT_MS);

  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pagehide', onPageHide);
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
  return startFocusReporter((state, signal) =>
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
      }),
      keepalive: true,
    }),
  );
}
