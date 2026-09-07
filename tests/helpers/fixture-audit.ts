import { test as base, expect, type Page, type Route } from '@playwright/test';

const unexpected = new WeakMap<Page, Set<string>>();

/** An omitted fixture response is a test defect, never an authoritative empty inventory. */
export async function rejectUnexpectedFixtureRequest(
  route: Route,
): Promise<void> {
  const page = route.request().frame().page();
  const failures = unexpected.get(page) ?? new Set<string>();
  const url = new URL(route.request().url());
  failures.add(`${route.request().method()} ${url.pathname}`);
  unexpected.set(page, failures);
  await route.fulfill({
    status: 501,
    contentType: 'application/json',
    body: JSON.stringify({
      success: false,
      error: 'Unmodeled fixture request',
    }),
  });
}

export const test = base.extend<{ fixtureAudit: undefined }>({
  fixtureAudit: [
    async ({ page }, use) => {
      try {
        await use(undefined);
      } finally {
        const failures = [...(unexpected.get(page) ?? [])].sort();
        unexpected.delete(page);
        expect(
          failures,
          'Declare the method and response shape for these fixture requests',
        ).toEqual([]);
      }
    },
    { auto: true },
  ],
});
