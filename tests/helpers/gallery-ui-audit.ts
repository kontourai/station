import type { Page } from '@playwright/test';
import { getBlockingAccessibilityViolations } from './accessibility';
import { HIT_TARGET_AUDIT, type HitTargetAudit } from './hit-target-audit';
import { STABLE_ANCHOR_SOURCE } from './stable-anchor';

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

/** Controls partly covered by the collapsed dock's non-interactive chrome. */
const DOCK_OCCLUSION_AUDIT = `(() => {
  ${STABLE_ANCHOR_SOURCE}
  const docks = Array.from(document.querySelectorAll('.chat-dock.is-collapsed'));
  const controls = Array.from(document.querySelectorAll('button, input, select, textarea, summary, a[href], [role="button"], [role="menuitem"]'));
  const findings = [];
  for (const control of controls) {
    if (docks.some((dock) => dock.contains(control))) continue;
    if (typeof control.checkVisibility === 'function' && !control.checkVisibility({ visibilityProperty: true })) continue;
    const r = control.getBoundingClientRect();
    // A control entirely clipped by an ancestor is not dock-occluded. A
    // partly visible control can still extend beneath a dock outside that
    // ancestor, so use its original rectangle for the overlap itself.
    let visible = { left: Math.max(r.left, 0), right: Math.min(r.right, innerWidth), top: Math.max(r.top, 0), bottom: Math.min(r.bottom, innerHeight) };
    for (let ancestor = control.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor), clip = ancestor.getBoundingClientRect();
      if (style.overflowX !== 'visible') { visible.left = Math.max(visible.left, clip.left); visible.right = Math.min(visible.right, clip.right); }
      if (style.overflowY !== 'visible') { visible.top = Math.max(visible.top, clip.top); visible.bottom = Math.min(visible.bottom, clip.bottom); }
    }
    if (visible.right - visible.left <= 1 || visible.bottom - visible.top <= 1) continue;
    for (const dock of docks) {
      const d = dock.getBoundingClientRect();
      const left = Math.max(r.left, d.left, 0), right = Math.min(r.right, d.right, innerWidth);
      const top = Math.max(r.top, d.top, 0), bottom = Math.min(r.bottom, d.bottom, innerHeight);
      if (right - left <= 1 || bottom - top <= 1) continue;
      // The control itself may be clipped out of the overlap. Compare the
      // dock with the first painted element in the control's ancestor chain
      // as well, so a foreground dialog stays above the dock while clipped
      // content behind the dock remains detectable.
      const covered = [0.25, 0.5, 0.75].some((x) =>
        [0.25, 0.5, 0.75].some((y) => {
          const stack = document.elementsFromPoint(left + (right - left) * x, top + (bottom - top) * y);
          const dockIndex = stack.findIndex((element) => dock.contains(element));
          const controlIndex = stack.findIndex((element) => element === control || control.contains(element) || element.contains(control));
          return dockIndex >= 0 && controlIndex >= 0 && dockIndex < controlIndex;
        }),
      );
      if (covered) findings.push({ anchor: stableAnchor(control) });
    }
  }
  return findings;
})()`;

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
  ${STABLE_ANCHOR_SOURCE}
  // An anonymous element is named through its nearest anchored ancestor.
  const describe = (el) => {
    const name = stableAnchor(el);
    if (name !== el.tagName.toLowerCase()) return name;
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const scope = stableAnchor(a);
      if (scope !== a.tagName.toLowerCase()) return scope + ' ' + name;
    }
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

export async function auditGalleryScreen(
  page: Page,
  screenName: string,
): Promise<GalleryUiAudit> {
  const startedAt = Date.now();
  const findings: GalleryUiFinding[] = [];
  const width = page.viewportSize()?.width ?? 0;

  const hits = (await page.evaluate(HIT_TARGET_AUDIT)) as HitTargetAudit;
  const dockOcclusions = (await page.evaluate(DOCK_OCCLUSION_AUDIT)) as Array<{
    anchor: string;
  }>;
  for (const { anchor } of dockOcclusions)
    findings.push({
      identity: `hit-target:occluded-by-dock:${anchor}`,
      detail: 'control is partly covered by collapsed dock chrome',
    });
  for (const { anchor } of hits.unreachableTargets.filter(
    (target) => !target.offCanvas,
  ))
    findings.push({
      identity: `hit-target:unreachable:${anchor}`,
      detail: 'laid out but hidden by a clipping ancestor',
    });
  if (width <= TOUCH_LAYOUT_MAX_WIDTH)
    for (const target of hits.smallTargets)
      findings.push({
        identity: `hit-target:small:${target.anchor}`,
        detail: `${target.width}x${target.height}px target, under 44px`,
      });
  // Only overlaps a press can confirm: both centres on screen and nothing
  // else on top. Below-the-fold overlaps are not judged here.
  for (const pair of hits.overlapPairs.filter(
    (pair) => pair.checkable && !pair.layered,
  ))
    findings.push({
      identity: `hit-target:overlap:${pair.firstAnchor} / ${pair.secondAnchor}`,
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
  // axe names a node by a shortest-unique selector, which moves when
  // unrelated DOM changes; key on the node's stable anchor instead.
  // The anchor code is a constant installed as-is; axe's targets are page
  // data, so they travel as an evaluate argument, never as code.
  await page.evaluate(
    `(() => { ${STABLE_ANCHOR_SOURCE}; globalThis.__galleryStableAnchorForTarget = stableAnchorForTarget; })()`,
  );
  const anchors = await page.evaluate(
    (targets) =>
      targets.map((target) =>
        (
          globalThis as unknown as {
            __galleryStableAnchorForTarget: (target: unknown) => string;
          }
        ).__galleryStableAnchorForTarget(target),
      ),
    violations.flatMap((violation) =>
      violation.nodes.map((node) => node.target as unknown),
    ),
  );
  let next = 0;
  for (const violation of violations)
    for (const node of violation.nodes)
      findings.push({
        identity: `axe:${violation.id}:${anchors[next++]}`,
        detail: `${violation.impact}: ${violation.help} (${node.target.join(' ')})`,
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
