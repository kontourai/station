import { expect, test, vi } from 'vitest';
import { runEnvironmentCommand } from '../commands/environment.js';
import { runOutsideClientsCommand } from '../commands/outside-clients.js';

const commands = [
  ['list'],
  ['approve', 'request-id', '--global'],
  ['deny', 'request-id'],
  ['change', 'grant-id', '--global'],
  ['revoke', 'grant-id'],
  [
    'register',
    '--name=Example',
    '--redirect-uri=http://127.0.0.1:43197/callback',
  ],
  ['redirect-origins', 'list'],
  ['redirect-origins', 'add', 'https://example.com'],
  ['redirect-origins', 'remove', 'https://example.com'],
  ['cors-origins', 'list'],
  ['cors-origins', 'add', 'https://example.com'],
  ['cors-origins', 'remove', 'https://example.com'],
];
test('every released outside-clients command refuses with a not-yet-available message before home, auth, network or store access', async () => {
  const home = {
    schemaVersion: 1 as const,
    environmentId: '33333333-3333-4333-8333-333333333333',
    credential: 'isolated-test-operator',
  };
  const request = vi
    .fn()
    .mockResolvedValue({ environmentId: home.environmentId });
  const createService = vi.fn(() => ({
    initialize: vi.fn().mockResolvedValue(home),
    readExistingRecord: vi.fn().mockResolvedValue(home),
    rotateCredential: vi.fn(),
    resetEnvironment: vi.fn(),
  }));
  const stdout = vi.fn();
  const confirm = vi.fn();
  const outcomes: unknown[] = [];
  for (const command of commands)
    outcomes.push(
      await runEnvironmentCommand(
        ['outside-clients', ...command, '--api-base=http://127.0.0.1:47817'],
        {
          projectHome: '/isolated-inert-home',
          request,
          createService,
          stdout,
          confirm,
        },
      ).then(
        () => null,
        (error) => error,
      ),
    );
  // Assert the forbidden boundary crossing before inspecting refusal text, including under mutation.
  expect(createService).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(stdout).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  for (const outcome of outcomes)
    expect(outcome).toMatchObject({
      message: expect.stringContaining('not yet available'),
    });
});

test('isolated command composition rejects code input, full, unknown flags and implicit global before opening a host channel', async () => {
  const openChannel = vi.fn();
  const invalid = [
    [
      'approve',
      'request_identifier_123456',
      '--project=alpha',
      '--project=beta',
    ],
    ['approve', '123456', '--global'],
    ['deny', '123456'],
    ['approve', 'request_identifier_123456', '--global', '--code=123456'],
    ['approve', 'request_identifier_123456', '--global', '--access=full'],
    ['approve', 'request_identifier_123456'],
    ['approve', 'request_identifier_123456', '--global', '--project=alpha'],
  ];
  for (const args of invalid)
    await expect(
      runOutsideClientsCommand(args, {
        openChannel,
        write: vi.fn(),
        confirm: async () => true,
      }),
    ).rejects.toThrow();
  expect(openChannel).not.toHaveBeenCalled();
});

test('noninteractive approval requires explicit client, fingerprint and supersession binding before any host request', async () => {
  const openChannel = vi.fn();
  await expect(
    runOutsideClientsCommand(
      ['approve', 'request_identifier_123456', '--global'],
      { openChannel, write: vi.fn() },
    ),
  ).rejects.toThrow('Noninteractive approval requires');
  expect(openChannel).not.toHaveBeenCalled();
});
