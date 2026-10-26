/**
 * Page-side source for naming an element by what it IS, not where it sits,
 * so a gallery finding keeps one identity while unrelated DOM changes around
 * it. axe's `node.target` is a shortest-unique CSS selector: adding a sibling
 * turns `button` into `.pill`, a second instance gains `:nth-child`, and React
 * `useId` values renumber when an unrelated component gains a hook.
 *
 * `stableAnchor(el)`:
 * - the nearest `data-testid` (the element's own, or an ancestor's as a
 *   prefix), then
 * - the tag, its first stable class (letters and hyphens/underscores, no
 *   digits; a block or element class before a `--modifier`), a form
 *   control's `type` and `name` attributes, and
 * - the accessible name (`aria-labelledby`, `aria-label`, `title`, an
 *   associated `<label>` — `for` or wrapping — or a control's own text) or,
 *   failing that, the role.
 * Names are kept to 120 characters: long enough that two controls differ
 * before the cut, short enough to keep a key readable.
 * An element left with only its tag is scoped by its nearest ancestor with a
 * stable class.
 * Digit runs become `#` and React ids `*`, so no count, index or generated id
 * reaches the key. Two identical controls share an anchor by design.
 *
 * `stableAnchorForTarget(target)` resolves an axe target and anchors it; a
 * target in a frame or shadow root falls back to the selector with
 * positional and generated segments masked.
 */
export const STABLE_ANCHOR_SOURCE = `
function stableToken(value) {
  return String(value)
    .replace(/_r_[0-9a-z]+_|:r[0-9a-z]+:/gi, '*')
    .replace(/[0-9]+/g, '#')
    .replace(/\\s+/g, ' ')
    .trim()
    .slice(0, 120);
}
function stableClass(el) {
  const classes = Array.from(el.classList).filter((c) => /^[A-Za-z_-]+$/.test(c));
  return classes.find((c) => !c.includes('--')) || classes[0] || null;
}
function anchorName(el) {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy.split(/\\s+/)
      .map((id) => (document.getElementById(id)?.textContent || '').trim())
      .filter(Boolean).join(' ');
    if (text) return text;
  }
  const label = el.getAttribute('aria-label') || el.getAttribute('title');
  if (label) return label;
  const labels = Array.from(el.labels || [])
    .map((node) => (node.textContent || '').trim())
    .filter(Boolean).join(' ');
  if (labels) return labels;
  if (el.matches('button, a[href], summary, label, [role="button"], [role="tab"], [role^="menuitem"], option'))
    return (el.textContent || '').trim();
  return el.getAttribute('placeholder') || '';
}
function stableAnchor(el) {
  const own = el.getAttribute('data-testid');
  if (own) return '[data-testid=' + stableToken(own) + ']';
  const cls = stableClass(el);
  const name = stableToken(anchorName(el));
  const role = el.getAttribute('role');
  const form = el.matches('input, select, textarea');
  const type = form && el.getAttribute('type');
  const field = form && el.getAttribute('name');
  const self = el.tagName.toLowerCase() + (cls ? '.' + cls : '') +
    (type ? '[type=' + stableToken(type) + ']' : '') +
    (field ? '[name=' + stableToken(field) + ']' : '') +
    (name ? '[' + name + ']' : role ? '[role=' + role + ']' : '');
  const scope = el.parentElement && el.parentElement.closest('[data-testid]');
  if (scope) return '[data-testid=' + stableToken(scope.getAttribute('data-testid')) + '] ' + self;
  // A bare tag names nothing: scope it by its nearest classed ancestor.
  if (self === el.tagName.toLowerCase())
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const owner = stableClass(a);
      if (owner) return a.tagName.toLowerCase() + '.' + owner + ' ' + self;
    }
  return self;
}
function stableAnchorForTarget(target) {
  const parts = Array.isArray(target) ? target : [target];
  if (parts.length === 1 && typeof parts[0] === 'string') {
    let el = null;
    try { el = document.querySelector(parts[0]); } catch {}
    if (el) return stableAnchor(el);
  }
  return stableToken(parts.flat().join(' ').replace(/:nth-(child|of-type)\\([^)]*\\)/g, ''));
}
`;
