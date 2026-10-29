import type { Page, Route } from '@playwright/test';

/**
 * Whether a request is the server update CHECK, `GET|POST
 * /api/system/core-update`, whatever its query (#3851).
 *
 * The SDK's check asks for `?staged=1`. A Playwright glob such as
 * `'**\/api/system/core-update'` matches the whole URL, query included, so it
 * silently stopped matching that request. The fixture then fell through to
 * the real route, which runs a live `git fetch` against this checkout's
 * remote, and the Settings card's loading skeleton waited on it. Matching
 * the path keeps the stub in force. Sub-routes (`/state`, `/service-update`,
 * `/restart-status`, ...) are separate endpoints and are not matched.
 */
function isCoreUpdateCheckUrl(url: URL): boolean {
  return url.pathname.endsWith('/api/system/core-update');
}

/** Routes the server update check, with or without its query. */
export function routeCoreUpdateCheck(
  page: Pick<Page, 'route'>,
  handler: (route: Route) => unknown,
): ReturnType<Page['route']> {
  return page.route(isCoreUpdateCheckUrl, handler);
}
