import { EXTENSIONS_UNAVAILABLE_LABEL } from '../../src-ui/src/core/pluginRegistryCopy';
import { enUSCatalog } from '../../src-ui/src/i18n/catalog.en-US';
import type { DocumentTracker } from './gallery-document-tracker';
import { LAZY_BOUNDARY_ERROR_SELECTOR } from './lazy-surface-readiness';

/**
 * The Gallery's handling of "the app itself was in an error state" during a
 * capture.
 *
 * A lazily loaded chunk that fails inside the live page leaves the product on
 * a permanent error surface with no automatic retry. Photographing and
 * auditing that state produced hit-target findings that attribution then
 * blamed on whichever pull request happened to be captured (runs 43751068714,
 * 43739274329, 43704347024, 43769487439). The capture now names the state
 * instead of judging its layout and, when the page shows that a chunk failed
 * to download, captures that one screen once more (`gallery-screen-attempt.ts`).
 *
 * Everything here is either pure or a browser-side probe written as source
 * text (like `gallery-ui-audit.ts`), so the root `scripts` lane, which has no
 * DOM lib, can compile and unit-test it.
 */

/**
 * The product's own error surfaces, by the hooks the product renders. A
 * surface says that something in a lazily loaded part failed, NOT that a
 * download failed: `LazyBoundary` shows its row for any error its child
 * throws, including a render error. Whether a chunk download failed is read
 * from the failed requests instead (`chunkLoadFailed`).
 * - `lazy-boundary-row`: `LazyBoundaryError`'s `.lazy-boundary__error` row
 *   (`src-ui/src/components/LazyBoundary.tsx`). The ones `App.tsx` mounts
 *   above `.app` push the whole page down.
 * - `extension-registry-toast`: the notification `DeferredCapabilityBoundary`
 *   shows (notification mode) when the plugin registry chunk fails on a
 *   healthy connection: a `data-testid="toast-card"` carrying
 *   `EXTENSIONS_UNAVAILABLE_LABEL`.
 * - `route-chunk-error`: `RouteViewBoundary`'s `ErrorState` (`.error-state`)
 *   for a route whose chunk failed, titled with the catalog's
 *   `route.chunk.title` or `route.chunk.offlineTitle`.
 * - `route-pending-recovery`: the route fallback after its loading window expires.
 *
 * NOT detected, because none has a shared hook: `WorkspacePaneFrame` and
 * `HomeRolePane` boundaries, `RequiredSlotHost` rendering nothing,
 * `MonitoringErrorBoundary`, `DeferredCapabilityBoundary` in banner mode
 * (its condition lives in the Station details dialog), and a `LazyBoundary`
 * whose caller passes its own `unavailable` slot (several render nothing).
 *
 * No screen in `SCREENS` shows a detected surface on purpose (checked by
 * grep; no full capture has been run since `route-chunk-error` was added); a
 * screen that starts to must be exempted by name in
 * `APP_ERROR_SURFACE_EXEMPT_SCREENS` with the reason.
 */
const APP_ERROR_SURFACES = {
  'lazy-boundary-row': LAZY_BOUNDARY_ERROR_SELECTOR,
  'extension-registry-toast': '[data-testid="toast-card"]',
  'route-chunk-error': '.error-state',
  'route-pending-recovery': '.route-pending-recovery',
} as const;
export type AppErrorSurfaceName = keyof typeof APP_ERROR_SURFACES;
const ROUTE_CHUNK_TITLES = [
  enUSCatalog['route.chunk.title'],
  enUSCatalog['route.chunk.offlineTitle'],
];

/** Screens that show an error surface on purpose. None today. */
export const APP_ERROR_SURFACE_EXEMPT_SCREENS: ReadonlySet<string> = new Set();

