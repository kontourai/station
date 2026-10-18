import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../src-server/domain/config-loader.js';
import { FileStorageAdapter } from '../../src-server/domain/file-storage-adapter.js';
import { createAgentRoutes } from '../../src-server/routes/agents/agents.js';
import { createSkillRoutes } from '../../src-server/routes/agents/skills.js';
import { createToolRoutes } from '../../src-server/routes/agents/tools.js';
import type { AgentConfigurationMutationRunner } from '../../src-server/runtime/types.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../src-server/security/runtime-request-security.js';
import { AgentService } from '../../src-server/services/agents/agent-service.js';
import { SkillService } from '../../src-server/services/agents/skill-service.js';
import { MCPService } from '../../src-server/services/plugins/mcp-service.js';
import { createLogger } from '../../src-server/utils/logger.js';
import { scenarios } from '../engine-delivery-probes.js';

const makeTemp = trackTempDirs();
afterEach(() => vi.unstubAllEnvs());

describe('delivery setup/cleanup through real routes and persistence', () => {
  it.each([false, true])(
    'persists the probe and removes every resource (lost Agent acknowledgement: %s)',
    async (loseAcknowledgement) => {
      vi.stubEnv('STATION_DELIVERY_PROBE_MCP_ENDPOINT', '');
      const home = await makeTemp('delivery-routes-');
      const loader = new ConfigLoader({ projectHomeDir: home });
      const logger = createLogger({ name: 'delivery-route-test' });
      const skills = new SkillService(loader, logger);
      const integrations = new MCPService(
        loader,
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        new Map(),
        logger,
        undefined,
        49371,
      );
      const agents = new AgentService(
        loader,
        new FileStorageAdapter(home),
        new Map(),
        new Map(),
        new Map(),
        logger,
      );
      // Runtime activation is outside this route/persistence proof; no engine runs.
      const activate: AgentConfigurationMutationRunner = async (operation) =>
        operation(() => undefined);
      const app = new Hono();
      app.use('*', async (c, next) => {
        if (c.req.header('authorization') !== 'Bearer fixture-operator')
          return c.json({ success: false }, 401);
        setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
          kind: 'credential',
          credential: 'fixture-operator',
          authority: 'operator-credential',
          source: 'bearer',
        });
        await next();
      });
      app.route(
        '/api/skills',
        createSkillRoutes(skills, () => home),
      );
      app.route(
        '/integrations',
        createToolRoutes(integrations, async () => undefined),
      );
      app.route(
        '/agents',
        createAgentRoutes(agents, skills, activate, () => ({
          getAgents: () => [],
        })),
      );
      const cleanup: Array<() => Promise<unknown>> = [];
      const requests: Array<{ path: string; method: string; status: number }> =
        [];
      let agentSlug = '';
      const api = async (
        path: string,
        body?: unknown,
        method = body ? 'POST' : 'GET',
      ) => {
        const response = await app.request(path, {
          method,
          headers: {
            authorization: 'Bearer fixture-operator',
            'content-type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const payload = (await response.json()) as {
          success: boolean;
          data?: unknown;
          error?: string;
        };
        requests.push({ path, method, status: response.status });
        if (!response.ok || !payload.success)
          throw new Error(
            `${method} ${path} rejected (${response.status}): ${payload.error}`,
          );
        if (path === '/agents' && method === 'POST') {
          const input = body as { slug: string };
          agentSlug = input.slug;
          if (loseAcknowledgement)
            throw new Error('Agent acknowledgement lost after persistence');
        }
        return payload;
      };
      const cleanupErrors: unknown[] = [];
      try {
        const operation = scenarios[0].prepare({
          api,
          engine: 'claude',
          connectionId: 'fixture-engine',
          cwd: home,
          model: 'claude-sonnet-4-5',
          delivery: {},
          deferCleanup: (_label, run) => cleanup.push(run),
        });
        if (loseAcknowledgement)
          await expect(operation).rejects.toThrow(
            'Agent acknowledgement lost after persistence',
          );
        else expect((await operation).metadata).toEqual({ agentSlug });
        expect(agentSlug).not.toBe('');
        const agent = await loader.loadAgent(agentSlug);
        expect(agent.skills).toEqual([agentSlug]);
        expect(agent.execution?.agentConnectionId).toBe('fixture-engine');
        const serverId = agent.tools?.mcpServers?.find((id) =>
          id.startsWith('probe'),
        );
        expect(serverId).toBeDefined();
        const integration = await loader.loadIntegration(serverId ?? '');
        expect(integration.enabled).toBe(true);
        expect(integration.disabledTools).toEqual(['blocked']);
        expect(integration.probe?.ok).toBe(true);
        const skill = await skills.getSkill(agentSlug);
        expect(
          await readFile(join(skill.path, 'scripts/probe.mjs'), 'utf8'),
        ).toContain('const nonce = ');
        expect(requests.every((request) => request.status < 300)).toBe(true);
      } finally {
        for (const run of cleanup.reverse()) {
          try {
            await run();
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        await integrations.resetRuntimeState();
      }
      expect(cleanupErrors).toEqual([]);
      expect(requests.slice(-3).map(({ method }) => method)).toEqual([
        'DELETE',
        'DELETE',
        'DELETE',
      ]);
      expect(await loader.agentExists(agentSlug)).toBe(false);
      expect(await loader.listIntegrations()).toEqual([]);
      await expect(stat(join(home, 'skills', agentSlug))).rejects.toMatchObject(
        { code: 'ENOENT' },
      );
    },
  );
});
