// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FOLD_FOLLOW_UP_READS_MS,
  type FoldSourceEnvironment,
  installFoldGeometry,
} from '../foldSources';
import { getFoldGeometry, publishFoldGeometry } from '../foldStore';
import {
  bookSnapshot,
  coldLaunchBookSnapshot,
  coldLaunchFirstSnapshot,
  flatSnapshot,
} from './nativeFoldFixtures';

/**
 * The bridge as the page sees it: `plugin:station-fold|state` replies and the
 * plugin's `change` nudge go in; the document's posture attribute and hinge
 * properties, which every fold-aware layout reads, come out.
 */
function harness({
  tauri = true,
  native = vi.fn<() => Promise<unknown>>(),
  segments = null as FoldSourceEnvironment['window']['viewport'] | null,
  listenFails = false,
  innerHeight = 669,
  innerWidth = 951,
} = {}) {
  let nudge: (() => void) | undefined;
  // Follow-up reads only run when a test fires them.
  const timers: { run: () => void; ms: number; cleared: boolean }[] = [];
  const resizeListeners: (() => void)[] = [];
  const win = {
    innerWidth,
    innerHeight,
    viewport: segments ?? undefined,
    addEventListener: vi.fn((type: string, listener: () => void) => {
      if (type === 'resize') resizeListeners.push(listener);
    }),
    removeEventListener: vi.fn(),
  };
  const environment: FoldSourceEnvironment = {
    window: win,
    devicePosture: null,
    document,
    hasTauri: () => tauri,
    readNative: native,
    listenNative: async (changed) => {
      if (listenFails) throw new Error('register_listener refused');
      nudge = changed;
      return () => {
        nudge = undefined;
      };
    },
    publish: publishFoldGeometry,
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
  const stop = installFoldGeometry(environment);
  return {
    stop,
    native,
    win,
    nudge: () => nudge?.(),
    /** Runs every follow-up read still scheduled. */
    fireFollowUps: () => {
      for (const timer of timers) if (!timer.cleared) timer.run();
    },
    pendingFollowUps: () => timers.filter((timer) => !timer.cleared).length,
    resize: () => {
      for (const listener of resizeListeners) listener();
    },
  };
}

const root = () => document.documentElement;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  publishFoldGeometry(null);
});

describe('installFoldGeometry', () => {
  it('publishes the native Book crease onto the document', async () => {
    const { stop } = harness({
      native: vi.fn().mockResolvedValue(bookSnapshot),
    });
    await settle();
    expect(root().dataset.foldPosture).toBe('folded');
    expect(root().dataset.foldAxis).toBe('vertical');
    expect(root().style.getPropertyValue('--station-hinge-x')).toBe(
      `${Math.round(bookSnapshot.regions[0].x)}px`,
    );
    stop();
  });

  it('re-reads on the plugin’s change nudge and follows the hinge opening flat', async () => {
    const native = vi
      .fn()
      .mockResolvedValueOnce(bookSnapshot)
      .mockResolvedValueOnce(flatSnapshot);
    const { stop, nudge } = harness({ native });
    await settle();
    expect(root().dataset.foldPosture).toBe('folded');
    nudge();
    await settle();
    expect(native).toHaveBeenCalledTimes(2);
    expect(root().dataset.foldPosture).toBe('flat');
    stop();
  });

  it('ignores a delayed reply older than the reading it already has', async () => {
    const native = vi
      .fn()
      .mockResolvedValueOnce(flatSnapshot)
      .mockResolvedValueOnce(bookSnapshot);
    expect(flatSnapshot.revision).toBeGreaterThan(bookSnapshot.revision);
    const { stop, nudge } = harness({ native });
    await settle();
    nudge();
    await settle();
    expect(root().dataset.foldPosture).toBe('flat');
    stop();
  });

  it('clears every attribute and property when the native shell reports no crease', async () => {
    const native = vi
      .fn()
      .mockResolvedValueOnce(bookSnapshot)
      .mockResolvedValueOnce({ ...bookSnapshot, revision: 99, regions: [] });
    const { stop, nudge } = harness({ native });
    await settle();
    nudge();
    await settle();
    expect(getFoldGeometry()).toBeNull();
    expect(root().dataset.foldPosture).toBeUndefined();
    expect(root().style.getPropertyValue('--station-hinge-x')).toBe('');
    stop();
  });

  it('falls back to CSS Viewport Segments when the shell has no plugin', async () => {
    const { stop } = harness({
      native: vi.fn().mockRejectedValue(new Error('plugin not found')),
      segments: {
        segments: [
          { x: 0, y: 0, width: 475, height: 669 },
          { x: 475, y: 0, width: 476, height: 669 },
        ],
      },
    });
    await settle();
    expect(getFoldGeometry()?.source).toBe('viewport-segments');
    expect(root().style.getPropertyValue('--station-hinge-x')).toBe('475px');
    stop();
  });

  it('never asks a plain browser for the native plugin', async () => {
    const native = vi.fn();
    const { stop } = harness({ tauri: false, native });
    await settle();
    expect(native).not.toHaveBeenCalled();
    expect(getFoldGeometry()).toBeNull();
    stop();
  });
});

