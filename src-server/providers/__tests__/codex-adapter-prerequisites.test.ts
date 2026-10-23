import { afterEach, describe, expect, test, vi } from 'vitest';

// Keep the real `parseCliAuthState` (the non-proxy branch's parser under
// test); replace only the probe runner and the prerequisite builder, whose
// handed-through `detectAuthState` is what these tests drive.
vi.mock('../auth/cli-auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/cli-auth.js')>()),
  buildCliRuntimePrerequisites: vi.fn(async () => []),
  runCliCommand: vi.fn(),
}));

const { buildCliRuntimePrerequisites, runCliCommand } = await import(
  '../auth/cli-auth.js'
);
const { CodexAdapter } = await import('../adapters/codex-adapter.js');

const mockBuildCliRuntimePrerequisites = vi.mocked(
  buildCliRuntimePrerequisites,
);
const mockRunCliCommand = vi.mocked(runCliCommand);

type DetectedAuthState = () => Promise<
  'authenticated' | 'unauthenticated' | 'unknown'
>;

/** Drives the adapter's readiness derivation and evaluates the auth detector it handed the shared builder. */
async function readinessAuthState(
  options: ConstructorParameters<typeof CodexAdapter>[0],
): Promise<'authenticated' | 'unauthenticated' | 'unknown'> {
  const adapter = new CodexAdapter(options);
  await adapter.getPrerequisites?.();
  const call = mockBuildCliRuntimePrerequisites.mock.calls.at(-1)?.[0];
  if (!call?.detectAuthState) {
    throw new Error('detectAuthState was not handed to the builder');
  }
  return (call.detectAuthState as DetectedAuthState)();
}

describe('codex connection readiness auth state', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test('a proxy-routed connection counts as authenticated without probing the CLI login', async () => {
    await expect(
      readinessAuthState({
        getConnectionLaunch: async () => ({
          env: {
            STATION_ENGINE_PROXY_KEY: 'proxy-key',
            CODEX_HOME: '/home/u/.station/codex-config-home',
          },
          args: ['-c', 'model_provider="station-proxy"'],
          route: {
            connectionId: 'proxy-connection',
            label: 'CLI Proxy',
            endpoint: 'https://bmedia.example:8317',
          },
        }),
        findBinary: () => '/usr/bin/codex',
      }),
    ).resolves.toBe('authenticated');
    // The proxy decision is made from the route alone: the CLI's own login
    // state is never consulted (it cannot see the proxy and would report
    // "Not logged in" for a connection that works).
    expect(mockRunCliCommand).not.toHaveBeenCalled();
  });

  test('without a proxy route the plain login probe runs under the connection env', async () => {
    mockRunCliCommand.mockResolvedValue({
      stdout: 'Not logged in',
      stderr: '',
      code: 0,
    });
    await expect(
      readinessAuthState({
        getConnectionLaunch: async () => ({
          env: { CODEX_HOME: '/home/u/.codex' },
          args: [],
        }),
        findBinary: () => '/usr/bin/codex',
      }),
    ).resolves.toBe('unauthenticated');
    expect(mockRunCliCommand).toHaveBeenCalledWith(
      'codex',
      ['login', 'status'],
      undefined,
      { CODEX_HOME: '/home/u/.codex' },
    );
  });

  test('without a proxy route a logged-in CLI status answers authenticated', async () => {
    mockRunCliCommand.mockResolvedValue({
      stdout: 'Logged in using an API key - abcd1234***wxyz9',
      stderr: '',
      code: 0,
    });
    await expect(
      readinessAuthState({
        getConnectionLaunch: async () => ({
          env: undefined,
          args: [],
        }),
        findBinary: () => '/usr/bin/codex',
      }),
    ).resolves.toBe('authenticated');
  });

  test('an adapter without a launch seam keeps the plain probe with no env overlay', async () => {
    mockRunCliCommand.mockResolvedValue({
      stdout: '',
      stderr: '',
      code: 1,
    });
    await expect(
      readinessAuthState({
        findBinary: () => '/usr/bin/codex',
      }),
    ).resolves.toBe('unknown');
    expect(mockRunCliCommand).toHaveBeenCalledWith(
      'codex',
      ['login', 'status'],
      undefined,
      undefined,
    );
  });

  test('a rejected probe answers unknown instead of guessing', async () => {
    mockRunCliCommand.mockResolvedValue(null);
    await expect(
      readinessAuthState({
        findBinary: () => '/usr/bin/codex',
      }),
    ).resolves.toBe('unknown');
  });
});
