import { describe, expect, it } from 'vitest';
import { createForegroundWorkJournal } from '../foreground-work-journal';

const attribution = {
  phase: 'authoritative-apply',
  interaction: 'collaboration',
  action: 'remote-apply',
  pane: 'task-editor',
} as const;

function installLongTaskObserverFixture() {
  let callback:
    | ((entries: readonly { startTime: number; duration: number }[]) => void)
    | undefined;
  const original = (globalThis as any).PerformanceObserver;
  class FakePerformanceObserver {
    static supportedEntryTypes = ['longtask'];
    constructor(
      next: (list: {
        getEntries(): readonly { startTime: number; duration: number }[];
      }) => void,
    ) {
      callback = (entries) => next({ getEntries: () => entries });
    }
    observe(options: unknown) {
      fixture.observeOptions = options;
    }
    disconnect() {}
  }
  (globalThis as any).PerformanceObserver = FakePerformanceObserver;
  const fixture = {
    observeOptions: undefined as unknown,
    emit(entries: readonly { startTime: number; duration: number }[]) {
      callback?.(entries);
    },
    restore() {
      (globalThis as any).PerformanceObserver = original;
    },
  };
  return fixture;
}

describe('foreground work journal', () => {
  it('records one bounded incident for an explicit synthetic over-50ms stall', () => {
    let time = 0;
    const journal = createForegroundWorkJournal({
      now: () => time,
      observeLongTasks: false,
    });
    const finish = journal.begin(attribution);
    journal.recordManualStall(51);
    time = 5_000;
    finish();
    expect(journal.snapshot()).toMatchObject({
      collector: 'NOT_VERIFIED',
      thresholdMs: 50,
      incidents: [{ ...attribution, source: 'manual-stall', durationMs: 51 }],
      aggregate: { count: 1, totalDurationMs: 51, maxDurationMs: 51 },
      native: { status: 'NOT_VERIFIED' },
    });
  });

  it('does not turn a >50ms timer yield into an incident', async () => {
    const journal = createForegroundWorkJournal({ observeLongTasks: false });
    const finish = journal.begin(attribution);
    await new Promise((resolve) => setTimeout(resolve, 55));
    finish();
    expect(journal.snapshot()).toMatchObject({
      incidents: [],
      aggregate: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
    });
  });

  it('attributes one Long Task to the latest render mark inside input, dedupes it, and never duplicates it on close', () => {
    let time = 0;
    const observer = installLongTaskObserverFixture();
    try {
      const journal = createForegroundWorkJournal({ now: () => time });
      const outer = journal.begin(attribution);
      journal.mark(attribution, 0);
      journal.mark(
        {
          ...attribution,
          phase: 'render',
          pane: 'diff-panel',
          action: 'layout-commit',
        },
        5,
      );
      observer.emit([{ startTime: 10, duration: 73 }]);
      observer.emit([{ startTime: 10, duration: 73 }]);
      time = 100;
      outer();
      expect(observer.observeOptions).toEqual({
        type: 'longtask',
        buffered: false,
      });
      expect(journal.snapshot()).toMatchObject({
        collector: 'browser-longtask',
        incidents: [
          expect.objectContaining({
            source: 'browser-longtask',
            phase: 'render',
            durationMs: 73,
          }),
        ],
        aggregate: { count: 1, totalDurationMs: 73, maxDurationMs: 73 },
      });
    } finally {
      observer.restore();
    }
  });

  it.each([
    [
      'render',
      {
        phase: 'render',
        interaction: 'workspace-pane',
        action: 'layout-commit',
        pane: 'diff-panel',
      },
    ],
    ['apply', attribution],
    [
      'layout',
      {
        phase: 'layout',
        interaction: 'task-editor',
        action: 'layout-commit',
        pane: 'task-editor',
      },
    ],
    [
      'presence',
      {
        phase: 'render',
        interaction: 'collaboration',
        action: 'presence-update',
        pane: 'task-editor',
      },
    ],
    [
      'cursor',
      {
        phase: 'render',
        interaction: 'collaboration',
        action: 'presence-update',
        pane: 'task-editor',
      },
    ],
    [
      'reconnect',
      {
        phase: 'authoritative-apply',
        interaction: 'navigation',
        action: 'pane-restore',
        pane: 'task-editor',
      },
    ],
  ] as const)(
    'attributes a Long Task to its %s completion instead of its preceding start',
    (_name, completion) => {
      let time = 10;
      const observer = installLongTaskObserverFixture();
      try {
        const journal = createForegroundWorkJournal({ now: () => time });
        journal.mark(
          {
            phase: 'input',
            interaction: 'task-editor',
            action: 'local-input',
            pane: 'task-editor',
          },
          0,
          'start',
        );
        const finish = journal.begin({
          phase: 'input',
          interaction: 'task-editor',
          action: 'local-input',
          pane: 'task-editor',
        });
        journal.mark(completion, 60, 'completion');
        observer.emit([{ startTime: 10, duration: 70 }]);
        time = 80;
        finish();
        expect(journal.snapshot().incidents).toEqual([
          expect.objectContaining({
            ...completion,
            source: 'browser-longtask',
            durationMs: 70,
          }),
        ]);
      } finally {
        observer.restore();
      }
    },
  );

  it('closes an earlier start at the correlated completion so it cannot own a later unowned Long Task', () => {
    const observer = installLongTaskObserverFixture();
    try {
      const journal = createForegroundWorkJournal({ now: () => 100 });
      journal.mark(
        {
          phase: 'input',
          interaction: 'task-editor',
          action: 'local-input',
          pane: 'task-editor',
        },
        0,
        'start',
      );
      journal.mark(
        {
          phase: 'render',
          interaction: 'workspace-pane',
          action: 'layout-commit',
          pane: 'diff-panel',
        },
        60,
        'completion',
      );

      observer.emit([{ startTime: 100, duration: 70 }]);
      expect(journal.snapshot().incidents).toEqual([]);
    } finally {
      observer.restore();
    }
  });

  it('closes only the latest nested start, leaving the outer interaction to own the next Long Task', () => {
    let time = 0;
    const observer = installLongTaskObserverFixture();
    const outer = {
      phase: 'input',
      interaction: 'task-editor',
      action: 'local-input',
      pane: 'task-editor',
    } as const;
    const inner = {
      phase: 'render',
      interaction: 'workspace-pane',
      action: 'layout-commit',
      pane: 'diff-panel',
    } as const;
    try {
      const journal = createForegroundWorkJournal({ now: () => time });
      journal.begin(outer);
      time = 10;
      journal.begin(inner);
      journal.mark(inner, 20, 'completion');

      observer.emit([{ startTime: 25, duration: 60 }]);
      expect(journal.snapshot().incidents).toEqual([
        expect.objectContaining({ ...outer, durationMs: 60 }),
      ]);
    } finally {
      observer.restore();
    }
  });

  it('closes the remaining outer start on its later completion, leaving following Long Tasks unowned', () => {
    let time = 0;
    const observer = installLongTaskObserverFixture();
    const outer = {
      phase: 'input',
      interaction: 'task-editor',
      action: 'local-input',
      pane: 'task-editor',
    } as const;
    const inner = {
      phase: 'render',
      interaction: 'workspace-pane',
      action: 'layout-commit',
      pane: 'diff-panel',
    } as const;
    try {
      const journal = createForegroundWorkJournal({ now: () => time });
      journal.begin(outer);
      time = 10;
      journal.begin(inner);
      journal.mark(inner, 20, 'completion');
      journal.mark(outer, 30, 'completion');

      observer.emit([{ startTime: 35, duration: 60 }]);
      expect(journal.snapshot().incidents).toEqual([]);
    } finally {
      observer.restore();
    }
  });

  it('does not extend a completion-closed inner interval when its late finish callback runs', () => {
    let time = 0;
    const observer = installLongTaskObserverFixture();
    const outer = {
      phase: 'input',
      interaction: 'task-editor',
      action: 'local-input',
      pane: 'task-editor',
    } as const;
    const inner = {
      phase: 'render',
      interaction: 'workspace-pane',
      action: 'layout-commit',
      pane: 'diff-panel',
    } as const;
    try {
      const journal = createForegroundWorkJournal({ now: () => time });
      journal.begin(outer);
      time = 10;
      const finishInner = journal.begin(inner);
      journal.mark(inner, 20, 'completion');
      time = 80;
      finishInner();

      observer.emit([{ startTime: 50, duration: 60 }]);
      expect(journal.snapshot().incidents).toEqual([
        expect.objectContaining({ ...outer, durationMs: 60 }),
      ]);
    } finally {
      observer.restore();
    }
  });

  it('dedupes one raw Long Task entry when delivery straddles an attribution mark', () => {
    const observer = installLongTaskObserverFixture();
    try {
      const journal = createForegroundWorkJournal();
      journal.mark(
        {
          phase: 'input',
          interaction: 'task-editor',
          action: 'local-input',
          pane: 'task-editor',
        },
        0,
        'start',
      );
      observer.emit([{ startTime: 10, duration: 70 }]);
      journal.mark(
        {
          phase: 'render',
          interaction: 'workspace-pane',
          action: 'layout-commit',
          pane: 'diff-panel',
        },
        60,
        'completion',
      );
      observer.emit([{ startTime: 10, duration: 70 }]);

      expect(journal.snapshot().incidents).toEqual([
        expect.objectContaining({
          phase: 'input',
          source: 'browser-longtask',
          durationMs: 70,
        }),
      ]);
    } finally {
      observer.restore();
    }
  });

  it('closes active starts at fixture end before a queued observer delivery', () => {
    const observer = installLongTaskObserverFixture();
    try {
      const journal = createForegroundWorkJournal({ now: () => 60 });
      journal.mark(
        {
          phase: 'input',
          interaction: 'task-editor',
          action: 'local-input',
          pane: 'task-editor',
        },
        0,
        'start',
      );
      journal.close();
      observer.emit([{ startTime: 100, duration: 70 }]);
      expect(journal.snapshot().incidents).toEqual([]);
    } finally {
      observer.restore();
    }
  });

  it('rejects hostile attribution extras and bounds invalid, fractional, and oversized capacities', () => {
    const journal = (capacity?: number) =>
      createForegroundWorkJournal({
        capacity,
        now: () => 0,
        observeLongTasks: false,
      });
    // Positive control: a valid begin() held open across the stall owns it.
    const accepted = journal();
    const acceptedFinish = accepted.begin(attribution);
    accepted.recordManualStall(60);
    acceptedFinish();
    expect(accepted.snapshot().incidents).toHaveLength(1);

    const begun = journal();
    const hostileFinish = begun.begin({
      ...attribution,
      taskId: 'task-99',
    } as any);
    begun.recordManualStall(60);
    hostileFinish();
    const marked = journal();
    marked.mark({ ...attribution, path: '/private/work' } as any, 0);
    marked.recordManualStall(60);
    for (const rejected of [begun, marked]) {
      expect(rejected.snapshot().incidents).toEqual([]);
      expect(JSON.stringify(rejected.snapshot())).not.toMatch(
        /task-99|\/private\/work/,
      );
    }

    const invalid = journal(Number.NaN);
    const invalidFinish = invalid.begin(attribution);
    for (let index = 0; index < 70; index += 1)
      invalid.recordManualStall(60 + index);
    invalidFinish();
    expect(invalid.snapshot().incidents).toHaveLength(64);

    const bounded = createForegroundWorkJournal({
      capacity: 1000,
      observeLongTasks: false,
    });
    const finish = bounded.begin(attribution);
    for (let index = 0; index < 130; index += 1)
      bounded.recordManualStall(60 + index);
    finish();
    expect(bounded.snapshot().incidents).toHaveLength(128);

    const fractional = createForegroundWorkJournal({
      capacity: 1.5,
      observeLongTasks: false,
    });
    const complete = fractional.begin(attribution);
    fractional.recordManualStall(60);
    fractional.recordManualStall(61);
    complete();
    expect(fractional.snapshot().incidents).toHaveLength(2);
  });
});
