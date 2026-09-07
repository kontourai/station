import { describe, expect, it } from 'vitest';
import {
  readDocumentFontsReady,
  runScreenshotCaptureSequence,
  type ScreenshotCaptureSteps,
} from '../../tests/helpers/screenshot-capture-sequence';

/**
 * #1650: the gallery's web-font settle used to run only BEFORE the per-screen
 * `afterGoto` hook, so any text that hook mounted could still be mid-swap when
 * the shot was taken. The fix is an ordering change, and an ordering change is
 * precisely what the 48-screen browser run cannot report: it compares pixels,
 * so a settle in the wrong place surfaces only as intermittent flake.
 *
 * These tests execute the real sequence with recording doubles in place of the
 * Playwright mechanics, so the assertions are about the order the production
 * composition actually produces — not about the text of the spec file, which
 * could not see order, a rename, or a step moved inside a conditional.
 *
 * The sequence performs the settle ITSELF against the passed page rather than
 * accepting it as a caller-supplied step, so these tests close the hole a step
 * map would leave open: the STEP MAP cannot wire in a settle that reads nothing,
 * and the last two tests prove the evaluated callback really does read the font
 * set's ready promise.
 *
 * What that does NOT close — and the stub in this very file is the proof — is the
 * passed-in object. `recordingSteps`'s `page` captures the page function and
 * returns without invoking it, which is an inert settle supplied by a caller. No
 * test here binds the object. What binds the real one is `typecheck:e2e`, where
 * `FontSettleTarget` is asserted against Playwright's `Page` at the spec's call
 * site, plus reading the diff — the same standing the other six steps have.
 */

type StepName =
  | 'reachScreen'
  | 'settleWebFonts'
  | 'assertNoLoadingSkeleton'
  | 'afterGoto'
  | 'assertConnectionChrome'
  | 'hideVolatileChrome'
  | 'screenshot';

type OptionalStepName =
  | 'assertNoLoadingSkeleton'
  | 'afterGoto'
  | 'assertConnectionChrome';

function recordingSteps(skipped: OptionalStepName[] = []) {
  const calls: StepName[] = [];
  /** Every function the sequence handed to `page.evaluate`, in order. */
  const evaluated: Array<() => Promise<unknown>> = [];
  const step = (name: StepName) => async () => {
    calls.push(name);
  };
  const optional = (name: OptionalStepName) =>
    skipped.includes(name) ? null : step(name);
  // The sequence's only use of the page is the settle, so recording the
  // evaluate call IS recording the settle. The callback is captured rather than
  // invoked: running it needs a document, which the last test supplies.
  const page = {
    evaluate: async (pageFunction: () => Promise<unknown>) => {
      calls.push('settleWebFonts');
      evaluated.push(pageFunction);
      return undefined;
    },
  };
  const steps: ScreenshotCaptureSteps = {
    reachScreen: step('reachScreen'),
    assertNoLoadingSkeleton: optional('assertNoLoadingSkeleton'),
    afterGoto: optional('afterGoto'),
    assertConnectionChrome: optional('assertConnectionChrome'),
    hideVolatileChrome: step('hideVolatileChrome'),
    screenshot: step('screenshot'),
  };
  return { calls, evaluated, page, steps };
}

