import {
  APP_ERROR_SURFACE_EXEMPT_SCREENS,
  type AppErrorObservation,
  type AppErrorPhase,
  type AppErrorSurfaceCounts,
  AppErrorSurfaceFailure,
  type ControlBox,
  type ControlMovement,
  type ControlNameDiff,
  chunkLoadFailed,
  diffControlNames,
  type FailedRequestRecord,
  formatAppErrorIdentity,
  hasAppErrorSurface,
  measureControlMovement,
} from './gallery-app-error-state';

/**
 * One Gallery screen's capture attempts, as a unit a test can drive: the
 * error-surface checks around the photo and the audit, and whether a failed
 * attempt earns a second capture. `tests/screenshots.spec.ts` supplies the
 * page operations as ports and keeps every mechanic; this module carries no
 * Playwright import, so its unit test drives it with fakes.
 */
export interface ScreenAttemptPorts<Audit> {
  /**
   * The screen's own steps, from setup to the photo. Must call `photo` exactly
   * where the screenshot belongs; anything it does after `photo` returns
   * (a screen's post-shot diagnostic) still happens before the audit.
   */
  capture(photo: () => Promise<void>): Promise<void>;
  readSurfaces(): Promise<AppErrorSurfaceCounts>;
  /** The full-page photo. */
  screenshot(): Promise<void>;
  /** Visible controls with their boxes. */
  readControls(): Promise<ControlBox[]>;
  /** The product assertions; an audit that throws is the port's to record. */
  audit(): Promise<Audit>;
  /** Screen-specific checks once the audit has passed its surface check. */
  afterAudit(): Promise<void>;
  /** A viewport image of the failed state, used only when no photo was taken. */
  fallbackScreenshot(): Promise<void>;
  cleanup(): Promise<void>;
  /** Milliseconds on a monotonic clock, and a plain wait. */
  now(): number;
  wait(ms: number): Promise<void>;
  /**
   * The shortest time from the photo to the second read; 0, the default,
   * reads as soon as the audit ends (`readSettleWindow`).
   */
  settleWindowMs: number;
  /** This attempt's failed requests and console errors so far. */
  evidence(): {
    failedRequests: FailedRequestRecord[];
    omitted: number;
    consoleErrors: string[];
  };
}

export type AttemptOutcome<Audit> =
  | {
      ok: true;
      audit: Audit;
      atPhoto: ControlBox[];
      controlsAfterPhoto: ControlNameDiff;
      controlMovement: ControlMovement;
    }
  | {
      ok: false;
      /** The thrown error, or the surface identity for a surface failure. */
      message: string;
      appError: AppErrorObservation | null;
      /** Whether the photo was taken (and is the file on disk). */
      photoTaken: boolean;
    };

/**
 * The longest settle window `STATION_E2E_GALLERY_SETTLE_WINDOW_MS` may ask
 * for. Off by default: a 1 s pad measured about 1,010 ms on untouched screens,
 * roughly four minutes on a 242-screen capture, for report-only data.
 */
export const MAX_SETTLE_WINDOW_MS = 5000;

/**
 * The investigation-only settle window: 0 unless
 * `STATION_E2E_GALLERY_SETTLE_WINDOW_MS` asks for a positive integer up to
 * `MAX_SETTLE_WINDOW_MS`, which delays the second read (the after-audit surface
 * check and the control record) to at least that long after the photo.
 */
export function readSettleWindow(
  env: Record<string, string | undefined>,
): number {
  const raw = env.STATION_E2E_GALLERY_SETTLE_WINDOW_MS;
  if (raw === undefined || raw === '') return 0;
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > MAX_SETTLE_WINDOW_MS)
    throw new Error(
      `STATION_E2E_GALLERY_SETTLE_WINDOW_MS must be an integer from 1 to ${MAX_SETTLE_WINDOW_MS}.`,
    );
  return Number(raw);
}