/** Browser-side: the error surfaces attached to the document, with counts. */
export const READ_APP_ERROR_SURFACES = `(() => {
  const found = {};
  const textOf = (element) => element.textContent || '';
  const rows = document.querySelectorAll(${JSON.stringify(APP_ERROR_SURFACES['lazy-boundary-row'])}).length;
  if (rows > 0) found['lazy-boundary-row'] = rows;
  const toasts = Array.from(document.querySelectorAll(${JSON.stringify(APP_ERROR_SURFACES['extension-registry-toast'])}))
    .filter((card) => textOf(card).includes(${JSON.stringify(EXTENSIONS_UNAVAILABLE_LABEL)})).length;
  if (toasts > 0) found['extension-registry-toast'] = toasts;
  const titles = ${JSON.stringify(ROUTE_CHUNK_TITLES)};
  const routes = Array.from(document.querySelectorAll(${JSON.stringify(APP_ERROR_SURFACES['route-chunk-error'])}))
    .filter((state) => titles.some((title) => textOf(state).includes(title))).length;
  if (routes > 0) found['route-chunk-error'] = routes;
  const stalled = document.querySelectorAll(${JSON.stringify(APP_ERROR_SURFACES['route-pending-recovery'])}).length;
  if (stalled > 0) found['route-pending-recovery'] = stalled;
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
  /**
   * Whether the URL is one of the app's own build files: the origin of the
   * page under capture and a path under `APP_ASSET_PATH`. Only such a script
   * is a chunk (`failedChunkPaths`); a cross-origin script is not.
   */
  appAsset: boolean;
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
  /** For `after capture`: which controls changed or moved after the photo. */
  controlsAfterPhoto?: ControlNameDiff;
  controlMovement?: ControlMovement;
}

/** Retained per attempt for script requests and, separately, for the rest. */
export const MAX_FAILED_REQUESTS = 12;
const MAX_TEXT = 160;
const bounded = (text: string, max = MAX_TEXT) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * A content-hashed asset name with its hash replaced, so the same chunk reads
 * the same in two builds. The record keeps the real path.
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

/** Where the UI build (Vite's default `assetsDir`) serves its files. */
const APP_ASSET_PATH = '/assets/';

/**
 * The live document's failed requests for the app's own scripts (same origin
 * as the page, under `APP_ASSET_PATH`), hash-masked, sorted and deduplicated.
 */
const isLiveAppChunk = (request: FailedRequestRecord) =>
  request.document === 'current' &&
  request.resourceType === 'script' &&
  request.appAsset;

function failedChunkPaths(observation: AppErrorObservation): string[] {
  return [
    ...new Set(
      observation.failedRequests
        .filter(isLiveAppChunk)
        .map((request) => withoutAssetHash(request.path)),
    ),
  ].sort();
}

/** Whether the attempt shows a chunk download failing in the live page. */
export function chunkLoadFailed(observation: AppErrorObservation): boolean {
  return failedChunkPaths(observation).length > 0;
}

/**
 * A failed screen's reason for the capture log, one line. A screen that showed
 * an error surface while an app chunk request of the live document failed reads
 * `lazy chunk unavailable: <screen> (<path> <error>, ...)`, with the requests'
 * real paths, so the log names the lost chunk rather than the error row's
 * layout (#5028). Any other failure reads `<screen>: <its error's first line>`.
 */
export function failedScreenReason(
  screen: string,
  error: string,
  appError: AppErrorObservation | undefined,
): string {
  if (appError && chunkLoadFailed(appError)) {
    const requests = appError.failedRequests
      .filter(isLiveAppChunk)
      .map((request) => `${request.path} ${request.errorText}`);
    return `lazy chunk unavailable: ${screen} (${[...new Set(requests)].join(', ')})`;
  }
  return `${screen}: ${error.split('\n')[0]}`;
}

