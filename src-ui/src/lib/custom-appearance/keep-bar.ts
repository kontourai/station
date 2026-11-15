/**
 * The preview bar: Keep, Discard and a countdown, which the CSS being
 * previewed must not be able to hide, restyle or spoof
 * (docs/decisions/custom-appearance.md).
 *
 * - It lives in a CLOSED shadow root on a host that is a child of `<html>`,
 *   not of `<body>`. Document CSS cannot select into the shadow tree, and the
 *   host's positioning, display and visibility are inline `!important`,
 *   which beats any author `!important` rule. `all: initial` on the host
 *   stops inherited properties (colour, font) from reaching the bar; its own
 *   styles use literal values, never custom properties, which inherit
 *   through `all`.
 * - It is shown as a manual popover, so it sits in the top layer, above any
 *   element the page can stack.
 * - Keep accepts only a trusted activation: a pointer click where the Keep
 *   button is the topmost element at the pointer (checked through both the
 *   document and the shadow root), or a keyboard activation while Keep has
 *   focus. While the page itself is made invisible or moved (opacity,
 *   visibility, filters, transforms, clipping, masks, zoom on `<html>`), or
 *   anything covers Keep, Keep is disabled and says why.
 * - Escape reverts the preview. Whatever else fails, the countdown reverts.
 */

export interface KeepBarOptions {
  name: string;
  seconds: number;
  /** Shown when the preview is a proposal rather than the person's own draft. */
  fromAgent: boolean;
  onKeep(): void;
  /** Discard button. */
  onDiscard(): void;
  /** Escape or the countdown: revert without deciding. */
  onRevert(): void;
  /**
   * A reason Keep is off that the bar cannot see itself (the preview's CSS is
   * paused for an approval, or its colours fail contrast), or `null`.
   */
  blockedBy?(): string | null;
}

export interface KeepBar {
  destroy(): void;
  /** For tests and the report: why Keep is disabled now, or `null`. */
  keepBlockedReason(): string | null;
  /** Where Keep is on screen; the shadow root is closed, so tests ask here. */
  keepRect(): DOMRect;
}

export const KEEP_BAR_TAG = 'station-appearance-preview';

const HOST_STYLE = [
  'all: initial',
  'position: fixed',
  'left: 0',
  'right: 0',
  'top: auto',
  'bottom: 0',
  'inset: auto 0 0 0',
  'width: auto',
  'height: auto',
  'margin: 0',
  'padding: 0',
  'border: 0',
  'z-index: 2147483647',
  'display: block',
  'visibility: visible',
  'opacity: 1',
  'transform: none',
  'translate: none',
  'scale: none',
  'rotate: none',
  'filter: none',
  'clip-path: none',
  'mask: none',
  'zoom: 1',
  'pointer-events: auto',
  'overflow: visible',
  'background: transparent',
  'contain: none',
  'content-visibility: visible',
  'mix-blend-mode: normal',
  'isolation: isolate',
]
  .map((rule) => `${rule} !important`)
  .join('; ');

