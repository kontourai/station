import { describe, expect, it } from 'vitest';
import type {
  AppErrorSurfaceCounts,
  ControlBox,
  FailedRequestRecord,
} from '../../tests/helpers/gallery-app-error-state';
import {
  type AttemptOutcome,
  attemptScreen,
  captureScreen,
  captureScreens,
  createRetryBudget,
  MAX_SECOND_CAPTURES,
  MAX_SETTLE_WINDOW_MS,
  readSettleWindow,
  type ScreenAttemptPorts,
} from '../../tests/helpers/gallery-screen-attempt';

// The per-screen order the Gallery capture runs (tests/screenshots.spec.ts is
// a thin caller of these two functions), driven with fake page operations.

const box = (label: string, y: number): ControlBox => ({
  label,
  disabled: false,
  x: 0,
  y,
  width: 44,
  height: 44,
});
const chunkFailure: FailedRequestRecord = {
  path: '/assets/CoreUpdateLaunchCheck-DDGWUae_.js',
  appAsset: true,
  errorText: 'net::ERR_FAILED',
  resourceType: 'script',
  failedAt: 1,
  document: 'current',
};
const row: AppErrorSurfaceCounts = { 'lazy-boundary-row': 1 };

/** A fake page: `surfaces` is what each successive surface read returns. */
function fakePorts(
  options: {
    surfaces?: AppErrorSurfaceCounts[];
    failedRequests?: FailedRequestRecord[];
    controls?: ControlBox[][];
    stepError?: string;
    cleanupError?: string;
    settleWindowMs?: number;
    auditMs?: number;
  } = {},
) {
  const calls: string[] = [];
  let clock = 0;
  const surfaces = [...(options.surfaces ?? [])];
  const controls = [...(options.controls ?? [])];
  const ports: ScreenAttemptPorts<{ findings: [] }> = {
    capture: async (photo) => {
      calls.push('capture');
      if (options.stepError) throw new Error(options.stepError);
      await photo();
      calls.push('after-photo');
    },
    readSurfaces: async () => {
      calls.push('surfaces');
      return surfaces.shift() ?? {};
    },
    screenshot: async () => {
      calls.push('screenshot');
    },
    readControls: async () => {
      calls.push('controls');
      return controls.shift() ?? [box('Send', 100)];
    },
    audit: async () => {
      calls.push('audit');
      clock += options.auditMs ?? 0;
      return { findings: [] };
    },
    afterAudit: async () => {
      calls.push('after-audit');
    },
    fallbackScreenshot: async () => {
      calls.push('fallback');
    },
    cleanup: async () => {
      calls.push('cleanup');
      if (options.cleanupError) throw new Error(options.cleanupError);
    },
    now: () => clock,
    wait: async (ms) => {
      calls.push(`wait ${ms}`);
      clock += ms;
    },
    settleWindowMs: options.settleWindowMs ?? 0,
    evidence: () => ({
      failedRequests: options.failedRequests ?? [],
      omitted: 0,
      consoleErrors: ['TypeError: Failed to fetch dynamically imported module'],
    }),
  };
  return { ports, calls };
}

