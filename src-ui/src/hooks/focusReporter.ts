import {
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

/**
 * Reports this document's focus to Station (#2585) and returns a stop
 * function.
 *
 * - focus/blur/visibility changes are debounced by 1 s and sent only when the
 *   state differs from the last one sent;
 * - becoming hidden is sent at once: a backgrounded mobile webview may be
 *   frozen before a debounce timer fires, and a stale `focused` would keep
 *   suppressing this person's notifications for the rest of the lease;
 * - while focused, a 60 s heartbeat renews the lease only if there was user
 *   input in the last 2 minutes, so an unattended focused window lapses.
 *
 * `send` failures are swallowed: presence is advisory and must never break
 * the app.
 */
export function startFocusReporter(
  send: (state: FocusState) => Promise<unknown> | undefined,
  env: FocusReporterEnvironment = {
    document,
    window,
    now: () => Date.now(),
  },
): () => void {
  const { document: doc, window: win, now } = env;
  let stopped = false;
  let lastSent: FocusState | undefined;
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let debounce: ReturnType<typeof setTimeout> | undefined;

  const emit = (state: FocusState) => {
    lastSent = state;
    try {
      void Promise.resolve(send(state)).catch(() => {});
    } catch {
      /* advisory */
    }
  };
  const flush = () => {
    debounce = undefined;
    if (stopped) return;
    const state = readFocusState(doc);
    if (state !== lastSent) emit(state);
  };
  const schedule = () => {
    if (stopped) return;
    if (debounce !== undefined) clearTimeout(debounce);
    debounce = setTimeout(flush, FOCUS_REPORT_DEBOUNCE_MS);
  };
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') {
      if (debounce !== undefined) clearTimeout(debounce);
      flush();
      return;
    }
    schedule();
  };
  // The page is going away (or into the back/forward cache) and may already
  // read as visible; nothing after this runs, so say hidden now.
  const onPageHide = () => {
    if (debounce !== undefined) clearTimeout(debounce);
    debounce = undefined;
    if (!stopped && lastSent !== 'hidden') emit('hidden');
  };
  const onFocus = () => {
    lastInputAt = now();
    schedule();
  };
  const onInput = () => {
    lastInputAt = now();
  };
  const heartbeat = setInterval(() => {
    if (stopped) return;
    if (readFocusState(doc) !== 'focused') return;
    if (now() - lastInputAt > FOCUS_INPUT_RECENCY_MS) return;
    emit('focused');
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
    if (debounce !== undefined) clearTimeout(debounce);
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
  return startFocusReporter((state) =>
    authenticatedFetch(url, {
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
