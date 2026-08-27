import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { runEnvironmentCommand } from '../commands/environment.js';

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: status < 400, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SSH environment CLI commands', () => {
  const fetchMock = vi.fn();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  beforeEach(() => {
    fetchMock.mockReset();
    log.mockClear();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  test('adds an SSH environment with spaced flags and no local secret service', async () => {
    fetchMock.mockResolvedValueOnce(
      envelope({
        profile: { id: 'environment-1', name: 'Media' },
        state: { phase: 'idle' },
      }),
    );

    await runEnvironmentCommand(
      [
        'add',
        '--ssh',
        'brian-media',
        '--project',
        '~/dev/github/kontourai/station',
        '--name',
        'Media',
        '--api-base=http://127.0.0.1:3141',
      ],
      { projectHome: '/unused' },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3141/api/environments/ssh',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          hostAlias: 'brian-media',
          remoteProjectPath: '~/dev/github/kontourai/station',
          name: 'Media',
        }),
      }),
    );
  });

  test('adds a managed-launch SSH environment with --managed', async () => {
    fetchMock.mockResolvedValueOnce(
      envelope({
        profile: { id: 'environment-2', name: 'Media', launchMode: 'managed' },
        state: { phase: 'idle' },
      }),
    );

    await runEnvironmentCommand(
      [
        'add',
        '--ssh',
        'brian-media',
        '--project',
        '~/dev/github/kontourai/station',
        '--managed',
        '--api-base=http://127.0.0.1:3141',
      ],
      { projectHome: '/unused' },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3141/api/environments/ssh',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          hostAlias: 'brian-media',
          remoteProjectPath: '~/dev/github/kontourai/station',
          launchMode: 'managed',
        }),
      }),
    );
  });

  test('rejects the retired environment resume execution surface', async () => {
    await expect(
      runEnvironmentCommand(
        ['resume', 'environment-1', '--agent=codex', 'continue'],
        { projectHome: '/unused' },
      ),
    ).rejects.toThrow('Usage:');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
