/**
 * Where a foldable display's crease is, as one shape every layout reads.
 *
 * Two sources produce it: the iOS shell's `station-fold` plugin (iOS 27.1
 * reserved division regions plus `UIHingeInteraction`; see
 * `src-desktop/plugins/station-fold`), and the CSS Viewport Segments API
 * (`window.viewport.segments`) where an engine has one. Safari has no
 * segments API, so on an iPhone the native shell is the only source; in a
 * plain browser there the geometry is simply absent and layouts are unchanged.
 *
 * Pure functions only: the store (`foldStore.ts`) owns publication, the
 * sources (`foldSources.ts`) own subscription.
 */

/**
 * `folded`: the hinge is partially open, so the crease is a physical valley
 * text should not run across (Book). `flat`: the display is open as far as it
 * goes; the crease is known but content may cross it.
 */
export type FoldPosture = 'folded' | 'flat';

/**
 * The direction of the crease LINE. A `vertical` crease divides the display
 * into side-by-side segments (Book); a `horizontal` one into top and bottom
 * segments (Laptop).
 */
export type FoldAxis = 'vertical' | 'horizontal';

export interface FoldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FoldGeometry {
  source: 'native' | 'viewport-segments';
  posture: FoldPosture;
  axis: FoldAxis;
  /** The crease, in CSS pixels of the layout viewport. Width or height may be 0. */
  hinge: FoldRect;
}

/** What the iOS plugin's `state` command returns (`StationFoldPlugin.swift`). */
export interface NativeFoldSnapshot {
  revision: number;
  supported: boolean;
  hinge: { status: string; angle: number } | null;
  regions: FoldRect[];
  viewport: { width: number; height: number };
}

const HINGE_STATUSES = new Set([
  'unknown',
  'closed',
  'partially-open',
  'fully-open',
]);

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseRect(value: unknown): FoldRect | null {
  if (value === null || typeof value !== 'object') return null;
  const rect = value as Record<string, unknown>;
  if (
    !finiteNumber(rect.x) ||
    !finiteNumber(rect.y) ||
    !finiteNonNegative(rect.width) ||
    !finiteNonNegative(rect.height)
  )
    return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * Validates a plugin reply. Anything malformed is refused as a whole rather
 * than partly trusted: a wrong crease is worse than none.
 */
export function parseNativeFoldSnapshot(
  value: unknown,
): NativeFoldSnapshot | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(raw.revision) ||
    (raw.revision as number) < 1 ||
    typeof raw.supported !== 'boolean' ||
    !Array.isArray(raw.regions) ||
    raw.regions.length > 4
  )
    return null;
  let hinge: NativeFoldSnapshot['hinge'] = null;
  if (raw.hinge !== null && raw.hinge !== undefined) {
    const candidate = raw.hinge as Record<string, unknown>;
    if (
      typeof candidate !== 'object' ||
      typeof candidate.status !== 'string' ||
      !HINGE_STATUSES.has(candidate.status) ||
      !finiteNumber(candidate.angle)
    )
      return null;
    hinge = { status: candidate.status, angle: candidate.angle };
  }
  const regions: FoldRect[] = [];
  for (const entry of raw.regions) {
    const rect = parseRect(entry);
    if (!rect) return null;
    regions.push(rect);
  }
  const viewport = raw.viewport as Record<string, unknown> | null | undefined;
  if (
    !viewport ||
    typeof viewport !== 'object' ||
    !finiteNonNegative(viewport.width) ||
    !finiteNonNegative(viewport.height)
  )
    return null;
  return {
    revision: raw.revision as number,
    supported: raw.supported,
    hinge,
    regions,
    viewport: { width: viewport.width, height: viewport.height },
  };
}

/**
 * The axis of a crease that runs edge to edge across a viewport, or null when
 * the rect does not divide it (a camera cut-out, a stale region).
 */
function creaseAxis(
  rect: FoldRect,
  viewportWidth: number,
  viewportHeight: number,
): FoldAxis | null {
  const spansHeight = rect.y <= 1 && rect.y + rect.height >= viewportHeight - 1;
  const spansWidth = rect.x <= 1 && rect.x + rect.width >= viewportWidth - 1;
  const insideX = rect.x > 0 && rect.x + rect.width < viewportWidth;
  const insideY = rect.y > 0 && rect.y + rect.height < viewportHeight;
  if (spansHeight && insideX && !spansWidth) return 'vertical';
  if (spansWidth && insideY && !spansHeight) return 'horizontal';
  return null;
}

/**
 * The geometry a native snapshot describes, in this page's CSS pixels.
 *
 * Exactly one division region must cross the viewport edge to edge; zero or
 * several is "no usable crease". The hinge status decides the posture:
 * partially open is folded. A division the system reports with no hinge
 * reading is also treated as folded, because the system only divides a
 * display it considers creased.
 */