/** The bar's own styles, inside the shadow root; literal values only. */
const BAR_CSS = [
  // The host's own pseudo-elements paint inside the bar's top layer and are
  // outside the shadow tree, so document CSS could draw a fake label over
  // Keep. A shadow root's !important rule for its host beats the document's.
  ':host::before, :host::after { content: none !important; display: none !important; }',
  ':host::backdrop { display: none !important; }',
  // `all: initial` leaves direction and unicode-bidi alone; they inherit.
  ':host { direction: ltr !important; unicode-bidi: normal !important; }',
  '.bar { box-sizing: border-box; display: flex; flex-wrap: wrap; align-items: center; }',
  '.bar { gap: 8px 16px; padding: 12px 16px; background: #10151c; color: #f4f6f8; }',
  '.bar { border-top: 2px solid #f0b429; }',
  '.bar { font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }',
  '.text { flex: 1 1 240px; min-width: 0; }',
  '.title { font-weight: 600; }',
  '.note { color: #c9d1d9; font-size: 13px; }',
  '.blocked { color: #ffd479; font-size: 13px; }',
  '.actions { display: flex; gap: 8px; }',
  'button { font: 600 14px/1 system-ui, -apple-system, "Segoe UI", sans-serif; }',
  'button { min-height: 44px; min-width: 88px; padding: 0 16px; border-radius: 6px; }',
  'button { border: 1px solid #8b949e; cursor: pointer; }',
  'button.keep { background: #f4f6f8; color: #10151c; border-color: #f4f6f8; }',
  'button.keep:disabled { background: #30363d; color: #8b949e; border-color: #30363d; }',
  'button.keep:disabled { cursor: not-allowed; }',
  'button.discard { background: transparent; color: #f4f6f8; }',
  'button:focus-visible { outline: 3px solid #f0b429; outline-offset: 2px; }',
].join('\n');

const NUMERIC_ONE = (value: string) => value === '' || Number(value) === 1;

/** Whether this element's own rendering hides or moves everything inside it. */
function hidesItsContent(element: Element): boolean {
  const style = getComputedStyle(element);
  return (
    !NUMERIC_ONE(style.opacity) ||
    style.visibility !== 'visible' ||
    style.display === 'none' ||
    (style.filter !== 'none' && style.filter !== '') ||
    (style.transform !== 'none' && style.transform !== '') ||
    (style.translate !== 'none' && style.translate !== '') ||
    (style.scale !== 'none' && style.scale !== '') ||
    (style.rotate !== 'none' && style.rotate !== '') ||
    (style.clipPath !== 'none' && style.clipPath !== '') ||
    (style.maskImage !== 'none' && style.maskImage !== '') ||
    (style.mixBlendMode !== 'normal' && style.mixBlendMode !== '') ||
    (style.contentVisibility !== 'visible' && style.contentVisibility !== '') ||
    !NUMERIC_ONE(style.getPropertyValue('zoom'))
  );
}

/**
 * Points across the page above the bar. The app fills the viewport, so a hit
 * on `<html>` or `<body>` itself means something painted by them, such as a
 * pseudo-element overlay (`html::after { position: fixed; inset: 0 }`),
 * covers the page. An overlay with `pointer-events: none` is invisible to
 * this hit test; that gap is recorded in the decision record.
 */
function pageCovered(host: HTMLElement): boolean {
  const top = host.getBoundingClientRect().top;
  const width = window.innerWidth;
  if (top < 40 || width < 40) return false;
  for (const [fx, fy] of [
    [0.5, 0.5],
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ] as const) {
    const hit = document.elementFromPoint(width * fx, top * fy);
    if (hit === document.documentElement || hit === document.body) return true;
  }
  return false;
}

/** Why the page cannot be trusted to show what Keep would keep, or `null`. */
function pageIntegrityProblem(host: HTMLElement): string | null {
  if (
    hidesItsContent(document.documentElement) ||
    (document.body !== null && hidesItsContent(document.body))
  )
    return 'This preview changes the whole page, so Keep is off. Discard it, or let it revert.';
  if (pageCovered(host))
    return 'Something covers the page in this preview, so Keep is off. Discard it, or let it revert.';
  for (const pseudo of ['::before', '::after']) {
    const content = getComputedStyle(host, pseudo).content;
    if (content !== 'none' && content !== 'normal' && content !== '')
      return 'This preview draws over this bar, so Keep is off. Discard it, or let it revert.';
  }
  const own = getComputedStyle(host);
  const rect = host.getBoundingClientRect();
  if (
    own.display === 'none' ||
    own.visibility !== 'visible' ||
    !NUMERIC_ONE(own.opacity) ||
    rect.height < 40 ||
    rect.bottom > window.innerHeight + 1 ||
    rect.top < 0
  )
    return 'This preview moves this bar, so Keep is off. Discard it, or let it revert.';
  return null;
}

