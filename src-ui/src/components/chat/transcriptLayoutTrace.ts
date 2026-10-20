/**
 * Opt-in transcript layout tracer: the entry-side half.
 *
 * Debugs "space appears below / above while the conversation loads" on a
 * real device. Off by default and close to free when off: a phase mark
 * returns after two flag checks, and the observers in
 * `transcriptLayoutTracer.ts` (which ships in the lazily loaded transcript
 * chunk, not the entry bundle) attach only when tracing is requested. Turn it
 * on with
 *
 *   localStorage.debug = 'app:transcript-layout'   (the `debug` logger;
 *                                                   also prints each record)
 *
 * and reload. Then `window.__stationTranscriptTrace.dump()` returns the
 * bounded record buffer; see "Transcript layout tracing" in
 * docs/guides/development.md.
 */
import debug from 'debug';

const TRANSCRIPT_LAYOUT_TRACE_NAMESPACE = 'app:transcript-layout';

export interface TranscriptTraceState {
  isUserScrolledUp: boolean;
}

export interface TranscriptTraceSink {
  /** `at` is set for a mark replayed from before the tracer attached. */
  phase(label: string, detail?: Record<string, unknown>, at?: number): void;
  programmaticScroll(top: number): void;
}

export const transcriptTraceLogger = debug(TRANSCRIPT_LAYOUT_TRACE_NAMESPACE);

interface PendingPhase {
  label: string;
  detail?: Record<string, unknown>;
  at: number;
}

// Marks raised before the lazily loaded tracer attaches (the first pin runs in
// the same commit as the mount) wait here, bounded, and are replayed on attach.
const PENDING_CAPACITY = 200;
let pending: PendingPhase[] = [];
let pendingDropped = 0;
let sink: TranscriptTraceSink | null = null;

function readRequested(): boolean {
  try {
    // An explicit `localStorage.debug` only: a development build enables
    // `app:*` implicitly when it is unset (utils/logger.ts), and that must not
    // turn the observers on for every developer.
    return Boolean(
      typeof localStorage !== 'undefined' &&
        localStorage.getItem('debug') &&
        debug.enabled(TRANSCRIPT_LAYOUT_TRACE_NAMESPACE),
    );
  } catch {
    // Storage can be unavailable (privacy mode).
    return false;
  }
}

/**
 * A transcript row key can embed message text (its last-resort identity is
 * content-derived), so the tracer records a short one-way hash of it. The
 * same key always hashes the same, so records still correlate.
 */
export function traceKey(key: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

let requested = readRequested();

/** Whether tracing was requested; re-read so a toggle applies on next mount. */
export function transcriptLayoutTraceRequested(): boolean {
  requested = readRequested();
  return requested;
}

/** Records a named loading/scroll phase. A no-op unless tracing is on. */
export function markTranscriptPhase(
  label: string,
  detail?: Record<string, unknown>,
): void {
  if (sink) {
    sink.phase(label, detail);
    return;
  }
  if (!requested) return;
  if (pending.length >= PENDING_CAPACITY) {
    pending.shift();
    pendingDropped += 1;
  }
  pending.push({ label, detail, at: performance.now() });
}

/** Lets the tracer label the scroll event a programmatic write dispatches. */
export function noteTranscriptProgrammaticScroll(top: number): void {
  sink?.programmaticScroll(top);
}

/** Installs the tracer's sink and hands it every mark raised before it. */
export function installTranscriptTraceSink(next: TranscriptTraceSink) {
  sink = next;
  if (pendingDropped > 0)
    next.phase('pending-marks-dropped', { count: pendingDropped });
  for (const mark of pending) next.phase(mark.label, mark.detail, mark.at);
  pending = [];
  pendingDropped = 0;
  return () => {
    if (sink === next) sink = null;
  };
}
