/**
 * A page-side audit of every control's touch target under `#root`, for
 * `page.evaluate`. A target is the control's box widened by an absolutely
 * positioned `::before`/`::after` (the sheets' 44px hit-area idiom, centred on
 * the control), then CUT by every ancestor that hides overflow — a hit area a
 * clipping ancestor hides receives no touch, so an unclipped measure would
 * pass a control a finger cannot press. Reports controls a clip hides
 * entirely (laid out but unreachable), targets under 44px either way, and
 * pairs of targets that overlap (a finger aiming at one presses the other).
 * Light DOM only: a shadow tree (the diff renderer's) is its owner's.
 *
 * A scroll container that really scrolls on an axis (its scroll size exceeds
 * its client size) can bring a control outside its visible box into view.
 * Past it, the walk stops cutting the control and instead cuts the
 * scroller's visible box by the clips further out: the control is unreachable
 * when that box is clipped away, and its target is no larger than that box.
 * An `auto`/`scroll` box that does not scroll is a clip like `hidden`.
 *
 * Known limits, not modelled: a `clip-path` or `contain: paint` ancestor
 * clips without hiding overflow, so its cut is not applied; and a hit-area
 * pseudo-element is assumed centred on its control (the idiom here), so an
 * offset one is measured as if it were centred.
 */
import { STABLE_ANCHOR_SOURCE } from './stable-anchor';

export interface HitTargetAudit {
  /** Controls with a reachable target; `small` and `overlaps` judge these. */
  count: number;
  /** Laid-out controls that a hard-clipping ancestor hides entirely. */
  unreachable: string[];
  small: string[];
  overlaps: string[];
  /** `unreachable` as data, with whether the control is wholly off-canvas. */
  unreachableTargets: Array<{
    name: string;
    anchor: string;
    offCanvas: boolean;
  }>;
  /** `small` as data: the control's name and its measured target. */
  smallTargets: Array<{
    name: string;
    anchor: string;
    width: number;
    height: number;
  }>;
  /**
   * `overlaps` as data: the two controls' names, in document order;
   * `checkable` when both centres are on screen to hit-test, and `layered`
   * when a third element is topmost at either centre.
   */
  overlapPairs: Array<{
    first: string;
    second: string;
    firstAnchor: string;
    secondAnchor: string;
    checkable: boolean;
    layered: boolean;
  }>;
}

export const HIT_TARGET_AUDIT = `(() => {
  ${STABLE_ANCHOR_SOURCE}
  const root = document.getElementById('root');
  const clips = (value) => value === 'hidden' || value === 'clip';
  const scrolls = (value) => value === 'auto' || value === 'scroll';
  // One axis of the walk: clips cut the control until the first scroller that
  // really scrolls; after it they cut that scroller's visible box (reach).
  const step = (axis, overflow, lo, hi, scrollable) => {
    const scroller = scrolls(overflow) && scrollable;
    const clip = clips(overflow) || (scrolls(overflow) && !scrollable);
    if (axis.reach) {
      if (scroller || clip) { axis.reach[0] = Math.max(axis.reach[0], lo); axis.reach[1] = Math.min(axis.reach[1], hi); }
    } else if (scroller) axis.reach = [lo, hi];
    else if (clip) { axis.lo = Math.max(axis.lo, lo); axis.hi = Math.min(axis.hi, hi); }
  };
  const interactive = Array.from(root.querySelectorAll(
    'button, input, textarea, summary, a[href], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
  )).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  });
  const all = interactive.map((el) => {
    const r = el.getBoundingClientRect();
    let w = r.width, h = r.height;
    for (const pseudo of ['::before', '::after']) {
      const cs = getComputedStyle(el, pseudo);
      if (cs.content !== 'none' && cs.position === 'absolute') {
        const pw = parseFloat(cs.width), ph = parseFloat(cs.height);
        if (pw > w) w = pw;
        if (ph > h) h = ph;
      }
    }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const x = { lo: -Infinity, hi: Infinity, reach: null };
    const y = { lo: -Infinity, hi: Infinity, reach: null };
    for (let a = el.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const ar = a.getBoundingClientRect();
      step(x, cs.overflowX, ar.left, ar.right, a.scrollWidth > a.clientWidth + 1);
      step(y, cs.overflowY, ar.top, ar.bottom, a.scrollHeight > a.clientHeight + 1);
      if (a === root) break;
    }
    const l = Math.max(cx - w / 2, x.lo), rr = Math.min(cx + w / 2, x.hi);
    const t = Math.max(cy - h / 2, y.lo), b = Math.min(cy + h / 2, y.hi);
    const reachSpan = (axis) => (axis.reach ? axis.reach[1] - axis.reach[0] : Infinity);
    // A control a clip hides entirely is not on screen to press: it is
    // reported, not skipped, so a clip that swallows a control fails the audit.
    const hidden = r.right <= x.lo || r.left >= x.hi || r.bottom <= y.lo || r.top >= y.hi ||
      reachSpan(x) <= 0 || reachSpan(y) <= 0;
    const name = el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 30) || el.tagName;
    // What a press at the control's centre lands on, when that is on screen.
    const inView = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight;
    const hit = inView ? document.elementFromPoint(cx, cy) : null;
    // Wholly beside the viewport: an off-canvas control (a skip link at
    // left:-9999px until focused), not one a clip swallowed on screen.
    const offCanvas = r.right <= 0 || r.left >= innerWidth;
    return {
      el, hit, name, anchor: stableAnchor(el), hidden, offCanvas,
      w: Math.min(rr - l, reachSpan(x)), h: Math.min(b - t, reachSpan(y)), l, r: rr, t, b,
    };
  });
  const unreachable = all.filter((z) => z.hidden).map((z) => z.name);
  const unreachableTargets = all.filter((z) => z.hidden).map((z) => ({ name: z.name, anchor: z.anchor, offCanvas: z.offCanvas }));
  const zones = all.filter((z) => !z.hidden);
  const smallZones = zones.filter((z) => z.w < 43.5 || z.h < 43.5);
  const small = smallZones.map((z) => z.name + ' ' + Math.round(z.w) + 'x' + Math.round(z.h));
  const smallTargets = smallZones.map((z) => ({ name: z.name, anchor: z.anchor, width: Math.round(z.w), height: Math.round(z.h) }));
  const overlaps = [];
  const overlapPairs = [];
  for (let i = 0; i < zones.length; i += 1) for (let j = i + 1; j < zones.length; j += 1) {
    const a = zones[i], b = zones[j];
    const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l), oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
    if (ox > 1 && oy > 1) {
      overlaps.push(a.name + ' / ' + b.name + ' ' + Math.round(ox) + 'x' + Math.round(oy));
      // Layered: a third element is on top at either centre (a dialog over
      // the page, a fixed bar over scrolled content), so the two targets are
      // not both pressable here. One control covering the other is not
      // layered: that centre lands on the pair.
      const third = (z) => z.hit !== null && !a.el.contains(z.hit) && !b.el.contains(z.hit);
      overlapPairs.push({
        first: a.name,
        second: b.name,
        firstAnchor: a.anchor,
        secondAnchor: b.anchor,
        checkable: a.hit !== null && b.hit !== null,
        layered: third(a) || third(b),
      });
    }
  }
  return { count: zones.length, unreachable, small, overlaps, unreachableTargets, smallTargets, overlapPairs };
})()`;
