/**
 * Geometry of the float-over-chat mini-player (#90 D9). Everything here is a
 * pure function of three measurements the shell hands in: the chat column's
 * size, the composer docked at its bottom, and the aspect ratio of whatever
 * is floating (a Browser viewport or a device screen). The shell measures;
 * this module decides where the player goes and how big it is.
 *
 * Rules the functions below share:
 * - The player keeps FLOAT_EDGE_GAP pixels from every edge of the column.
 * - Its height is always derived from its width and the source's aspect
 *   ratio, so the live picture fills the player with no letterboxing.
 * - It never sits on the composer. The composer only claims the columns it
 *   spans; a player beside a narrow composer may use the full height.
 * - Stored state (width, position) is never rewritten by clamping: a chat
 *   that is briefly too narrow must not destroy the size the user picked.
 */

export const FLOAT_EDGE_GAP = 12;
export const FLOAT_MIN_SIZE = { width: 240, height: 150 } as const;
/** Pixels moved or grown by one arrow-key press. */
export const FLOAT_KEYBOARD_STEP = 16;
/** A player that has never been sized fits inside a square of this side. */
const INITIAL_BOUND = 320;

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

/**
 * The composer, in chat-column coordinates: the columns it covers
 * (`left`..`right`) and how tall it stands above the column's bottom edge.
 */
export interface FloatObstacles {
  readonly composer: {
    readonly left: number;
    readonly right: number;
    readonly height: number;
  } | null;
}

const NOTHING_IN_THE_WAY: FloatObstacles = { composer: null };

/**
 * The y coordinate a player occupying columns `x`..`x + width` must stay
 * above (before the edge gap): the composer's top when those columns reach
 * over it, otherwise the bottom of the chat.
 */
function usableBottom(
  x: number,
  width: number,
  chat: FloatSize,
  obstacles: FloatObstacles,
): number {
  const composer = obstacles.composer;
  if (!composer) return chat.height;
  const coversComposer = x < composer.right && x + width > composer.left;
  return coversComposer
    ? chat.height - Math.max(0, composer.height)
    : chat.height;
}

/** True when a player at `at` reaches below the bottom its columns allow. */
function sitsOnComposer(
  at: FloatPosition,
  size: FloatSize,
  chat: FloatSize,
  obstacles: FloatObstacles,
): boolean {
  return at.y + size.height > usableBottom(at.x, size.width, chat, obstacles);
}

/** Pins one coordinate between the leading gap and the trailing gap. */
function withinGaps(value: number, extent: number, span: number): number {
  const last = Math.max(FLOAT_EDGE_GAP, span - extent - FLOAT_EDGE_GAP);
  return Math.min(Math.max(value, FLOAT_EDGE_GAP), last);
}

function insideChat(
  at: FloatPosition,
  chat: FloatSize,
  size: FloatSize,
): FloatPosition {
  return {
    x: withinGaps(at.x, size.width, chat.width),
    y: withinGaps(at.y, size.height, chat.height),
  };
}

/**
 * Sizes a player from the width it wants. The result is at least the
 * minimum (whichever of the minimum width or minimum height binds at this
 * aspect ratio), at most the source's own width — anything larger is just
 * upscaling — and at most the `limit` box. When the limit is smaller than
 * the minimum, the limit wins.
 */
export function fitFloatWidth(
  desiredWidth: number,
  source: FloatSize,
  limit: FloatSize,
): FloatSize {
  const ratio = source.width / source.height;
  const smallest = Math.max(
    FLOAT_MIN_SIZE.width,
    FLOAT_MIN_SIZE.height * ratio,
  );
  const largest = Math.min(
    source.width,
    Math.max(1, limit.width),
    Math.max(1, limit.height * ratio),
  );
  const width = Math.min(Math.max(desiredWidth, smallest), largest);
  return { width: Math.round(width), height: Math.round(width / ratio) };
}

