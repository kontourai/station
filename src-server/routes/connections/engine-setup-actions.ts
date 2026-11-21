import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { installRecipeForPlatform } from '@kontourai/station-contracts/acp';
import { BUILTIN_STATION_AGENT_MCP_SERVER_IDS } from '@kontourai/station-contracts/agent';
import { terminalScopeAllows } from '@kontourai/station-contracts/terminal-transport';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { findEngineAgent } from '../../domain/agent-registry.js';
import type { ConfigLoader } from '../../domain/config-loader.js';
import {
  findCliBinaryAsync,
  resolveAugmentedPath,
} from '../../providers/auth/cli-auth.js';
import type { RuntimeContext } from '../../runtime/types.js';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import {
  isOperatorInPersonNotAgent,
  mayRunCommandsOnHost,
} from '../../security/coding-authority.js';
import {
  assertEngineAllowedByManagedPolicy,
  managedEngineRefusalBody,
} from '../../security/managed-engine-limits.js';
import { grantedPairingScope } from '../../security/pairing-route-scopes.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import {
  listValidatedACPRegistryEntries,
  namesSameExecutable,
} from '../../services/acp/acp-engine-descriptors.js';
import type { FeaturePreviewSelector } from '../../services/feature-previews/feature-preview-registry.js';
import type { TerminalSessions } from '../../services/terminal/terminal-sessions.js';
import { createKeyedSerialQueue } from '../../utils/keyed-serial-queue.js';
import {
  captureConfigurationMutation,
  configurationMutationResponse,
} from '../system/configuration-activation.js';

const installRequest = z
  .object({
    command: z.string().min(1).max(8192),
    operationId: z.string().uuid(),
  })
  .strict();
const installScope = (id: string) => ({
  projectId: '.engine-install',
  bindingKey: `install:${id}`,
});

async function setupBody(request: Request): Promise<unknown> {
  const read = await readBoundedRequestBody(request, 16 * 1024);
  if (read.status !== 'ok') return null;
  try {
    return JSON.parse(read.body);
  } catch {
    return null;
  }
}

