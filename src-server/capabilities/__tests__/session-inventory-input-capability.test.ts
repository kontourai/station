import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHostedTenantRegistry } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { createOrchestrationRoutes } from '../../routes/orchestration/orchestration.js';
import { HOSTED_TENANT_REGISTRY_FILE_ENV } from '../../runtime/bootstrap/hosted-tenant-mode.js';
import { configureRuntimePublicRoutes } from '../../runtime/routes/runtime-routes.js';
import { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';

const makeTempDir = trackTempDirs();

const REGISTRY = {
  schemaVersion: 1,
  tenants: [{ id: 'alpha', authority: 'alpha.example.test' }],
};

/**
 * #4177: the public handshake's `sessionInventoryInputRead` must say whether
 * this deployment's input route can serve a read. Each mode builds the real
 * handshake (EnvironmentSecurityService behind the public route) and the real
 * input route from the same deployment fact, then compares the advertised flag
 * with what the route actually answers for a read its owner would grant.
 */
describe('sessionInventoryInputRead matches what the input route serves (#4177)', () => {
  test.each([
    { mode: 'personal', hosted: false },
    { mode: 'hosted', hosted: true },
  ])('$mode deployment', async ({ hosted }) => {
    const homeDir = makeTempDir('station-input-capability-');
    const registryPath = join(homeDir, 'tenants.json');
    writeFileSync(registryPath, JSON.stringify(REGISTRY));

    const security = new EnvironmentSecurityService({
      homeDir,
      environment: hosted
        ? { [HOSTED_TENANT_REGISTRY_FILE_ENV]: registryPath }
        : {},
    });
    const publicApp = new Hono();
    configureRuntimePublicRoutes(publicApp as never, security);
    const handshake = (await (
      await publicApp.request('/.well-known/station/v1')
    ).json()) as { capabilities?: Record<string, boolean> };
    const advertised =
      handshake.capabilities?.sessionInventoryInputRead === true;

    const readUserInput = vi.fn(async () => ({
      status: 'found',
      sessionId: 'session-a',
      eventId: 'input-a',
      turnId: 'turn-a',
      input: { prompt: 'Protected input', attachments: [] },
    }));
    const routes = createOrchestrationRoutes(
      {
        canUserReadSession: () => true,
        sessionQueries: { readUserInput },
      } as never,
      {
        eventBus: { subscribe: () => () => {} },
        logger: { debug: vi.fn() },
        getUserId: () => 'owner',
        isRequestPrincipalCurrent: () => true,
        ...(hosted
          ? { hostedTenantRegistry: parseHostedTenantRegistry(REGISTRY) }
          : {}),
      },
    );
    const response = await routes.request(
      '/sessions/session-a/inputs/input-a?turnId=turn-a',
    );
    const served = response.status === 200;

    // Pinned literals beside the derived comparison, so a change that flips
    // both sides together (e.g. withdrawing the flag everywhere) still reds.
    expect(served).toBe(!hosted);
    expect(advertised).toBe(!hosted);
    expect(advertised).toBe(served);
    // An absent key, not `false`: absence is the contract's "unsupported".
    expect(
      Object.hasOwn(handshake.capabilities ?? {}, 'sessionInventoryInputRead'),
    ).toBe(!hosted);
  });
});
