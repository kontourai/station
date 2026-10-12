/**
 * #2719 follow-up: `station install <path>` of a folder an open proposal
 * names. The CLI's own `install` command runs against the real preview and
 * install routes (real staging, real consent check, real installer, a real
 * proposal store); only the transport is replaced, by handing the CLI's
 * request to the route app. The preview reports `gitMetadata: "excluded"`,
 * and the install must send it back or the route refuses it with a 409.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { beforeEach, expect, test, vi } from 'vitest';
import type { ParsedCoreArgs } from '../../../../packages/cli/src/commands/core-api.js';
import { withOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { PluginLifecycleProposalService } from '../../../services/plugins/plugin-lifecycle-proposals.js';
import { execGitSync } from '../../../utils/git-exec.js';
import { registerPluginInstallRoutes } from '../plugin-install-routes.js';

const transport = vi.hoisted(() => ({
  app: null as null | {
    request: (path: string, init?: RequestInit) => Response | Promise<Response>;
  },
  calls: [] as Array<{ path: string; body: unknown }>,
}));

vi.mock('@kontourai/station-sdk/client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk/client')>();
  return {
    ...actual,
    authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname.replace(/^\/api\/plugins/, '');
      transport.calls.push({
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return transport.app!.request(path, {
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
      });
    }),
  };
});

vi.mock(
  '../../../../packages/cli/src/commands/core-api.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../../packages/cli/src/commands/core-api.js')
      >();
    return {
      ...actual,
      configureApiCredential: vi.fn(),
      resolveApiBaseDetailed: vi.fn(() => ({
        apiBase: 'http://127.0.0.1:3999',
        source: 'loopback',
        station: undefined,
      })),
    };
  },
);

const tempDir = trackTempDirs();
const parsed: ParsedCoreArgs = {
  flags: { yes: true },
  positionals: [],
  repeatedFlags: {},
};

beforeEach(() => {
  transport.calls = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

test('station install <path> of a proposed folder echoes the preview’s gitMetadata and installs it stripped', async () => {
  const root = realpathSync(tempDir('station-cli-proposed-'));
  const home = join(root, 'home');
  const pluginsDir = join(home, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  const source = join(root, 'cli-plugin');
  mkdirSync(source);
  writeFileSync(
    join(source, 'plugin.json'),
    JSON.stringify({ name: 'cli-plugin', version: '1.0.0' }),
  );
  execGitSync(['init', '-q'], { cwd: source, stdio: 'ignore' });
  const proposals = new PluginLifecycleProposalService(home);
  await proposals.propose({
    kind: 'install',
    source,
    rationale: 'Adds the pane.',
    author: { principal: 'agent' },
  });
  const app = new Hono();
  registerPluginInstallRoutes(app, {
    projectVisiblePlugins: () => (installed) => installed,
    agentsDir: join(home, 'agents'),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    } as any,
    pluginsDir,
    projectHomeDir: home,
    proposals,
  });
  transport.app = withOperatorPrincipal(app);

  const { install } = await import(
    '../../../../packages/cli/src/commands/install.js'
  );
  await expect(install(source, [], parsed, null)).resolves.toEqual({
    pluginName: 'cli-plugin',
    version: '1.0.0',
  });

  expect(transport.calls.map((call) => call.path)).toEqual([
    '/preview',
    '/install',
  ]);
  expect((transport.calls[1].body as any).consent).toMatchObject({
    gitMetadata: 'excluded',
  });
  expect(existsSync(join(pluginsDir, 'cli-plugin', 'plugin.json'))).toBe(true);
  expect(existsSync(join(pluginsDir, 'cli-plugin', '.git'))).toBe(false);
});