function topmostIs(
  shadow: ShadowRoot,
  host: HTMLElement,
  target: Element,
  x: number,
  y: number,
): boolean {
  return (
    document.elementFromPoint(x, y) === host &&
    shadow.elementFromPoint(x, y) === target
  );
}

export function mountKeepBar(options: KeepBarOptions): KeepBar {
  const host = document.createElement(KEEP_BAR_TAG);
  host.setAttribute('style', HOST_STYLE);
  host.setAttribute('popover', 'manual');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = BAR_CSS;
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Appearance preview');
  const text = document.createElement('div');
  text.className = 'text';
  const title = document.createElement('div');
  title.className = 'title';
  const note = document.createElement('div');
  note.className = 'note';
  note.setAttribute('aria-live', 'polite');
  const blocked = document.createElement('div');
  blocked.className = 'blocked';
  blocked.setAttribute('role', 'status');
  text.append(title, note, blocked);
  const actions = document.createElement('div');
  actions.className = 'actions';
  const keep = document.createElement('button');
  keep.type = 'button';
  keep.className = 'keep';
  keep.textContent = 'Keep';
  const discard = document.createElement('button');
  discard.type = 'button';
  discard.className = 'discard';
  discard.textContent = 'Discard';
  actions.append(keep, discard);
  bar.append(text, actions);
  shadow.append(style, bar);

  title.textContent = `Previewing “${options.name.slice(0, 80)}”${options.fromAgent ? ', proposed by an agent' : ''}`;
  let remaining = Math.max(1, Math.round(options.seconds));
  let reason: string | null = null;
  let done = false;
  const renderNote = () => {
    note.textContent = `Reverts in ${remaining} s unless you keep it. Esc reverts now.`;
  };
  const check = () => {
    reason = pageIntegrityProblem(host) ?? options.blockedBy?.() ?? null;
    if (!reason) {
      const r = keep.getBoundingClientRect();
      if (
        r.width === 0 ||
        !topmostIs(
          shadow,
          host,
          keep,
          r.left + r.width / 2,
          r.top + r.height / 2,
        )
      )
        reason =
          'Something on the page covers Keep, so it is off. Discard it, or let it revert.';
    }
    keep.disabled = reason !== null;
    blocked.textContent = reason ?? '';
  };

  const finish = (outcome: () => void) => {
    if (done) return;
    done = true;
    destroy();
    outcome();
  };
  keep.addEventListener('click', (event) => {
    if (!event.isTrusted || done) return;
    check();
    if (reason) return;
    const pointer = event.detail > 0;
    const accepted = pointer
      ? topmostIs(shadow, host, keep, event.clientX, event.clientY)
      : shadow.activeElement === keep;
    if (!accepted) return;
    finish(options.onKeep);
  });
  discard.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    finish(options.onDiscard);
  });
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && event.isTrusted) {
      event.stopPropagation();
      finish(options.onRevert);
    }
  };
  window.addEventListener('keydown', onKey, true);
  const tick = window.setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      finish(options.onRevert);
      return;
    }
    renderNote();
  }, 1000);
  const integrity = window.setInterval(check, 250);

  function destroy() {
    window.clearInterval(tick);
    window.clearInterval(integrity);
    window.removeEventListener('keydown', onKey, true);
    host.remove();
  }

  document.documentElement.append(host);
  try {
    (host as HTMLElement & { showPopover?: () => void }).showPopover?.();
  } catch {
    // Not in the top layer; the inline position still holds it.
  }
  renderNote();
  check();
  // Not focused on mount: an Enter meant for the page must not keep it.
  return {
    destroy: () => {
      done = true;
      destroy();
    },
    keepBlockedReason: () => {
      check();
      return reason;
    },
    keepRect: () => keep.getBoundingClientRect(),
  };
}
