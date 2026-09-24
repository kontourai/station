/**
 * Geometry of the float-over-chat mini-player (#90 D9): pure functions over
 * the chat column's size, the composer it must stay off, and the source's
 * aspect ratio. No DOM here; the shell measures and these decide.
 *
 * Adapted from t3code's `apps/web/src/components/preview/previewMiniPlayerLayout.ts`
 * (https://github.com/pingdotgg/t3code, aca3c87c). MIT License,
 * Copyright (c) 2026 T3 Tools Inc. Permission is hereby granted, free of
 * charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without
 * restriction, subject to the condition that the above copyright notice and
 * this permission notice be included in all copies or substantial portions
 * of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
 * KIND.
 *
 * What changed in the adaptation: the source size is a plain width/height
 * (Station's server-owned viewport, or a device screen later) rather than
 * t3code's webview presentation; the device-specific sizing and corner
 * radius are left to the Device source (#90 device batch); and a keyboard
 * nudge (`nudgeFloatFrame`) is added, because t3code's player is pointer-only.
 */

export const FLOAT_EDGE_GAP = 12;
/** A fresh player is the largest box at the source aspect ratio that fits here. */
const FLOAT_DEFAULT_BOX = { width: 320, height: 320 } as const;
export const FLOAT_MIN_SIZE = { width: 240, height: 150 } as const;
/** One arrow-key step, in CSS pixels, for moving or resizing. */
export const FLOAT_KEYBOARD_STEP = 16;

export interface FloatPosition {
  readonly x: number;
  readonly y: number;
}

export interface FloatSize {
  readonly width: number;
  readonly height: number;
}

export interface FloatFrame extends FloatPosition, FloatSize {}

export type FloatResizeDirection =
  | 'north'
  | 'south'
  | 'east'
  | 'west'
  | 'northeast'
  | 'northwest'
  | 'southeast'
  | 'southwest';

interface HorizontalSpan {
  readonly left: number;
  readonly right: number;
}

/**
 * The composer docked to the bottom of the chat column, in the column's
 * coordinates: the columns it covers and how far up from the bottom edge it
 * reaches. Only those columns are reserved, so the margins beside a
 * narrower composer stay open all the way down.
 */
export interface FloatObstacles {
  readonly composer: (HorizontalSpan & { readonly height: number }) | null;
}

const NO_FLOAT_OBSTACLES: FloatObstacles = { composer: null };

const spanOf = (x: number, width: number): HorizontalSpan => ({
  left: x,
  right: x + width,
});

const spansOverlap = (a: HorizontalSpan, b: HorizontalSpan) =>
  a.left < b.right && a.right > b.left;

/** The lowest row (before the edge gap) open to a player covering these columns. */
function floorFor(
  span: HorizontalSpan,
  container: FloatSize,
  obstacles: FloatObstacles,
): number {
  const { composer } = obstacles;
  return composer && spansOverlap(span, composer)
    ? container.height - Math.max(0, composer.height)
    : container.height;
}

/**
 * The box a stored size is fitted into. A player with a position keeps the
 * rows its own columns have, so a tall frame parked beside the composer
 * survives the next layout pass; without one it takes the rows above the
 * composer, which every column has.
 */
const availableArea = (
  container: FloatSize,
  obstacles: FloatObstacles,
  span: HorizontalSpan | null,
): FloatSize => ({
  width: container.width - FLOAT_EDGE_GAP * 2,
  height:
    (span
      ? floorFor(span, container, obstacles)
      : container.height - Math.max(0, obstacles.composer?.height ?? 0)) -
    FLOAT_EDGE_GAP * 2,
});

/**
 * Width is the player's only free dimension; height always follows the
 * source aspect ratio, so the live view fills the box without letterboxing.
 * The player never grows past the source's own size (going bigger would
 * only upscale), and a tight container wins over the minimum.
 */
