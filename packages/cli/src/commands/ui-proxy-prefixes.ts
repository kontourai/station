// Leaf module (no imports): `vite.config.ts` reads this list for the dev proxy,
// and must not pull in lifecycle.ts's process-spawning graph to do so.

/**
 * Bare top-level backend mounts the UI-server proxy forwards to when a
 * request has no matching static asset. Mirrors the non-`/api` mounts in
 * `src-server/runtime/routes/runtime-routes.ts` (`/agents`, `/acp`, `/events`,
 * `/integrations`, `/config`, `/bedrock`, `/monitoring`, `/scheduler`,
 * `/notifications`) plus bare framework routes registered directly on the
 * same Hono app by `@voltagent/server-core`/`@voltagent/server-hono` that are
 * not declared in `runtime-routes.ts` at all: `/tools` and `/observability`
 * (confirmed via their framework route registrations in
 * `node_modules/@voltagent/server-core/dist/index.js`, wired
 * unconditionally by `honoServer`'s `createApp` — no current `src-ui` call
 * site hits it yet, but it is a live mount today, not hypothetical). `/api`
 * covers every `/api/*` mount as one prefix. This list is empirically
 * derived, not a static enumeration of `runtime-routes.ts` alone — re-check
 * both `runtime-routes.ts` and the VoltAgent server packages' own route
 * wiring before assuming it is exhaustive.
 */
export const UI_PROXY_BACKEND_PREFIXES: string[] = [
  '/.well-known',
  '/api',
  '/agents',
  '/acp',
  '/events',
  '/integrations',
  '/config',
  '/bedrock',
  '/monitoring',
  '/scheduler',
  '/notifications',
  '/tools',
  '/observability',
];
