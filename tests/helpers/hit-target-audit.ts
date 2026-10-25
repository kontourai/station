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
 * A scroll container lets a control outside its visible box scroll into
 * view, so clips outside the nearest scroller (per axis) do not hide it; a
 * clip between the control and that scroller still does.
 *
 * Known limits, not modelled: a `clip-path` or `contain: paint` ancestor
 * clips without hiding overflow, so its cut is not applied; and a hit-area
 * pseudo-element is assumed centred on its control (the idiom here), so an
 * offset one is measured as if it were centred.
 */
export interface HitTargetAudit {
  /** Controls with a reachable target; `small` and `overlaps` judge these. */
  count: number;
  /** Laid-out controls that a hard-clipping ancestor hides entirely. */
  unreachable: string[];
  small: string[];
  overlaps: string[];
  /** `unreachable` as data, with whether the control is wholly off-canvas. */
  unreachableTargets: Array<{ name: string; offCanvas: boolean }>;
  /** `small` as data: the control's name and its measured target. */
  smallTargets: Array<{ name: string; width: number; height: number }>;
  /**
   * `overlaps` as data: the two controls' names, in document order;
   * `checkable` when both centres are on screen to hit-test, and `layered`
   * when a third element is topmost at either centre.
   */
  overlapPairs: Array<{
    first: string;
    second: string;
    checkable: boolean;
    layered: boolean;
  }>;
}

export const HIT_TARGET_AUDIT = `(() => {
  const root = document.getElementById('root');
  // Only a hard clip: a scroller's edge moves with its scroll position and
  // its scrollable overflow includes the hit areas, so it can bring them in.
  const clips = (value) => value === 'hidden' || value === 'clip';
  const scrolls = (value) => value === 'auto' || value === 'scroll';
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
    let l = cx - w / 2, rr = cx + w / 2, t = cy - h / 2, b = cy + h / 2;
    // Once the walk passes a scroller on an axis, clips further out no longer
    // decide that axis: scrolling brings the control inside the scroller's
    // box, which those outer clips already contain.
    let scrolledX = false, scrolledY = false;
    for (let a = el.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const ar = a.getBoundingClientRect();
      if (!scrolledX && clips(cs.overflowX)) { l = Math.max(l, ar.left); rr = Math.min(rr, ar.right); }
      if (!scrolledY && clips(cs.overflowY)) { t = Math.max(t, ar.top); b = Math.min(b, ar.bottom); }
      if (scrolls(cs.overflowX)) scrolledX = true;
      if (scrolls(cs.overflowY)) scrolledY = true;
      if (a === root) break;
    }
    // A control a hard clip hides entirely is not on screen to press: it is
    // reported, not skipped, so a clip that swallows a control fails the audit.
    const hidden = r.right <= l || r.left >= rr || r.bottom <= t || r.top >= b;
    const name = el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 30) || el.tagName;
    // What a press at the control's centre lands on, when that is on screen.
    const inView = cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight;
    const hit = inView ? document.elementFromPoint(cx, cy) : null;
    // Wholly beside the viewport: an off-canvas control (a skip link at
    // left:-9999px until focused), not one a clip swallowed on screen.
    const offCanvas = r.right <= 0 || r.left >= innerWidth;
    return { el, hit, name, hidden, offCanvas, w: rr - l, h: b - t, l, r: rr, t, b };
  });
  const unreachable = all.filter((z) => z.hidden).map((z) => z.name);
  const unreachableTargets = all.filter((z) => z.hidden).map((z) => ({ name: z.name, offCanvas: z.offCanvas }));
  const zones = all.filter((z) => !z.hidden);
  const smallZones = zones.filter((z) => z.w < 43.5 || z.h < 43.5);
  const small = smallZones.map((z) => z.name + ' ' + Math.round(z.w) + 'x' + Math.round(z.h));
  const smallTargets = smallZones.map((z) => ({ name: z.name, width: Math.round(z.w), height: Math.round(z.h) }));
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
        checkable: a.hit !== null && b.hit !== null,
        layered: third(a) || third(b),
      });
    }
  }
  return { count: zones.length, unreachable, small, overlaps, unreachableTargets, smallTargets, overlapPairs };
})()`;