describe('runScreenshotCaptureSequence', () => {
  it('runs every step exactly once, in the declared order', async () => {
    const { calls, page, steps } = recordingSteps();
    await runScreenshotCaptureSequence(page, steps);
    expect(calls).toEqual([
      'reachScreen',
      'settleWebFonts',
      'assertNoLoadingSkeleton',
      'afterGoto',
      'assertConnectionChrome',
      'settleWebFonts',
      'hideVolatileChrome',
      'screenshot',
    ]);
  });

  it('settles web fonts AFTER the afterGoto hook, which is the step that mounts new text', async () => {
    const { calls, page, steps } = recordingSteps();
    await runScreenshotCaptureSequence(page, steps);
    const lastSettle = calls.lastIndexOf('settleWebFonts');
    expect(lastSettle).toBeGreaterThan(calls.indexOf('afterGoto'));
  });

  it('settles web fonts AFTER the connection-chrome assertion, which waits for a chip state change', async () => {
    const { calls, page, steps } = recordingSteps();
    await runScreenshotCaptureSequence(page, steps);
    const lastSettle = calls.lastIndexOf('settleWebFonts');
    expect(lastSettle).toBeGreaterThan(calls.indexOf('assertConnectionChrome'));
  });

  it('takes the shot with only hideVolatileChrome between the final settle and the screenshot', async () => {
    const { calls, page, steps } = recordingSteps();
    await runScreenshotCaptureSequence(page, steps);
    const lastSettle = calls.lastIndexOf('settleWebFonts');
    // Nothing between them may introduce text; hiding elements that already
    // exist introduces none, so it is the only admissible step here.
    expect(calls.slice(lastSettle + 1)).toEqual([
      'hideVolatileChrome',
      'screenshot',
    ]);
  });

  it('still settles twice when the skeleton assertion is skipped', async () => {
    const { calls, page, steps } = recordingSteps(['assertNoLoadingSkeleton']);
    await runScreenshotCaptureSequence(page, steps);
    expect(calls).toEqual([
      'reachScreen',
      'settleWebFonts',
      'afterGoto',
      'assertConnectionChrome',
      'settleWebFonts',
      'hideVolatileChrome',
      'screenshot',
    ]);
  });

  it('still settles after the connection assertion when a screen declares no afterGoto hook', async () => {
    const { calls, page, steps } = recordingSteps(['afterGoto']);
    await runScreenshotCaptureSequence(page, steps);
    expect(calls).toEqual([
      'reachScreen',
      'settleWebFonts',
      'assertNoLoadingSkeleton',
      'assertConnectionChrome',
      'settleWebFonts',
      'hideVolatileChrome',
      'screenshot',
    ]);
  });

  it('still settles after the hook when the connection assertion is skipped', async () => {
    const { calls, page, steps } = recordingSteps(['assertConnectionChrome']);
    await runScreenshotCaptureSequence(page, steps);
    expect(calls).toEqual([
      'reachScreen',
      'settleWebFonts',
      'assertNoLoadingSkeleton',
      'afterGoto',
      'settleWebFonts',
      'hideVolatileChrome',
      'screenshot',
    ]);
  });

  it('awaits each step before starting the next, so the order is real and not just the order the calls were issued', async () => {
    // Every step yields to the macrotask queue between its own start and end.
    // A missing `await` anywhere in the sequence would let the next step's
    // start land before the previous step's end, interleaving this log.
    const log: string[] = [];
    const yieldOnce = () => new Promise((resolve) => setTimeout(resolve, 0));
    const step = (name: StepName) => async () => {
      log.push(`${name}:start`);
      await yieldOnce();
      log.push(`${name}:end`);
    };
    const page = {
      evaluate: async () => {
        log.push('settleWebFonts:start');
        await yieldOnce();
        log.push('settleWebFonts:end');
        return undefined;
      },
    };
    await runScreenshotCaptureSequence(page, {
      reachScreen: step('reachScreen'),
      assertNoLoadingSkeleton: step('assertNoLoadingSkeleton'),
      afterGoto: step('afterGoto'),
      assertConnectionChrome: step('assertConnectionChrome'),
      hideVolatileChrome: step('hideVolatileChrome'),
      screenshot: step('screenshot'),
    });
    expect(log).toHaveLength(16);
    for (let index = 0; index < log.length; index += 2) {
      const [name, phase] = log[index].split(':');
      expect(phase).toBe('start');
      expect(log[index + 1]).toBe(`${name}:end`);
    }
  });

  it('propagates a failing step and never reaches the shot, so a broken screen cannot be recorded as captured', async () => {
    const { calls, page, steps } = recordingSteps();
    await expect(
      runScreenshotCaptureSequence(page, {
        ...steps,
        afterGoto: async () => {
          calls.push('afterGoto');
          throw new Error('overlay never opened');
        },
      }),
    ).rejects.toThrow('overlay never opened');
    expect(calls).toEqual([
      'reachScreen',
      'settleWebFonts',
      'assertNoLoadingSkeleton',
      'afterGoto',
    ]);
  });

  /**
   * The order assertions above would all still pass if the evaluated callback
   * did nothing at all. This is the one that makes an inert settle impossible:
   * invoke each callback the sequence actually handed to `evaluate` against a
   * stubbed font set whose `ready` is a getter, and count the reads.
   *
   * A getter, not a plain property, because reading is the observable act — a
   * callback that returned the font set, or the document, without touching
   * `ready` would satisfy any assertion about the returned value.
   *
   * Environment note: this installs and removes a global `document`, which is
   * safe only because this lane runs `environment: 'node'` (vitest.config.ts),
   * where no such global exists. Under a DOM environment the `delete` would
   * throw on a non-configurable global — so if this file is ever moved to a
   * jsdom lane, save and restore rather than delete.
   */
  it('evaluates a callback that reads the font set ready promise, both times', async () => {
    const { evaluated, page, steps } = recordingSteps();
    await runScreenshotCaptureSequence(page, steps);
    expect(evaluated).toHaveLength(2);

    let readyReads = 0;
    const globals = globalThis as { document?: unknown };
    const hadDocument = 'document' in globals;
    const previousDocument = globals.document;
    globals.document = {
      fonts: {
        get ready() {
          readyReads += 1;
          return Promise.resolve();
        },
      },
    };
    try {
      for (const pageFunction of evaluated) {
        await pageFunction();
      }
    } finally {
      if (hadDocument) globals.document = previousDocument;
      else delete globals.document;
    }

    expect(readyReads).toBe(2);
  });

  it('exports the probe the sequence evaluates, and it reads document.fonts.ready', async () => {
    // Pins the probe independently of the sequence, so a change to either is
    // visible on its own.
    let readyReads = 0;
    const globals = globalThis as { document?: unknown };
    const hadDocument = 'document' in globals;
    const previousDocument = globals.document;
    globals.document = {
      fonts: {
        get ready() {
          readyReads += 1;
          return Promise.resolve('settled');
        },
      },
    };
    try {
      await expect(readDocumentFontsReady()).resolves.toBe('settled');
    } finally {
      if (hadDocument) globals.document = previousDocument;
      else delete globals.document;
    }
    expect(readyReads).toBe(1);
  });
});
