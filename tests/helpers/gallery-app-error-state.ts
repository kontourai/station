import { EXTENSIONS_UNAVAILABLE_LABEL } from '../../src-ui/src/core/pluginRegistryCopy';
import type { DocumentTracker } from './gallery-document-tracker';
import { LAZY_BOUNDARY_ERROR_SELECTOR } from './lazy-surface-readiness';

/**
 * The Gallery's handling of "the app itself was in an error state" during a
 * capture, and the report-only layout-shift record that sits next to it.
 *
 * A lazily loaded chunk that fails inside the live page leaves the product on
 * a permanent error surface with no automatic retry. Photographing and
 * auditing that state produced hit-target findings that attribution then
 * blamed on whichever pull request happened to be captured (runs 43751068714,
 * 43739274329, 43704347024, 43769487439). The capture now names the state
 * instead of judging its layout, captures that one screen once more, and keeps
 * a record of every time that happened.
 *
 * Everything here is either pure or a browser-side probe written as source
 * text (like `gallery-ui-audit.ts`), so the root `scripts` lane, which has no
 * DOM lib, can compile and unit-test it.
 */

/**
 * The product's own error surfaces, by the hooks the product renders:
 * - `lazy-boundary-row`: `LazyBoundaryError`'s `.lazy-boundary__error` row
 *   (`src-ui/src/components/LazyBoundary.tsx`). The ones `App.tsx` mounts
 *   above `.app` push the whole page down.
 * - `extension-registry-toast`: the notification `DeferredCapabilityBoundary`
 *   shows when the plugin registry chunk fails on a healthy connection. Its
 *   title is `EXTENSIONS_UNAVAILABLE_LABEL`, imported from the module the
 *   product renders it from; the card is `data-testid="toast-card"`.
 *
 * Not covered: a `LazyBoundary` whose caller passes its own `unavailable`
 * slot (the command palette, message bubbles, the file preview, ...) renders
 * that caller's markup, not this row, and the connection-recovery boundary's
 * condition lives in the Station details dialog. Neither has a shared hook.
 *
 * No screen in `SCREENS` shows either surface on purpose (checked by grep for
 * the selector, the label and chunk routes when this was written); a screen
 * that starts to must be exempted by name in `APP_ERROR_SURFACE_EXEMPT_SCREENS`
 * with the reason.
 */
export const APP_ERROR_SURFACES = {
  'lazy-boundary-row': LAZY_BOUNDARY_ERROR_SELECTOR,
  'extension-registry-toast': '[data-testid="toast-card"]',
} as const;
export type AppErrorSurfaceName = keyof typeof APP_ERROR_SURFACES;

/** Screens that show an error surface on purpose. None today. */
export const APP_ERROR_SURFACE_EXEMPT_SCREENS: ReadonlySet<string> = new Set();

/** Browser-side: the error surfaces attached to the document, with counts. */
export const READ_APP_ERROR_SURFACES = `(() => {
  const found = {};
  const rows = document.querySelectorAll(${JSON.stringify(APP_ERROR_SURFACES['lazy-boundary-row'])}).length;
  if (rows > 0) found['lazy-boundary-row'] = rows;
  const toasts = Array.from(document.querySelectorAll(${JSON.stringify(APP_ERROR_SURFACES['extension-registry-toast'])}))
    .filter((card) => (card.textContent || '').includes(${JSON.stringify(EXTENSIONS_UNAVAILABLE_LABEL)})).length;
  if (toasts > 0) found['extension-registry-toast'] = toasts;
  return found;
})()`;

export type AppErrorSurfaceCounts = Partial<
  Record<AppErrorSurfaceName, number>
>;

/** When in the attempt the surface was seen. */
export type AppErrorPhase =
  /** Immediately before the screenshot: the photo was not taken. */
  | 'before capture'
  /** After the audit: the photo may show the normal page, the audit did not. */
  | 'after capture'
  /** A capture step threw while the surface was on the page. */
  | 'during capture';

export interface FailedRequestRecord {
  /** Same-origin path (host prefixed when cross-origin); never a query. */
  path: string;
  errorText: string;
  resourceType: string;
  /** Wall-clock milliseconds since the epoch, taken when the failure arrived. */
  failedAt: number;
  /**
   * Whether the request was issued by the document showing when it failed
   * (`current`) or by one a navigation has since replaced (`previous`). An
   * ERR_ABORTED from `previous` is ordinary navigation teardown; one from
   * `current` failed inside the live page.
   */
  document: 'current' | 'previous' | 'unknown';
}

