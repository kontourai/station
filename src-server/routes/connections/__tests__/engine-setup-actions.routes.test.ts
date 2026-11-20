import { randomUUID } from 'node:crypto';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { NodePtyAdapter } from '../../../adapters/node-pty-adapter.js';
import {
  loadOrCreateAgentRegistry,
  materializeEngineAgent,
  registerEngineConnection,
} from '../../../domain/agent-registry.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import {
  clearAll,
  registerACPConnectionRegistryProvider,
} from '../../../providers/registries/registry.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { bindStationControlRequestAuthority } from '../../../security/station-control-request-authority.js';
import { InProcessShellHost } from '../../../services/terminal/shell-host.js';
import { TerminalSessions } from '../../../services/terminal/terminal-sessions.js';
import { createEngineSetupActionsRoutes } from '../engine-setup-actions.js';

const temp = trackTempDirs();
const command =
  process.platform === 'win32'
    ? 'Write-Output engine-installed'
    : "printf 'engine-installed\\n'";
let installCommand = command;
let sessions: TerminalSessions<Request>;
let configLoader: ConfigLoader;
let enabled = true;
let current = true;
let http = true;
let changed = vi.fn();
let home: string;
function createSessions() {
  return new TerminalSessions<Request>(
    home,
    new InProcessShellHost(new NodePtyAdapter(), () =>
      process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    ),
    {
      authorize: () => current,
      resolveRoot: async () => home,
      legacyProjectSlug: async () => '.engine-install',
    },
  );
}
function app(agent = false) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
      kind: 'credential',
      credential: 'fixture-owner',
      authority: 'operator-credential',
      source: 'bearer',
    });
    if (agent)
      bindStationControlRequestAuthority(c.req.raw, {
        kind: 'caller',
        boundOperator: true,
        caller: { sessionId: 'fixture', assurance: 'bound' },
      });
    await next();
  });
  app.route(
    '/',
    createEngineSetupActionsRoutes({
      configLoader,
      preview: {
        select: (branches) =>
          enabled ? branches.enabled() : branches.disabled(),
      },
      personalHost: true,
      terminals: () => sessions,
      current: () => current,
      changed,
      advertisedHttp: () => http,
      reconnect: async () => true,
    }),
  );
  return app;
}
function start(app: Hono, operationId: string, installer = command) {
  return app.request('/registry/fixture-engine/install-terminal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command: installer, operationId }),
  });
}
beforeEach(async () => {
  home = temp('engine-setup-actions-');
  configLoader = new ConfigLoader({ projectHomeDir: home });
  await loadOrCreateAgentRegistry(configLoader);
  installCommand = command;
  enabled = true;
  current = true;
  http = true;
  changed = vi.fn();
  registerACPConnectionRegistryProvider(
    {
      listAvailable: () => [
        {
          id: 'fixture-engine',
          name: 'Fixture engine',
          command: 'fixture-engine',
          args: ['acp', '--process-per-session'],
          install: {
            [process.platform]: {
              command: installCommand,
              docsUrl: 'https://example.test/install',
            },
          },
        },
      ],
    },
    'fixture-builtin',
    true,
  );
  sessions = createSessions();
});
afterEach(async () => {
  await sessions.dispose();
  clearAll();
});

