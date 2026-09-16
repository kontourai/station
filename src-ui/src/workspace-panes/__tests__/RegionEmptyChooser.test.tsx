/** @vitest-environment jsdom */

/**
 * #2154: the chooser an empty region shows, and the panel its "+" opens.
 * The region model is stubbed at its context (the arrangement and the
 * registry are the real ones; the open is a spy), so what is proved is what
 * the chooser LISTS, in what order, which rows it enables and why, what
 * choosing does, and the panel's dismiss contract. The shipped path — a
 * region host rendering it — is `RegionPaneHost.regions.test.tsx` and
 * `RegionPaneHost.project.test.tsx`.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { OpenInRegionOutcome } from '../../contexts/RegionModelContext';
import {
  INSTANCE_SURFACE_PREFIXES,
  REGION_SURFACE_REGISTRY,
  type RegionArrangement,
  type RegionId,
} from '../../regions/region-model';

const harness = vi.hoisted(() => ({
  openSurfaceInRegion: vi.fn(),
  regions: null as unknown,
}));

vi.mock('../../contexts/RegionModelContext', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../contexts/RegionModelContext')>();
  const { REGION_SURFACE_REGISTRY } = await import(
    '../../regions/region-model'
  );
  const model = {
    get regions() {
      return harness.regions;
    },
    surfaces: REGION_SURFACE_REGISTRY,
    openSurfaceInRegion: harness.openSurfaceInRegion,
  };
  return {
    ...actual,
    useRegionModel: () => model,
    useRegionModelOptional: () => model,
  };
});

import { RegionEmptyChooser } from '../RegionEmptyChooser';

const NO_PROJECT = { projectId: null, projectSlug: null };
const ALPHA = { projectId: 'alpha-id', projectSlug: 'alpha' };

/** A fresh home: Chat at the bottom, Home in `main`, Right visible and empty. */
function freshArrangement(): RegionArrangement {
  return {
    main: {
      visible: true,
      size: 0,
      panes: ['home'],
      occupant: 'home',
      maximized: false,
    },
    left: {
      visible: false,
      size: 400,
      panes: [],
      occupant: null,
      maximized: false,
    },
    right: {
      visible: true,
      size: 400,
      panes: [],
      occupant: null,
      maximized: false,
    },
    bottom: {
      visible: true,
      size: 320,
      panes: ['chat'],
      occupant: 'chat',
      maximized: false,
    },
  };
}

beforeEach(() => {
  harness.regions = freshArrangement();
  harness.openSurfaceInRegion.mockReset();
  harness.openSurfaceInRegion.mockImplementation(
    (surfaceId: string, options?: { region?: RegionId }) =>
      ({
        ok: true,
        region: options?.region ?? 'right',
        surfaceId,
        existing: false,
      }) satisfies OpenInRegionOutcome,
  );
});

afterEach(() => vi.restoreAllMocks());

const rowNames = (container: HTMLElement) =>
  within(container)
    .getAllByRole('button')
    .map((row) => row.textContent);

/**
 * A1/A3: the rows are the registry's surfaces declaring the region, in
 * registry order, `exposure` notwithstanding — Home drops out by its own
 * `regions`. Reverting the filter to `exposure !== 'catalog'` reds the
 * exact-list assertion (only Chat and Activity would list); dropping the
 * `regions` filter reds it with Home listed.
 */
test('an empty region lists every surface declaring it, in registry order, for Right and for Bottom alike', () => {
  const { unmount } = render(
    <RegionEmptyChooser
      regionId="right"
      context={NO_PROJECT}
      variant="inline"
    />,
  );
  const list = screen.getByRole('list', { name: 'Add to Right region' });
  expect(
    within(list)
      .getAllByRole('button')
      .map((row) => row.querySelector('.region-chooser__title')?.textContent),
  ).toEqual([
    'Chat',
    'Activity',
    'Agents',
    'Device',
    'Terminal',
    'Diff',
    'Files',
  ]);
  // No instance-keyed family is offered: `board:`, `layout:`, `pr:` and
  // `file-preview:` name one occurrence each and have no blank one to
  // place, so they are prefixes (`INSTANCE_SURFACE_PREFIXES`) and never
  // registry keys. The retired "+" catalog filtered their descriptors out
  // by hand; the chooser reads `model.surfaces`, which never held them.
  // The filter is only a claim while there are prefixes to match with.
  expect(INSTANCE_SURFACE_PREFIXES.length).toBeGreaterThan(0);
  expect(
    [...REGION_SURFACE_REGISTRY.keys()].filter((id) =>
      INSTANCE_SURFACE_PREFIXES.some((prefix) => id.startsWith(prefix.prefix)),
    ),
  ).toEqual([]);
  expect(screen.getByText('Nothing in the Right region yet')).toBeTruthy();
  expect(screen.queryByRole('menu')).toBeNull();
  unmount();

  (harness.regions as RegionArrangement).bottom = {
    visible: true,
    size: 320,
    panes: [],
    occupant: null,
    maximized: false,
  };
  render(
    <RegionEmptyChooser
      regionId="bottom"
      context={NO_PROJECT}
      variant="inline"
    />,
  );
  const bottom = screen.getByRole('list', { name: 'Add to Bottom region' });
  expect(
    within(bottom)
      .getAllByRole('button')
      .map((row) => row.querySelector('.region-chooser__title')?.textContent),
  ).toEqual([
    'Chat',
    'Activity',
    'Agents',
    'Device',
    'Terminal',
    'Diff',
    'Files',
  ]);
});

