/**
 * kontourai/station#1419: `personOnly()` on plugin command-effect admission
 * and on the operator resolve/abandon routes.
 *
 * `operatorOnly()` alone checks the caller's principal id, and Station's own
 * internal caller class (station-control, Station's agent adapter) resolves
 * to the SAME local-operator principal id a real person's operator
 * credential does (`principal-resolver.ts`'s home-possession mint) — so
 * `operatorOnly()` alone would let it through. This drives requests through
 * the REAL auth boundary (`configureRuntimeHttp`), the way
 * `plugin-person-approval.routes.test.ts` does for install/update/remove,
 * so "internal" here is the principal that boundary actually binds for
 * station-control's headers, not a caller the test hands the route.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { afterEach, describe, expect, test } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import {
  LOCAL_OPERATOR_PRINCIPAL_ID,
  PrincipalUnresolvedError,
} from '../../../services/identity/principal-resolver.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import { createPluginRoutes } from '../plugins.js';
import { PLUGIN_PERSON_APPROVAL_REQUIRED } from '../plugin-person-approval.js';
import { TEST_OPERATOR_PRINCIPAL } from './plugin-visibility-test-support.js';

const OPERATOR = 'operator-credential-for-command-effects';

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return this;
  },
  setLevel() {},
  getLevel() {
    return 'info' as const;
  },
} as never;

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

/** Read off the real bound principal, the same shape production resolves. */
function principalFor(request: Request) {
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  if (
    principal?.kind === 'internal' ||
    principal?.authority === 'operator-credential'
  )
    return TEST_OPERATOR_PRINCIPAL;
  throw new PrincipalUnresolvedError('no principal');
}

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(
    cleanup.splice(0, cleanup.length).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'station-command-effect-person-'));
  cleanup.push(root);
  const home = join(root, 'home');
  const pluginsDir = join(home, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });

  const app = new Hono<{ Bindings: TestBindings }>();
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit() {} } as never,
    security: {
      verifyCredential: (candidate: string) => candidate === OPERATOR,
      resolveGrantedScope: (candidate: string) =>
        candidate === OPERATOR ? DEFAULT_GRANT_PAIRING_SCOPE : undefined,
      resolveCredentialAuthority: (candidate: string) =>
        candidate === OPERATOR ? 'operator-credential' : undefined,
      resolveCredentialDeviceId: () => undefined,
      resolveCredentialDeviceKind: () => undefined,
      allowedOrigins: [],
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);

  const plugins = createPluginRoutes(home, logger, undefined, {
    visibility: {
      service: { canSee: () => true } as never,
      resolvePrincipal: (c) => principalFor(c.req.raw),
      listKnownPrincipals: () => [],
    },
    applyConfigurationMutation: undefined as never,
    settleProviderAdapterRetirements: async () => {},
    commandEffects: {
      isHostedDeployment: () => false,
      publishAudit: () => true,
      resolveRequirement: async () => 'unavailable',
    },
  });
  app.route('/api/plugins', plugins);

  const request = (
    caller: 'internal' | 'person',
    method: string,
    path: string,
    body?: unknown,
  ) =>
    app.request(
      path,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(caller === 'internal'
            ? {
                [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
                [INTERNAL_PROXY_CALLER_HEADER]: 'local',
              }
            : { Authorization: `Bearer ${OPERATOR}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as TestBindings,
    );

  return { request, pluginsDir };
}

describe('#1419: plugin command-effect routes refuse Station’s agent caller', () => {
  test('POST /:name/command-effects: refused for the internal caller before admission runs; a person reaches it', async () => {
    const { request, pluginsDir } = harness();
    mkdirSync(join(pluginsDir, 'demo'), { recursive: true });
    writeFileSync(
      join(pluginsDir, 'demo', 'plugin.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0' }),
    );
    const body = {
      documentId: 'doc-1',
      documentKey: 'd'.repeat(43),
      requestId: 'req-1',
      installationGeneration: 'gen-1',
      commandId: 'demo.open',
      target: { kind: 'destination', destinationId: 'plugins' },
      issuedAt: Date.now(),
    };

    const refused = await request(
      'internal',
      'POST',
      '/api/plugins/demo/command-effects',
      body,
    );
    expect(refused.status).toBe(403);
    expect((await readJson(refused)).code).toBe(PLUGIN_PERSON_APPROVAL_REQUIRED);

    const reached = await request(
      'person',
      'POST',
      '/api/plugins/demo/command-effects',
      body,
    );
    // Admission itself may still refuse (generation/command mismatch); the
    // point is that a person is not stopped at the person-approval gate.
    expect(reached.status).not.toBe(403);
  });

  test('POST /command-effects/withdrawals/:id/resolve: refused for the internal caller; a person reaches the operator handler', async () => {
    const { request } = harness();

    const refused = await request(
      'internal',
      'POST',
      '/api/plugins/command-effects/withdrawals/missing/resolve',
      { disposition: 'accept-indeterminate' },
    );
    expect(refused.status).toBe(403);
    expect((await readJson(refused)).code).toBe(PLUGIN_PERSON_APPROVAL_REQUIRED);

    const reached = await request(
      'person',
      'POST',
      '/api/plugins/command-effects/withdrawals/missing/resolve',
      { disposition: 'accept-indeterminate' },
    );
    expect(reached.status).not.toBe(403);
  });

  test('POST /command-effects/effects/:effectId/abandon: refused for the internal caller; a person reaches the operator handler', async () => {
    const { request } = harness();

    const refused = await request(
      'internal',
      'POST',
      '/api/plugins/command-effects/effects/missing/abandon',
    );
    expect(refused.status).toBe(403);
    expect((await readJson(refused)).code).toBe(PLUGIN_PERSON_APPROVAL_REQUIRED);

    const reached = await request(
      'person',
      'POST',
      '/api/plugins/command-effects/effects/missing/abandon',
    );
    expect(reached.status).not.toBe(403);
  });
});