export async function attemptScreen<Audit>(
  ports: ScreenAttemptPorts<Audit>,
): Promise<AttemptOutcome<Audit>> {
  let photoTaken = false;
  let photoAt = 0;
  let atPhoto: ControlBox[] = [];
  const observe = (
    surfaces: AppErrorSurfaceCounts,
    phase: AppErrorPhase,
    extra: Partial<AppErrorObservation> = {},
  ): AppErrorObservation => {
    const { failedRequests, omitted, consoleErrors } = ports.evidence();
    return {
      surfaces,
      phase,
      failedRequests,
      failedRequestsOmitted: omitted,
      consoleErrors,
      ...extra,
    };
  };
  try {
    try {
      await ports.capture(async () => {
        // An error surface is not a state to photograph or audit.
        const before = await ports.readSurfaces();
        if (hasAppErrorSurface(before))
          throw new AppErrorSurfaceFailure(observe(before, 'before capture'));
        // Read as close to the photo as possible: the baseline for what moves.
        atPhoto = await ports.readControls();
        photoAt = ports.now();
        await ports.screenshot();
        photoTaken = true;
      });
      const audit = await ports.audit();
      // By default the second read follows the audit directly, so a change
      // that lands after the audit ends is not seen; an investigation can
      // widen the window (readSettleWindow).
      const elapsed = ports.now() - photoAt;
      if (elapsed < ports.settleWindowMs)
        await ports.wait(ports.settleWindowMs - elapsed);
      const atAudit = await ports.readControls();
      const windowMs = Math.round(ports.now() - photoAt);
      const controlsAfterPhoto = diffControlNames(
        atPhoto.map(({ label }) => label),
        atAudit.map(({ label }) => label),
      );
      const controlMovement = {
        ...measureControlMovement(atPhoto, atAudit),
        windowMs,
      };
      // A surface that appeared after the photo means the audit judged a page
      // that was never photographed (run 43704347024).
      const after = await ports.readSurfaces();
      if (hasAppErrorSurface(after))
        throw new AppErrorSurfaceFailure(
          observe(after, 'after capture', {
            controlsAfterPhoto,
            controlMovement,
          }),
        );
      await ports.afterAudit();
      return { ok: true, audit, atPhoto, controlsAfterPhoto, controlMovement };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      let appError =
        error instanceof AppErrorSurfaceFailure ? error.observation : null;
      if (!appError) {
        // A step that threw with a surface on the page is named by it.
        try {
          const surfaces = await ports.readSurfaces();
          if (hasAppErrorSurface(surfaces))
            appError = observe(surfaces, 'during capture', {
              stepError: message.split('\n')[0],
            });
        } catch {
          /* nothing readable: an ordinary failure */
        }
      }
      // Keep the photo when one was taken; otherwise show what rendered.
      if (!photoTaken) await ports.fallbackScreenshot().catch(() => {});
      return {
        ok: false,
        message: appError ? formatAppErrorIdentity(appError) : message,
        appError,
        photoTaken,
      };
    }
  } finally {
    await ports.cleanup();
  }
}

/**
 * Second captures allowed per run. Measured: about 2 to 3% of runs met a
 * transient, each on one screen; five leaves room for that while a systemic
 * break (every screen failing) adds at most five captures, not 242.
 */
export const MAX_SECOND_CAPTURES = 5;

export function createRetryBudget(max = MAX_SECOND_CAPTURES) {
  let used = 0;
  let refused = 0;
  return {
    take() {
      if (used >= max) {
        refused++;
        return false;
      }
      used++;
      return true;
    },
    get used() {
      return used;
    },
    get refused() {
      return refused;
    },
    max,
  };
}
export type RetryBudget = ReturnType<typeof createRetryBudget>;