describe('one attempt', () => {
  it('reads again as soon as the audit ends unless a settle window is set', async () => {
    const byDefault = fakePorts({ auditMs: 300 });
    const outcome = await attemptScreen(byDefault.ports);
    expect(byDefault.calls.some((call) => call.startsWith('wait'))).toBe(false);
    if (outcome.ok) expect(outcome.controlMovement.windowMs).toBe(300);
    const widened = fakePorts({ auditMs: 300, settleWindowMs: 1000 });
    const widenedOutcome = await attemptScreen(widened.ports);
    expect(widened.calls).toContain('wait 700');
    if (widenedOutcome.ok)
      expect(widenedOutcome.controlMovement.windowMs).toBe(1000);
  });

  it('accepts a settle window only from the environment, bounded', () => {
    expect(readSettleWindow({})).toBe(0);
    expect(readSettleWindow({ STATION_E2E_GALLERY_SETTLE_WINDOW_MS: '' })).toBe(
      0,
    );
    expect(
      readSettleWindow({ STATION_E2E_GALLERY_SETTLE_WINDOW_MS: '1000' }),
    ).toBe(1000);
    expect(MAX_SETTLE_WINDOW_MS).toBe(5000);
    for (const bad of ['0', '-5', '1.5', '5001', 'soon'])
      expect(
        () => readSettleWindow({ STATION_E2E_GALLERY_SETTLE_WINDOW_MS: bad }),
        bad,
      ).toThrow(/integer from 1 to 5000/);
  });

  it('checks for a surface before the photo and after the audit, then cleans up', async () => {
    const { ports, calls } = fakePorts();
    const outcome = await attemptScreen(ports);
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual([
      'capture',
      'surfaces',
      'controls',
      'screenshot',
      'after-photo',
      'audit',
      'controls',
      'surfaces',
      'after-audit',
      'cleanup',
    ]);
    if (outcome.ok)
      expect(outcome.controlMovement).toEqual({
        compared: 1,
        moved: 0,
        largest: null,
        windowMs: 0,
      });
  });

  it('does not photograph or audit a surface that is there before the photo', async () => {
    const { ports, calls } = fakePorts({
      surfaces: [row],
      failedRequests: [chunkFailure],
    });
    const outcome = await attemptScreen(ports);
    expect(outcome).toMatchObject({
      ok: false,
      photoTaken: false,
      message:
        'app-error-surface: lazy-boundary-row; failed chunk requests: /assets/CoreUpdateLaunchCheck-<hash>.js',
      appError: { phase: 'before capture' },
    });
    expect(calls).not.toContain('screenshot');
    expect(calls).not.toContain('audit');
    expect(calls).toContain('fallback');
    expect(calls.at(-1)).toBe('cleanup');
  });

  it('fails a surface that appeared after the photo and keeps the photo', async () => {
    const { ports, calls } = fakePorts({
      surfaces: [{}, row],
      failedRequests: [chunkFailure],
      controls: [[box('Send', 100)], [box('Retry', 0), box('Send', 180)]],
    });
    const outcome = await attemptScreen(ports);
    expect(outcome).toMatchObject({
      ok: false,
      photoTaken: true,
      appError: {
        phase: 'after capture',
        controlsAfterPhoto: { changed: true, added: ['Retry'] },
        controlMovement: { moved: 1, largest: { control: 'Send', dy: 80 } },
      },
    });
    expect(calls).toContain('audit');
    expect(calls).not.toContain('after-audit');
    // The real photo stays; the viewport-only fallback would overwrite it.
    expect(calls).not.toContain('fallback');
  });

  it('names a step failure by the surface on the page, and an ordinary one by its error', async () => {
    const withSurface = await attemptScreen(
      fakePorts({ surfaces: [row], stepError: 'locator timeout' }).ports,
    );
    expect(withSurface).toMatchObject({
      ok: false,
      message: 'app-error-surface: lazy-boundary-row; no failed chunk request',
      appError: { phase: 'during capture', stepError: 'locator timeout' },
    });
    const ordinary = await attemptScreen(
      fakePorts({ stepError: 'expect(locator).toBeVisible() failed' }).ports,
    );
    expect(ordinary).toMatchObject({
      ok: false,
      appError: null,
      message: 'expect(locator).toBeVisible() failed',
    });
  });
});

