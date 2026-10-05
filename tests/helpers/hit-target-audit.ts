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
}

export const HIT_TARGET_AUDIT = `(() => {
  const root = document.getElementById('root');
  // Only a hard clip: a scroller's edge moves with its scroll position and
  // its scrollable overflow includes the hit areas, so it can bring them in.
  const clips = (value) => value === 'hidden' || value === 'clip';
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
    for (let a = el.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const ar = a.getBoundingClientRect();
      if (clips(cs.overflowX)) { l = Math.max(l, ar.left); rr = Math.min(rr, ar.right); }
      if (clips(cs.overflowY)) { t = Math.max(t, ar.top); b = Math.min(b, ar.bottom); }
      if (a === root) break;
    }
    // A control a hard clip hides entirely is not on screen to press: it is
    // reported, not skipped, so a clip that swallows a control fails the audit.
    const hidden = r.right <= l || r.left >= rr || r.bottom <= t || r.top >= b;
    const name = el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 30) || el.tagName;
    return { name, hidden, w: rr - l, h: b - t, l, r: rr, t, b };
  });
  const unreachable = all.filter((z) => z.hidden).map((z) => z.name);
  const zones = all.filter((z) => !z.hidden);
  const small = zones.filter((z) => z.w < 43.5 || z.h < 43.5).map((z) => z.name + ' ' + Math.round(z.w) + 'x' + Math.round(z.h));
  const overlaps = [];
  for (let i = 0; i < zones.length; i += 1) for (let j = i + 1; j < zones.length; j += 1) {
    const a = zones[i], b = zones[j];
    const ox = Math.min(a.r, b.r) - Math.max(a.l, b.l), oy = Math.min(a.b, b.b) - Math.max(a.t, b.t);
    if (ox > 1 && oy > 1) overlaps.push(a.name + ' / ' + b.name + ' ' + Math.round(ox) + 'x' + Math.round(oy));
  }
  return { count: zones.length, unreachable, small, overlaps };
})()`;