/**
 * The one-line identity of a screen that failed on an app error surface: the
 * first line of the screen's `error`, which the findings judge reports as
 * `capture-failed` (no layout findings for that state) and attribution
 * compares exactly after `normaliseFailureDetail`.
 *
 * It carries only what is the same for two captures of the same failure: the
 * surfaces, and the live document's failed chunk paths with hashes masked,
 * or `no failed chunk request` so a render error is never read as a failed
 * download. Deliberately left out, and kept in the record (`appError`):
 * previous-document requests (they depend on the screen before and on
 * timing), error text (one aborted chunk reads ERR_ABORTED on one attempt and
 * ERR_FAILED on another), the phase (the same failure can surface before the
 * photo on one capture and after it on the next), counts, and a step's error.
 * Hash masking makes the identity comparable between two builds only where
 * the failing chunk keeps its name; a renamed chunk is a different identity.
 */
export function formatAppErrorIdentity(observation: AppErrorObservation) {
  const surfaces = (Object.keys(observation.surfaces) as AppErrorSurfaceName[])
    .filter((name) => (observation.surfaces[name] ?? 0) > 0)
    .sort();
  const chunks = failedChunkPaths(observation);
  return `app-error-surface: ${surfaces.join(', ')}; ${
    chunks.length > 0
      ? `failed chunk requests: ${chunks.join(', ')}`
      : 'no failed chunk request'
  }`;
}

/** Thrown by the capture's own error-surface checks; carries what was seen. */
export class AppErrorSurfaceFailure extends Error {
  constructor(readonly observation: AppErrorObservation) {
    super(formatAppErrorIdentity(observation));
  }
}

type RequestLike = {
  url(): string;
  resourceType(): string;
  failure(): { errorText: string } | null;
};

/**
 * Failed requests of the page, per capture attempt, with the document they
 * belonged to (`createDocumentTracker`). `origin` is the origin of the page
 * under capture (the spec passes its base URL's, which every screen's path
 * resolves against).
 */
