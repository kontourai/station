import type { PairedHomeIdentityObservation } from '@kontourai/station-contracts/cloud-move';
import {
  PAIRING_SCOPE_HOME_TRANSFER,
  pairingScopeIncludes,
} from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { createPersonalRuntimeRequestGuard } from '../../runtime/bootstrap/runtime-tenant-context.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import type { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';

/** Observe a separately paired transfer participant on this controller.
 * Deliberately no mutation, ownership claim, tenant membership or lease API. */
export function createHomeAuthorityRoutes(
  security: Pick<
    EnvironmentSecurityService,
    'identifyDevice' | 'getPublicHandshake'
  >,
) {
  const app = new Hono();
  const personal = createPersonalRuntimeRequestGuard();
  app.get('/identity', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!personal(c.req.raw)) {
      return c.json(
        { error: { code: 'home_authority_tenant_binding_required' } },
        403,
      );
    }
    const principal = getRuntimeAuthenticatedRequestPrincipal(c.req.raw);
    if (principal?.authority !== 'device-credential' || !principal.deviceId) {
      return c.json({ error: { code: 'home_transfer_pairing_required' } }, 403);
    }
    const current = () => {
      const device = security.identifyDevice(principal.credential);
      return (
        personal(c.req.raw) &&
        device !== null &&
        device.id === principal.deviceId &&
        pairingScopeIncludes(device.scope, PAIRING_SCOPE_HOME_TRANSFER)
      );
    };
    try {
      if (!current()) {
        return c.json(
          { error: { code: 'home_transfer_pairing_required' } },
          403,
        );
      }
      const controller = await security.getPublicHandshake();
      // Pairing can be revoked while reading controller identity. Never publish
      // an enrollment observation under the old request authentication alone.
      if (!current()) {
        return c.json(
          { error: { code: 'home_transfer_pairing_required' } },
          403,
        );
      }
      const observation: PairedHomeIdentityObservation = {
        schemaVersion: 'station.paired-home-identity/v1',
        controllerEnvironmentId: controller.environmentId,
        pairedDeviceId: principal.deviceId,
        scope: 'personal',
        executionAuthorityTransferred: false,
        executionResumeAvailable: false,
      };
      return c.json(observation);
    } catch {
      return c.json({ error: { code: 'home_authority_unavailable' } }, 503);
    }
  });
  return app;
}
