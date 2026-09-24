// @vitest-environment jsdom

/**
 * #90 D9: "Open in right panel" places a Browser pane attached to THE
 * floated session, through the region seam every cross-region open uses.
 * The model is a fake that records what it was asked; the stored state and
 * the id it is asked to place are the real ones the region host reads.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { openBrowserSessionInRegion } from '../../contexts/useOpenInRegion';
import {
  DEFAULT_DEVICE_REGION_ARRANGEMENT,
  type RegionArrangement,
} from '../../regions/region-model';
import { readBrowserPreviewPaneState } from '../../workspace-panes/browserPreviewPaneStateStorage';

const SESSION = 'bs_0f8f7c1e-9a41-4f2b-9d4a-2b8b1c0e5a77';
const PROJECT = 'p-alpha';

function model(
  outcome: 'ok' | 'refuse' = 'ok',
  regions: RegionArrangement = DEFAULT_DEVICE_REGION_ARRANGEMENT,
) {
  const openSurfaceInRegion = vi.fn((surfaceId: string, _options?: object) =>
    outcome === 'ok'
      ? {
          ok: true as const,
          region: 'right' as const,
          surfaceId,
          existing: false,
        }
      : { ok: false as const, reason: 'refused' as const },
  );
  return { regions, openSurfaceInRegion };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('openBrowserSessionInRegion (#90 D9)', () => {
  test('places a Browser pane whose stored state is the session, in the region asked for', () => {
    const fake = model();
    const outcome = openBrowserSessionInRegion(
      fake,
      { projectId: PROJECT, browserSessionId: SESSION },
      { region: 'right' },
    );
    expect(outcome.ok).toBe(true);
    const [surfaceId, options] = fake.openSurfaceInRegion.mock.calls[0] ?? [];
    expect(surfaceId).toMatch(/^browser-preview:[0-9a-f]{32}$/);
    expect(options).toEqual({ region: 'right' });
    const stored = readBrowserPreviewPaneState(
      window.localStorage,
      String(surfaceId),
    );
    expect(stored?.version).toBe('2.0');
    expect(stored?.version === '2.0' ? stored.state : null).toMatchObject({
      projectId: PROJECT,
      browserSessionId: SESSION,
    });
  });

  test('a session already open in a pane is revealed, not opened a second time', () => {
    const first = model();
    openBrowserSessionInRegion(first, {
      projectId: PROJECT,
      browserSessionId: SESSION,
    });
    const placed = String(first.openSurfaceInRegion.mock.calls[0]?.[0]);
    const arranged: RegionArrangement = {
      ...DEFAULT_DEVICE_REGION_ARRANGEMENT,
      right: {
        ...DEFAULT_DEVICE_REGION_ARRANGEMENT.right,
        visible: true,
        panes: [placed],
        occupant: placed,
      },
    };
    const second = model('ok', arranged);
    openBrowserSessionInRegion(
      second,
      { projectId: PROJECT, browserSessionId: SESSION },
      { region: 'right' },
    );
    expect(second.openSurfaceInRegion).toHaveBeenCalledWith(placed, {
      region: 'right',
      focusExisting: true,
    });
  });

  test('a refused open leaves no stored state behind', () => {
    const fake = model('refuse');
    const outcome = openBrowserSessionInRegion(fake, {
      projectId: PROJECT,
      browserSessionId: SESSION,
    });
    expect(outcome).toEqual({ ok: false, reason: 'refused' });
    const surfaceId = String(fake.openSurfaceInRegion.mock.calls[0]?.[0]);
    expect(
      readBrowserPreviewPaneState(window.localStorage, surfaceId),
    ).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  test('a malformed session id is refused before anything is written or placed', () => {
    const fake = model();
    const outcome = openBrowserSessionInRegion(fake, {
      projectId: PROJECT,
      browserSessionId: 'not-a-session',
    });
    expect(outcome).toEqual({ ok: false, reason: 'no-surface' });
    expect(fake.openSurfaceInRegion).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });
});