type Outcome = AttemptOutcome<{ findings: [] }>;
const passed: Outcome = {
  ok: true,
  audit: { findings: [] },
  atPhoto: [],
  controlsAfterPhoto: { changed: false, added: [], removed: [], omitted: 0 },
  controlMovement: { compared: 0, moved: 0, largest: null },
};
const surfaceFailure = (failedRequests: FailedRequestRecord[]): Outcome => ({
  ok: false,
  message: 'identity',
  appError: {
    surfaces: row,
    phase: 'before capture',
    failedRequests,
    failedRequestsOmitted: 0,
    consoleErrors: [],
  },
  photoTaken: false,
});
const ordinaryFailure: Outcome = {
  ok: false,
  message: 'expect(locator).toBeVisible() failed',
  appError: null,
  photoTaken: false,
};

async function run(
  outcomes: Array<Outcome | Error>,
  budget = createRetryBudget(),
) {
  const attempts: number[] = [];
  const logs: string[] = [];
  const result = await captureScreen(
    'home',
    async (n) => {
      attempts.push(n);
      const next = outcomes.shift() as Outcome | Error;
      if (next instanceof Error) throw next;
      return next;
    },
    budget,
    {
      keepFirstImage: () => 'transients/home.attempt-1.png',
      log: (line) => logs.push(line),
    },
  );
  return { result, attempts, logs };
}

describe('the second capture', () => {
  it('captures again once when the live page lost a chunk download, and records a transient', async () => {
    const { result, attempts, logs } = await run([
      surfaceFailure([chunkFailure]),
      passed,
    ]);
    expect(attempts).toEqual([1, 2]);
    expect(result.final.ok).toBe(true);
    expect(result.record).toMatchObject({
      second: 'passed',
      firstFile: 'transients/home.attempt-1.png',
      identity:
        'app-error-surface: lazy-boundary-row; failed chunk requests: /assets/CoreUpdateLaunchCheck-<hash>.js',
    });
    expect(logs[0]).toMatch(
      /^::warning title=Gallery transient app error::home /,
    );
  });

  it('fails a second time like the first, never a third', async () => {
    const { result, attempts } = await run([
      surfaceFailure([chunkFailure]),
      surfaceFailure([chunkFailure]),
    ]);
    expect(attempts).toEqual([1, 2]);
    expect(result.final.ok).toBe(false);
    expect(result.record?.second).toBe('app-error-surface');
  });

  it('does not capture again a surface without a failed chunk request (a render error), or an ordinary failure', async () => {
    for (const first of [
      surfaceFailure([]),
      surfaceFailure([{ ...chunkFailure, document: 'previous' }]),
      surfaceFailure([{ ...chunkFailure, resourceType: 'fetch' }]),
      // A cross-origin script is not one of the app's chunks.
      surfaceFailure([
        { ...chunkFailure, path: 'cdn.invalid/assets/x.js', appAsset: false },
      ]),
      ordinaryFailure,
    ]) {
      const { result, attempts } = await run([first, passed]);
      expect(attempts).toEqual([1]);
      expect(result.final.ok).toBe(false);
      expect(result.record).toBeNull();
    }
  });

  it(`stops after ${MAX_SECOND_CAPTURES} second captures in a run and says so once`, async () => {
    expect(MAX_SECOND_CAPTURES).toBe(5);
    const budget = createRetryBudget();
    const logs: string[] = [];
    for (let screen = 0; screen < 7; screen++) {
      const outcome = await run(
        [surfaceFailure([chunkFailure]), passed],
        budget,
      );
      logs.push(
        ...outcome.logs.filter((line) => !line.startsWith('::warning')),
      );
      expect(outcome.attempts, `screen ${screen}`).toEqual(
        screen < 5 ? [1, 2] : [1],
      );
      if (screen >= 5) {
        expect(outcome.result.final.ok).toBe(false);
        expect(outcome.result.record?.second).toBe('budget-exhausted');
      }
    }
    expect(logs).toEqual([
      'Gallery second captures exhausted (5 this run); home and any later app error surface fail without one.',
    ]);
  });

  it('fails the one screen with both errors when the second capture throws, and lets the capture go on', async () => {
    const { result } = await run([
      surfaceFailure([chunkFailure]),
      new Error('cleanup: expected 0 rooms, received 1\nCall log: ...'),
    ]);
    expect(result.final.ok).toBe(false);
    expect(result.record?.second).toBe('threw');
    expect(result.errorLines).toEqual([
      'app-error-surface: lazy-boundary-row; failed chunk requests: /assets/CoreUpdateLaunchCheck-<hash>.js',
      'second capture threw: cleanup: expected 0 rooms, received 1',
    ]);
  });

  it('lets a first attempt that throws propagate, as before', async () => {
    await expect(run([new Error('cleanup failed')])).rejects.toThrow(
      'cleanup failed',
    );
  });
});