/**
 * Keeps a player inside the chat and off the composer. When the clamped spot
 * still overlaps the composer, three escapes are considered: straight up
 * above the composer, or sideways past its left or right end. A sideways
 * escape only counts if it fits in the chat without clamping and clears the
 * composer; the shortest move wins, and on a tie going up is preferred, then
 * left. Sliding sideways is what lets a drag along the bottom glide into the
 * margin beside a narrow composer instead of catching on its top edge.
 */
export function clampFloatPosition(
  position: FloatPosition,
  container: FloatSize,
  player: FloatSize,
  obstacles: FloatObstacles = NOTHING_IN_THE_WAY,
): FloatPosition {
  const clamped = insideChat(position, container, player);
  const composer = obstacles.composer;
  if (!composer || !sitsOnComposer(clamped, player, container, obstacles)) {
    return clamped;
  }

  const up = insideChat(
    {
      x: clamped.x,
      y: container.height - composer.height - FLOAT_EDGE_GAP - player.height,
    },
    container,
    player,
  );
  let choice = up;
  let travel = Math.abs(up.y - clamped.y);

  const sidewaysXs = [
    composer.left - FLOAT_EDGE_GAP - player.width,
    composer.right + FLOAT_EDGE_GAP,
  ];
  for (const x of sidewaysXs) {
    const spot = { x, y: clamped.y };
    const fitsUnclamped = withinGaps(x, player.width, container.width) === x;
    if (!fitsUnclamped) continue;
    if (sitsOnComposer(spot, player, container, obstacles)) continue;
    const distance = Math.abs(x - clamped.x);
    if (distance < travel) {
      choice = spot;
      travel = distance;
    }
  }
  return choice;
}

/**
 * Turns the stored width and position into the frame to draw, clamping on
 * every call rather than writing the result back. A player with no stored
 * width opens at the largest size that fits INITIAL_BOUND at the source's
 * aspect ratio; with no stored position it opens in the top-right corner.
 *
 * The height available for sizing depends on whether the player has a
 * place: a placed player (stored position and width) is allowed the rows its
 * own columns have, so a tall player parked beside the composer keeps its
 * size; an unplaced one only gets the rows above the composer, which every
 * column has.
 */
export function resolveFloatFrame(input: {
  readonly width: number | null;
  readonly position: FloatPosition | null;
  readonly source: FloatSize;
  readonly container: FloatSize;
  readonly obstacles?: FloatObstacles;
}): FloatFrame {
  const { source, container } = input;
  const obstacles = input.obstacles ?? NOTHING_IN_THE_WAY;
  const wanted =
    input.width ??
    Math.min(INITIAL_BOUND, (INITIAL_BOUND * source.width) / source.height);

  const bottomEdge =
    input.position && input.width
      ? usableBottom(input.position.x, input.width, container, obstacles)
      : container.height - Math.max(0, obstacles.composer?.height ?? 0);
  const size = fitFloatWidth(wanted, source, {
    width: container.width - 2 * FLOAT_EDGE_GAP,
    height: bottomEdge - 2 * FLOAT_EDGE_GAP,
  });

  const place = input.position ?? {
    x: container.width - FLOAT_EDGE_GAP - size.width,
    y: FLOAT_EDGE_GAP,
  };
  const at = clampFloatPosition(place, container, size, obstacles);
  return { x: at.x, y: at.y, width: size.width, height: size.height };
}

/**
 * Which edges each handle moves: -1 drags the left/top edge, +1 the
 * right/bottom edge, 0 leaves that axis alone.
 */
const HANDLE_AXES: Record<
  FloatResizeDirection,
  { readonly h: -1 | 0 | 1; readonly v: -1 | 0 | 1 }
> = {
  north: { h: 0, v: -1 },
  south: { h: 0, v: 1 },
  east: { h: 1, v: 0 },
  west: { h: -1, v: 0 },
  northeast: { h: 1, v: -1 },
  northwest: { h: -1, v: -1 },
  southeast: { h: 1, v: 1 },
  southwest: { h: -1, v: 1 },
};

/** How far a handle pulls its edge outward along one axis. */
function outwardPull(axis: -1 | 0 | 1, pointerDelta: number): number {
  if (axis === 0) return 0;
  return axis > 0 ? pointerDelta : -pointerDelta;
}

