import { describe, expect, test } from 'vitest';

import { StationHttpError } from '../client/http';
import {
  LAYOUT_CATALOG_MAX_RETRIES,
  LAYOUT_CATALOG_RETRY_DELAYS_MS,
  layoutCatalogRetryDelay,
  shouldRetryLayoutCatalog,
  shouldRetryProjectLayout,
} from '../query-domains/workspaceProjects';

describe('layout catalog retry policy', () => {
  test('uses finite exponential backoff and never retries authentication failures', () => {
    expect(shouldRetryLayoutCatalog(0, new Error('offline'))).toBe(true);
    expect(
      shouldRetryLayoutCatalog(
        LAYOUT_CATALOG_MAX_RETRIES - 1,
        new Error('offline'),
      ),
    ).toBe(true);
    expect(
      shouldRetryLayoutCatalog(
        LAYOUT_CATALOG_MAX_RETRIES,
        new Error('offline'),
      ),
    ).toBe(false);
    expect(shouldRetryLayoutCatalog(0, new StationHttpError(401))).toBe(false);
    expect(shouldRetryLayoutCatalog(0, new StationHttpError(403))).toBe(false);
    expect(LAYOUT_CATALOG_RETRY_DELAYS_MS).toEqual([1_000, 2_000, 4_000]);
    expect(
      LAYOUT_CATALOG_RETRY_DELAYS_MS.map((_, attempt) =>
        layoutCatalogRetryDelay(attempt),
      ),
    ).toEqual(LAYOUT_CATALOG_RETRY_DELAYS_MS);
  });
});

/**
 * 4-HOME-009. Measured live before this policy: `/projects/x/layouts/missing`
 * sat on the loading screen for 6-12 seconds and issued four 404 requests,
 * because the query inherited the host's `retry: 1` and re-asked a question
 * the server had already answered.
 */
describe('single project layout retry policy', () => {
  test('never retries a 4xx', () => {
    expect(shouldRetryProjectLayout(0, new StationHttpError(404))).toBe(false);
    expect(shouldRetryProjectLayout(0, new StationHttpError(403))).toBe(false);
  });

  test('keeps one retry for a 5xx or a transport failure', () => {
    expect(shouldRetryProjectLayout(0, new StationHttpError(503))).toBe(true);
    expect(shouldRetryProjectLayout(0, new TypeError('Failed to fetch'))).toBe(
      true,
    );
    expect(shouldRetryProjectLayout(1, new TypeError('Failed to fetch'))).toBe(
      false,
    );
  });
});
