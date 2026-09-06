import { describe, expect, it } from 'vitest';
import {
  runScreenshotCaptureSequence,
  type ScreenshotCaptureSteps,
} from '../../tests/helpers/screenshot-capture-sequence';

/**
 * #1650: the gallery's web-font settle used to run only BEFORE the per-screen
 * `afterGoto` hook, so any text that hook mounted could still be mid-swap when
 * the shot was taken. The fix is an ordering change, and an ordering change is
 * precisely what the 48-screen browser run cannot report: it compares pixels.
 *
 * These tests execute the real sequence with recording doubles in place of the
 * Playwright mechanics, so the assertions are about the order the production
 * composition actually produces — not about the text of the spec file, which
 * could not see order, a rename, or a step moved inside a conditional.
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
  const step = (name: StepName) => async () => {
    calls.push(name);
  };
  const optional = (name: OptionalStepName) =>
    skipped.includes(name) ? null : step(name);
  const steps: ScreenshotCaptureSteps = {
    reachScreen: step('reachScreen'),
    settleWebFonts: step('settleWebFonts'),
    assertNoLoadingSkeleton: optional('assertNoLoadingSkeleton'),
    afterGoto: optional('afterGoto'),
    assertConnectionChrome: optional('assertConnectionChrome'),
    hideVolatileChrome: step('hideVolatileChrome'),
    screenshot: step('screenshot'),
  };
  return { calls, steps };
}

describe('runScreenshotCaptureSequence', () => {
  it('runs every step exactly once, in the declared order', async () => {
    const { calls, steps } = recordingSteps();
    await runScreenshotCaptureSequence(steps);
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
    const { calls, steps } = recordingSteps();
    await runScreenshotCaptureSequence(steps);
    const lastSettle = calls.lastIndexOf('settleWebFonts');
    expect(lastSettle).toBeGreaterThan(calls.indexOf('afterGoto'));
  });

  it('settles web fonts AFTER the connection-chrome assertion, which waits for a chip state change', async () => {
    const { calls, steps } = recordingSteps();
    await runScreenshotCaptureSequence(steps);
    const lastSettle = calls.lastIndexOf('settleWebFonts');
    expect(lastSettle).toBeGreaterThan(calls.indexOf('assertConnectionChrome'));
  });

  it('takes the shot with only hideVolatileChrome between the final settle and the screenshot', async () => {
    const { calls, steps } = recordingSteps();
    await runScreenshotCaptureSequence(steps);
    const lastSettle = calls.lastIndexOf('settleWebFonts');
    // Nothing between them may introduce text; hiding an element that already
    // exists cannot start a font load, so it is the only admissible step here.
    expect(calls.slice(lastSettle + 1)).toEqual([
      'hideVolatileChrome',
      'screenshot',
    ]);
  });

  it('still settles twice when the skeleton assertion is skipped', async () => {
    const { calls, steps } = recordingSteps(['assertNoLoadingSkeleton']);
    await runScreenshotCaptureSequence(steps);
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
    const { calls, steps } = recordingSteps(['afterGoto']);
    await runScreenshotCaptureSequence(steps);
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
    const { calls, steps } = recordingSteps(['assertConnectionChrome']);
    await runScreenshotCaptureSequence(steps);
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
    const step = (name: StepName) => async () => {
      log.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      log.push(`${name}:end`);
    };
    await runScreenshotCaptureSequence({
      reachScreen: step('reachScreen'),
      settleWebFonts: step('settleWebFonts'),
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
    const { calls, steps } = recordingSteps();
    await expect(
      runScreenshotCaptureSequence({
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
});
