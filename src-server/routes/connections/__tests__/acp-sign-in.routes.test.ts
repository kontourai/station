/**
 * Engine sign-in routes behind the real runtime auth boundary: the Station's
 * own security service pairs devices and stores grants, the pairing route
 * table and the handlers decide. The engine is the fake ACP agent behind a
 * program named `pi-acp` (a terminal sign-in) or `droid` (an authenticate
 * sign-in and an API key), so the built-in descriptors apply.
 */
import {
  chmodSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import {
  PAIRING_SCOPE_CODING_EXEC,
  PAIRING_SCOPE_ENGINE_LOGIN,
  PAIRING_SCOPE_PRESETS,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { TerminalOpenInput } from '../../../domain/terminal-types.js';
import { BUILTIN_ACP_ENGINES } from '../../../providers/llm/builtin-acp-engines.js';
import {
  clearAll,
  registerACPConnectionRegistryProvider,
} from '../../../providers/registries/registry.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import {
  engineSignInStatus,
  resetEngineAuthStatus,
  setEngineStatusTestHooks,
} from '../../../services/acp/engine-auth-status.js';
import {
  EngineCredentials,
  registerEngineCredentials,
} from '../../../services/acp/engine-credentials.js';
import { EngineSignInService } from '../../../services/acp/engine-sign-in.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import {
  STATION_CONTROL_ORIGIN_AGENT_TOOL,
  STATION_CONTROL_ORIGIN_HEADER,
} from '../../../tools/station-control-shared.js';
import { createLogger, installLoggerLineSink } from '../../../utils/logger.js';
import { createACPSignInRoutes } from '../acp-sign-in.js';

const FAKE_AGENT = fileURLToPath(
  new URL(
    '../../../providers/__tests__/fixtures/fake-acp-agent.mjs',
    import.meta.url,
  ),
);
const PROFILES = fileURLToPath(
  new URL(
    '../../../providers/__tests__/fixtures/acp-engine-profiles/',
    import.meta.url,
  ),
);
const SECRET = 'fixture-value';
const posix = process.platform !== 'win32';
const makeTempDir = trackTempDirs();

beforeEach(() => {
  registerACPConnectionRegistryProvider(
    { listAvailable: () => BUILTIN_ACP_ENGINES.map((entry) => ({ ...entry })) },
    'builtin-acp-connections',
    true,
  );
});
afterEach(() => {
  clearAll();
  resetEngineAuthStatus();
  setEngineStatusTestHooks({});
  registerEngineCredentials(null);
  installLoggerLineSink(undefined);
  vi.unstubAllEnvs();
});

function engineProgram(program: string, profile: string): string {
  const dir = makeTempDir('station-sign-in-route-engine-');
  const command = join(dir, program);
  const quoted = [
    process.execPath,
    FAKE_AGENT,
    '--engine-profile',
    join(PROFILES, profile),
  ]
    .map((part) => `'${part}'`)
    .join(' ');
  writeFileSync(command, `#!/bin/sh\nexec ${quoted} "$@"\n`);
  chmodSync(command, 0o755);
  return command;
}

