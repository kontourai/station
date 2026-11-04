// @vitest-environment jsdom

/**
 * Foldable devices in the Device pane: the fold the stream reports drives a
 * bent drawing of the lit display, stand/hinge/table controls that send
 * `fold` input through the surface, and touches that land on the bent
 * drawing reach the flat display point under them.
 */

import type { LiveSurfaceFold } from '@kontourai/station-contracts/live-surface';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../hooks/useActiveProject', () => ({
  useActiveProject: () => ({
    projectSlug: null,
    projectName: null,
    workingDirectory: null,
  }),
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'authority-1',
  }),
}));

import { resetFloatStoreForTests } from '../../float-over-chat/floatStore';
import { DeviceWorkspacePane } from '../DeviceWorkspacePane';
import { foldPresentation, projectFoldPoint } from '../device/deviceFold';
import {
  authorizeScope,
  click,
  frameRecord,
  IOS_DEVICE,
  readyInventory,
  renderInQueryClient,
  stateRecord,
  stubDeviceFetch,
} from './deviceWorkspacePaneHarness';

/** The inner display's frame, and the box the stage gives it (1/5 scale). */
const INNER = { width: 2200, height: 1920 };
const BOX = { width: 440, height: 384 };

const BOOK: LiveSurfaceFold = {
  activeDisplay: 'inner',
  hingeAngle: 90,
  posture: 'book',
  postures: ['closed', 'open', 'book', 'laptop', 'tent'],
  angleControl: true,
  tableMode: false,
};

function rect(box: { width: number; height: number }): DOMRect {
  return {
    left: 0,
    top: 0,
    x: 0,
    y: 0,
    width: box.width,
    height: box.height,
    right: box.width,
    bottom: box.height,
    toJSON: () => ({}),
  };
}

beforeEach(() => {
  authorizeScope();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: 1, height: 1, close() {} })),
  );
  // jsdom lays nothing out: the stage and the fitted canvas get the box a
  // browser would give them.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => rect(BOX),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setClientCredentialResolver();
  localStorage.clear();
  resetFloatStoreForTests();
});

async function live(fold: LiveSurfaceFold | undefined) {
  const log = stubDeviceFetch({ inventory: readyInventory([IOS_DEVICE]) });
  renderInQueryClient(<DeviceWorkspacePane />);
  await click(
    await screen.findByRole('button', { name: 'Open iPhone 17 Pro' }),
  );
  await waitFor(() => expect(log.streams).toHaveLength(1));
  const stream = log.streams[0]!;
  const surfaceId = decodeURIComponent(
    new URL(stream.url).pathname.split('/live-surfaces/')[1]!.split('/')[0]!,
  );
  await stream.push(
    stateRecord(surfaceId, {
      inputChannel: 'connected',
      ...(fold ? { fold } : {}),
    }),
  );
  await stream.push(frameRecord(surfaceId, 1, fold ? INNER : undefined));
  return { log, stream, surfaceId };
}

describe('a foldable device', () => {
  test('a phone that does not fold gets no fold controls and a flat canvas', async () => {
    await live(undefined);
    expect(screen.queryByTestId('device-fold-controls')).toBeNull();
    expect(screen.queryByTestId('live-surface-projection')).toBeNull();
  });

  test('stands, the hinge and table mode send fold input through the surface', async () => {
    const { log } = await live(BOOK);
    const stands = screen.getByRole('radiogroup', { name: 'Stand' });
    expect(
      screen.getByRole('radio', { name: 'Book' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(stands.querySelectorAll('[role="radio"]')).toHaveLength(5);
    await click(screen.getByRole('radio', { name: 'Laptop' }));
    await waitFor(() => expect(log.inputs).toHaveLength(1));
    expect(log.inputs[0]!.events).toEqual([
      { kind: 'fold', posture: 'laptop' },
    ]);

    // The hinge previews while it moves, settles on a stand's angle near
    // it, and sends ONE angle when released.
    const hinge = screen.getByRole('slider', { name: 'Hinge' });
    fireEvent.change(hinge, { target: { value: '133' } });
    expect(screen.getByText('133°')).toBeTruthy();
    expect(log.inputs).toHaveLength(1);
    fireEvent.change(hinge, { target: { value: '176' } });
    expect(screen.getByText('180°')).toBeTruthy();
    fireEvent.pointerUp(hinge);
    fireEvent.blur(hinge);
    await waitFor(() => expect(log.inputs).toHaveLength(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(log.inputs).toHaveLength(2);
    expect(log.inputs[1]!.events).toEqual([{ kind: 'fold', hingeAngle: 180 }]);

    await click(screen.getByRole('checkbox', { name: 'Table mode' }));
    await waitFor(() => expect(log.inputs).toHaveLength(3));
    expect(log.inputs[2]!.events).toEqual([{ kind: 'fold', tableMode: true }]);
  });

  test('the lit inner display is drawn bent at a crease across its longer side', async () => {
    const { stream, surfaceId } = await live(BOOK);
    const view = screen.getByTestId('device-fold-view');
    expect(view.dataset.crease).toBe('vertical');
    const halves = view.querySelectorAll('canvas');
    expect([...halves].map((half) => half.dataset.turn)).toEqual(['45', '45']);
    expect(screen.getByTestId('live-surface-canvas').className).toContain(
      'live-surface__canvas--projected',
    );
    // Closing hands off to the cover display: drawn flat, no crease.
    await stream.push(
      stateRecord(surfaceId, {
        inputChannel: 'connected',
        fold: {
          ...BOOK,
          activeDisplay: 'cover',
          hingeAngle: 0,
          posture: 'closed',
        },
      }),
    );
    expect(screen.getByTestId('device-fold-view').dataset.crease).toBe('none');
  });

  test('a touch on the bent drawing reaches the flat display point under it', async () => {
    const { log } = await live(BOOK);
    const presentation = foldPresentation(BOOK, INNER);
    // Where the display point (1650, 480) — the right half — is drawn.
    const drawn = projectFoldPoint({ x: 330, y: 96 }, BOX, presentation);
    // Bent, it is drawn closer to the crease than it lies flat.
    expect(drawn.x).toBeLessThan(330);
    const canvas = screen.getByTestId('live-surface-canvas');
    fireEvent.pointerDown(canvas, {
      clientX: drawn.x,
      clientY: drawn.y,
      button: 0,
      pointerId: 1,
    });
    fireEvent.pointerUp(canvas, {
      clientX: drawn.x,
      clientY: drawn.y,
      button: 0,
      pointerId: 1,
    });
    await waitFor(() =>
      expect(log.inputs.flatMap((batch) => batch.events)).toHaveLength(2),
    );
    const [down] = log.inputs.flatMap((batch) => batch.events) as {
      type: string;
      x: number;
      y: number;
    }[];
    expect(down!.type).toBe('down');
    expect(down!.x).toBeCloseTo(1650, 3);
    expect(down!.y).toBeCloseTo(480, 3);

    // The box's outer edge, beyond the drawn halves, is no display at all.
    fireEvent.pointerDown(canvas, {
      clientX: BOX.width - 2,
      clientY: BOX.height / 2,
      button: 0,
      pointerId: 2,
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(log.inputs.flatMap((batch) => batch.events)).toHaveLength(2);
  });
});