export function geometryFromNativeSnapshot(
  snapshot: NativeFoldSnapshot,
  innerWidth: number,
  innerHeight: number,
): FoldGeometry | null {
  if (!snapshot.supported || snapshot.regions.length !== 1) return null;
  if (snapshot.hinge?.status === 'closed') return null;
  const { width: nativeWidth, height: nativeHeight } = snapshot.viewport;
  if (nativeWidth <= 0 || nativeHeight <= 0 || innerWidth <= 0) return null;
  // The WebView's points are CSS pixels at the default zoom; scale if a page
  // zoom made them differ.
  const scale = innerWidth / nativeWidth;
  const region = snapshot.regions[0];
  const hinge: FoldRect = {
    x: region.x * scale,
    y: region.y * scale,
    width: region.width * scale,
    height: region.height * scale,
  };
  const axis = creaseAxis(
    hinge,
    innerWidth,
    innerHeight || nativeHeight * scale,
  );
  if (!axis) return null;
  const posture: FoldPosture =
    snapshot.hinge === null || snapshot.hinge.status === 'partially-open'
      ? 'folded'
      : 'flat';
  return { source: 'native', posture, axis, hinge };
}

/**
 * The geometry two CSS viewport segments describe. The crease is the gap
 * between them (often 0px wide on a seamless fold).
 */
export function geometryFromViewportSegments(
  segments: readonly FoldRect[] | null | undefined,
  postureType: string | null | undefined,
): FoldGeometry | null {
  if (segments?.length !== 2) return null;
  const [first, second] = segments.map((segment) => parseRect(segment));
  if (!first || !second) return null;
  const posture: FoldPosture = postureType === 'continuous' ? 'flat' : 'folded';
  if (second.x >= first.x + first.width - 1) {
    const x = first.x + first.width;
    return {
      source: 'viewport-segments',
      posture,
      axis: 'vertical',
      hinge: {
        x,
        y: Math.min(first.y, second.y),
        width: Math.max(0, second.x - x),
        height: Math.max(first.height, second.height),
      },
    };
  }
  if (second.y >= first.y + first.height - 1) {
    const y = first.y + first.height;
    return {
      source: 'viewport-segments',
      posture,
      axis: 'horizontal',
      hinge: {
        x: Math.min(first.x, second.x),
        y,
        width: Math.max(first.width, second.width),
        height: Math.max(0, second.y - y),
      },
    };
  }
  return null;
}

/**
 * Where the crease divides one element, measured from that element's own
 * edges, or null when it does not cross the element (or the display is
 * flat).
 *
 * `start` is the room before the crease (left of a vertical one, above a
 * horizontal one), `gap` the crease itself, `end` the room after it. A
 * layout that splits places its first pane in `start` and its second after
 * `start + gap`; a single column moves into the `larger` side.
 */
export interface FoldSplit {
  axis: FoldAxis;
  start: number;
  gap: number;
  end: number;
  larger: 'start' | 'end';
}

/** A crease closer than this to an element's edge leaves no usable side. */
export const FOLD_SPLIT_MIN_SIDE = 48;

export function foldSplitWithin(
  rect: { left: number; top: number; width: number; height: number },
  geometry: FoldGeometry | null,
): FoldSplit | null {
  if (geometry?.posture !== 'folded') return null;
  const vertical = geometry.axis === 'vertical';
  const origin = vertical ? rect.left : rect.top;
  const extent = vertical ? rect.width : rect.height;
  const creaseStart = vertical ? geometry.hinge.x : geometry.hinge.y;
  const gap = vertical ? geometry.hinge.width : geometry.hinge.height;
  const start = Math.round(creaseStart - origin);
  const end = Math.round(origin + extent - (creaseStart + gap));
  if (start < FOLD_SPLIT_MIN_SIDE || end < FOLD_SPLIT_MIN_SIDE) return null;
  return {
    axis: geometry.axis,
    start,
    gap: Math.round(gap),
    end,
    larger: end >= start ? 'end' : 'start',
  };
}

export function sameFoldGeometry(
  a: FoldGeometry | null,
  b: FoldGeometry | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.source === b.source &&
    a.posture === b.posture &&
    a.axis === b.axis &&
    a.hinge.x === b.hinge.x &&
    a.hinge.y === b.hinge.y &&
    a.hinge.width === b.hinge.width &&
    a.hinge.height === b.hinge.height
  );
}

export function sameFoldSplit(a: FoldSplit | null, b: FoldSplit | null) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.axis === b.axis &&
    a.start === b.start &&
    a.gap === b.gap &&
    a.end === b.end &&
    a.larger === b.larger
  );
}