/**
 * Why a failed first attempt is not captured again, or null when it is. Only
 * a surface with direct evidence of a chunk DOWNLOAD failing in the live page
 * (a failed script request of the current document) is retried, once per
 * screen, within the run's budget: a surface without one is a render error or
 * a chunk the server answered, and an ordinary failure has no surface.
 */
function secondCaptureRefusal(
  outcome: AttemptOutcome<unknown>,
  screen: string,
): 'passed' | 'no-surface' | 'exempt' | 'no-failed-chunk-request' | null {
  if (outcome.ok) return 'passed';
  if (!outcome.appError) return 'no-surface';
  if (APP_ERROR_SURFACE_EXEMPT_SCREENS.has(screen)) return 'exempt';
  if (!chunkLoadFailed(outcome.appError)) return 'no-failed-chunk-request';
  return null;
}

export interface SecondCaptureRecord {
  screen: string;
  /** The first attempt's identity, as attribution would see it. */
  identity: string;
  first: AppErrorObservation;
  /** The first attempt's image, kept beside the gallery. */
  firstFile: string | null;
  /**
   * `passed`: a transient. `budget-exhausted`: not captured again. The rest
   * failed the screen.
   */
  second:
    | 'passed'
    | 'app-error-surface'
    | 'failed'
    | 'threw'
    | 'budget-exhausted';
}

export type ScreenResult<Audit> = {
  final: AttemptOutcome<Audit>;
  attempts: 1 | 2;
  /** Every error line for a failed screen, the first being its identity. */
  errorLines: string[];
  record: SecondCaptureRecord | null;
};

/**
 * A screen's capture: the first attempt, and a second only when
 * `secondCaptureRefusal` allows it and the budget has room. A first attempt
 * that throws (its cleanup, say) propagates as it always did. A second that
 * throws fails this one screen with both errors, so the capture goes on.
 */
export async function captureScreen<Audit>(
  screen: string,
  attempt: (n: 1 | 2) => Promise<AttemptOutcome<Audit>>,
  budget: RetryBudget,
  hooks: {
    /** Keeps the first attempt's image; returns its gallery path or null. */
    keepFirstImage(): string | null;
    log(line: string): void;
  },
): Promise<ScreenResult<Audit>> {
  const first = await attempt(1);
  const linesOf = (outcome: AttemptOutcome<Audit>) =>
    outcome.ok ? [] : [outcome.message];
  if (secondCaptureRefusal(first, screen) !== null || first.ok)
    return {
      final: first,
      attempts: 1,
      errorLines: linesOf(first),
      record: null,
    };
  const appError = first.appError as AppErrorObservation;
  const identity = formatAppErrorIdentity(appError);
  if (!budget.take()) {
    if (budget.refused === 1)
      hooks.log(
        `Gallery second captures exhausted (${budget.max} this run); ${screen} and any later app error surface fail without one.`,
      );
    return {
      final: first,
      attempts: 1,
      errorLines: linesOf(first),
      record: {
        screen,
        identity,
        first: appError,
        firstFile: null,
        second: 'budget-exhausted',
      },
    };
  }
  const firstFile = hooks.keepFirstImage();
  let second: AttemptOutcome<Audit>;
  let threw = false;
  try {
    second = await attempt(2);
  } catch (error) {
    threw = true;
    second = {
      ok: false,
      message: `second capture threw: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      appError: null,
      photoTaken: false,
    };
  }
  const record: SecondCaptureRecord = {
    screen,
    identity,
    first: appError,
    firstFile,
    second: second.ok
      ? 'passed'
      : threw
        ? 'threw'
        : second.appError
          ? 'app-error-surface'
          : 'failed',
  };
  if (second.ok)
    hooks.log(
      `::warning title=Gallery transient app error::${screen} passed on its second capture after ${identity}`,
    );
  return {
    final: second,
    attempts: 2,
    // A second attempt that threw keeps the first attempt's identity first.
    errorLines: threw ? [identity, ...linesOf(second)] : linesOf(second),
    record,
  };
}