export interface AppErrorObservation {
  surfaces: AppErrorSurfaceCounts;
  phase: AppErrorPhase;
  failedRequests: FailedRequestRecord[];
  /** Failed requests beyond the retained ones. */
  failedRequestsOmitted: number;
  consoleErrors: string[];
  /** First line of the step error, for `during capture`. */
  stepError?: string;
  /** For `after capture`: how the page moved and which controls changed. */
  layoutShift?: LayoutShiftSummary;
  controlsAfterPhoto?: ControlNameDiff;
}

export const MAX_FAILED_REQUESTS = 12;
const MAX_IDENTITY_REQUESTS = 4;
const MAX_TEXT = 160;
const bounded = (text: string, max = MAX_TEXT) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * A content-hashed asset name with its hash replaced, so the identity of the
 * same failure compares equal across two builds (attribution compares a
 * `capture-failed` error verbatim after `normaliseFailureDetail`). The record
 * keeps the real path.
 */
export function withoutAssetHash(path: string): string {
  return path.replace(
    /^(\/assets\/(?:[\w-]+\/)*[\w.-]+)-[A-Za-z0-9_-]{8,}(\.\w+)$/,
    '$1-<hash>$2',
  );
}

/** Whether any surface was observed. */
export function hasAppErrorSurface(counts: AppErrorSurfaceCounts): boolean {
  return Object.values(counts).some((count) => (count ?? 0) > 0);
}

/**
 * The one-line identity of a screen that failed on an app error surface.
 * It is the first line of the screen's `error`, so the findings judge reports
 * it as `capture-failed` and never judges that state's layout.
 */
export function formatAppErrorIdentity(observation: AppErrorObservation) {
  const surfaces = (Object.keys(observation.surfaces) as AppErrorSurfaceName[])
    .filter((name) => (observation.surfaces[name] ?? 0) > 0)
    .sort();
  // The live document's own script failures lead: they are the likely cause,
  // and the identity shows only the first few.
  const rank = (request: FailedRequestRecord) =>
    (request.document === 'current' ? 0 : 2) +
    (request.resourceType === 'script' ? 0 : 1);
  const requests = [...observation.failedRequests]
    .map((request) => ({
      rank: rank(request),
      text: `${withoutAssetHash(request.path)} ${bounded(request.errorText, 60)} (${request.resourceType}, ${request.document} document)`,
    }))
    .sort((a, b) => a.rank - b.rank || a.text.localeCompare(b.text))
    .map(({ text }) => text);
  const shown = requests.slice(0, MAX_IDENTITY_REQUESTS);
  const more =
    requests.length - shown.length + observation.failedRequestsOmitted;
  const requestText =
    shown.length === 0
      ? 'none recorded'
      : `${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`;
  return [
    `app-error-surface: ${surfaces.join(', ')}`,
    observation.phase,
    `failed requests: ${requestText}`,
    ...(observation.stepError
      ? [`step error: ${bounded(observation.stepError)}`]
      : []),
  ].join('; ');
}

/**
 * Whether a finished attempt earns the screen its single second capture:
 * only the first attempt, only when it failed, and only when an app error
 * surface was on the page. An ordinary assertion or audit failure has no
 * surface and is never captured again; nothing is captured a third time.
 */
export function shouldCaptureAgain(
  attempt: number,
  outcome: { ok: boolean; appError: AppErrorObservation | null },
  screen: string,
): boolean {
  return (
    attempt === 1 &&
    !outcome.ok &&
    outcome.appError !== null &&
    !APP_ERROR_SURFACE_EXEMPT_SCREENS.has(screen)
  );
}

type RequestLike = {
  url(): string;
  resourceType(): string;
  failure(): { errorText: string } | null;
};

/**
 * Failed requests of the page, per capture attempt, with the document they
 * belonged to (`createDocumentTracker`).
 */
export function createFailedRequestLog(
  origin: string,
  documents: Pick<DocumentTracker, 'classify'>,
  now: () => number = Date.now,
) {
  let records: FailedRequestRecord[] = [];
  let omitted = 0;
  const host = new URL(origin).host;
  return {
    failed(request: RequestLike) {
      let path: string;
      try {
        const url = new URL(request.url());
        path = url.host === host ? url.pathname : `${url.host}${url.pathname}`;
      } catch {
        path = '<unparseable>';
      }
      if (records.length >= MAX_FAILED_REQUESTS) {
        omitted++;
        return;
      }
      records.push({
        path: bounded(path),
        errorText: bounded(request.failure()?.errorText ?? 'unknown'),
        resourceType: request.resourceType(),
        failedAt: now(),
        document: documents.classify(request) ?? 'unknown',
      });
    },
    /** Starts a new attempt's log. */
    reset() {
      records = [];
      omitted = 0;
    },
    snapshot() {
      return { records: [...records], omitted };
    },
  };
}

