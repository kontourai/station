import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('E2E browser bootstrap wiring', () => {
  test('runner marks Playwright configuration as runner-owned', () => {
    const source = readFileSync('scripts/run-e2e-suite.mjs', 'utf8');

    expect(source).toContain("STATION_E2E_RUNNER: '1'");
    expect(source).toContain('STATION_E2E_HOST_CREDENTIAL: operatorCredential');
    expect(source).toContain(
      'STATION_E2E_BROWSER_SESSION_CREDENTIAL: browserSessionCredential',
    );
    expect(source).toContain('STATION_E2E_HOME: stationHome');
  });

  test('does not attach an operator credential to browser-wide requests', () => {
    const config = readFileSync('playwright.config.ts', 'utf8');
    const firstRun = readFileSync('tests/first-run-live.spec.ts', 'utf8');
    const uiCrud = readFileSync('tests/ui-crud-smoke.spec.ts', 'utf8');

    expect(config).not.toContain('extraHTTPHeaders');
    expect(config).not.toContain('Authorization');
    expect(firstRun).toContain('authenticatedRequest.get');
    expect(firstRun).toContain("from './helpers/authenticated-request'");
    expect(uiCrud).toContain('authenticatedRequest.put');
    expect(uiCrud).toContain('authenticatedRequest.delete');
    expect(uiCrud).not.toContain('page.evaluate');
  });

  test('plugin preview retains the runner-provided authenticated profile', () => {
    const source = readFileSync('tests/plugin-preview.spec.ts', 'utf8');

    expect(source).not.toContain("station-connect-connections-active', 'c1'");
    expect(source).not.toContain("id: 'c1'");
  });
});
