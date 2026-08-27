import { beforeEach, describe, expect, test } from 'vitest';
import { deviceSettingsStore } from '../../../lib/device-settings-store';
import {
  firstRunStore,
  isKnownFirstRunChapter,
  resolveResumePoint,
  resolveTourEntryPoint,
} from '../first-run-store';
import { FIRST_RUN_TOUR_STEPS } from '../tour-steps';

describe('isKnownFirstRunChapter — what THIS build can render', () => {
  test('every chapter this build renders is known', () => {
    for (const chapter of ['connect', 'engines', 'about-you', 'tour', 'done']) {
      expect(isKnownFirstRunChapter(chapter)).toBe(true);
    }
  });

  test('a chapter from a newer Station, and an absent one, are not', () => {
    expect(isKnownFirstRunChapter('from-a-newer-station')).toBe(false);
    expect(isKnownFirstRunChapter(undefined)).toBe(false);
    expect(isKnownFirstRunChapter('')).toBe(false);
  });

  test('an inherited Object key is not a chapter (delta review LOW-C)', () => {
    // `in` walks the prototype chain, so these all read as known chapters and
    // the guard silently restored the dead first run it exists to remove.
    // Reachable: `firstRunProgress` is a composite device setting with no
    // shape validator, so Settings Import accepts any plain object.
    for (const key of ['toString', 'constructor', 'valueOf', '__proto__']) {
      expect(isKnownFirstRunChapter(key)).toBe(false);
    }
  });
});

describe('resolveResumePoint', () => {
  test('a run that has not started resumes at Connect', () => {
    expect(resolveResumePoint({ chapter: 'connect' })).toEqual({
      chapter: 'connect',
      stepIndex: 0,
    });
  });

  test('a run abandoned in the engines chapter resumes there', () => {
    // Without its own case this chapter would fall through to the
    // unrecognised-chapter default and restart the whole run at Connect.
    expect(resolveResumePoint({ chapter: 'engines' })).toEqual({
      chapter: 'engines',
      stepIndex: 0,
    });
  });

  test('a run abandoned in About you resumes at About you', () => {
    expect(resolveResumePoint({ chapter: 'about-you' })).toEqual({
      chapter: 'about-you',
      stepIndex: 0,
    });
  });

  test('a partial tour resumes on the step it stopped on', () => {
    const third = FIRST_RUN_TOUR_STEPS[2];
    expect(
      resolveResumePoint({ chapter: 'tour', tourStepId: third.id }),
    ).toEqual({ chapter: 'tour', stepIndex: 2 });
  });

  test('a finished run re-entered on purpose restarts the tour from step one', () => {
    // Not a resume: there is nothing left to resume, and dropping someone on
    // the last coachmark of a tour they asked to see again is not one.
    expect(
      resolveResumePoint({
        chapter: 'done',
        tourStepId: FIRST_RUN_TOUR_STEPS[FIRST_RUN_TOUR_STEPS.length - 1].id,
      }),
    ).toEqual({ chapter: 'tour', stepIndex: 0 });
  });

  test('a retired step id restarts the tour instead of guessing a position', () => {
    expect(
      resolveResumePoint({ chapter: 'tour', tourStepId: 'retired-step' }),
    ).toEqual({ chapter: 'tour', stepIndex: 0 });
  });

  test('absent or unrecognised progress falls back to the first chapter', () => {
    expect(resolveResumePoint(undefined)).toEqual({
      chapter: 'connect',
      stepIndex: 0,
    });
    expect(
      resolveResumePoint({ chapter: 'from-a-newer-station' } as never),
    ).toEqual({ chapter: 'connect', stepIndex: 0 });
  });
});

describe('resolveTourEntryPoint — the explicit "Take the tour" action (review L3)', () => {
  test('opens the tour even when the run was abandoned at the questions', () => {
    // The command says "tour". Reopening the About-you form the user walked
    // away from would be the action lying about what it does.
    expect(resolveTourEntryPoint({ chapter: 'about-you' })).toEqual({
      chapter: 'tour',
      stepIndex: 0,
    });
  });

  test('resumes the step when the tour itself is what was interrupted', () => {
    expect(
      resolveTourEntryPoint({
        chapter: 'tour',
        tourStepId: FIRST_RUN_TOUR_STEPS[2].id,
      }),
    ).toEqual({ chapter: 'tour', stepIndex: 2 });
  });

  test('restarts from the top for a finished or unknown run', () => {
    expect(resolveTourEntryPoint({ chapter: 'done' })).toEqual({
      chapter: 'tour',
      stepIndex: 0,
    });
    expect(resolveTourEntryPoint(undefined)).toEqual({
      chapter: 'tour',
      stepIndex: 0,
    });
  });
});

describe('firstRunStore persistence', () => {
  beforeEach(() => {
    firstRunStore.reset();
  });

  test('defaults to the Connect chapter with no step recorded', () => {
    expect(firstRunStore.getSnapshot()).toEqual({ chapter: 'connect' });
  });

  test('records the tour step so leaving mid-tour resumes there', () => {
    const second = FIRST_RUN_TOUR_STEPS[1];
    firstRunStore.enterChapter('tour');
    firstRunStore.recordTourStep(second.id);
    expect(firstRunStore.getSnapshot()).toEqual({
      chapter: 'tour',
      tourStepId: second.id,
    });
    // The persisted value is what a fresh read resumes from, not component
    // state that dies with the page.
    expect(
      resolveResumePoint(deviceSettingsStore.get('firstRunProgress')),
    ).toEqual({ chapter: 'tour', stepIndex: 1 });
  });

  test('skipping out of the tour persists exactly like finishing it', () => {
    firstRunStore.enterChapter('tour');
    firstRunStore.recordTourStep(FIRST_RUN_TOUR_STEPS[1].id);
    firstRunStore.finish();
    expect(firstRunStore.getSnapshot().chapter).toBe('done');
    // Re-asking someone who already said no is the failure this prevents.
    expect(resolveResumePoint(firstRunStore.getSnapshot()).chapter).toBe(
      'tour',
    );
  });

  test('notifies subscribers when progress moves', () => {
    let notifications = 0;
    const unsubscribe = firstRunStore.subscribe(() => {
      notifications += 1;
    });
    firstRunStore.enterChapter('about-you');
    expect(notifications).toBeGreaterThan(0);
    unsubscribe();
  });
});
