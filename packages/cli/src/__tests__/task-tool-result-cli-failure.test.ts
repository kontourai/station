import { MAX_TASK_REFERENCE_ID_LENGTH } from '@kontourai/station-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('task tool-result CLI protected failures', () => {
  it.each([
    ['tasks', 'attach-result', 'text', 404, false],
    ['tasks', 'attach-result', 'text', 503, true],
    ['tasks', 'attach-result', 'json', 404, false],
    ['tasks', 'attach-result', 'json', 503, true],
    ['tasks', 'show-results', 'text', 404, false],
    ['tasks', 'show-results', 'text', 503, true],
    ['tasks', 'show-results', 'json', 404, false],
    ['tasks', 'show-results', 'json', 503, true],
    ['sessions', 'inspect', 'text', 404, false],
    ['sessions', 'inspect', 'text', 503, true],
    ['sessions', 'inspect', 'json', 404, false],
    ['sessions', 'inspect', 'json', 503, true],
  ] as const)(
    '%s %s %s %i stays generic and redacts protected diagnostics',
    async (command, action, mode, status, retryable) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              success: false,
              error: 'event=event-secret result=private result',
              details: {
                sessionId: 'session-secret',
                result: 'private result',
                paths: ['/private/path'],
              },
            }),
            { status },
          ),
        ),
      );
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
      const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { runCli } = await import('../cli.js');
      const actionArgs =
        action === 'attach-result'
          ? [
              'attach-result',
              'task-a',
              '--session=session-secret',
              '--event=event-secret',
            ]
          : action === 'show-results'
            ? ['show-results', 'task-a']
            : ['inspect', 'station', 'session-secret', 'event-secret'];
      await runCli([
        command,
        ...actionArgs,
        '--api-base=http://station.test',
        ...(mode === 'json' ? ['--json'] : []),
      ]);

      const output = stderr.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(process.exitCode).toBe(1);
      const message = retryable
        ? 'Tool results are temporarily unavailable. Retry the request.'
        : 'Tool results are unavailable.';
      if (mode === 'json') {
        expect(JSON.parse(output)).toEqual({
          success: false,
          error: message,
          status,
          ...(retryable ? { retryable: true } : {}),
        });
      } else {
        expect(output).toBe(`Error: ${message}`);
      }
      expect(stdout).not.toHaveBeenCalled();
      for (const secret of [
        'event-secret',
        'session-secret',
        'private result',
        '/private/path',
      ])
        expect(output).not.toContain(secret);
    },
  );

  it.each([
    ['tasks', 'attach-result', 'json', 401, 'response'],
    ['tasks', 'attach-result', 'text', 403, 'response'],
    ['tasks', 'attach-result', 'json', 0, 'network'],
    ['tasks', 'attach-result', 'text', 200, 'malformed'],
    ['tasks', 'show-results', 'text', 401, 'response'],
    ['tasks', 'show-results', 'json', 403, 'response'],
    ['tasks', 'show-results', 'text', 0, 'network'],
    ['tasks', 'show-results', 'json', 200, 'malformed'],
    ['sessions', 'inspect', 'json', 401, 'response'],
    ['sessions', 'inspect', 'text', 403, 'response'],
    ['sessions', 'inspect', 'json', 0, 'network'],
    ['sessions', 'inspect', 'text', 200, 'malformed'],
  ] as const)(
    '%s %s turns SDK %s failures with status %i into generic output',
    async (command, action, mode, status, failureKind) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      if (failureKind === 'network') {
        fetch.mockRejectedValue(
          new Error('network event=event-secret result=private result'),
        );
      } else {
        fetch.mockResolvedValue(
          new Response(
            JSON.stringify(
              failureKind === 'malformed'
                ? { success: true, data: { private: 'private result' } }
                : {
                    success: false,
                    error: 'event=event-secret result=private result',
                    details: {
                      sessionId: 'session-secret',
                      paths: ['/private/path'],
                    },
                  },
            ),
            { status },
          ),
        );
      }
      vi.stubGlobal('fetch', fetch);
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
      const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { runCli } = await import('../cli.js');
      const actionArgs =
        action === 'attach-result'
          ? [
              'attach-result',
              'task-a',
              '--session=session-secret',
              '--event=event-secret',
            ]
          : action === 'show-results'
            ? ['show-results', 'task-a']
            : ['inspect', 'station', 'session-secret', 'event-secret'];
      await runCli([
        command,
        ...actionArgs,
        '--api-base=http://station.test',
        ...(mode === 'json' ? ['--json'] : []),
      ]);

      const output = stderr.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(process.exitCode).toBe(1);
      if (mode === 'json') {
        expect(JSON.parse(output)).toEqual({
          success: false,
          error: 'Tool results are unavailable.',
          status,
        });
      } else {
        expect(output).toBe('Error: Tool results are unavailable.');
      }
      expect(stdout).not.toHaveBeenCalled();
      for (const secret of [
        'event-secret',
        'session-secret',
        'private result',
        '/private/path',
      ])
        expect(output).not.toContain(secret);
    },
  );

  it.each([
    [
      ['tasks', 'attach-result', 'task-a', '--event=event-a'],
      'attach-result requires --session=<sessionId>.',
    ],
    [
      ['tasks', 'attach-result', 'task-a', '--session=session-a'],
      'attach-result requires --event=<eventId>.',
    ],
    [
      [
        'tasks',
        'attach-result',
        'task-a',
        '--session= session-a',
        '--event=event-a',
      ],
      'attach-result has invalid reference: sessionId is required',
    ],
    [
      [
        'sessions',
        'inspect',
        'station',
        `s${'x'.repeat(MAX_TASK_REFERENCE_ID_LENGTH)}`,
        'event-a',
      ],
      'inspect has invalid tool result reference: sessionId is required',
    ],
    [
      ['sessions', 'inspect', 'station', 'session-a'],
      'Missing required argument: tool result event id',
    ],
  ])('keeps local tuple validation explicit for %j', async (args, expected) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const { runCli } = await import('../cli.js');
    await expect(runCli(args)).rejects.toThrow(expected);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not normalize an untyped local error that happens to carry 404', async () => {
    vi.doMock('../commands/core.js', () => ({
      runCoreCommand: vi.fn().mockRejectedValue(
        Object.assign(new Error('inspect local validation failed'), {
          status: 404,
        }),
      ),
    }));
    const { runCli } = await import('../cli.js');
    await expect(
      runCli(['sessions', 'inspect', 'station', 'session-a', 'event-a']),
    ).rejects.toThrow('inspect local validation failed');
  });
});