export function fitFloatWidth(
  desiredWidth: number,
  source: FloatSize,
  max: FloatSize,
): FloatSize {
  const aspectRatio = source.width / source.height;
  const width = Math.min(
    Math.max(
      desiredWidth,
      FLOAT_MIN_SIZE.width,
      FLOAT_MIN_SIZE.height * aspectRatio,
    ),
    source.width,
    Math.max(1, max.width),
    Math.max(1, max.height * aspectRatio),
  );
  return { width: Math.round(width), height: Math.round(width / aspectRatio) };
}

function defaultFloatWidth(source: FloatSize): number {
  return Math.min(
    FLOAT_DEFAULT_BOX.width,
    (FLOAT_DEFAULT_BOX.height * source.width) / source.height,
  );
}

const clampToContainer = (
  position: FloatPosition,
  container: FloatSize,
  player: FloatSize,
): FloatPosition => ({
  x: Math.min(
    Math.max(position.x, FLOAT_EDGE_GAP),
    Math.max(FLOAT_EDGE_GAP, container.width - player.width - FLOAT_EDGE_GAP),
  ),
  y: Math.min(
    Math.max(position.y, FLOAT_EDGE_GAP),
    Math.max(FLOAT_EDGE_GAP, container.height - player.height - FLOAT_EDGE_GAP),
  ),
});

const overlapsObstacle = (
  position: FloatPosition,
  player: FloatSize,
  container: FloatSize,
  obstacles: FloatObstacles,
): boolean =>
  position.y + player.height >
  floorFor(spanOf(position.x, player.width), container, obstacles);

/**
 * Keeps the player inside the container and off the composer. An
 * overlapping player is pushed out along whichever side needs the smaller
 * move, so a drag slides along the composer into the margin beside it
 * instead of stopping at its top edge; when no side leaves it fully clear it
 * sits above the composer.
 */
