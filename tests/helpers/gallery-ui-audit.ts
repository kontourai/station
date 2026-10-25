import type { Page } from '@playwright/test';
import { getBlockingAccessibilityViolations } from './accessibility';
import { HIT_TARGET_AUDIT, type HitTargetAudit } from './hit-target-audit';

/**
 * Product assertions the gallery runs on every captured screen, after the
 * shot, against the exact state it photographed. Each finding has an
 * `identity` that names the defect without any measurement in it, so the
 * shrink-only allowlist (`tests/gallery-ui-findings.allowlist.json`, judged by
 * `scripts/gallery-ui-findings.mjs`) can key on screen + identity and a
 * control that grows from 30px to 32px is still the same known finding.
 * `detail` carries the measurement for the reader.
 */
export interface GalleryUiFinding {
  identity: string;
  detail: string;
}

/** The phone layout is the touch layout; the 44px rule applies there. */
const TOUCH_LAYOUT_MAX_WIDTH = 600;

/**
 * Horizontal escape, measured in the page. Reports the document scrolling
 * sideways, and every element that crosses the viewport's left or right edge
 * while partly on screen, unless an on-screen ancestor scrolls it, or clips
 * it while narrower than the viewport (a scroller's overflow is reachable; a
 * clip at the viewport edge is content cut off). Wholly off-canvas
 * elements (closed drawers) are not on screen and are skipped. Only the
 * outermost escaping element of a subtree is reported.
 */
const HORIZONTAL_OVERFLOW_AUDIT = `(() => {
  const viewport = document.documentElement.clientWidth;
  const documentOverflow = Math.max(0, document.documentElement.scrollWidth - viewport);
  const own = (el) => {
    const classes = Array.from(el.classList).slice(0, 3).map((c) => '.' + c).join('');
    const label = el.getAttribute('aria-label') || el.getAttribute('role') || '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + classes + (label ? '[' + label.slice(0, 40) + ']' : '');
  };
  // An anonymous element is named through its nearest identifiable ancestor.
  const describe = (el) => {
    const name = own(el);
    if (name !== el.tagName.toLowerCase()) return name;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement)
      if (own(a) !== a.tagName.toLowerCase()) return own(a) + ' ' + name;
    return name;
  };
  const escaping = [];
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.left >= -1 && r.right <= viewport + 1) continue;
    if (r.right <= 0 || r.left >= viewport) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.opacity === '0') continue;
    let contained = false;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const overflowX = getComputedStyle(a).overflowX;
      if (overflowX === 'visible') continue;
      const ar = a.getBoundingClientRect();
      if (ar.left < -1 || ar.right > viewport + 1) continue;
      // A scroller on screen lets the user reach it (a scrolling tab row);
      // a clip contains only when narrower than the viewport, since a clip
      // AT the viewport edge is content cut off.
      if (overflowX === 'auto' || overflowX === 'scroll' || ar.width < viewport - 1) { contained = true; break; }
    }
    if (!contained) escaping.push({ el, left: r.left, right: r.right });
  }
  const set = new Set(escaping.map((e) => e.el));
  const elements = escaping
    .filter(({ el }) => { for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false; return true; })
    .map(({ el, left, right }) => ({ name: describe(el), left: Math.round(left), right: Math.round(right) }));
  return { viewport, documentOverflow, elements };
})()`;

interface HorizontalOverflowAudit {
  viewport: number;
  documentOverflow: number;
  elements: Array<{ name: string; left: number; right: number }>;
}

export interface GalleryUiAudit {
  findings: GalleryUiFinding[];
  /** Raw counts, recorded whatever the policy, so the policy has evidence. */
  measured: {
    controls: number;
    smallTargets: number;
    viewport: number;
    /** Wall time the three audits took on this screen. */
    auditMs: number;
  };
}

/**
 * React `useId` values (`_r_1c_`, legacy `:r1c:`) number hooks in render
 * order, so an unrelated component gaining a hook renames them. An axe
 * target keeps its shape with the id masked.
 */
function stableTarget(target: string): string {
  return target
    .replace(/_r_[0-9a-z]+_/g, '_r_*_')
    .replace(/:r[0-9a-z]+:/g, ':r*:');
}

export async function auditGalleryScreen(
  page: Page,
  screenName: string,
): Promise<GalleryUiAudit> {
  const startedAt = Date.now();
  const findings: GalleryUiFinding[] = [];
  const width = page.viewportSize()?.width ?? 0;

  const hits = (await page.evaluate(HIT_TARGET_AUDIT)) as HitTargetAudit;
  for (const { name } of hits.unreachableTargets.filter(
    (target) => !target.offCanvas,
  ))
    findings.push({
      identity: `hit-target:unreachable:${name}`,
      detail: 'laid out but hidden by a clipping ancestor',
    });
  if (width <= TOUCH_LAYOUT_MAX_WIDTH)
    for (const target of hits.smallTargets)
      findings.push({
        identity: `hit-target:small:${target.name}`,
        detail: `${target.width}x${target.height}px target, under 44px`,
      });
  // Only overlaps a press can confirm: both centres on screen and nothing
  // else on top. Below-the-fold overlaps are not judged here.
  for (const pair of hits.overlapPairs.filter(
    (pair) => pair.checkable && !pair.layered,
  ))
    findings.push({
      identity: `hit-target:overlap:${pair.first} / ${pair.second}`,
      detail: 'touch targets overlap',
    });

  const overflow = (await page.evaluate(
    HORIZONTAL_OVERFLOW_AUDIT,
  )) as HorizontalOverflowAudit;
  if (overflow.documentOverflow > 1)
    findings.push({
      identity: 'overflow:document',
      detail: `document scrolls ${overflow.documentOverflow}px sideways at ${overflow.viewport}px`,
    });
  for (const element of overflow.elements)
    findings.push({
      identity: `overflow:element:${element.name}`,
      detail: `spans ${element.left}..${element.right}px in a ${overflow.viewport}px viewport`,
    });

  const violations = await getBlockingAccessibilityViolations(
    page,
    `gallery/${screenName}`,
  );
  for (const violation of violations)
    for (const node of violation.nodes)
      findings.push({
        identity: `axe:${violation.id}:${stableTarget(node.target.join(' '))}`,
        detail: `${violation.impact}: ${violation.help}`,
      });

  // One identity may repeat (two unnamed controls of one kind); the allowlist
  // keys on identity, so keep each once and say how many were seen.
  const byIdentity = new Map<string, GalleryUiFinding & { seen: number }>();
  for (const finding of findings) {
    const existing = byIdentity.get(finding.identity);
    if (existing) existing.seen += 1;
    else byIdentity.set(finding.identity, { ...finding, seen: 1 });
  }
  return {
    findings: [...byIdentity.values()]
      .map(({ seen, ...finding }) =>
        seen > 1
          ? { ...finding, detail: `${finding.detail} (x${seen})` }
          : finding,
      )
      .sort((a, b) => a.identity.localeCompare(b.identity)),
    measured: {
      controls: hits.count,
      smallTargets: hits.smallTargets.length,
      viewport: width,
      auditMs: Date.now() - startedAt,
    },
  };
}
