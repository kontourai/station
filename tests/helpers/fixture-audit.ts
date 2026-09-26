import { FOCUS_PRESENCE_REPORT_PATH } from '@kontourai/station-contracts/presence';
import { test as base, expect, type Page, type Route } from '@playwright/test';

const unexpected = new WeakMap<Page, Set<string>>();

/** An omitted fixture response is a test defect, never an authoritative empty inventory. */
export async function rejectUnexpectedFixtureRequest(
  route: Route,
): Promise<void> {
  const url = new URL(route.request().url());
  // Every mounted App reports its document focus (#2585). The route's real
  // answer is an empty 204, so this is its declared model, not a guessed
  // empty inventory; journeys that assert on focus route it themselves.
  if (
    route.request().method() === 'POST' &&
    url.pathname === FOCUS_PRESENCE_REPORT_PATH
  ) {
    await route.fulfill({ status: 204 });
    return;
  }
  const page = route.request().frame().page();
  const failures = unexpected.get(page) ?? new Set<string>();
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