describe('a cold launch on a device that is already folded', () => {
  it('reaches the crease when the first reply is empty and no posture change or nudge follows', async () => {
    const native = vi
      .fn()
      .mockResolvedValueOnce(coldLaunchFirstSnapshot)
      .mockResolvedValue(coldLaunchBookSnapshot);
    const { stop, fireFollowUps, pendingFollowUps } = harness({ native });
    await settle();
    // The page's first answer is the plugin's launch reading: nothing yet.
    expect(root().dataset.foldPosture).toBeUndefined();
    expect(pendingFollowUps()).toBe(FOLD_FOLLOW_UP_READS_MS.length);
    // No `change` event and no resize: only the page asking again finds it.
    fireFollowUps();
    await settle();
    expect(root().dataset.foldPosture).toBe('folded');
    expect(root().style.getPropertyValue('--station-hinge-x')).toBe('456px');
    // A definitive reply ends the follow-ups.
    expect(pendingFollowUps()).toBe(0);
    stop();
  });

  it('still asks again when the change subscription could not be registered', async () => {
    const native = vi
      .fn()
      .mockResolvedValueOnce(coldLaunchFirstSnapshot)
      .mockResolvedValue(coldLaunchBookSnapshot);
    const { stop, fireFollowUps } = harness({ native, listenFails: true });
    await settle();
    fireFollowUps();
    await settle();
    expect(root().dataset.foldPosture).toBe('folded');
    stop();
  });

  it('re-reads the shell on resize, not only recomputing a stale reading', async () => {
    const native = vi
      .fn()
      .mockResolvedValueOnce(coldLaunchFirstSnapshot)
      .mockResolvedValue(coldLaunchBookSnapshot);
    const { stop, resize } = harness({ native });
    await settle();
    resize();
    await settle();
    expect(root().dataset.foldPosture).toBe('folded');
    stop();
  });

  it('keeps the crease while the page height has not settled', async () => {
    const { stop } = harness({
      native: vi.fn().mockResolvedValue(coldLaunchBookSnapshot),
      innerHeight: 700,
    });
    await settle();
    expect(root().dataset.foldPosture).toBe('folded');
    stop();
  });

  it('re-evaluates an unchanged reading once the page has its real width', async () => {
    // The first evaluation happens while the page still reports a stale width
    // (the cover display's); the follow-up returns the same revision.
    const native = vi.fn().mockResolvedValue(coldLaunchBookSnapshot);
    const { stop, win, nudge } = harness({ native, innerWidth: 466 });
    await settle();
    expect(root().style.getPropertyValue('--station-hinge-x')).toBe('223px');
    win.innerWidth = 951;
    native.mockClear();
    // A nudge only re-reads; the same-revision reply must still be applied.
    nudge();
    await settle();
    expect(native).toHaveBeenCalled();
    expect(root().style.getPropertyValue('--station-hinge-x')).toBe('456px');
    stop();
  });

  it('stops asking at the first definitive reply', async () => {
    const native = vi.fn().mockResolvedValue(coldLaunchBookSnapshot);
    const { stop, pendingFollowUps } = harness({ native });
    await settle();
    expect(pendingFollowUps()).toBe(0);
    stop();
  });
});