export function createEngineSetupActionsRoutes(deps: {
  configLoader: ConfigLoader;
  preview: FeaturePreviewSelector;
  personalHost: boolean;
  terminals: () => TerminalSessions<Request> | undefined;
  current: (request: Request) => boolean;
  changed: () => void;
  apply?: RuntimeContext['applyAgentConfigurationMutation'];
  advertisedHttp: (id: string) => boolean;
  reconnect: (
    config: Awaited<
      ReturnType<ConfigLoader['loadACPConfig']>
    >['connections'][number],
  ) => Promise<boolean>;
}) {
  const app = new Hono();
  const queue = createKeyedSerialQueue();
  function guard(c: Context, maintenance = false) {
    if (!deps.personalHost)
      return c.json(
        {
          success: false,
          error: 'Engine setup is available on personal Stations.',
        },
        404,
      );
    if (
      !maintenance &&
      !deps.preview.select({ enabled: () => true, disabled: () => false })
    )
      return c.json(
        {
          success: false,
          code: 'feature_preview_disabled',
          previewId: 'guided-engine-setup',
          settingsPath:
            '/settings?view=feature-previews&highlight=feature-previews',
          error:
            'Enable Guided engine setup in Settings → Advanced → Feature previews.',
        },
        404,
      );
    if (
      !deps.current(c.req.raw) ||
      stationControlRequestAuthority(c.req.raw)?.kind === 'caller' ||
      !isOperatorInPersonNotAgent(c.req.raw)
    )
      return c.json(
        {
          success: false,
          error: 'Complete this step from the Station owner’s device.',
        },
        403,
      );
  }
  function mayInstall(c: Context) {
    const scope = grantedPairingScope(c);
    return (
      mayRunCommandsOnHost(c.req.raw, scope) &&
      (scope === undefined || terminalScopeAllows(scope, 'operate'))
    );
  }
  function recipe(id: string) {
    const entry = listValidatedACPRegistryEntries({ detect: false }).find(
      (item) => item.builtin && item.entry.id === id,
    )?.entry;
    const install = installRecipeForPlatform(entry?.install, process.platform);
    return entry && install ? { entry, install } : null;
  }
  function terminalView(
    record:
      | Awaited<ReturnType<TerminalSessions<Request>['list']>>[number]
      | undefined,
  ) {
    return record
      ? {
          projectSlug: '.engine-install',
          projectId: record.projectId,
          bindingKey: record.bindingKey,
          terminalId: record.terminalId,
          operationId: record.operationId,
          status: record.status,
          exitCode: record.exitCode ?? null,
        }
      : null;
  }
  const path = '/registry/:id/install-terminal';
  app.get(path, async (c) => {
    const refused = guard(c, true);
    if (refused) return refused;
    const found = recipe(c.req.param('id'));
    if (!found)
      return c.json(
        {
          success: false,
          error: 'No supported installer is available for this engine.',
        },
        404,
      );
    const terminals = deps.terminals();
    const watching = mayInstall(c) && !!terminals;
    const offered = deps.preview.select({
      enabled: () => true,
      disabled: () => false,
    });
    const allowed = watching && offered;
    const records = watching
      ? await terminals!.list(c.req.raw, installScope(found.entry.command))
      : [];
    if (!offered && records.length === 0) return guard(c);
    return c.json({
      success: true,
      data: {
        name: found.entry.name,
        command: found.install.command,
        allowed,
        canStop: watching,
        terminal: terminalView(records.at(-1)),
      },
    });
  });
  app.post(path, async (c) => {
    const refused = guard(c);
    if (refused) return refused;
    if (!mayInstall(c))
      return c.json(
        {
          success: false,
          error:
            'Allow this device to run and view terminals before installing engines here.',
        },
        403,
      );
    const body = await setupBody(c.req.raw);
    const parsed = installRequest.safeParse(body);
    if (!parsed.success)
      return c.json(
        {
          success: false,
          error: 'Review the installer command before starting.',
        },
        400,
      );
    const initial = recipe(c.req.param('id'));
    if (!initial)
      return c.json(
        {
          success: false,
          error: 'No supported installer is available for this engine.',
        },
        404,
      );
    return queue.run(initial.entry.command, async () => {
      const refused = guard(c);
      if (refused) return refused;
      const found = recipe(c.req.param('id'));
      if (!found)
        return c.json(
          {
            success: false,
            error: 'No supported installer is available for this engine.',
          },
          404,
        );
      try {
        assertEngineAllowedByManagedPolicy('acp', {});
      } catch (error) {
        return c.json(managedEngineRefusalBody(error), 403);
      }
      if (parsed.data.command !== found.install.command)
        return c.json(
          {
            success: false,
            code: 'engine-installer-changed',
            error: 'The installer changed. Review its command again.',
          },
          409,
        );
      const terminals = deps.terminals();
      if (!terminals)
        return c.json(
          {
            success: false,
            error: 'Terminals are unavailable on this Station.',
          },
          503,
        );
      const scope = installScope(found.entry.command);
      const records = await terminals.list(c.req.raw, scope);
      const previous = records.find(
        (record) => record.operationId === parsed.data.operationId,
      );
      if (previous)
        return c.json({
          success: true,
          data: { terminal: terminalView(previous) },
        });
      if (
        records.some(
          (record) =>
            record.status === 'running' || record.status === 'starting',
        )
      )
        return c.json(
          {
            success: false,
            error: 'An installer is already running. Follow it in this pane.',
          },
          409,
        );
      const env = { PATH: await resolveAugmentedPath() };
      const file =
        process.platform === 'win32'
          ? await findCliBinaryAsync('powershell.exe')
          : '/bin/sh';
      if (!file)
        return c.json(
          { success: false, error: 'The installer’s shell is unavailable.' },
          503,
        );
      let opened: Awaited<ReturnType<typeof terminals.openInternal>>;
      try {
        opened = await terminals.openInternal(
          scope,
          {
            cwd: homedir(),
            cols: 100,
            rows: 30,
            operationId: parsed.data.operationId,
            maxRuntimeMs: 15 * 60_000,
            launch: {
              file,
              args:
                process.platform === 'win32'
                  ? ['-NoProfile', '-Command', found.install.command]
                  : ['-c', found.install.command],
              env,
            },
          },
          async () => {
            if (guard(c) || !mayInstall(c))
              throw new Error('Installation permission changed before launch.');
            assertEngineAllowedByManagedPolicy('acp', {});
          },
        );
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'terminal-lifetime-unsupported'
        )
          return c.json(
            {
              success: false,
              code: 'engine-install-host-update-required',
              error:
                'Update and restart the Station service to install engines here.',
            },
            409,
          );
        return c.json(
          {
            success: false,
            error:
              'The installer terminal could not start. Check terminal access and try again.',
          },
          503,
        );
      }
      const current = (await terminals.list(c.req.raw, scope)).find(
        (record) => record.terminalId === opened.terminalId,
      );
      return c.json({
        success: true,
        data: { terminal: terminalView(current) },
      });
    });
  });
  app.delete(path, async (c) => {
    const refused = guard(c, true);
    if (refused) return refused;
    if (!mayInstall(c))
      return c.json(
        { success: false, error: 'This device cannot stop installers.' },
        403,
      );
    const id = c.req.param('id');
    const target = z
      .object({ terminalId: z.string().uuid(), operationId: z.string().uuid() })
      .strict()
      .safeParse(await setupBody(c.req.raw));
    if (!target.success)
      return c.json(
        {
          success: false,
          error: 'Read the installer status before stopping it.',
        },
        400,
      );
    const terminals = deps.terminals();
    if (!terminals || !recipe(id))
      return c.json({ success: false, error: 'Installer not found.' }, 404);
    const installer = recipe(id)!;
    return queue.run(installer.entry.command, async () => {
      const refused = guard(c, true);
      if (refused) return refused;
      const selected = (
        await terminals.list(c.req.raw, installScope(installer.entry.command))
      ).find(
        (record) =>
          record.terminalId === target.data.terminalId &&
          record.operationId === target.data.operationId,
      );
      if (
        selected &&
        (selected.status === 'running' || selected.status === 'starting')
      )
        await terminals.close(
          c.req.raw,
          installScope(installer.entry.command),
          selected.terminalId,
        );
      return c.json({ success: true, data: null });
    });
  });
  app.get('/connections/:id/station-tools', async (c) => {
    const refused = guard(c);
    if (refused) return refused;
    const id = c.req.param('id');
    const config = (await deps.configLoader.loadACPConfig()).connections.find(
      (entry) => entry.id === id,
    );
    if (!config)
      return c.json({ success: false, error: 'Engine not found.' }, 404);
    const slug = await findEngineAgent(deps.configLoader, id, config.name);
    const agent = slug ? await deps.configLoader.loadAgent(slug) : null;
    const candidates = listValidatedACPRegistryEntries({
      detect: false,
    }).filter(
      (item) =>
        item.builtin && namesSameExecutable(config.command, item.entry.command),
    );
    const matched = candidates.some((item) =>
      isDeepStrictEqual(config.args ?? [], item.entry.args ?? []),
    );
    const builtin =
      matched || deps.advertisedHttp(id)
        ? undefined
        : (
            candidates.find((item) => item.entry.id === id) ??
            (candidates.length === 1 ? candidates[0] : undefined)
          )?.entry;
    return c.json({
      success: true,
      data: {
        agentSlug: slug,
        ...(builtin
          ? {
              recommended: {
                id: builtin.id,
                name: builtin.name,
                command: builtin.command,
                args: builtin.args ?? [],
              },
            }
          : {}),
        supported: deps.advertisedHttp(id),
        selected: BUILTIN_STATION_AGENT_MCP_SERVER_IDS.every((server) =>
          agent?.tools?.mcpServers.includes(server),
        ),
      },
    });
  });
  app.post('/connections/:id/recommended-setup', async (c) => {
    const refused = guard(c);
    if (refused) return refused;
    if (!mayRunCommandsOnHost(c.req.raw, grantedPairingScope(c)))
      return c.json(
        { success: false, error: 'This device cannot change engine commands.' },
        403,
      );
    const input = await setupBody(c.req.raw);
    const parsed = z
      .object({
        id: z.string().min(1).max(128),
        command: z.string().min(1).max(4096),
        args: z.array(z.string().max(1024)).max(32),
      })
      .strict()
      .safeParse(input);
    if (!parsed.success)
      return c.json(
        {
          success: false,
          error: 'Review the recommended setup before applying it.',
        },
        400,
      );
    return configurationMutationResponse(
      await captureConfigurationMutation(deps.apply, async (beginMutation) => {
        const refused = guard(c);
        if (refused) return refused;
        const entry = listValidatedACPRegistryEntries({ detect: false }).find(
          (item) => item.builtin && item.entry.id === parsed.data.id,
        )?.entry;
        if (
          !entry ||
          entry.command !== parsed.data.command ||
          !isDeepStrictEqual(entry.args ?? [], parsed.data.args)
        )
          return c.json(
            {
              success: false,
              error: 'The recommended setup changed. Review it again.',
            },
            409,
          );
        const config = await deps.configLoader.loadACPConfig();
        const saved = config.connections.find(
          (item) => item.id === c.req.param('id'),
        );
        if (!saved || !namesSameExecutable(saved.command, entry.command))
          return c.json(
            {
              success: false,
              error: 'Engine setup changed. Review its current connection.',
            },
            409,
          );
        try {
          assertEngineAllowedByManagedPolicy('acp', saved);
        } catch (error) {
          return c.json(managedEngineRefusalBody(error), 403);
        }
        if (guard(c))
          return c.json(
            { success: false, error: 'Permission changed before saving.' },
            403,
          );
        if (isDeepStrictEqual(saved.args ?? [], entry.args ?? []))
          return c.json({
            success: true,
            data: { connected: deps.advertisedHttp(saved.id) },
          });
        const next = { ...saved, args: [...(entry.args ?? [])] };
        config.connections = config.connections.map((item) =>
          item.id === saved.id ? next : item,
        );
        beginMutation();
        await deps.configLoader.saveACPConfig(config);
        const connected = await deps.reconnect(next);
        return c.json({ success: true, data: { connected } });
      }),
    );
  });
  app.post('/connections/:id/station-tools', async (c) => {
    const refused = guard(c);
    if (refused) return refused;
    const id = c.req.param('id');
    return configurationMutationResponse(
      await captureConfigurationMutation(deps.apply, (beginMutation) =>
        queue.run(`tools:${id}`, async () => {
          const refused = guard(c);
          if (refused) return refused;
          const config = (
            await deps.configLoader.loadACPConfig()
          ).connections.find((entry) => entry.id === id);
          if (!config || !deps.advertisedHttp(id))
            return c.json(
              {
                success: false,
                error:
                  'Check this engine’s connection first. It must support Station’s HTTP tools.',
              },
              409,
            );
          try {
            assertEngineAllowedByManagedPolicy('acp', config);
          } catch (error) {
            return c.json(managedEngineRefusalBody(error), 403);
          }
          const slug = await findEngineAgent(
            deps.configLoader,
            id,
            config.name,
          );
          if (!slug)
            return c.json(
              {
                success: false,
                error:
                  'Finish connecting this engine before adding Station tools.',
              },
              409,
            );
          await deps.configLoader.mutateAgent(slug, (current) => {
            if (guard(c) || current.execution?.agentConnectionId !== id)
              throw new Error(
                'Engine setup or permission changed. Check it again.',
              );
            const selected = current.tools?.mcpServers ?? [];
            const missing = BUILTIN_STATION_AGENT_MCP_SERVER_IDS.filter(
              (server) => !selected.includes(server),
            );
            if (missing.length === 0) return null;
            beginMutation();
            return {
              ...current,
              tools: {
                ...current.tools,
                mcpServers: [...selected, ...missing],
              },
            };
          });
          deps.changed();
          return c.json({
            success: true,
            data: { agentSlug: slug, enabled: true },
          });
        }),
      ),
    );
  });
  return app;
}