async function fixture(extraConnections: ACPConnectionConfig[] = []) {
  vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', undefined);
  const root = makeTempDir('station-sign-in-routes-');
  const security = new EnvironmentSecurityService({
    homeDir: join(root, 'security-home'),
  });
  const operator = await security.initialize();
  const pair = (name: string) => {
    const offer = security.devicePairing.createOffer({
      endpoint: 'https://station.example.test',
      scope: pairingScopePresetString('standard'),
    });
    const requested = security.devicePairing.requestPairing({
      requesterPosition: 'off-box',
      offerId: offer.offerId,
      proof: offer.challenge,
      deviceName: name,
    });
    security.devicePairing.confirmRequest(requested.requestId, {
      kind: 'presented-credential',
    });
    return security.devicePairing.exchange({
      offerId: offer.offerId,
      proof: offer.challenge,
      requestId: requested.requestId,
    });
  };
  const grant = (
    deviceId: string,
    extra: Array<
      typeof PAIRING_SCOPE_ENGINE_LOGIN | typeof PAIRING_SCOPE_CODING_EXEC
    >,
  ) =>
    security.devicePairing.setDeviceScope(
      deviceId,
      [...PAIRING_SCOPE_PRESETS.standard, ...extra],
      { kind: 'presented-credential' },
    );

  const home = join(root, 'home');
  registerEngineCredentials(new EngineCredentials(home));
  const connections: ACPConnectionConfig[] = [
    {
      id: 'pi',
      name: 'pi',
      command: engineProgram('pi-acp', 'pi-acp.json'),
      enabled: true,
    },
    {
      id: 'droid',
      name: 'Droid',
      command: engineProgram('droid', 'factory-droid.json'),
      enabled: true,
    },
    ...extraConnections,
  ];
  const acpJson = JSON.stringify({ connections });
  const opened: TerminalOpenInput[] = [];
  const service = new EngineSignInService({
    terminal: {
      open: async (input) => {
        opened.push(input);
        return { sessionId: `${input.projectSlug}:${input.terminalId}` };
      },
      close: async () => undefined,
      subscribe: () => () => undefined,
    },
  });

  const app = new Hono();
  configureRuntimeHttp({
    app: app as never,
    logger: createLogger({ name: 'acp-sign-in-routes-test', level: 'error' }),
    eventBus: { emit() {} } as unknown as EventBus,
    security: {
      verifyCredential: (candidate, request) =>
        request !== undefined &&
        security.authorizeCredential(candidate, request),
      recognizeCredential: (candidate) => security.verifyCredential(candidate),
      resolveGrantedScope: (candidate) =>
        security.resolveGrantedScope(candidate),
      resolveCredentialAuthority: (candidate) =>
        security.verifyOperatorCredential(candidate)
          ? 'operator-credential'
          : security.identifyDevice(candidate)
            ? 'device-credential'
            : undefined,
      resolveCredentialDeviceId: (candidate) =>
        security.identifyDevice(candidate)?.id,
      resolveCredentialLocality: (candidate) =>
        security.credentialLocality(candidate),
      resolveCredentialMintKind: (candidate) =>
        security.credentialMintKind(candidate),
      allowedOrigins: [],
    },
  });
  app.route(
    '/acp',
    createACPSignInRoutes({
      ctx: {
        configLoader: {
          loadACPConfig: async () => JSON.parse(acpJson),
        } as never,
      },
      service,
    }),
  );

  const call = async (
    credential: string,
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ) => {
    const res = await app.request(`/acp/connections/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
  };
  return { operator, pair, grant, call, opened, home, acpJson };
}

describe.runIf(posix)('engine sign-in route authority', () => {
  test('a standard paired device reads the view but cannot sign in or store a key', async () => {
    const f = await fixture();
    const phone = f.pair('Phone');
    const view = await f.call(phone.credential, 'GET', 'pi/sign-in');
    expect(view.status).toBe(200);
    expect(view.body.data.allowed).toEqual({ signIn: false, terminal: false });

    const start = await f.call(phone.credential, 'POST', 'pi/sign-in/start', {
      methodId: 'pi_terminal_login',
    });
    expect(start.status).toBe(403);
    // An engine-run sign-in needs no terminal grant, so only engine:login
    // stands between this device and it: nothing may have started.
    const agent = await f.call(
      phone.credential,
      'POST',
      'droid/sign-in/start',
      { methodId: 'device-pairing' },
    );
    expect(agent.status).toBe(403);
    const attempt = await f.call(
      f.operator.credential,
      'GET',
      'droid/sign-in/attempt',
    );
    expect(attempt.body.data).toBeNull();
    const key = await f.call(
      phone.credential,
      'PUT',
      'droid/credentials/FACTORY_API_KEY',
      { value: SECRET },
    );
    expect(key.status).toBe(403);
    expect(f.opened).toEqual([]);
  });

  test('engine:login alone starts an engine sign-in but not a terminal one', async () => {
    const f = await fixture();
    const phone = f.pair('Phone');
    f.grant(phone.device.id, [PAIRING_SCOPE_ENGINE_LOGIN]);

    const check = await f.call(phone.credential, 'POST', 'pi/sign-in/check');
    expect(check.body.data.allowed).toEqual({ signIn: true, terminal: false });
    const terminal = await f.call(
      phone.credential,
      'POST',
      'pi/sign-in/start',
      { methodId: 'pi_terminal_login' },
    );
    expect(terminal.status).toBe(403);
    expect(terminal.body.code).toBe('coding-exec-not-granted');
    expect(f.opened).toEqual([]);

    const agent = await f.call(
      phone.credential,
      'POST',
      'droid/sign-in/start',
      { methodId: 'device-pairing' },
    );
    expect(agent.status).toBe(200);
    expect(agent.body.data).toMatchObject({ kind: 'agent' });
  });

  test("with coding:exec too, a terminal sign-in runs the handshake args, never the client's", async () => {
    const f = await fixture();
    const phone = f.pair('Phone');
    f.grant(phone.device.id, [
      PAIRING_SCOPE_ENGINE_LOGIN,
      PAIRING_SCOPE_CODING_EXEC,
    ]);
    const res = await f.call(phone.credential, 'POST', 'pi/sign-in/start', {
      methodId: 'pi_terminal_login',
      // Ignored: only the method id is read from the client.
      args: ['--evil'],
      shellArgs: ['--evil'],
    });
    expect(res.status).toBe(200);
    expect(f.opened).toHaveLength(1);
    expect(f.opened[0].shellArgs).toEqual(['--terminal-login']);
  });

  test("a request that may be an agent's is refused, even on the operator's credential", async () => {
    const f = await fixture();
    const res = await f.call(
      f.operator.credential,
      'POST',
      'droid/sign-in/start',
      { methodId: 'device-pairing' },
      { [STATION_CONTROL_ORIGIN_HEADER]: STATION_CONTROL_ORIGIN_AGENT_TOOL },
    );
    expect(res.status).toBe(403);
    const attempt = await f.call(
      f.operator.credential,
      'GET',
      'droid/sign-in/attempt',
    );
    expect(attempt.body.data).toBeNull();
  });

  test('the operator in person needs no grant', async () => {
    const f = await fixture();
    const res = await f.call(f.operator.credential, 'GET', 'pi/sign-in');
    expect(res.body.data.allowed).toEqual({ signIn: true, terminal: true });
  });
});

describe.runIf(posix)('an engine key', () => {
  test.each(['PUT', 'DELETE'] as const)(
    '%s retires status work launched with the previous key environment',
    async (method) => {
      const config = {
        id: 'cursor',
        name: 'Cursor',
        command: engineProgram('cursor-agent', 'cursor.json'),
        enabled: true,
      };
      const f = await fixture([config]);
      vi.stubEnv('CURSOR_API_KEY', '');
      if (method === 'DELETE')
        await new EngineCredentials(f.home).set(
          config.id,
          'CURSOR_API_KEY',
          SECRET,
          ['CURSOR_API_KEY'],
        );
      const envs: Array<Record<string, string> | undefined> = [];
      let releaseOld!: () => void;
      const old = new Promise<{ stdout: string; stderr: string; code: number }>(
        (resolve) => {
          releaseOld = () =>
            resolve({
              stdout: JSON.stringify({ isAuthenticated: method === 'DELETE' }),
              stderr: '',
              code: 0,
            });
        },
      );
      setEngineStatusTestHooks({
        runner: async (_command, _args, env) => {
          envs.push(env);
          if (envs.length === 1) return old;
          return {
            stdout: JSON.stringify({ isAuthenticated: method === 'PUT' }),
            stderr: '',
            code: 0,
          };
        },
      });
      const previous = engineSignInStatus(config);
      await expect.poll(() => envs.length).toBe(1);
      const changed = f.call(
        f.operator.credential,
        method,
        'cursor/credentials/CURSOR_API_KEY',
        method === 'PUT' ? { value: SECRET } : undefined,
      );
      try {
        await expect.poll(() => envs.length).toBe(2);
        expect(envs[0]?.CURSOR_API_KEY).toBe(
          method === 'DELETE' ? SECRET : undefined,
        );
        expect(envs[1]?.CURSOR_API_KEY).toBe(
          method === 'PUT' ? SECRET : undefined,
        );
        const response = await changed;
        expect(response.status).toBe(200);
        const expected = method === 'PUT' ? 'authenticated' : 'unauthenticated';
        expect(response.body.data.status.state).toBe(expected);
        releaseOld();
        expect((await previous).state).toBe('unknown');
        const view = await f.call(
          f.operator.credential,
          'GET',
          'cursor/sign-in',
        );
        expect(view.body.data.status.state).toBe(expected);
        expect(envs).toHaveLength(2);
      } finally {
        releaseOld();
        await Promise.all([previous, changed]);
      }
    },
  );

  test('is stored only in the engine credential store and never served or logged', async () => {
    const f = await fixture();
    const lines: string[] = [];
    installLoggerLineSink({ writeLine: (line) => lines.push(line) });

    const saved = await f.call(
      f.operator.credential,
      'PUT',
      'droid/credentials/FACTORY_API_KEY',
      { value: SECRET },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.data.credentials).toEqual([
      { name: 'FACTORY_API_KEY', configured: true },
    ]);
    const view = await f.call(f.operator.credential, 'GET', 'droid/sign-in');
    for (const text of [saved.text, view.text])
      expect(text).not.toContain(SECRET);

    const file = join(f.home, 'security', 'engine-credentials.json');
    expect(readFileSync(file, 'utf8')).toContain(SECRET);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Nowhere else under the home, and not in the connection config.
    const elsewhere = readdirSync(f.home, { recursive: true })
      .map(String)
      .filter((name) => !name.startsWith('security'));
    for (const name of elsewhere) {
      const path = join(f.home, name);
      if (statSync(path).isFile())
        expect(readFileSync(path, 'utf8')).not.toContain(SECRET);
    }
    expect(f.acpJson).not.toContain(SECRET);
    expect(lines.join('\n')).not.toContain(SECRET);

    const cleared = await f.call(
      f.operator.credential,
      'DELETE',
      'droid/credentials/FACTORY_API_KEY',
    );
    expect(cleared.body.data.credentials).toEqual([
      { name: 'FACTORY_API_KEY', configured: false },
    ]);
    expect(readFileSync(file, 'utf8')).not.toContain(SECRET);
  });

  test('a variable the engine does not take is refused', async () => {
    const f = await fixture();
    const res = await f.call(
      f.operator.credential,
      'PUT',
      'droid/credentials/PATH',
      { value: '/tmp/evil' },
    );
    expect(res.status).toBe(400);
    const pi = await f.call(
      f.operator.credential,
      'PUT',
      'pi/credentials/FACTORY_API_KEY',
      { value: SECRET },
    );
    expect(pi.status).toBe(400);
  });
});