/**
 * A1: choosing a row is the model's `openSurfaceInRegion` for THIS region —
 * never `placeSurface` directly (which would skip the device's fold) and
 * never a host open action. Reverting the call to `placeSurface` reds the
 * spy assertion.
 */
test('choosing Activity opens it in this region through the model', () => {
  render(
    <RegionEmptyChooser
      regionId="right"
      context={NO_PROJECT}
      variant="inline"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
  expect(harness.openSurfaceInRegion).toHaveBeenCalledWith('activity', {
    region: 'right',
  });
  expect(harness.openSurfaceInRegion).toHaveBeenCalledTimes(1);
});

/**
 * A2: a row the dock cannot supply is listed DISABLED with the dock's own
 * refusal sentence in its name, in the tab order; the same row is enabled
 * once the context binds a project. Reverting the `enabled` derivation to
 * `true` reds the `aria-disabled` assertion; hiding the row instead reds
 * the name lookup. Chat, Activity, Agents and Device need no project.
 */
test('a coding row is disabled with the reason without a project, and enabled with one', () => {
  const { unmount } = render(
    <RegionEmptyChooser
      regionId="right"
      context={NO_PROJECT}
      variant="inline"
    />,
  );
  const terminal = screen.getByRole('button', {
    name: 'Terminal Choose a project for this dock before opening that pane.',
  });
  expect(terminal.getAttribute('aria-disabled')).toBe('true');
  expect(terminal.hasAttribute('disabled')).toBe(false);
  fireEvent.click(terminal);
  expect(harness.openSurfaceInRegion).not.toHaveBeenCalled();
  for (const name of ['Diff', 'Files']) {
    expect(
      screen
        .getByRole('button', { name: new RegExp(`^${name} Choose a project`) })
        .getAttribute('aria-disabled'),
    ).toBe('true');
  }
  for (const name of ['Activity', 'Agents', 'Device']) {
    expect(
      screen.getByRole('button', { name }).getAttribute('aria-disabled'),
    ).toBeNull();
  }
  unmount();

  render(
    <RegionEmptyChooser regionId="right" context={ALPHA} variant="inline" />,
  );
  const enabled = screen.getByRole('button', { name: 'Terminal' });
  expect(enabled.getAttribute('aria-disabled')).toBeNull();
  fireEvent.click(enabled);
  expect(harness.openSurfaceInRegion).toHaveBeenCalledWith('coding:terminal', {
    region: 'right',
  });
});

/**
 * A4: a surface placed ELSEWHERE is listed, not hidden, and its row says
 * where it comes from — choosing it is a move (the model's own rule; the
 * region it empties hides, `placeSurface` + #2153, pinned through the
 * shipped path in `RegionPaneHost.regions.test.tsx`). A surface THIS region
 * already holds reads "Already here". Hiding placed surfaces reds the
 * first lookup; deriving the origin from `defaultRegion` instead of the
 * arrangement reds it too (Chat's default IS Bottom, so the discriminator
 * is the second half: Chat moved to Left reads "from Left").
 */
test('a surface held elsewhere reads "Move here from <Region>", and one held here reads "Already here"', () => {
  const { unmount } = render(
    <RegionEmptyChooser
      regionId="right"
      context={NO_PROJECT}
      variant="inline"
    />,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Chat Move here from Bottom' }),
  );
  expect(harness.openSurfaceInRegion).toHaveBeenCalledWith('chat', {
    region: 'right',
  });
  unmount();

  const regions = freshArrangement();
  regions.bottom = { ...regions.bottom, panes: [], occupant: null };
  regions.left = {
    ...regions.left,
    visible: true,
    panes: ['chat', 'activity'],
    occupant: 'chat',
  };
  harness.regions = regions;
  // Chat's default region IS Bottom, so the first half cannot tell the
  // arrangement from the registry; Chat held in Left can.
  const fromLeft = render(
    <RegionEmptyChooser
      regionId="right"
      context={NO_PROJECT}
      variant="inline"
    />,
  );
  expect(
    screen.getByRole('button', { name: 'Chat Move here from Left' }),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Activity Move here from Left' }),
  ).toBeTruthy();
  fromLeft.unmount();
  render(
    <RegionEmptyChooser
      regionId="left"
      context={NO_PROJECT}
      variant="panel"
      anchor={{ right: 300, top: 10, bottom: 40 }}
      onClose={() => {}}
    />,
  );
  const menu = screen.getByRole('menu', { name: 'Add to Left region' });
  expect(
    within(menu).getByRole('menuitem', { name: 'Chat Already here' }),
  ).toBeTruthy();
  expect(
    within(menu).getByRole('menuitem', { name: 'Activity Already here' }),
  ).toBeTruthy();
  expect(
    within(menu)
      .getAllByRole('menuitem')
      .map((row) => row.getAttribute('aria-disabled')),
  ).toEqual([null, null, null, null, 'true', 'true', 'true']);
});

/**
 * A refusal is one sentence under the rows and the chooser stays; the
 * next successful choice clears it. Reverting the refusal branch to close
 * reds the alert lookup.
 */
test('a refused choice shows the refusal sentence and keeps the rows', () => {
  harness.openSurfaceInRegion.mockImplementation(() => ({
    ok: false,
    reason: 'region-unavailable',
  }));
  render(
    <RegionEmptyChooser
      regionId="right"
      context={NO_PROJECT}
      variant="inline"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
  expect(screen.getByRole('alert').textContent).toBe(
    'That region is not available on this device.',
  );
  expect(rowNames(screen.getByRole('list'))).toHaveLength(7);
});

/**
 * A5: the "+" panel is a `menu` of `menuitem` rows; a choice closes it, and
 * so do Escape and the backdrop's release — never the backdrop's press
 * alone (#1386). Reverting the panel's role to `group` reds the first
 * lookup; dropping the Escape listener reds the second `onClose` count.
 */
test('the panel variant is a menu that closes on a choice, on Escape and on its backdrop', () => {
  const onClose = vi.fn();
  const anchor = { right: 400, top: 20, bottom: 50 };
  const { unmount } = render(
    <RegionEmptyChooser
      regionId="right"
      context={NO_PROJECT}
      variant="panel"
      anchor={anchor}
      onClose={onClose}
    />,
  );
  const menu = screen.getByRole('menu', { name: 'Add to Right region' });
  expect(within(menu).getAllByRole('menuitem')).toHaveLength(7);
  expect(screen.queryByRole('list')).toBeNull();
  // Focus enters the menu's first row (`useMenuFocus`).
  expect(document.activeElement).toBe(
    within(menu).getByRole('menuitem', { name: 'Chat Move here from Bottom' }),
  );
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Activity' }));
  expect(harness.openSurfaceInRegion).toHaveBeenCalledWith('activity', {
    region: 'right',
  });
  expect(onClose).toHaveBeenCalledTimes(1);

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(2);

  const backdrop = screen.getByRole('button', {
    name: 'Close the Add to Right region menu',
  });
  fireEvent.pointerDown(backdrop);
  expect(onClose).toHaveBeenCalledTimes(2);
  fireEvent.pointerUp(backdrop);
  expect(onClose).toHaveBeenCalledTimes(3);
  fireEvent.pointerCancel(backdrop);
  expect(onClose).toHaveBeenCalledTimes(4);
  unmount();

  // A refused choice keeps the panel open with its sentence.
  harness.openSurfaceInRegion.mockImplementation(() => ({
    ok: false,
    reason: 'refused',
  }));
  const stays = vi.fn();
  render(
    <RegionEmptyChooser
      regionId="right"
      context={NO_PROJECT}
      variant="panel"
      anchor={anchor}
      onClose={stays}
    />,
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Activity' }));
  expect(stays).not.toHaveBeenCalled();
  expect(within(screen.getByRole('menu')).getByRole('alert').textContent).toBe(
    'That pane cannot be placed in that region.',
  );
});

/**
 * The panel flips ABOVE its anchor when there is no room below (#2112's
 * rule: never slide up over the trigger). jsdom measures every rect 0×0,
 * so the flip is proved by stubbing the menu's box (300 tall) and the
 * viewport (200 tall) with the anchor near the bottom: the panel's `top` is
 * then the anchor's top minus the gap minus the menu's height, clamped at 0,
 * not the anchor's bottom plus the gap. Replacing the flip with `top =
 * below` reds the assertion (it would read 174).
 */
test('the panel flips above the "+" when the menu does not fit below it', () => {
  const innerHeight = window.innerHeight;
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: 400,
  });
  const rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function () {
    const box = rect.call(this);
    return this.getAttribute('role') === 'menu'
      ? { ...box, width: 224, height: 300, toJSON: () => ({}) }
      : box;
  };
  try {
    render(
      <RegionEmptyChooser
        regionId="right"
        context={NO_PROJECT}
        variant="panel"
        anchor={{ right: 400, top: 350, bottom: 370 }}
        onClose={() => {}}
      />,
    );
    const menu = screen.getByRole('menu', { name: 'Add to Right region' });
    // Below would be 374 + 300 > 400; above is 350 - 4 - 300 = 46. A value
    // that fits above is what discriminates the arithmetic from a clamp
    // to 0 (an earlier fixture landed on the clamp, which a constant
    // satisfies).
    expect(menu.style.top).toBe('46px');
  } finally {
    HTMLElement.prototype.getBoundingClientRect = rect;
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: innerHeight,
    });
  }
});
