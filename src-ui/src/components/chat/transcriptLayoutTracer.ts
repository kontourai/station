/**
 * Transcript layout tracer: the observers. Loaded only when tracing is
 * requested (see `transcriptLayoutTrace.ts`).
 *
 * Every record carries the scroller's geometry at the time it was taken, so a
 * dump reads as a timeline: which row or sibling changed height, which scroll
 * was ours and which was the reader, which layout shift the browser saw and
 * what caused it, and which loading phase was active.
 */
import { type RefObject, useLayoutEffect, useRef } from 'react';
import {
  installTranscriptTraceSink,
  type TranscriptTraceState,
  traceKey,
  transcriptLayoutTraceRequested,
  transcriptTraceLogger,
} from './transcriptLayoutTrace';

export const TRANSCRIPT_TRACE_CAPACITY = 2000;
const OVERLAY_STORAGE_KEY = 'station.transcriptTrace.overlay';
const PROGRAMMATIC_ECHO_MS = 500;
const PROGRAMMATIC_ECHO_PX = 1;
const OBSERVED_SELECTOR = [
  '[data-chat-message-key]',
  '[data-transcript-row]',
  '[data-testid="virtualized-transcript-spacer"]',
  '.session-history-controls',
].join(',');

export type TranscriptTraceKind =
  | 'attach'
  | 'detach'
  | 'phase'
  | 'resize'
  | 'scroll'
  | 'layout-shift'
  | 'rows'
  | 'sibling';

export interface TranscriptTraceRecord {
  seq: number;
  t: number;
  kind: TranscriptTraceKind;
  sessionId: string;
  /** Row key or element description the record is about. */
  target?: string;
  label?: string;
  /**
   * A phase raised before the tracer attached: `t` is when it was raised,
   * but the geometry fields were read at attach time.
   */
  replayed?: true;
  from?: number;
  to?: number;
  detail?: Record<string, unknown>;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
  isUserScrolledUp: boolean;
}

export interface TranscriptTraceDump {
  capacity: number;
  /** Every record ever taken, including those the ring buffer let go. */
  total: number;
  /** Records overwritten because the buffer was full. */
  dropped: number;
  records: TranscriptTraceRecord[];
}

class TraceBuffer {
  private records: TranscriptTraceRecord[] = [];
  total = 0;
  dropped = 0;

  constructor(readonly capacity: number) {}

  push(record: Omit<TranscriptTraceRecord, 'seq'>): TranscriptTraceRecord {
    const full = { ...record, seq: this.total };
    this.total += 1;
    if (this.records.length >= this.capacity) {
      this.records.shift();
      this.dropped += 1;
    }
    this.records.push(full);
    return full;
  }

  dump(): TranscriptTraceDump {
    return {
      capacity: this.capacity,
      total: this.total,
      dropped: this.dropped,
      records: [...this.records],
    };
  }

  clear() {
    this.records = [];
    this.total = 0;
    this.dropped = 0;
  }
}

/** One buffer per page, so a chat switch keeps the previous chat's records. */
let buffer: TraceBuffer | null = null;
// A re-attach (chat switch) replays the browser's buffered layout shifts;
// those already recorded are skipped.
let lastShiftAt = Number.NEGATIVE_INFINITY;
let overlayEnabled = false;
let overlayElement: HTMLElement | null = null;

export interface TranscriptTraceApi {
  dump(): TranscriptTraceDump;
  clear(): void;
  /** Shows or hides the live overlay; persists for the next reload. */
  overlay(on?: boolean): boolean;
}

declare global {
  interface Window {
    __stationTranscriptTrace?: TranscriptTraceApi;
  }
}

/**
 * Describes a node without user content: a transcript row by its role and a
 * hash of its key (`traceKey`), anything else by its test id, else its tag,
 * classes and ARIA role. Accessible labels are never read: they can carry
 * file names and message text.
 */
export function describeTraceNode(node: Node | null | undefined): string {
  if (!(node instanceof Element)) return 'unknown';
  const row = node.closest<HTMLElement>(
    '.chat-message-anchor[data-chat-message-key], [data-transcript-row]',
  );
  const rowKey = row?.dataset.chatMessageKey ?? row?.dataset.transcriptRow;
  if (row && rowKey) {
    const role =
      row.dataset.chatRole ??
      row.querySelector<HTMLElement>('[data-chat-role]')?.dataset.chatRole;
    return `row:${role ?? 'row'}#${traceKey(rowKey)}`;
  }
  const testId = node.getAttribute('data-testid');
  if (testId) return `${node.tagName.toLowerCase()}#${testId}`;
  const classes =
    typeof node.className === 'string'
      ? node.className.split(/\s+/).filter(Boolean).slice(0, 2)
      : [];
  const ariaRole = node.getAttribute('role');
  return `${node.tagName.toLowerCase()}${classes.map((name) => `.${name}`).join('')}${ariaRole ? `[role=${ariaRole}]` : ''}`;
}

