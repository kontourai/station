import { expect, type Page } from '@playwright/test';

export async function monitorBrowserHealth(page: Page) {
  const failures: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      // Chromium mirrors ordinary HTTP 4xx responses into console.error.
      // Network policy below owns transport failures and 5xx responses; keep
      // application-authored console errors fail-closed without double-counting
      // expected not-found/validation probes as JavaScript failures.
      if (
        /^Failed to load resource: the server responded with a status of 4\d\d/.test(
          message.text(),
        )
      ) {
        return;
      }
      const location = message.location();
      const source = location.url ? ` (${location.url})` : '';
      failures.push(`console.error: ${message.text()}${source}`);
    }
  });
  page.on('pageerror', (error) => {
    failures.push(`pageerror: ${error.message}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 500) {
      failures.push(`HTTP ${response.status()}: ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    const resourceType = request.resourceType();
    const failure = request.failure()?.errorText || 'unknown failure';
    if (
      ['document', 'fetch', 'xhr', 'script', 'stylesheet'].includes(
        resourceType,
      ) &&
      failure !== 'net::ERR_ABORTED' &&
      !new URL(request.url()).pathname.endsWith('/events')
    ) {
      failures.push(`${resourceType} failed: ${request.url()} (${failure})`);
    }
  });

  if (process.env.STATION_E2E_SEED_REGRESSION === 'console') {
    await page.addInitScript(() => {
      console.error('STATION_E2E_SEEDED_CONSOLE_REGRESSION');
    });
  }

  return {
    assertHealthy() {
      expect(failures, 'unexpected browser console/network failures').toEqual(
        [],
      );
    },
  };
}
