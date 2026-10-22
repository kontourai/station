/**
 * Sign-in for engines reached as local commands, mounted under `/acp`.
 *
 * Scopes (pairing-route-scopes.ts): reading the view is `orchestration:read`;
 * re-checking runs the engine's status command and a handshake, so it is
 * `orchestration:operate`; starting, reading or cancelling a sign-in and
 * setting or clearing a key are `engine:login`, the token device-code login
 * already uses (a device needs it granted, the operator in person never
 * does). A terminal sign-in runs a command on the host, so a paired device
 * additionally needs `coding:exec`, and `terminal:operate` to attach to it.
 * A request that may be an agent's can do none of these.
 */

import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import type { EngineSignInView } from '@kontourai/station-contracts/engine-sign-in';
import {
  PAIRING_SCOPE_ENGINE_LOGIN,
  PAIRING_SCOPE_TERMINAL_OPERATE,
  pairingScopeIncludes,
} from '@kontourai/station-contracts/environment-security';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { RuntimeContext } from '../../runtime/types.js';
import {
  isOperatorInPersonNotAgent,
  mayRunCommandsOnHost,
  requestMayBeAnAgent,
} from '../../security/coding-authority.js';
import {
  grantedPairingScope,
  type PairingScopeContextStore,
} from '../../security/pairing-route-scopes.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import { registryAuthFor } from '../../services/acp/acp-engine-descriptors.js';
import {
  engineSignInStatus,
  invalidateEngineStatus,
} from '../../services/acp/engine-auth-status.js';
import {
  EngineCredentialRefusedError,
  engineCredentials,
} from '../../services/acp/engine-credentials.js';
import {
  EngineSignInError,
  type EngineSignInService,
} from '../../services/acp/engine-sign-in.js';
import { findACPConnection } from './acp.js';

function granted(c: Context): string | undefined {
  return grantedPairingScope(c as unknown as PairingScopeContextStore);
}

/** May start a sign-in or change a key: the operator in person, or a device granted `engine:login`. */
export function maySignInEngines(c: Context): boolean {
  const request = c.req.raw;
  if (requestMayBeAnAgent(request)) return false;
  if (isOperatorInPersonNotAgent(request)) return true;
  const scope = granted(c);
  return (
    !!getRuntimeAuthenticatedRequestPrincipal(request) &&
    scope !== undefined &&
    pairingScopeIncludes(scope, PAIRING_SCOPE_ENGINE_LOGIN)
  );
}

/** May run an engine's login in a host terminal and attach to it. */
export function mayRunTerminalSignIn(c: Context): boolean {
  if (!maySignInEngines(c)) return false;
  const request = c.req.raw;
  if (isOperatorInPersonNotAgent(request)) return true;
  const scope = granted(c);
  return (
    mayRunCommandsOnHost(request, scope) &&
    scope !== undefined &&
    pairingScopeIncludes(scope, PAIRING_SCOPE_TERMINAL_OPERATE)
  );
}

const SIGN_IN_NOT_GRANTED = {
  success: false as const,
  code: 'engine-login-not-granted' as const,
  error:
    "This device is not allowed to sign engines in. The Station's operator can allow it from this device's access settings.",
};

const TERMINAL_NOT_GRANTED = {
  success: false as const,
  code: 'coding-exec-not-granted' as const,
  error:
    "This device is not allowed to run commands on this Station's computer, so it cannot open the engine's sign-in there. Sign in on that computer, or ask the Station's operator to allow running commands from this device.",
};

async function viewFor(
  c: Context,
  service: EngineSignInService,
  config: ACPConnectionConfig,
  refresh: boolean,
): Promise<EngineSignInView> {
  const auth = registryAuthFor(config)?.auth;
  const names = auth?.credentialEnvVars ?? [];
  const configured = new Set(
    engineCredentials()?.configuredNames(config.id, names) ?? [],
  );
  const methods = service.methodsView(config);
  const termsNotice = service.engineTermsNotice(config);
  const signIn = maySignInEngines(c);
  return {
    connectionId: config.id,
    engineName: config.name,
    status: await engineSignInStatus(config, { refresh }),
    ...(auth?.signInHint ? { signInHint: auth.signInHint } : {}),
    ...(methods.methods ? { methods: methods.methods } : {}),
    ...(methods.observedAt ? { methodsObservedAt: methods.observedAt } : {}),
    ...(methods.error ? { methodsError: methods.error } : {}),
    credentials: names.map((name) => ({
      name,
      configured: configured.has(name),
    })),
    ...(termsNotice ? { termsNotice } : {}),
    allowed: {
      signIn,
      terminal: signIn && service.terminalAvailable && mayRunTerminalSignIn(c),
    },
  };
}