function readOverlayPreference() {
  try {
    return localStorage.getItem(OVERLAY_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function ensureApi(): TraceBuffer {
  if (!buffer) {
    buffer = new TraceBuffer(TRANSCRIPT_TRACE_CAPACITY);
    overlayEnabled = readOverlayPreference();
  }
  const owned = buffer;
  window.__stationTranscriptTrace = {
    dump: () => owned.dump(),
    clear: () => owned.clear(),
    overlay: (on = !overlayEnabled) => {
      overlayEnabled = on;
      try {
        if (on) localStorage.setItem(OVERLAY_STORAGE_KEY, '1');
        else localStorage.removeItem(OVERLAY_STORAGE_KEY);
      } catch {
        // The overlay still toggles for this page.
      }
      if (!on) {
        overlayElement?.remove();
        overlayElement = null;
      }
      return overlayEnabled;
    },
  };
  return owned;
}

function renderOverlay(record: TranscriptTraceRecord, lastShift: string) {
  if (!overlayEnabled) return;
  if (!overlayElement?.isConnected) {
    overlayElement = document.createElement('div');
    overlayElement.setAttribute('aria-hidden', 'true');
    overlayElement.dataset.transcriptTraceOverlay = '';
    Object.assign(overlayElement.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      zIndex: '2147483647',
      pointerEvents: 'none',
      font: '10px/1.3 ui-monospace, monospace',
      whiteSpace: 'pre',
      padding: '4px 6px',
      background: 'rgba(0,0,0,0.75)',
      color: '#fff',
      maxWidth: '100vw',
      overflow: 'hidden',
    });
    document.body.append(overlayElement);
  }
  overlayElement.textContent = [
    `top ${Math.round(record.scrollTop)} h ${record.scrollHeight} vh ${record.clientHeight}`,
    `to-bottom ${Math.round(record.distanceFromBottom)} up ${record.isUserScrolledUp ? 'yes' : 'no'}`,
    `${record.kind}${record.label ? ` ${record.label}` : ''}${record.target ? ` ${record.target}` : ''}`,
    `shift ${lastShift}`,
  ].join('\n');
}

export function attachTranscriptLayoutTracer(
  element: HTMLElement,
  {
    sessionId,
    readState,
    logger,
  }: {
    sessionId: string;
    readState: () => TranscriptTraceState;
    logger?: { (...args: unknown[]): void; enabled: boolean };
  },
): () => void {
  const store = ensureApi();
  let lastProgrammatic: { top: number; at: number } | null = null;
  let lastShift = 'none';
  let overlayFrame: number | undefined;
  let latest: TranscriptTraceRecord | null = null;

  const record = (
    kind: TranscriptTraceKind,
    fields: Partial<
      Pick<
        TranscriptTraceRecord,
        'target' | 'label' | 'from' | 'to' | 'detail' | 'replayed'
      >
    > = {},
    at = performance.now(),
  ) => {
    const taken = store.push({
      t: Math.round(at * 10) / 10,
      kind,
      sessionId,
      ...fields,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      distanceFromBottom:
        element.scrollHeight - element.scrollTop - element.clientHeight,
      isUserScrolledUp: readState().isUserScrolledUp,
    });
    if (logger?.enabled)
      logger(
        '%s %s%s%s top=%d h=%d vh=%d bottom=%d up=%s',
        taken.kind,
        taken.label ?? '',
        taken.target ? ` ${taken.target}` : '',
        taken.from !== undefined ? ` ${taken.from}→${taken.to}` : '',
        Math.round(taken.scrollTop),
        taken.scrollHeight,
        taken.clientHeight,
        Math.round(taken.distanceFromBottom),
        taken.isUserScrolledUp,
      );
    latest = taken;
    if (overlayEnabled && overlayFrame === undefined)
      overlayFrame = requestAnimationFrame(() => {
        overlayFrame = undefined;
        if (latest) renderOverlay(latest, lastShift);
      });
    return taken;
  };

  const releaseSink = installTranscriptTraceSink({
    phase: (label, detail, at) =>
      record(
        'phase',
        at === undefined
          ? { label, detail }
          : { label, detail, replayed: true },
        at,
      ),
    programmaticScroll: (top) => {
      lastProgrammatic = { top, at: performance.now() };
    },
  });
  record('attach');

  const onScroll = () => {
    const echo = lastProgrammatic;
    const programmatic =
      echo !== null &&
      performance.now() - echo.at <= PROGRAMMATIC_ECHO_MS &&
      Math.abs(element.scrollTop - echo.top) <= PROGRAMMATIC_ECHO_PX;
    record('scroll', { label: programmatic ? 'programmatic' : 'reader' });
  };
  element.addEventListener('scroll', onScroll, { passive: true });

  const heights = new WeakMap<Element, number>();
  const sizeOf = (entry: ResizeObserverEntry) =>
    entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
  const resizeObserver =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
          for (const entry of entries) {
            const to = Math.round(sizeOf(entry) * 10) / 10;
            const from = heights.get(entry.target);
            heights.set(entry.target, to);
            if (from === to) continue;
            record('resize', {
              target:
                entry.target === element
                  ? 'scroller'
                  : describeTraceNode(entry.target),
              from,
              to,
            });
          }
        });
  const observe = (node: Element) => resizeObserver?.observe(node);
  const observeWithin = (root: Element) => {
    if (root.matches(OBSERVED_SELECTOR)) observe(root);
    for (const node of root.querySelectorAll(OBSERVED_SELECTOR)) observe(node);
  };
  observe(element);
  observeWithin(element);
  const host = element.parentElement;
  if (host) for (const child of host.children) observe(child);

  const rowObserver = new MutationObserver((mutations) => {
    let added = 0;
    let removed = 0;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        observeWithin(node);
        if (node.matches(OBSERVED_SELECTOR)) added += 1;
        added += node.querySelectorAll('[data-chat-message-key]').length;
      }
      for (const node of mutation.removedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(OBSERVED_SELECTOR)) removed += 1;
        removed += node.querySelectorAll('[data-chat-message-key]').length;
      }
    }
    if (added || removed) record('rows', { detail: { added, removed } });
  });
  rowObserver.observe(element, { childList: true, subtree: true });

  // Loading surfaces the dock renders BESIDE the transcript (skeletons, the
  // lazy list's pending state) change the scroller's height from outside.
  const siblingObserver = host
    ? new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (!(node instanceof Element)) continue;
            observe(node);
            record('sibling', {
              label: 'added',
              target: describeTraceNode(node),
            });
          }
          for (const node of mutation.removedNodes) {
            if (!(node instanceof Element)) continue;
            record('sibling', {
              label: 'removed',
              target: describeTraceNode(node),
            });
          }
        }
      })
    : null;
  if (host) siblingObserver?.observe(host, { childList: true });

  let shiftObserver: PerformanceObserver | null = null;
  try {
    shiftObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as Array<
        PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
          sources?: Array<{ node?: Node | null }>;
        }
      >) {
        if (entry.startTime <= lastShiftAt) continue;
        lastShiftAt = entry.startTime;
        const sources = (entry.sources ?? []).map((source) =>
          describeTraceNode(source.node),
        );
        lastShift = `${entry.value.toFixed(4)} ${sources[0] ?? 'unknown'}`;
        record(
          'layout-shift',
          {
            label: entry.hadRecentInput ? 'after-input' : 'unprompted',
            target: sources.join(' '),
            detail: { value: entry.value },
          },
          entry.startTime,
        );
      }
    });
    shiftObserver.observe({ type: 'layout-shift', buffered: true });
  } catch {
    // Layout Instability is Chromium-only; resizes and scrolls still record.
  }

  return () => {
    record('detach');
    releaseSink();
    element.removeEventListener('scroll', onScroll);
    resizeObserver?.disconnect();
    rowObserver.disconnect();
    siblingObserver?.disconnect();
    shiftObserver?.disconnect();
    if (overlayFrame !== undefined) cancelAnimationFrame(overlayFrame);
    overlayElement?.remove();
    overlayElement = null;
  };
}

/**
 * Attaches the tracer to the transcript scroller, in the mounting commit, while
 * tracing is requested. `readState` supplies the owner's scroll intent.
 */
export function useTranscriptLayoutTrace(
  scrollRef: RefObject<HTMLElement | null>,
  sessionId: string,
  readState: () => TranscriptTraceState,
): void {
  const readStateRef = useRef(readState);
  readStateRef.current = readState;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !transcriptLayoutTraceRequested()) return;
    return attachTranscriptLayoutTracer(element, {
      sessionId,
      readState: () => readStateRef.current(),
      logger: transcriptTraceLogger,
    });
  }, [scrollRef, sessionId]);
}