/** Browser-side init script: buffers layout-shift entries for this document. */
export const LAYOUT_SHIFT_RECORDER = `(() => {
  if (globalThis.__galleryLayoutShifts) return;
  const store = { entries: [], dropped: 0, supported: true, observer: null };
  globalThis.__galleryLayoutShifts = store;
  const describe = (node) => {
    if (!node) return null;
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!element) return '#text';
    const classes = Array.from(element.classList || []).slice(0, 2).map((name) => '.' + name).join('');
    return (element.tagName.toLowerCase() + (element.id ? '#' + element.id : '') + classes).slice(0, 100);
  };
  const take = (entries) => {
    for (const entry of entries) {
      if (entry.hadRecentInput) continue;
      if (store.entries.length >= 200) { store.dropped++; continue; }
      store.entries.push({
        startTime: entry.startTime,
        value: entry.value,
        sources: Array.from(entry.sources || []).slice(0, 3).map((source) => describe(source.node)).filter(Boolean),
      });
    }
  };
  try {
    store.observer = new PerformanceObserver((list) => take(list.getEntries()));
    store.observer.observe({ type: 'layout-shift', buffered: true });
    store.take = () => take(store.observer.takeRecords());
  } catch {
    store.supported = false;
  }
})()`;

/** Browser-side: the document's current high-resolution time. */
export const READ_PERFORMANCE_NOW = 'performance.now()';

/** Browser-side: the shifts recorded since `since` (performance.now()). */
export function readLayoutShiftsSince(since: number): string {
  return `(() => {
  const store = globalThis.__galleryLayoutShifts;
  if (!store) return { supported: false, entries: [], dropped: 0 };
  if (store.take) store.take();
  return {
    supported: store.supported,
    dropped: store.dropped,
    entries: store.entries.filter((entry) => entry.startTime >= ${Number(since)}),
  };
})()`;
}

export interface LayoutShiftEntry {
  startTime: number;
  value: number;
  sources: string[];
}

export interface LayoutShiftSummary {
  /** False when Chromium's `layout-shift` entry type was unavailable. */
  supported: boolean;
  count: number;
  /** Sum of the shift values in the window (not the CLS session window). */
  score: number;
  largest: { value: number; sources: string[] } | null;
  /** Entries the page-side buffer refused once it held 200. */
  dropped: number;
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;

export function summariseLayoutShifts(read: {
  supported: boolean;
  dropped: number;
  entries: LayoutShiftEntry[];
}): LayoutShiftSummary {
  let largest: LayoutShiftEntry | null = null;
  let score = 0;
  for (const entry of read.entries) {
    score += entry.value;
    if (!largest || entry.value > largest.value) largest = entry;
  }
  return {
    supported: read.supported,
    count: read.entries.length,
    score: round(score),
    largest: largest
      ? { value: round(largest.value), sources: largest.sources }
      : null,
    dropped: read.dropped,
  };
}

const MAX_CONTROL_CHANGES = 10;

/**
 * Control names present at audit time but not at photo time and the
 * reverse, counted as multisets. A difference is direct evidence the page
 * changed between the photo and the audit.
 */
export function diffControlNames(atPhoto: string[], atAudit: string[]) {
  const count = (names: string[]) => {
    const counts = new Map<string, number>();
    for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
    return counts;
  };
  const before = count(atPhoto);
  const after = count(atAudit);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [name, n] of after)
    for (let i = before.get(name) ?? 0; i < n; i++) added.push(name);
  for (const [name, n] of before)
    for (let i = after.get(name) ?? 0; i < n; i++) removed.push(name);
  return {
    changed: added.length + removed.length > 0,
    added: added.slice(0, MAX_CONTROL_CHANGES).map((name) => bounded(name, 80)),
    removed: removed
      .slice(0, MAX_CONTROL_CHANGES)
      .map((name) => bounded(name, 80)),
    omitted:
      Math.max(0, added.length - MAX_CONTROL_CHANGES) +
      Math.max(0, removed.length - MAX_CONTROL_CHANGES),
  };
}
export type ControlNameDiff = ReturnType<typeof diffControlNames>;

