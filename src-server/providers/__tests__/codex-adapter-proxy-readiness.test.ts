import { describe, expect, test } from 'vitest';
import { CodexAdapter } from '../adapters/codex-adapter.js';

/**
 * A proxy-routed Codex connection authenticates with the SELECTED model
 * connection's key, which `engineProxyLaunch` supplies on the spawn
 * (`STATION_ENGINE_PROXY_KEY` + `model_provider` overrides). It does not log
 * the CLI in, so `codex login status` reports "Not logged in" for a connection
 * that runs perfectly well — verified live on 2026-10-22: `codex exec` answered
 * through the same proxy with no login, while Station refused the launch with
 * "codex prerequisites missing: Codex login".
 *
 * These tests pin the readiness answer to the route the launch resolves, and
 * keep the login probe as the answer when there is no route.
 */

const PROXY_ROUTE = {
  connectionId: '8719ec65-79ec-422c-a643-6b2b04f57a98',
  label: 'CLI Proxy (bmedia)',
  endpoint: 'https://bmedia.example:8317',
} as const;

function harness(options: {
  route?: typeof PROXY_ROUTE;
  loginExitCode?: number;
}) {
  const calls: string[][] = [];
  const adapter = new CodexAdapter({
    findBinary: () => '/home/someone/.local/bin/codex',
    getConnectionLaunch: async () => ({
      env: options.route
        ? { STATION_ENGINE_PROXY_KEY: 'proxy-key' }
        : undefined,
      args: options.route ? ['-c', 'model_provider=station-proxy'] : [],
      ...(options.route ? { route: options.route } : {}),
    }),
    runCommand: async (_command, args) => {
      calls.push([...args]);
      if (args[0] === '--version') {
        return { stdout: 'codex-cli 0.163.0', stderr: '', code: 0 };
      }
      return options.loginExitCode === 0
        ? { stdout: 'Logged in', stderr: '', code: 0 }
        : { stdout: '', stderr: 'Not logged in', code: 1 };
    },
  });
  return { adapter, calls };
}

describe('CodexAdapter.getPrerequisites authentication basis', () => {
  test('a proxy-routed connection is authenticated by its route, not by `codex login`', async () => {
    const { adapter, calls } = harness({ route: PROXY_ROUTE });

    const prerequisites = await adapter.getPrerequisites();

    expect(
      prerequisites.find((item) => item.id === 'codex-auth'),
    ).toMatchObject({
      name: 'Proxy key',
      status: 'installed',
      description:
        'A key is saved for CLI Proxy (bmedia). Check the connection to verify an answer.',
    });
    // The login probe is not just overridden — it is not asked, because the
    // CLI's login is not this connection's credential.
    expect(calls).toContainEqual(['--version']);
    expect(calls).not.toContainEqual(['login', 'status']);
  });

  test('the CLI prerequisite is still measured on a routed connection', async () => {
    const { adapter, calls } = harness({ route: PROXY_ROUTE });

    const cli = (await adapter.getPrerequisites()).find(
      (item) => item.id === 'codex-cli',
    );

    // The route settles the AUTH question only; whether the executable exists
    // and runs is still observed, so a routed connection cannot hide a
    // missing CLI.
    expect(cli?.status).toBe('installed');
    expect(calls).toContainEqual(['--version']);
  });

  test('without a route, a failed `codex login` still blocks the engine', async () => {
    // Discriminating control: if the route branch were an unconditional
    // "installed", this would pass as ready and the launch gate would let an
    // unauthenticated connection through.
    const { adapter, calls } = harness({ loginExitCode: 1 });

    const prerequisites = await adapter.getPrerequisites();

    expect(
      prerequisites.find((item) => item.id === 'codex-auth'),
    ).toMatchObject({ status: 'missing', name: 'Codex login' });
    expect(calls).toContainEqual(['login', 'status']);
  });

  test('without a route, a successful `codex login` reports the CLI credentials', async () => {
    const { adapter } = harness({ loginExitCode: 0 });

    const auth = (await adapter.getPrerequisites()).find(
      (item) => item.id === 'codex-auth',
    );

    expect(auth?.status).toBe('installed');
    expect(auth?.name).toBe('Codex login');
  });
});
