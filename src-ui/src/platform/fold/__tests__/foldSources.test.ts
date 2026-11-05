// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type FoldSourceEnvironment,
  installFoldGeometry,
} from '../foldSources';
import { getFoldGeometry, publishFoldGeometry } from '../foldStore';
import { bookSnapshot, flatSnapshot } from './nativeFoldFixtures';

/**
 * The bridge as the page sees it: `plugin:station-fold|state` replies and the
 * plugin's `change` nudge go in; the document's posture attribute and hinge
 * properties, which every fold-aware layout reads, come out.
 */
function harness({
  tauri = true,
  native = vi.fn<() => Promise<unknown>>(),
  segments = null as FoldSourceEnvironment['window']['viewport'] | null,
} = {}) {
  let nudge: (() => void) | undefined;
  const win = {
    innerWidth: 951,
    innerHeight: 669,
    viewport: segments ?? undefined,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const environment: FoldSourceEnvironment = {
    window: win,
    devicePosture: null,
    document,
    hasTauri: () => tauri,
    readNative: native,
    listenNative: async (changed) => {
      nudge = changed;
      return () => {
        nudge = undefined;
      };
    },
    publish: publishFoldGeometry,
  };
  const stop = installFoldGeometry(environment);
  return { stop, native, nudge: () => nudge?.() };
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