export function clampFloatPosition(
  position: FloatPosition,
  container: FloatSize,
  player: FloatSize,
  obstacles: FloatObstacles = NO_FLOAT_OBSTACLES,
): FloatPosition {
  const inside = clampToContainer(position, container, player);
  const { composer } = obstacles;
  if (!composer || !overlapsObstacle(inside, player, container, obstacles))
    return inside;
  const gap = FLOAT_EDGE_GAP;
  const above = {
    x: inside.x,
    y: container.height - composer.height - gap - player.height,
  };
  const beside = [
    { x: composer.left - gap - player.width, y: inside.y },
    { x: composer.right + gap, y: inside.y },
  ];
  let best = clampToContainer(above, container, player);
  let bestDistance = Math.abs(best.y - inside.y);
  for (const candidate of beside) {
    const clamped = clampToContainer(candidate, container, player);
    if (
      clamped.x !== candidate.x ||
      overlapsObstacle(candidate, player, container, obstacles)
    )
      continue;
    const distance = Math.abs(candidate.x - inside.x);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The on-screen frame from the stored width and position. Clamping happens
 * here on every layout pass instead of being written back, so a
 * temporarily narrow chat never destroys the user's chosen width. A player
 * without a position opens in the top-right corner.
 */
export function resolveFloatFrame(input: {
  readonly width: number | null;
  readonly position: FloatPosition | null;
  readonly source: FloatSize;
  readonly container: FloatSize;
  readonly obstacles?: FloatObstacles;
}): FloatFrame {
  const {
    width,
    position,
    source,
    container,
    obstacles = NO_FLOAT_OBSTACLES,
  } = input;
  const size = fitFloatWidth(
    width ?? defaultFloatWidth(source),
    source,
    availableArea(
      container,
      obstacles,
      position && width ? spanOf(position.x, width) : null,
    ),
  );
  const anchored = position ?? {
    x: container.width - FLOAT_EDGE_GAP - size.width,
    y: FLOAT_EDGE_GAP,
  };
  return {
    ...clampFloatPosition(anchored, container, size, obstacles),
    ...size,
  };
}

/**
 * Resizes from any edge or corner while holding the aspect ratio. The edge
 * opposite the dragged one stays anchored, so growth stops at the container
 * on that axis and the pointer keeps tracking the grabbed edge. On a plain
 * edge drag the perpendicular axis may use the whole container, and the
 * player shifts as needed to stay inside.
 */
export function resizeFloatFrame(input: {
  readonly start: FloatFrame;
  readonly direction: FloatResizeDirection;
  readonly delta: FloatPosition;
  readonly source: FloatSize;
  readonly container: FloatSize;
  readonly obstacles?: FloatObstacles;
}): FloatFrame {
  const {
    start,
    direction,
    delta,
    source,
    container,
    obstacles = NO_FLOAT_OBSTACLES,
  } = input;
  const east = direction.includes('east');
  const west = direction.includes('west');
  const north = direction.includes('north');
  const south = direction.includes('south');
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  // Growth stops where the player's current columns meet the composer, and
  // a plain edge drag lets the free axis use everything those columns have.
  const floor = floorFor(spanOf(start.x, start.width), container, obstacles);
  const max = {
    width: west
      ? right - FLOAT_EDGE_GAP
      : east
        ? container.width - FLOAT_EDGE_GAP - start.x
        : container.width - FLOAT_EDGE_GAP * 2,
    height: north
      ? bottom - FLOAT_EDGE_GAP
      : south
        ? floor - FLOAT_EDGE_GAP - start.y
        : floor - FLOAT_EDGE_GAP * 2,
  };
  const desiredWidth = start.width + (east ? delta.x : west ? -delta.x : 0);
  const desiredHeight = start.height + (south ? delta.y : north ? -delta.y : 0);
  const horizontal = east || west;
  const vertical = north || south;
  const widthLeads =
    horizontal && !vertical
      ? true
      : vertical && !horizontal
        ? false
        : Math.abs(desiredWidth - start.width) / start.width >=
          Math.abs(desiredHeight - start.height) / start.height;
  const size = fitFloatWidth(
    widthLeads ? desiredWidth : (desiredHeight * source.width) / source.height,
    source,
    max,
  );
  const position = clampFloatPosition(
    {
      x: west ? right - size.width : start.x,
      y: north ? bottom - size.height : start.y,
    },
    container,
    size,
    obstacles,
  );
  return { ...position, ...size };
}

export type FloatArrowKey =
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight';

export function isFloatArrowKey(key: string): key is FloatArrowKey {
  return (
    key === 'ArrowUp' ||
    key === 'ArrowDown' ||
    key === 'ArrowLeft' ||
    key === 'ArrowRight'
  );
}

/**
 * The keyboard's move and resize (Station addition). An arrow moves the
 * player one step, through the same clamp a drag uses, so the keyboard can
 * never park it on the composer. With `resize`, Right/Down grow and
 * Left/Up shrink it from the bottom-right corner (top-left anchored), still
 * aspect-locked and still bounded by the minimum and the container.
 */
export function nudgeFloatFrame(input: {
  readonly frame: FloatFrame;
  readonly key: FloatArrowKey;
  readonly resize: boolean;
  readonly source: FloatSize;
  readonly container: FloatSize;
  readonly obstacles?: FloatObstacles;
}): FloatFrame {
  const { frame, key, resize, source, container, obstacles } = input;
  const step = FLOAT_KEYBOARD_STEP;
  if (resize) {
    const grow = key === 'ArrowRight' || key === 'ArrowDown' ? step : -step;
    return resizeFloatFrame({
      start: frame,
      direction: 'east',
      delta: { x: grow, y: 0 },
      source,
      container,
      obstacles,
    });
  }
  const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
  const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
  return {
    ...clampFloatPosition(
      { x: frame.x + dx, y: frame.y + dy },
      container,
      frame,
      obstacles,
    ),
    width: frame.width,
    height: frame.height,
  };
}