describe('every screen of a run', () => {
  /** Screens whose first attempt fails on a lost chunk download. */
  async function runScreens(
    screens: Array<{
      name: string;
      afterAudit?: (page: string) => Promise<void>;
    }>,
    options: { firstFails?: boolean; captureThrows?: string } = {},
  ) {
    const events: string[] = [];
    const results = new Map<
      string,
      Awaited<ReturnType<typeof captureScreen>>
    >();
    const run = captureScreens('the-page', screens, {
      failedRequests: { reset: () => {} },
      ports: (screen, attempt) => {
        const fail = options.firstFails && attempt === 1;
        const { ports } = fakePorts({
          surfaces: fail ? [row] : [],
          failedRequests: fail ? [chunkFailure] : [],
        });
        const { afterAudit: _ignored, ...rest } = ports;
        return {
          ...rest,
          capture: async (photo) => {
            events.push(`${screen.name} attempt ${attempt}`);
            if (options.captureThrows === screen.name) throw new Error('boom');
            await photo();
          },
          cleanup: async () => {
            if (options.captureThrows === screen.name)
              throw new Error('cleanup failed');
          },
        };
      },
      keepFirstImage: (screen) => `transients/${screen.name}.attempt-1.png`,
      log: (line) => events.push(line),
      screenStarted: (screen) => events.push(`start ${screen.name}`),
      screenCaptured: (screen, result) => results.set(screen.name, result),
      screenFinished: (screen) => events.push(`finish ${screen.name}`),
    });
    return { run, events, results };
  }

  it(`shares one budget of ${MAX_SECOND_CAPTURES} second captures across the run`, async () => {
    const screens = Array.from({ length: 7 }, (_, index) => ({
      name: `screen-${index}`,
    }));
    const { run, results } = await runScreens(screens, { firstFails: true });
    await run;
    expect(
      screens.map(({ name }) => results.get(name)?.record?.second),
    ).toEqual([
      'passed',
      'passed',
      'passed',
      'passed',
      'passed',
      'budget-exhausted',
      'budget-exhausted',
    ]);
  });

  it("runs each screen's own afterAudit with the page, and fails the screen when it throws", async () => {
    const seen: string[] = [];
    const { run, results } = await runScreens([
      {
        name: 'checked',
        afterAudit: async (page) => {
          seen.push(page);
        },
      },
      { name: 'plain' },
      {
        name: 'broken',
        afterAudit: async () => {
          throw new Error('recovery did not happen');
        },
      },
    ]);
    await run;
    expect(seen).toEqual(['the-page']);
    expect(results.get('checked')?.final.ok).toBe(true);
    expect(results.get('plain')?.final.ok).toBe(true);
    expect(results.get('broken')?.final).toMatchObject({
      ok: false,
      message: 'recovery did not happen',
    });
  });

  it('finishes a screen whose first attempt throws, and stops there', async () => {
    const { run, events } = await runScreens(
      [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      { captureThrows: 'b' },
    );
    await expect(run).rejects.toThrow('cleanup failed');
    expect(events).toEqual([
      'start a',
      'a attempt 1',
      'finish a',
      'start b',
      'b attempt 1',
      'finish b',
    ]);
  });
});
