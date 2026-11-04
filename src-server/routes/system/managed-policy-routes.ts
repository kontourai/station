import type { LoadedManagedPolicy } from '@kontourai/station-shared/managed-policy';
import { managedPolicyStatus } from '@kontourai/station-shared/managed-policy';
import { Hono } from 'hono';

/**
 * `GET /api/settings/managed-policy` (#4516): what this server loaded at
 * startup. The body is a `ManagedPolicyStatus`: `{ state: 'none' }`, or the
 * source, the fingerprint and the value-free summary (organization, support
 * link, locked setting paths, effective limits). It never carries a setting
 * value. `station policy show` compares the fingerprint with the installed
 * policy to tell an administrator whether a restart is needed.
 *
 * The status is computed once: the policy is fixed for the process lifetime.
 */
export function createManagedPolicyRoutes(loaded: LoadedManagedPolicy | null) {
  const app = new Hono();
  const status = managedPolicyStatus(loaded);

  app.get('/', (c) => c.json({ success: true, data: status }));

  return app;
}
