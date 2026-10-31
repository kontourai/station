import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { asStationControlCaller } from '../../__test-utils__/station-control-caller-fixture.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { FeaturePreviewRegistry } from '../../services/feature-previews/feature-preview-registry.js';
import { createProjectCheckoutFreshnessReader } from '../../services/projects/project-checkout-freshness.js';
import { execGitSync } from '../../utils/git-exec.js';
import { createLogger } from '../../utils/logger.js';

process.env.STATION_API_BASE = 'http://control-project-read-test.local';
delete process.env.STATION_PORT;

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ToolHandler = (...args: any[]) => Promise<ToolResult>;

const temp = trackTempDirs();

function git(cwd: string, args: string[]) {
  execGitSync(
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    { cwd, hardening: { allowFileProtocol: true } },
  );
}

/** A checkout two commits behind its fetched upstream. */
function checkoutBehind(): string {
  const root = temp('station-get-project-');
  const upstream = join(root, 'upstream.git');
  const other = join(root, 'other');
  const checkout = join(root, 'checkout');
  git(root, ['init', '-q', '--bare', '-b', 'main', upstream]);
  git(root, ['clone', '-q', upstream, other]);
  git(other, ['checkout', '-q', '-b', 'main']);
  git(other, ['commit', '-q', '--allow-empty', '-m', 'first']);
  git(other, ['push', '-q', 'origin', 'main']);
  git(root, ['clone', '-q', upstream, checkout]);
  git(other, ['commit', '-q', '--allow-empty', '-m', 'second']);
  git(other, ['commit', '-q', '--allow-empty', '-m', 'third']);
  git(other, ['push', '-q', 'origin', 'main']);
  git(checkout, ['fetch', '-q']);
  return checkout;
}

/** The real project routes, with the real reader and preview registry. */
async function station(enabled: boolean) {
  const home = temp('station-get-project-home-');
  const previews = new FeaturePreviewRegistry(
    home,
    createLogger({ name: 'preview-test', level: 'error' }),
  );
  const preview = previews.bind({
    id: 'stale-project-checkout',
    label: 'Stale checkout warning',
    description: 'test',
  });
  if (enabled) await previews.setEnabled('stale-project-checkout', true);
  const project = {
    id: 'id-1',
    slug: 'atlas',
    name: 'Atlas',
    workingDirectory: checkoutBehind(),
  };
  const reader = createProjectCheckoutFreshnessReader();
  const { createProjectRoutes } = await import(
    '../../routes/projects/projects.js'
  );
  const app = new Hono().route(
    '/api/projects',
    createProjectRoutes(
      { getProject: () => project } as never,
      {} as never,
      home,
      {
        checkoutFreshness: {
          preview,
          read: (p) =>
            reader.read(p.workingDirectory, { commits: 2, days: 30 }),
        },
      },
    ),
  );
  return { app, project };
}

async function getProjectTool(): Promise<ToolHandler> {
  const { registerProjectReadTools } = await import(
    '../station-control-project-read-tools.js'
  );
  const { StationControlToolRegistry } = await import(
    '../station-control-mcp-server.js'
  );
  const server = new McpServer({
    name: 'project-read-tools',
    version: '0.0.0',
  });
  registerProjectReadTools(new StationControlToolRegistry(server));
  const registry = (
    server as unknown as {
      _registeredTools: Record<string, { handler: ToolHandler }>;
    }
  )._registeredTools;
  return asStationControlCaller({ get_project: registry.get_project.handler })
    .get_project;
}

describe('get_project', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => vi.stubGlobal('fetch', fetchMock));
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  test('carries the checkout’s freshness when the host answers it', async () => {
    const { app, project } = await station(true);
    fetchMock.mockImplementation(async (input, init) =>
      app.fetch(new Request(input as string, init)),
    );
    const result = await (await getProjectTool())({ slug: 'atlas' });
    const payload = JSON.parse(result.content[0]?.text ?? '{}');
    expect(payload).toMatchObject({
      success: true,
      data: {
        slug: 'atlas',
        checkoutFreshness: {
          status: 'stale',
          behind: 2,
          upstream: 'origin/main',
          updateCommand: `git -C ${project.workingDirectory} pull --ff-only`,
        },
      },
    });
  });

  test('is the plain Project, not a failure, when the preview is off', async () => {
    const { app } = await station(false);
    fetchMock.mockImplementation(async (input, init) =>
      app.fetch(new Request(input as string, init)),
    );
    const result = await (await getProjectTool())({ slug: 'atlas' });
    const payload = JSON.parse(result.content[0]?.text ?? '{}');
    expect(payload.success).toBe(true);
    expect(payload.data.slug).toBe('atlas');
    expect(payload.data).not.toHaveProperty('checkoutFreshness');
  });
});
