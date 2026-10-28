/**
 * `workload_status` end to end, short of a real Linux host: the tool's REST
 * call reaches the real `/api/system/workload/session` route (fetch is
 * dispatched into the Hono app), which resolves the caller from the forwarded
 * credential and reads that session's scope from a cgroup v2 fixture tree
 * through the real workload manager (driven by a fake systemd manager).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  closeChildWorkload,
  prepareChildWorkload,
  trackChildWorkload,
} from '@kontourai/station-shared/child-workload';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { createWorkloadRoutes } from '../../routes/system/workload-routes.js';
import { WORKLOAD_SESSION_ENV } from '../../services/infra/workload-budget.js';
import { __workloadTestHooks } from '../../services/infra/workload-resources.js';
import type { StationControlToolRegistry } from '../station-control-mcp-server.js';
import {
  STATION_CONTROL_CALLER_TOKEN_HEADER,
  withStationControlCallerContext,
} from '../station-control-shared.js';
import { registerWorkloadTools } from '../station-control-workload-tools.js';

process.env.STATION_API_BASE = 'http://workload-control.test';
const makeTempDir = trackTempDirs();

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
};

function tool() {
  const register = vi.fn();
  registerWorkloadTools({
    tool: register,
  } as unknown as StationControlToolRegistry);
  expect(register.mock.calls[0]?.[0]).toBe('workload_status');
  return register.mock.calls[0]?.[3] as () => Promise<ToolResult>;
}

function asCaller<T>(token: string | undefined, run: () => Promise<T>) {
  return token === undefined
    ? run()
    : withStationControlCallerContext({ token, resolve: () => null }, run);
}

describe('workload_status', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    __workloadTestHooks.reset();
  });

  test("reads the calling session's own scope from its cgroup files", async () => {
    const home = makeTempDir('workload-tool-');
    const cgroupRoot = join(home, 'cgroup');
    const groups = new Map<string, string>();
    await __workloadTestHooks.start({
      homeDir: home,
      cgroupRoot,
      run: async (args) => {
        if (args[0] === 'show' && args.includes('--property=ControlGroup'))
          return `${groups.get(args[1]) ?? ''}\n`;
        if (args[0] === 'show') return 'LoadState=not-found\n';
        return '';
      },
    });
    const engine = prepareChildWorkload('/usr/bin/codex', ['app-server'], {
      [WORKLOAD_SESSION_ENV]: 'session-a',
    });
    if (!engine) throw new Error('no launcher');
    const unit = engine.args
      .find((arg) => arg.startsWith('--unit='))
      ?.slice('--unit='.length) as string;
    const group = `/user.slice/user-1000.slice/user@1000.service/${unit}`;
    groups.set(unit, group);
    const scope = `${cgroupRoot}${group}`;
    await mkdir(scope, { recursive: true });
    for (const [file, text] of Object.entries({
      'memory.current': '2147483648\n',
      'memory.max': '5153751040\n',
      'memory.peak': '4831838208\n',
      'memory.swap.current': '1048576\n',
      'memory.swap.max': '268435456\n',
      'memory.events': 'low 0\nhigh 0\nmax 3\noom 0\noom_kill 0\n',
      'pids.current': '41\n',
      'pids.max': '512\n',
    }))
      await writeFile(join(scope, file), text);
    trackChildWorkload(engine, process.pid);

    const app = new Hono().route(
      '/api/system',
      createWorkloadRoutes({
        resolveCallerSession: (request) =>
          request.headers.get(STATION_CONTROL_CALLER_TOKEN_HEADER) ===
          'token-for-session-a'
            ? 'session-a'
            : null,
      }),
    );
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      app.request(new URL(url).pathname, init),
    );
    try {
      const result = await asCaller('token-for-session-a', tool());
      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0]?.text ?? '');
      expect(body).toMatchObject({
        success: true,
        data: {
          enforcement: { state: 'ready' },
          scope: {
            state: 'measured',
            unit,
            memory: {
              currentBytes: 2147483648,
              peakBytes: 4831838208,
              maxBytes: 5153751040,
              swapCurrentBytes: 1048576,
              swapMaxBytes: 268435456,
              oomKills: 0,
              tasksCurrent: 41,
              tasksMax: 512,
            },
          },
        },
      });

      const refused = await asCaller(undefined, tool());
      expect(refused.isError).toBe(true);
      expect(JSON.parse(refused.content[0]?.text ?? '')).toMatchObject({
        success: false,
        code: 'station_control_caller_required',
      });
    } finally {
      await closeChildWorkload(process.pid);
    }
  });
});
