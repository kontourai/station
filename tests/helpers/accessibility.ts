import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { ACCESSIBILITY_EXCEPTIONS } from './accessibility-exceptions';

const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

/**
 * The slice of the page's Web Animations API the settle below reads. It runs
 * in the browser, but this module is also compiled by the scripts program
 * (no DOM lib), so the callback names the shapes it uses itself.
 */
interface PageAnimation {
  playState: string;
  effect: { getTiming(): { iterations?: number } } | null;
  timeline: unknown;
  finished: Promise<unknown>;
}
interface PageDocument {
  getAnimations(): PageAnimation[];
  timeline: unknown;
}

export async function getBlockingAccessibilityViolations(
  page: Page,
  surface: string,
  include?: string,
) {
  // Sample settled paint: a dialog's entrance opacity is intentionally below
  // its final text contrast. Do not wait for looping activity indicators.
  await page.evaluate(async () => {
    const page = (globalThis as unknown as { document: PageDocument }).document;
    await Promise.all(
      page
        .getAnimations()
        .filter(
          (animation: PageAnimation) =>
            animation.playState === 'running' &&
            animation.effect?.getTiming().iterations !== Infinity &&
            // A scroll-driven cue (a scrollable table's or the composer
            // rail's faded edge) finishes only when scrolled to its end, so
            // it never settles by waiting. Only time-based ones do.
            animation.timeline === page.timeline,
        )
        .map((animation: PageAnimation) => animation.finished.catch(() => {})),
    );
  });
  const builder = new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa',
  ]);
  if (include) builder.include(include);
  const result = await builder.analyze();
  const accepted = ACCESSIBILITY_EXCEPTIONS.filter(
    (entry) => entry.surface === surface,
  );
  for (const entry of accepted) {
    if (Date.parse(entry.expires) <= Date.now()) {
      throw new Error(
        `Expired accessibility exception: ${entry.surface}/${entry.ruleId}/${entry.target}`,
      );
    }
  }
  return result.violations
    .filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))
    .map((violation) => ({
      ...violation,
      nodes: violation.nodes.filter(
        (node) =>
          !accepted.some(
            (entry) =>
              entry.ruleId === violation.id &&
              entry.target === node.target.join(' '),
          ),
      ),
    }))
    .filter((violation) => violation.nodes.length > 0);
}

export async function expectNoBlockingAccessibilityViolations(
  page: Page,
  surface: string,
  include?: string,
) {
  const violations = await getBlockingAccessibilityViolations(
    page,
    surface,
    include,
  );
  expect(
    violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({
        target: node.target.join(' '),
        reason: node.failureSummary,
      })),
    })),
    `${surface} has unaccepted serious/critical accessibility violations`,
  ).toEqual([]);
}
