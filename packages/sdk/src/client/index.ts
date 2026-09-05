/**
 * `@kontourai/station-sdk/client` — a React-free entry point (#167).
 *
 * HTTP operations under this barrel are pure `fetch()`-based and take
 * `apiBase` as an explicit plain-string
 * parameter (never the module-level `_apiBase`/`_setApiBase` singleton used
 * by the SDK's hook surface). Pure header utilities also receive their
 * attribution explicitly. This graph never imports `react`, `react-dom`,
 * `@tanstack/react-query`, a `.tsx` file, or a `.css` file, nor reaches back
 * into `../hooks*`, `../providers`, `../components/*`, or `../layout/*`.
 * This is what lets `packages/cli` (a `tsx`-run Node process) and
 * `src-server/tools/station-control-*.ts` (esbuild-bundled into
 * `dist-server/command-station.js`, where `@kontourai/station-sdk` is not in
 * `esbuild.config.mjs`'s `external` list) import this subgraph safely,
 * while the SDK's root `.` export keeps its full hook/provider/component
 * surface unchanged for `src-ui` and plugin consumers.
 *
 * Enforced by `packages/sdk/src/__tests__/client-entry-portability.test.ts`.
 *
 * Scope: one canonical fetcher per operation named in the #167 plan /
 * `.kontourai/flow-agents/cli-harness/cli-coverage-audit.md`'s §3
 * triplication inventory (excluding app config, `#175`, and plugin
 * install/update/remove — genuinely different mechanisms, tracked
 * separately) — not a general-purpose HTTP client for every Station route.
 */

export * from './agents';
export * from './analytics';
export * from './answer-basis';
export * from './answer-narrative-binding';
export * from './answer-support';
export * from './attachment-staging';
export * from './board';
export { ChatHttpError } from './chatHttpError';
export { setClientOriginResolver } from './client-origin.js';
export * from './conversations';
export * from './delegations';
export * from './execution';
export * from './fleet-routing';
export type {
  ApiRequestScope,
  AuthenticatedFetchInit,
  ClientAuthenticatedRequestInit,
  ClientCredential,
  ClientCredentialResolver,
  ClientRequestOptions,
  FetchSseConnection,
  FetchSseMessage,
  FetchSseOptions,
} from './http';
export {
  authenticatedFetch,
  DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
  fetchSSE,
  getClientRequestTimeout,
  isApiRequestScope,
  notifyCredentialChanged,
  StationCredentialConflictError,
  StationHttpError,
  StationReadOnlyError,
  StationRequestAuthorityError,
  StationRequestTimeoutError,
  setClientCredentialResolver,
  setClientRequestTimeout,
} from './http';
export * from './integrations';
export * from './knowledge';
export * from './learning-source';
export * from './orchestration';
export { getPluginHeaders } from './plugin-headers';
export * from './plugins';
export * from './project-task-rooms';
export * from './projects';
export * from './request-inspection';
export * from './reviews';
export * from './runs';
export * from './scheduler';
export * from './session-outputs';
export * from './skills';
export * from './task-basis';
export * from './task-outputs';
export * from './task-tool-results';
export * from './task-user-input-references';
export * from './unified-search';
