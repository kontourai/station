export interface RuntimeAuthRouteCase {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  kind: 'public' | 'protected';
  /**
   * Whether `requiredPairingScope` (archive#1098) recognizes this exact
   * path — i.e. whether it has an entry in `pairing-route-scopes.ts`'s
   * table. Every real route family here is `true`; the one deliberately
   * fictional "unknown future route" case is `false` on purpose, so it
   * proves the OTHER half of the fail-closed contract: even a fully
   * authenticated, fully-scoped credential is denied (403
   * `insufficient_scope`) on a route the table has never heard of — see
   * `'denies authenticated remote access to an unmapped route'` below.
   */
  scopeMapped: boolean;
}

/**
 * A deliberately small cross-section of every runtime route family. Unknown
 * routes are included because the security boundary must run before routing.
 */
export const RUNTIME_AUTH_ROUTE_MATRIX: readonly RuntimeAuthRouteCase[] = [
  {
    name: 'versioned public handshake',
    method: 'GET',
    path: '/.well-known/station/v1',
    kind: 'public',
    scopeMapped: true,
  },
  {
    name: 'public liveness',
    method: 'GET',
    path: '/api/system/liveness',
    kind: 'public',
    scopeMapped: true,
  },
  {
    name: 'system status and home recovery disclosure',
    method: 'GET',
    path: '/api/system/status',
    kind: 'protected',
    scopeMapped: true,
  },
  {
    name: 'API read',
    method: 'GET',
    path: '/api/projects',
    kind: 'protected',
    scopeMapped: true,
  },
  {
    name: 'API mutation',
    method: 'POST',
    path: '/api/projects',
    kind: 'protected',
    scopeMapped: true,
  },
  {
    name: 'server events SSE',
    method: 'GET',
    // The real mount (`createEventRoutes`, `runtime-routes.ts`) is `/events`.
    path: '/events',
    kind: 'protected',
    scopeMapped: true,
  },
  {
    name: 'agent session',
    method: 'POST',
    path: '/agents/example/chat',
    kind: 'protected',
    scopeMapped: true,
  },
  {
    name: 'ACP bridge',
    method: 'GET',
    path: '/acp/status',
    kind: 'protected',
    scopeMapped: true,
  },
  {
    name: 'integration route',
    method: 'GET',
    path: '/integrations/example',
    kind: 'protected',
    scopeMapped: true,
  },
  {
    name: 'framework root invoke',
    method: 'POST',
    path: '/invoke',
    kind: 'protected',
    scopeMapped: true,
  },
  {
    name: 'unknown future route',
    method: 'GET',
    path: '/future-sensitive-surface',
    kind: 'protected',
    scopeMapped: false,
  },
] as const;
