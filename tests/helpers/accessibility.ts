import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { ACCESSIBILITY_EXCEPTIONS } from './accessibility-exceptions';

const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

export async function getBlockingAccessibilityViolations(
  page: Page,
  surface: string,
  include?: string,
) {
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
      targets: violation.nodes.map((node) => node.target.join(' ')),
    })),
    `${surface} has unaccepted serious/critical accessibility violations`,
  ).toEqual([]);
}
