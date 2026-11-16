/**
 * Sign-in for engines reached as local commands, mounted under `/acp`.
 *
 * Scopes (pairing-route-scopes.ts): reading the view is `orchestration:read`;
 * re-checking runs the engine's status command and a handshake, so it is
 * `orchestration:operate`; starting, reading or cancelling a sign-in and
 * setting or clearing a key are `engine:login`, the token device-code login
 * already uses (a device needs it granted, the operator in person never
 * does). A terminal sign-in runs a command on the host, so a paired device
 * additionally needs both `coding:exec` and `terminal:operate` to start it,
 * and `terminal:operate` to attach to it.
 * A request that may be an agent's can do none of these.
 *
 * Station-run sign-in, for an engine that delegates its credential to the
 * host (`/connections/:id/host-auth/login`, `/host-auth/sign-out`), is
 * `engine:login` like any other sign-in; its attempt read carries the device
 * code, so it is gated too. Installing a managed engine
 * (`/connections/:id/managed-install`) downloads and lays down code Station
 * will run, so it is `orchestration:operate` and needs explicit consent.
 */

import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import type { HostAuthLoginRequest } from '@kontourai/station-contracts/engine-credential-provider';
import type {
  EngineHostAuthView,
  EngineSignInView,
  ManagedInstallStateView,
} from '@kontourai/station-contracts/engine-sign-in';
import {
  PAIRING_SCOPE_ENGINE_LOGIN,
  PAIRING_SCOPE_ORCHESTRATION_OPERATE,
  PAIRING_SCOPE_TERMINAL_OPERATE,
  pairingScopeIncludes,
} from '@kontourai/station-contracts/environment-security';
import type { ManagedInstallState } from '@kontourai/station-contracts/managed-engine-install';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { RuntimeContext } from '../../runtime/types.js';
import {
  isOperatorInPersonNotAgent,
  mayRunCommandsOnHost,
  requestMayBeAnAgent,
} from '../../security/coding-authority.js';
import { classifyOperatorCredentialPosition } from '../../security/host-operator-credential.js';
import {
  assertEngineAllowedByManagedPolicy,
  engineHostAuthPolicy,
  isManagedEngineRefusal,
  managedEngineRefusalBody,
} from '../../security/managed-engine-limits.js';
import { grantedPairingScope } from '../../security/pairing-route-scopes.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../security/runtime-request-security.js';
import {
  managedRuntimeEntryFor,
  registryAuthFor,
  stationOwnsEngineSignIn,
} from '../../services/acp/acp-engine-descriptors.js';
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
import {
  HOST_AUTH_LOGIN_REFUSAL_TEXT,
  HostAuthLoginRefusedError,
} from '../../services/engine-host-auth/kiro-oidc/kiro-sign-in.js';
import { engineHostAuth } from '../../services/engine-host-auth/service.js';
import {
  ManagedInstallConsentRequiredError,
  managedInstaller,
} from '../../services/engines/managed-install.js';
import { findACPConnection } from './acp.js';

function granted(c: Context): string | undefined {
  return grantedPairingScope(c);
}