function failure(c: Context, error: unknown) {
  if (error instanceof EngineSignInError)
    return c.json({ success: false, error: error.message }, error.status);
  if (error instanceof EngineCredentialRefusedError)
    return c.json({ success: false, error: error.message }, 400);
  return c.json(
    { success: false, error: 'The sign-in request could not be completed.' },
    500,
  );
}

async function readMethodId(c: Context): Promise<string | null> {
  const body: unknown = await c.req.json().catch(() => null);
  const methodId =
    body && typeof body === 'object' && 'methodId' in body
      ? (body as { methodId: unknown }).methodId
      : undefined;
  return typeof methodId === 'string' &&
    methodId.length > 0 &&
    methodId.length <= 256
    ? methodId
    : null;
}

export function createACPSignInRoutes(input: {
  ctx: Pick<RuntimeContext, 'configLoader'>;
  service: EngineSignInService;
}) {
  const { ctx, service } = input;
  const app = new Hono();

  const connection = async (c: Context) =>
    findACPConnection(ctx.configLoader, c.req.param('id') ?? '');
  const notFound = (c: Context) =>
    c.json({ success: false, error: 'Connection not found' }, 404);

  app.get('/connections/:id/sign-in', async (c) => {
    const config = await connection(c);
    if (!config) return notFound(c);
    return c.json({
      success: true,
      data: await viewFor(c, service, config, false),
    });
  });

  // Runs the status command again and a fresh sign-in handshake.
  app.post('/connections/:id/sign-in/check', async (c) => {
    if (requestMayBeAnAgent(c.req.raw)) return c.json(SIGN_IN_NOT_GRANTED, 403);
    const config = await connection(c);
    if (!config) return notFound(c);
    await service.refreshMethods(config);
    return c.json({
      success: true,
      data: await viewFor(c, service, config, true),
    });
  });

  app.post('/connections/:id/sign-in/start', async (c) => {
    if (!maySignInEngines(c)) return c.json(SIGN_IN_NOT_GRANTED, 403);
    const config = await connection(c);
    if (!config) return notFound(c);
    const methodId = await readMethodId(c);
    if (!methodId)
      return c.json({ success: false, error: 'Choose a way to sign in.' }, 400);
    if (!service.methodsView(config).methods)
      await service.refreshMethods(config);
    const method = service
      .methodsView(config)
      .methods?.find((candidate) => candidate.id === methodId);
    try {
      // Kind is decided again from the live handshake inside the service;
      // this read only picks which gate applies before anything runs.
      if (method?.kind === 'terminal') {
        if (!mayRunTerminalSignIn(c)) return c.json(TERMINAL_NOT_GRANTED, 403);
        return c.json({
          success: true,
          data: await service.startTerminal(config, methodId),
        });
      }
      return c.json({
        success: true,
        data: await service.startAgent(config, methodId),
      });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get('/connections/:id/sign-in/attempt', async (c) => {
    if (!maySignInEngines(c)) return c.json(SIGN_IN_NOT_GRANTED, 403);
    const config = await connection(c);
    if (!config) return notFound(c);
    return c.json({ success: true, data: service.attempt(config.id) });
  });

  app.delete('/connections/:id/sign-in/attempt', async (c) => {
    if (!maySignInEngines(c)) return c.json(SIGN_IN_NOT_GRANTED, 403);
    const config = await connection(c);
    if (!config) return notFound(c);
    service.cancel(config.id);
    return c.json({ success: true, data: service.attempt(config.id) });
  });

  app.put('/connections/:id/credentials/:name', async (c) => {
    if (!maySignInEngines(c)) return c.json(SIGN_IN_NOT_GRANTED, 403);
    const config = await connection(c);
    if (!config) return notFound(c);
    const store = engineCredentials();
    if (!store)
      return c.json(
        { success: false, error: 'Keys cannot be stored here.' },
        503,
      );
    const body: unknown = await c.req.json().catch(() => null);
    const value =
      body && typeof body === 'object' && 'value' in body
        ? (body as { value: unknown }).value
        : undefined;
    if (typeof value !== 'string')
      return c.json({ success: false, error: 'Enter the key.' }, 400);
    try {
      await store.set(
        config.id,
        c.req.param('name'),
        value,
        registryAuthFor(config)?.auth.credentialEnvVars ?? [],
      );
    } catch (error) {
      return failure(c, error);
    }
    invalidateEngineStatus(config.id);
    return c.json({
      success: true,
      data: await viewFor(c, service, config, true),
    });
  });

  app.delete('/connections/:id/credentials/:name', async (c) => {
    if (!maySignInEngines(c)) return c.json(SIGN_IN_NOT_GRANTED, 403);
    const config = await connection(c);
    if (!config) return notFound(c);
    try {
      await engineCredentials()?.remove(config.id, c.req.param('name'));
      invalidateEngineStatus(config.id);
    } catch (error) {
      return failure(c, error);
    }
    return c.json({
      success: true,
      data: await viewFor(c, service, config, true),
    });
  });

  return app;
}
