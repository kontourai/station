import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../api', () => ({
  _getApiBase: async () => 'http://station.test',
}));

const authenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock('../client/http', () => ({ authenticatedFetch }));

const {
  checkACPConnection,
  connectAndMaterializeACPRegistryEngine,
  createACPConnection,
  EngineStillStartingError,
  fetchUnregisteredACPConnections,
  joinACPArgs,
  splitACPArgs,
} = await import('../query-domains/acpWorkspace');

describe('connectAndMaterializeACPRegistryEngine', () => {
  beforeEach(() => authenticatedFetch.mockReset());

  test('returns the materialized Agent receipt including an adopted name', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          agent: {
            data: { slug: 'my-kiro', name: 'My Kiro' },
            created: false,
          },
        }),
      ),
    );

    await expect(
      connectAndMaterializeACPRegistryEngine('kiro'),
    ).resolves.toEqual({
      data: { slug: 'my-kiro', name: 'My Kiro' },
      created: false,
    });
  });

  test.each([
    ['a string error', 'Kiro CLI is unavailable', 'Kiro CLI is unavailable'],
    [
      'an object error with correlation',
      { code: 'internal_error', correlationId: 'corr-123' },
      'Failed to connect engine (internal_error; correlation ID: corr-123).',
    ],
    ['a missing error', undefined, 'Failed to connect engine'],
  ])('formats %s', async (_label, error, message) => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error }), { status: 500 }),
    );

    await expect(
      connectAndMaterializeACPRegistryEngine('kiro'),
    ).rejects.toThrow(message);
  });

  test('names the probe failure when a first add saved no Agent', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            id: 'kiro',
            name: 'Kiro CLI',
            status: 'unavailable',
            lastError: { phase: 'spawn', message: 'spawn kiro ENOENT' },
          },
        }),
      ),
    );

    await expect(
      connectAndMaterializeACPRegistryEngine('kiro'),
    ).rejects.toThrow('Kiro CLI did not connect. spawn: spawn kiro ENOENT');
  });

  // A cold engine's first add answers `probing` while its first start
  // continues on the server; the request-budget timeout is in lastError, but
  // the engine has not failed.
  test('a first start still running is its own outcome, not a failure', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            id: 'kiro',
            name: 'Kiro CLI',
            status: 'probing',
            lastError: {
              phase: 'initialize',
              message: 'Timed out after 10000ms',
            },
          },
        }),
      ),
    );

    const outcome = connectAndMaterializeACPRegistryEngine('kiro');
    await expect(outcome).rejects.toBeInstanceOf(EngineStillStartingError);
    await expect(outcome).rejects.toMatchObject({ engineName: 'Kiro CLI' });
    await expect(outcome).rejects.not.toThrow(/did not connect/);
  });

  test('preserves an explicit 409 message', async () => {
    authenticatedFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          error: "Connection 'kiro' already exists",
        }),
        { status: 409 },
      ),
    );

    await expect(
      connectAndMaterializeACPRegistryEngine('kiro'),
    ).rejects.toThrow("Connection 'kiro' already exists");
  });
});

describe('custom engine connections', () => {
  beforeEach(() => authenticatedFetch.mockReset());

  // A custom engine added with no arguments must launch with none, not with
  // one empty-string argument.
  test('blank arguments send no arguments, and words split on whitespace', async () => {
    authenticatedFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ success: true, data: { id: 'stub' } })),
    );

    await createACPConnection({ id: 'stub', command: 'stub', args: '' });
    await createACPConnection({
      id: 'stub',
      command: 'stub',
      args: '  --acp  -v ',
    });

    const sent = authenticatedFetch.mock.calls.map(
      ([, init]) => JSON.parse(init.body).args,
    );
    expect(sent).toEqual([[], ['--acp', '-v']]);
  });

  test('re-checks a saved connection and reads the unregistered ones', async () => {
    authenticatedFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: { id: 'stub', status: 'available' },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: [{ id: 'stub', status: 'unavailable' }],
          }),
        ),
      );

    await expect(checkACPConnection('stub')).resolves.toMatchObject({
      status: 'available',
    });
    await expect(fetchUnregisteredACPConnections()).resolves.toEqual([
      { id: 'stub', status: 'unavailable' },
    ]);
    expect(
      authenticatedFetch.mock.calls.map(([url, init]) => [url, init?.method]),
    ).toEqual([
      ['http://station.test/acp/connections/stub/check', 'POST'],
      ['http://station.test/acp/connections/unregistered', undefined],
    ]);
  });
});

// Edit setup shows saved arguments as one line and splits the edited line
// back: an argument containing a space must survive the round trip.
describe('argument line round trip', () => {
  test.each([
    [['--acp'], '--acp'],
    [['--prompt', 'a b'], '--prompt "a b"'],
    [['say "hi"'], '"say \\"hi\\""'],
    [['C:\\Program Files\\x'], '"C:\\\\Program Files\\\\x"'],
    [[], ''],
  ])('%j joins to %s and splits back', (args, line) => {
    expect(joinACPArgs(args)).toBe(line);
    expect(splitACPArgs(line)).toEqual(args);
  });

  test('single quotes group too, and blank means no arguments', () => {
    expect(splitACPArgs(`--name 'my engine' -v`)).toEqual([
      '--name',
      'my engine',
      '-v',
    ]);
    expect(splitACPArgs('   ')).toEqual([]);
  });
});