/** May start a sign-in or change a key: the operator in person, or a device granted `engine:login`. */
function maySignInEngines(c: Context): boolean {
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
function mayRunTerminalSignIn(c: Context): boolean {
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

/** May install a managed engine: the operator in person, or a device granted `orchestration:operate`. */
function mayInstallEngines(c: Context): boolean {
  const request = c.req.raw;
  if (requestMayBeAnAgent(request)) return false;
  if (isOperatorInPersonNotAgent(request)) return true;
  const scope = granted(c);
  return (
    !!getRuntimeAuthenticatedRequestPrincipal(request) &&
    scope !== undefined &&
    pairingScopeIncludes(scope, PAIRING_SCOPE_ORCHESTRATION_OPERATE)
  );
}

const INSTALL_NOT_GRANTED = {
  success: false as const,
  code: 'engine-install-not-granted' as const,
  error:
    "This device is not allowed to install engines on this Station's computer. Install it there, or ask the Station's operator to allow operating Station from this device.",
};

function installStateView(state: ManagedInstallState): ManagedInstallStateView {
  return state.kind === 'installed'
    ? { kind: 'installed', version: state.version }
    : state;
}

/**
 * Whether this request's browser is on the Station's computer, the only place
 * a social sign-in's loopback callback can reach. The same-machine reading
 * `runtime-http.ts` uses; it can only narrow (a forwarded or tailnet request
 * reads off-host), so a wrong answer costs a sign-in that times out, never
 * access. See `classifyOperatorCredentialPosition` for what it does not prove.
 */
function browserOnHost(c: Context): boolean {
  return classifyOperatorCredentialPosition(c) !== 'off-host';
}

/** The credential scope a connection's Station-run sign-in uses. */
function hostAuthScope(config: ACPConnectionConfig) {
  return { connectionId: config.id, credentialProfileRef: 'default' };
}

function hostAuthView(
  c: Context,
  config: ACPConnectionConfig,
): EngineHostAuthView | undefined {
  const owned = stationOwnsEngineSignIn(config);
  const managed = managedRuntimeEntryFor(config)?.managedRuntime;
  if (!owned && !managed) return undefined;
  const service = engineHostAuth();
  const installer = managedInstaller();
  const definition = managed
    ? installer?.definition(managed.installId)
    : undefined;
  return {
    ...(owned && service
      ? { status: service.status(hostAuthScope(config)) }
      : {}),
    identities: owned
      ? [
          'builder-id',
          'identity-center',
          ...(browserOnHost(c) ? (['social'] as const) : []),
        ]
      : [],
    ...(owned && !browserOnHost(c)
      ? { socialSignIn: 'needs-browser-on-host' as const }
      : {}),
    policy: engineHostAuthPolicy(),
    ...(managed && installer && definition
      ? {
          install: {
            installId: managed.installId,
            version: definition.pin.version,
            state: installStateView(installer.state(managed.installId)),
          },
        }
      : {}),
    allowed: { install: mayInstallEngines(c) },
  };
}

/** Reads a sign-in request body; anything malformed is null. */
async function readHostAuthLoginRequest(
  c: Context,
): Promise<HostAuthLoginRequest | null> {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  const region =
    typeof value.region === 'string' && value.region.length <= 32
      ? value.region.trim()
      : undefined;
  if (value.identity === 'builder-id')
    return { identity: 'builder-id', ...(region ? { region } : {}) };
  if (value.identity === 'social') return { identity: 'social' };
  if (
    value.identity === 'identity-center' &&
    typeof value.startUrl === 'string' &&
    value.startUrl.length <= 512 &&
    region
  )
    return {
      identity: 'identity-center',
      startUrl: value.startUrl,
      region,
    };
  return null;
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
  const hostAuth = hostAuthView(c, config);
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
    ...(hostAuth ? { hostAuth } : {}),
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

/**
 * #4515: the managed refusal for an ACP connection the policy does not let
 * run (ACP engines not allowed, or a public-registry agent under
 * `acpRegistryAgents: false`), or null. Its sign-in reads and setup writes
 * answer with it before the credential store is touched.
 */
function managedRefusal(config: ACPConnectionConfig): Error | null {
  try {
    assertEngineAllowedByManagedPolicy('acp', config);
    return null;
  } catch (error) {
    if (isManagedEngineRefusal(error)) return error as Error;
    throw error;
  }
}

/**
 * After a key is removed for a connection the policy refuses: the view the
 * client parses, built without reading the credential store or running the
 * engine. Nothing is listed and nothing may be started.
 */
function managedView(config: ACPConnectionConfig): EngineSignInView {
  return {
    connectionId: config.id,
    engineName: config.name,
    status: { state: 'unknown', source: 'none', checkable: false },
    credentials: [],
    allowed: { signIn: false, terminal: false },
  };
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
    const refused = managedRefusal(config);
    if (refused) return c.json(managedEngineRefusalBody(refused), 403);
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
    const refused = managedRefusal(config);
    if (refused) return c.json(managedEngineRefusalBody(refused), 403);
    // An engine Station signs in has no sign-in methods of its own to read,
    // and launching it for a handshake would only ask Station for a token.
    if (!stationOwnsEngineSignIn(config)) await service.refreshMethods(config);
    return c.json({
      success: true,
      data: await viewFor(c, service, config, true),
    });
  });

  app.post('/connections/:id/sign-in/start', async (c) => {
    if (!maySignInEngines(c)) return c.json(SIGN_IN_NOT_GRANTED, 403);
    const config = await connection(c);
    if (!config) return notFound(c);
    const refused = managedRefusal(config);
    if (refused) return c.json(managedEngineRefusalBody(refused), 403);
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
    const refused = managedRefusal(config);
    if (refused) return c.json(managedEngineRefusalBody(refused), 403);
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
    // #4515: removal is never refused; the answer reads nothing back.
    if (managedRefusal(config))
      return c.json({ success: true, data: managedView(config) });
    return c.json({
      success: true,
      data: await viewFor(c, service, config, true),
    });
  });

  // --- Station-run sign-in (an engine that delegates its credential) -------

  const hostAuthTarget = async (c: Context) => {
    const config = await connection(c);
    if (!config) return { response: notFound(c) };
    const refused = managedRefusal(config);
    if (refused)
      return { response: c.json(managedEngineRefusalBody(refused), 403) };
    const hostAuth = engineHostAuth();
    if (!stationOwnsEngineSignIn(config) || !hostAuth)
      return {
        response: c.json(
          {
            success: false,
            error: `${config.name} keeps its own sign-in; Station does not sign it in.`,
          },
          409,
        ),
      };
    return { config, hostAuth };
  };

  app.post('/connections/:id/host-auth/login', async (c) => {
    if (!maySignInEngines(c)) return c.json(SIGN_IN_NOT_GRANTED, 403);
    const target = await hostAuthTarget(c);
    if ('response' in target) return target.response;
    const request = await readHostAuthLoginRequest(c);
    if (!request)
      return c.json(
        {
          success: false,
          error:
            'Choose AWS Builder ID, IAM Identity Center with a start URL and region, or Google or GitHub.',
        },
        400,
      );
    // The sign-in page returns to a loopback port here: from a browser
    // elsewhere it could only time out, holding a port meanwhile.
    if (request.identity === 'social' && !browserOnHost(c))
      return c.json(
        {
          success: false,
          code: 'social-sign-in-needs-browser-on-host',
          error: HOST_AUTH_LOGIN_REFUSAL_TEXT['browser-not-on-host'],
        },
        409,
      );
    try {
      return c.json({
        success: true,
        data: await target.hostAuth.startLogin(
          hostAuthScope(target.config),
          request,
        ),
      });
    } catch (error) {
      if (error instanceof HostAuthLoginRefusedError)
        return c.json(
          { success: false, error: HOST_AUTH_LOGIN_REFUSAL_TEXT[error.code] },
          400,
        );
      return failure(c, error);
    }
  });

  app.get('/connections/:id/host-auth/login', async (c) => {
    if (!maySignInEngines(c)) return c.json(SIGN_IN_NOT_GRANTED, 403);
    const target = await hostAuthTarget(c);
    if ('response' in target) return target.response;
    return c.json({
      success: true,
      data: target.hostAuth.login(hostAuthScope(target.config)) ?? null,
    });
  });

  app.delete('/connections/:id/host-auth/login', async (c) => {
    if (!maySignInEngines(c)) return c.json(SIGN_IN_NOT_GRANTED, 403);
    const target = await hostAuthTarget(c);
    if ('response' in target) return target.response;
    return c.json({
      success: true,
      data: target.hostAuth.cancelLogin(hostAuthScope(target.config)) ?? null,
    });
  });

  app.post('/connections/:id/host-auth/sign-out', async (c) => {
    if (!maySignInEngines(c)) return c.json(SIGN_IN_NOT_GRANTED, 403);
    const target = await hostAuthTarget(c);
    if ('response' in target) return target.response;
    try {
      await target.hostAuth.signOut(hostAuthScope(target.config));
    } catch (error) {
      return failure(c, error);
    }
    invalidateEngineStatus(target.config.id);
    return c.json({
      success: true,
      data: await viewFor(c, service, target.config, false),
    });
  });

  // --- Managed install ------------------------------------------------------

  app.post('/connections/:id/managed-install', async (c) => {
    if (!mayInstallEngines(c)) return c.json(INSTALL_NOT_GRANTED, 403);
    const config = await connection(c);
    if (!config) return notFound(c);
    const refused = managedRefusal(config);
    if (refused) return c.json(managedEngineRefusalBody(refused), 403);
    const managed = managedRuntimeEntryFor(config)?.managedRuntime;
    const installer = managedInstaller();
    if (!managed || !installer?.definition(managed.installId))
      return c.json(
        {
          success: false,
          error: `${config.name} is not an engine Station installs.`,
        },
        409,
      );
    const body: unknown = await c.req.json().catch(() => null);
    const consent =
      body && typeof body === 'object' && 'consent' in body
        ? (body as { consent: unknown }).consent
        : undefined;
    try {
      // The literal `true` a person gave, or a refusal before any I/O.
      const { state } = installer.start(managed.installId, {
        consent: consent as true,
      });
      return c.json({ success: true, data: installStateView(state) });
    } catch (error) {
      if (error instanceof ManagedInstallConsentRequiredError)
        return c.json(
          {
            success: false,
            error: 'Installing an engine needs your explicit go-ahead.',
          },
          400,
        );
      return failure(c, error);
    }
  });

  return app;
}