describe('person-owned engine setup actions', () => {
  test('a reviewed installer runs in a durable terminal and response-loss retries never launch it twice', async () => {
    const router = app();
    const open = vi.spyOn(sessions, 'openInternal');
    const operationId = randomUUID();
    const [a, b] = await Promise.all([
      start(router, operationId),
      start(router, operationId),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const first = (await json(a)).data.terminal;
    expect((await json(b)).data.terminal.terminalId).toBe(first.terminalId);
    expect(open).toHaveBeenCalledTimes(1);
    await expect
      .poll(
        async () =>
          (
            await json(
              await router.request('/registry/fixture-engine/install-terminal'),
            )
          ).data.terminal.status,
      )
      .toBe('exited');
    const done = (
      await json(
        await router.request('/registry/fixture-engine/install-terminal'),
      )
    ).data.terminal;
    expect(done.exitCode).toBe(0);
    const output = await sessions.readInternal(
      { projectId: first.projectId, bindingKey: first.bindingKey },
      first.terminalId,
      0,
    );
    expect(
      output.journal.records.map((record) => record.data).join(''),
    ).toContain('engine-installed');
    await sessions.dispose();
    sessions = createSessions();
    const recoveredOpen = vi.spyOn(sessions, 'openInternal');
    expect(
      (await json(await start(router, operationId))).data.terminal.terminalId,
    ).toBe(first.terminalId);
    expect(recoveredOpen).not.toHaveBeenCalled();
  });

  test('turning the preview off retains observation and Stop for an existing installer', async () => {
    installCommand =
      process.platform === 'win32' ? 'Start-Sleep -Seconds 60' : 'sleep 60';
    const router = app();
    const launched = await json(
      await start(router, randomUUID(), installCommand),
    );
    const target = {
      terminalId: launched.data.terminal.terminalId,
      operationId: launched.data.terminal.operationId,
    };
    enabled = false;
    const retained = await json(
      await router.request('/registry/fixture-engine/install-terminal'),
    );
    expect(retained.data).toMatchObject({
      allowed: false,
      canStop: true,
      terminal: { status: 'running' },
    });
    expect((await start(router, randomUUID(), installCommand)).status).toBe(
      404,
    );
    expect(
      (
        await router.request('/registry/fixture-engine/install-terminal', {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(target),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await json(
          await router.request('/registry/fixture-engine/install-terminal'),
        )
      ).data.terminal.status,
    ).toBe('exited');
  });

  test('a delayed Stop for an ended installer cannot stop its successor', async () => {
    const router = app();
    const first = (await json(await start(router, randomUUID()))).data.terminal;
    await expect
      .poll(
        async () =>
          (
            await json(
              await router.request('/registry/fixture-engine/install-terminal'),
            )
          ).data.terminal.status,
      )
      .toBe('exited');
    installCommand =
      process.platform === 'win32' ? 'Start-Sleep -Seconds 60' : 'sleep 60';
    const second = (
      await json(await start(router, randomUUID(), installCommand))
    ).data.terminal;
    const stop = (terminal: { terminalId: string; operationId: string }) =>
      router.request('/registry/fixture-engine/install-terminal', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          terminalId: terminal.terminalId,
          operationId: terminal.operationId,
        }),
      });
    expect((await stop(first)).status).toBe(200);
    expect(
      (
        await json(
          await router.request('/registry/fixture-engine/install-terminal'),
        )
      ).data.terminal,
    ).toMatchObject({ terminalId: second.terminalId, status: 'running' });
    expect((await stop(second)).status).toBe(200);
  });

  test('preview-off, agent, changed command and withdrawn authority refuse before launch', async () => {
    const open = vi.spyOn(sessions, 'openInternal');
    enabled = false;
    expect((await start(app(), randomUUID())).status).toBe(404);
    enabled = true;
    expect((await start(app(true), randomUUID())).status).toBe(403);
    expect((await start(app(), randomUUID(), 'different command')).status).toBe(
      409,
    );
    current = false;
    expect((await start(app(), randomUUID())).status).toBe(403);
    expect(open).not.toHaveBeenCalled();
  });

  test('recommended setup repairs arguments in place and refuses an unreviewed command', async () => {
    const saved = {
      id: 'legacy-name',
      name: 'My engine',
      command: '/usr/local/bin/fixture-engine',
      args: ['acp'],
      enabled: true,
    };
    await configLoader.saveACPConfig({ connections: [saved] });
    http = false;
    const router = app();
    const view = await json(
      await router.request('/connections/legacy-name/station-tools'),
    );
    expect(view.data.recommended).toMatchObject({
      id: 'fixture-engine',
      args: ['acp', '--process-per-session'],
    });
    const { name: _name, ...launch } = view.data.recommended;
    const denied = await router.request(
      '/connections/legacy-name/recommended-setup',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...launch, args: ['unreviewed'] }),
      },
    );
    expect(denied.status).toBe(409);
    expect((await configLoader.loadACPConfig()).connections).toEqual([saved]);
    const repaired = await router.request(
      '/connections/legacy-name/recommended-setup',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(launch),
      },
    );
    expect(repaired.status).toBe(200);
    expect((await configLoader.loadACPConfig()).connections).toEqual([
      { ...saved, args: ['acp', '--process-per-session'] },
    ]);
  });

  test('Station tools require a proved HTTP channel and preserve authored settings and tool restrictions', async () => {
    const saved = {
      id: 'fixture-engine',
      name: 'Fixture engine',
      command: 'fixture-engine',
      enabled: true,
    };
    await configLoader.saveACPConfig({ connections: [saved] });
    await registerEngineConnection(configLoader, engineConnectionId(saved.id), {
      kind: 'user-acp',
    });
    const agent = await materializeEngineAgent(
      configLoader,
      saved.id,
      saved.name,
    );
    await configLoader.mutateAgent(agent.slug, (value) => ({
      ...value,
      prompt: 'Keep this prompt',
      tools: {
        mcpServers: ['own-tools'],
        askBeforeUse: ['station-control_*'],
        available: ['own-tools_*'],
      },
    }));
    http = false;
    expect(
      (
        await app().request('/connections/fixture-engine/station-tools', {
          method: 'POST',
        })
      ).status,
    ).toBe(409);
    http = true;
    expect(
      (
        await app(true).request('/connections/fixture-engine/station-tools', {
          method: 'POST',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app().request('/connections/fixture-engine/station-tools', {
          method: 'POST',
        })
      ).status,
    ).toBe(200);
    const result = await configLoader.loadAgent(agent.slug);
    expect(result.prompt).toBe('Keep this prompt');
    expect(result.tools).toMatchObject({
      mcpServers: [
        'own-tools',
        'station-control',
        'station-knowledge',
        'station-docs',
      ],
      askBeforeUse: ['station-control_*'],
      available: ['own-tools_*'],
    });
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