/** The end-of-capture table: the ten screens that moved most after ready. */
export function formatLayoutShiftTable(
  rows: Array<{
    name: string;
    layoutShift?: LayoutShiftSummary;
    controlsAfterPhoto?: ControlNameDiff;
  }>,
): string[] {
  const measured = rows.filter((row) => row.layoutShift?.supported);
  const moved = measured.filter(
    (row) =>
      (row.layoutShift?.count ?? 0) > 0 || row.controlsAfterPhoto?.changed,
  );
  const worst = [...moved]
    .sort(
      (a, b) =>
        (b.layoutShift?.score ?? 0) - (a.layoutShift?.score ?? 0) ||
        (b.layoutShift?.count ?? 0) - (a.layoutShift?.count ?? 0) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 10);
  const lines = [
    `Gallery layout shift from ready to after the audit (report only; nothing fails on it): ${measured.length} of ${rows.length} screen(s) measured, ${moved.length} moved or changed controls.`,
  ];
  if (worst.length === 0) return lines;
  lines.push('  score    shifts  controls  screen  (largest shift: sources)');
  for (const row of worst) {
    const shift = row.layoutShift as LayoutShiftSummary;
    const controls = row.controlsAfterPhoto?.changed ? 'changed' : 'same';
    lines.push(
      `  ${shift.score.toFixed(4)}  ${String(shift.count).padStart(6)}  ${controls.padEnd(8)}  ${row.name}${shift.largest ? `  (${shift.largest.value.toFixed(4)}: ${shift.largest.sources.join(', ') || 'no source'})` : ''}`,
    );
  }
  return lines;
}

/**
 * Test-only fault injection for the capture, from `STATION_E2E_GALLERY_FAULTS`
 * (a JSON array). It exists so the detection and the single retry can be
 * shown against the real app: there is no other way to make a chunk fail on
 * one named screen. Refused (the capture throws before any screen) on a
 * GitHub Actions runner and on a full capture, so no gallery the PR check or
 * the nightly judges can carry one; a targeted capture is never complete
 * evidence for attribution or the pixel baseline anyway. When accepted it is
 * recorded under `faultInjection` in `capture.json`.
 *
 * - `abort-chunk`: abort (net::ERR_ABORTED) the first request on each listed
 *   attempt for `/assets/<chunk>-<hash>.js`. `when: 'after-screenshot'` holds
 *   that request until the screenshot is written, so the surface appears
 *   only after the photo.
 * - `fail-step`: throw an ordinary error in the screenshot step.
 */
export type GalleryFault =
  | {
      screen: string;
      kind: 'abort-chunk';
      chunk: string;
      attempts: number[];
      when: 'load' | 'after-screenshot';
    }
  | { screen: string; kind: 'fail-step'; attempts: number[] };

export function readGalleryFaults(
  env: Record<string, string | undefined>,
  selection: readonly string[] | null,
): GalleryFault[] {
  const raw = env.STATION_E2E_GALLERY_FAULTS;
  if (raw === undefined || raw === '') return [];
  if (env.GITHUB_ACTIONS === 'true')
    throw new Error(
      'STATION_E2E_GALLERY_FAULTS is refused on a GitHub Actions runner.',
    );
  if (!selection)
    throw new Error(
      'STATION_E2E_GALLERY_FAULTS needs a targeted capture (--screens=...).',
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('STATION_E2E_GALLERY_FAULTS is not JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error('STATION_E2E_GALLERY_FAULTS must be a non-empty array.');
  return parsed.map((fault, index) => {
    const where = `STATION_E2E_GALLERY_FAULTS[${index}]`;
    if (typeof fault !== 'object' || fault === null)
      throw new Error(`${where} is not an object.`);
    const { screen, kind, attempts } = fault as Record<string, unknown>;
    if (typeof screen !== 'string' || !selection.includes(screen))
      throw new Error(`${where}.screen must name a selected screen.`);
    if (
      !Array.isArray(attempts) ||
      attempts.length === 0 ||
      attempts.some((attempt) => attempt !== 1 && attempt !== 2)
    )
      throw new Error(`${where}.attempts must list attempts 1 and/or 2.`);
    if (kind === 'fail-step')
      return { screen, kind, attempts: attempts as number[] };
    if (kind !== 'abort-chunk')
      throw new Error(`${where}.kind must be abort-chunk or fail-step.`);
    const { chunk, when = 'load' } = fault as Record<string, unknown>;
    if (typeof chunk !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(chunk))
      throw new Error(`${where}.chunk must be a chunk name without its hash.`);
    if (when !== 'load' && when !== 'after-screenshot')
      throw new Error(`${where}.when must be load or after-screenshot.`);
    return {
      screen,
      kind,
      chunk,
      attempts: attempts as number[],
      when,
    };
  });
}

/** Whether a URL path is the named chunk's content-hashed file. */
export function isChunkPath(pathname: string, chunk: string): boolean {
  if (!pathname.startsWith(`/assets/${chunk}-`)) return false;
  return /^[A-Za-z0-9_-]{8,}\.m?js$/.test(
    pathname.slice(`/assets/${chunk}-`.length),
  );
}