/**
 * Resizes from an edge or corner handle, aspect-locked. The edge opposite
 * the handle stays where it was, so the grabbed edge follows the pointer and
 * growth stops where that edge meets the chat (or, downward, the composer
 * under the player's columns). A side handle only constrains its own axis;
 * the other axis may use the whole chat, with the player shifted back
 * inside if needed. On a corner, whichever axis the pointer moved further
 * (relative to the current size) drives the new size.
 */
export function resizeFloatFrame(input: {
  readonly start: FloatFrame;
  readonly direction: FloatResizeDirection;
  readonly delta: FloatPosition;
  readonly source: FloatSize;
  readonly container: FloatSize;
  readonly obstacles?: FloatObstacles;
}): FloatFrame {
  const { start, delta, source, container } = input;
  const obstacles = input.obstacles ?? NOTHING_IN_THE_WAY;
  const { h, v } = HANDLE_AXES[input.direction];
  const gap = FLOAT_EDGE_GAP;
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  const floor = usableBottom(start.x, start.width, container, obstacles);

  let widthLimit = container.width - 2 * gap;
  if (h < 0) widthLimit = right - gap;
  else if (h > 0) widthLimit = container.width - gap - start.x;
  let heightLimit = floor - 2 * gap;
  if (v < 0) heightLimit = bottom - gap;
  else if (v > 0) heightLimit = floor - gap - start.y;

  const wantedWidth = start.width + outwardPull(h, delta.x);
  const wantedHeight = start.height + outwardPull(v, delta.y);
  let followWidth: boolean;
  if (v === 0) followWidth = true;
  else if (h === 0) followWidth = false;
  else {
    const widthChange = Math.abs(wantedWidth - start.width) / start.width;
    const heightChange = Math.abs(wantedHeight - start.height) / start.height;
    followWidth = widthChange >= heightChange;
  }

  const size = fitFloatWidth(
    followWidth ? wantedWidth : (wantedHeight * source.width) / source.height,
    source,
    { width: widthLimit, height: heightLimit },
  );
  const anchored = {
    x: h < 0 ? right - size.width : start.x,
    y: v < 0 ? bottom - size.height : start.y,
  };
  const at = clampFloatPosition(anchored, container, size, obstacles);
  return { x: at.x, y: at.y, width: size.width, height: size.height };
}

export type FloatArrowKey =
  | 'ArrowUp'
  | 'ArrowDown'
  | 'ArrowLeft'
  | 'ArrowRight';

const ARROW_KEYS: ReadonlySet<string> = new Set<FloatArrowKey>([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

export function isFloatArrowKey(key: string): key is FloatArrowKey {
  return ARROW_KEYS.has(key);
}

/**
 * Keyboard control, so the player is usable without a pointer. A plain
 * arrow moves one step through the same clamp a drag uses (so it can never
 * land on the composer). With `resize`, Right and Down grow the player by
 * one step and Left and Up shrink it, keeping the top-left corner fixed and
 * the same aspect and size limits as a pointer resize.
 */
export function nudgeFloatFrame(input: {
  readonly frame: FloatFrame;
  readonly key: FloatArrowKey;
  readonly resize: boolean;
  readonly source: FloatSize;
  readonly container: FloatSize;
  readonly obstacles?: FloatObstacles;
}): FloatFrame {
  const { frame, key, source, container, obstacles } = input;
  const step = FLOAT_KEYBOARD_STEP;
  if (input.resize) {
    const grows = key === 'ArrowRight' || key === 'ArrowDown';
    return resizeFloatFrame({
      start: frame,
      direction: 'east',
      delta: { x: grows ? step : -step, y: 0 },
      source,
      container,
      obstacles,
    });
  }
  let { x, y } = frame;
  if (key === 'ArrowLeft') x -= step;
  else if (key === 'ArrowRight') x += step;
  else if (key === 'ArrowUp') y -= step;
  else y += step;
  const at = clampFloatPosition({ x, y }, container, frame, obstacles);
  return { x: at.x, y: at.y, width: frame.width, height: frame.height };
}