export function createFailedRequestLog(
  origin: string,
  documents: Pick<DocumentTracker, 'classify'>,
  now: () => number = Date.now,
) {
  // Scripts are kept apart so navigation teardown cannot crowd out the one
  // record a retry decision depends on.
  let scripts: FailedRequestRecord[] = [];
  let others: FailedRequestRecord[] = [];
  let omitted = 0;
  const pageOrigin = new URL(origin).origin;
  return {
    failed(request: RequestLike) {
      let path: string;
      let appAsset = false;
      try {
        const url = new URL(request.url());
        const sameOrigin = url.origin === pageOrigin;
        path = sameOrigin ? url.pathname : `${url.host}${url.pathname}`;
        appAsset = sameOrigin && url.pathname.startsWith(APP_ASSET_PATH);
      } catch {
        path = '<unparseable>';
      }
      const records = request.resourceType() === 'script' ? scripts : others;
      if (records.length >= MAX_FAILED_REQUESTS) {
        omitted++;
        return;
      }
      records.push({
        path: bounded(path),
        appAsset,
        errorText: bounded(request.failure()?.errorText ?? 'unknown'),
        resourceType: request.resourceType(),
        failedAt: now(),
        document: documents.classify(request) ?? 'unknown',
      });
    },
    /** Starts a new attempt's log. */
    reset() {
      scripts = [];
      others = [];
      omitted = 0;
    },
    snapshot() {
      return {
        records: [...scripts, ...others].sort(
          (a, b) => a.failedAt - b.failedAt,
        ),
        omitted,
      };
    },
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

/** A visible control and its box in viewport CSS pixels. */
export interface ControlBox {
  label: string;
  disabled: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ControlMovement {
  /** Controls present at both reads, paired by name and order. */
  compared: number;
  /** Of those, how many moved more than half a CSS pixel. */
  moved: number;
  largest: { control: string; dx: number; dy: number; distance: number } | null;
  /** Milliseconds from the photo to the second read. */
  windowMs?: number;
}

const MOVE_THRESHOLD_PX = 0.5;
const px = (value: number) => Math.round(value * 10) / 10;

/**
 * How far same-identity controls moved between two reads. A control is
 * identified by its name and its position among controls of that name, in
 * document order; one that appeared or disappeared is the names diff's
 * business, not a movement.
 */
export function measureControlMovement(
  atPhoto: ControlBox[],
  atAudit: ControlBox[],
): ControlMovement {
  const byName = (boxes: ControlBox[]) => {
    const groups = new Map<string, ControlBox[]>();
    for (const box of boxes) {
      const group = groups.get(box.label) ?? [];
      group.push(box);
      groups.set(box.label, group);
    }
    return groups;
  };
  const later = byName(atAudit);
  let compared = 0;
  let moved = 0;
  let largest: ControlMovement['largest'] = null;
  for (const [label, earlier] of byName(atPhoto)) {
    const now = later.get(label) ?? [];
    for (let index = 0; index < Math.min(earlier.length, now.length); index++) {
      compared++;
      const dx = now[index].x - earlier[index].x;
      const dy = now[index].y - earlier[index].y;
      const distance = Math.hypot(dx, dy);
      if (distance <= MOVE_THRESHOLD_PX) continue;
      moved++;
      if (!largest || distance > largest.distance)
        largest = {
          control: bounded(label || '(unnamed)', 80),
          dx: px(dx),
          dy: px(dy),
          distance: px(distance),
        };
    }
  }
  return { compared, moved, largest };
}

/**
 * The end-of-capture table, report only. The window is exactly: controls read
 * immediately before the full-page screenshot, against controls read again
 * as soon as the audit has finished (later only when an investigation sets
 * a settle window). A change after that read is not seen.
 */
export function formatControlChangeTable(
  rows: Array<{
    name: string;
    controlsAfterPhoto?: ControlNameDiff;
    controlMovement?: ControlMovement;
  }>,
  settleWindowMs = 0,
): string[] {
  const measured = rows.filter((row) => row.controlMovement);
  const changed = measured.filter(
    (row) =>
      (row.controlMovement?.moved ?? 0) > 0 || row.controlsAfterPhoto?.changed,
  );
  const worst = [...changed]
    .sort(
      (a, b) =>
        (b.controlMovement?.largest?.distance ?? 0) -
          (a.controlMovement?.largest?.distance ?? 0) ||
        (b.controlMovement?.moved ?? 0) - (a.controlMovement?.moved ?? 0) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 10);
  const lines = [
    `Gallery controls between the photo (read just before the screenshot) and a second read ${settleWindowMs > 0 ? `at least ${settleWindowMs} ms after the photo, after the audit` : 'when the audit ends; a change after that is not seen'} (report only; nothing fails on it): ${measured.length} of ${rows.length} screen(s) measured, ${changed.length} moved or changed controls.`,
  ];
  if (worst.length === 0) return lines;
  lines.push('  largest px  moved  names    screen  (largest: control)');
  for (const row of worst) {
    const movement = row.controlMovement as ControlMovement;
    lines.push(
      `  ${String(movement.largest?.distance ?? 0).padStart(10)}  ${String(movement.moved).padStart(5)}  ${(row.controlsAfterPhoto?.changed ? 'changed' : 'same').padEnd(7)}  ${row.name}${movement.largest ? `  (${movement.largest.control}: dx ${movement.largest.dx}, dy ${movement.largest.dy})` : ''}`,
    );
  }
  return lines;
}

/**
 * Test-only fault injection for the capture, from `STATION_E2E_GALLERY_FAULTS`
 * (a JSON array). It exists so the detection, the retry rule and the control
 * record can be shown against the real app: there is no other way to make a
 * chunk fail on one named screen. Refused (the capture throws before any
 * screen) on a GitHub Actions runner and whenever the selection covers every
 * declared screen, however it was written, so no gallery the PR check or the
 * nightly judges can carry one; a targeted capture is never complete evidence
 * for attribution or the pixel baseline anyway. When accepted it is recorded
 * under `faultInjection` in `capture.json`.
 *
 * - `chunk`: every request in each listed attempt for
 *   `/assets/<chunk>-<hash>.js` is aborted (`mode: 'abort'`, the default),
 *   answered 404 (`'not-found'`), or answered with a module that throws when
 *   evaluated (`'poison'`, a failure with no failed request). `when:
 *   'after-screenshot'` holds the request until the photo is written.
 * - `fail-step`: throw an ordinary error in the screenshot step.
 * - `move-after-photo`: insert an 80 px block above `.app` `delayMs` after
 *   the photo.
 * - `fail-cleanup`: throw from the screen's cleanup after it ran.
 */
export type GalleryFault =
  | {
      screen: string;
      kind: 'chunk';
      chunk: string;
      attempts: number[];
      mode: 'abort' | 'not-found' | 'poison';
      when: 'load' | 'after-screenshot';
    }
  | { screen: string; kind: 'fail-step' | 'fail-cleanup'; attempts: number[] }
  | {
      screen: string;
      kind: 'move-after-photo';
      attempts: number[];
      delayMs: number;
    };

export function readGalleryFaults(
  env: Record<string, string | undefined>,
  selection: readonly string[] | null,
  declared: readonly string[],
): GalleryFault[] {
  const raw = env.STATION_E2E_GALLERY_FAULTS;
  if (raw === undefined || raw === '') return [];
  if (env.GITHUB_ACTIONS === 'true')
    throw new Error(
      'STATION_E2E_GALLERY_FAULTS is refused on a GitHub Actions runner.',
    );
  if (!selection || declared.every((name) => selection.includes(name)))
    throw new Error(
      'STATION_E2E_GALLERY_FAULTS needs a targeted capture that leaves out at least one screen.',
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('STATION_E2E_GALLERY_FAULTS is not JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error('STATION_E2E_GALLERY_FAULTS must be a non-empty array.');
  return parsed.map((fault, index): GalleryFault => {
    const where = `STATION_E2E_GALLERY_FAULTS[${index}]`;
    if (typeof fault !== 'object' || fault === null)
      throw new Error(`${where} is not an object.`);
    const fields = fault as Record<string, unknown>;
    const { screen, kind, attempts } = fields;
    if (typeof screen !== 'string' || !selection.includes(screen))
      throw new Error(`${where}.screen must name a selected screen.`);
    if (
      !Array.isArray(attempts) ||
      attempts.length === 0 ||
      attempts.some((attempt) => attempt !== 1 && attempt !== 2)
    )
      throw new Error(`${where}.attempts must list attempts 1 and/or 2.`);
    const listed = attempts as number[];
    if (kind === 'fail-step' || kind === 'fail-cleanup')
      return { screen, kind, attempts: listed };
    if (kind === 'move-after-photo') {
      const { delayMs } = fields;
      if (
        typeof delayMs !== 'number' ||
        !Number.isInteger(delayMs) ||
        delayMs < 0 ||
        delayMs > 5000
      )
        throw new Error(`${where}.delayMs must be an integer from 0 to 5000.`);
      return { screen, kind, attempts: listed, delayMs };
    }
    if (kind !== 'chunk')
      throw new Error(
        `${where}.kind must be chunk, fail-step, fail-cleanup or move-after-photo.`,
      );
    const { chunk, when = 'load', mode = 'abort' } = fields;
    if (typeof chunk !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(chunk))
      throw new Error(`${where}.chunk must be a chunk name without its hash.`);
    if (when !== 'load' && when !== 'after-screenshot')
      throw new Error(`${where}.when must be load or after-screenshot.`);
    if (mode !== 'abort' && mode !== 'not-found' && mode !== 'poison')
      throw new Error(`${where}.mode must be abort, not-found or poison.`);
    return { screen, kind, chunk, attempts: listed, mode, when };
  });
}

/** Whether a URL path is the named chunk's content-hashed file. */
export function isChunkPath(pathname: string, chunk: string): boolean {
  if (!pathname.startsWith(`/assets/${chunk}-`)) return false;
  return /^[A-Za-z0-9_-]{8,}\.m?js$/.test(
    pathname.slice(`/assets/${chunk}-`.length),
  );
}
