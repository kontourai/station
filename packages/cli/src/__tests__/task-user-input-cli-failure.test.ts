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

describe('task user-input CLI protected failures', () => {
  it.each([
    ['attach-input', 'text', 404, false],
    ['attach-input', 'text', 503, true],
    ['attach-input', 'json', 404, false],
    ['attach-input', 'json', 503, true],
    ['show-inputs', 'text', 404, false],
    ['show-inputs', 'text', 503, true],
    ['show-inputs', 'json', 404, false],
    ['show-inputs', 'json', 503, true],
  ] as const)(
    '%s %s %i stays generic and redacts protected diagnostics',
    async (action, mode, status, retryable) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              success: false,
              error: 'event=event-secret prompt=private input',
              details: {
                sessionId: 'session-secret',
                prompt: 'private input',
                attachments: [{ name: 'secret.pdf' }],
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
        action === 'attach-input'
          ? [
              'attach-input',
              'task-a',
              '--session=session-secret',
              '--event=event-secret',
            ]
          : ['show-inputs', 'task-a'];
      await runCli([
        'tasks',
        ...actionArgs,
        '--api-base=http://station.test',
        ...(mode === 'json' ? ['--json'] : []),
      ]);

      const output = stderr.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(process.exitCode).toBe(1);
      const message = retryable
        ? 'User input references are temporarily unavailable. Retry the request.'
        : 'User input references are unavailable.';
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
        'private input',
        'secret.pdf',
      ])
        expect(output).not.toContain(secret);
    },
  );

  it.each([
    [
      ['tasks', 'attach-input', 'task-a', '--event=event-a'],
      'attach-input requires --session=<sessionId>.',
    ],
    [
      ['tasks', 'attach-input', 'task-a', '--session=session-a'],
      'attach-input requires --event=<eventId>.',
    ],
    [
      [
        'tasks',
        'attach-input',
        'task-a',
        '--session= session-a',
        '--event=event-a',
      ],
      'attach-input has invalid reference: sessionId is required',
    ],
    [
      [
        'tasks',
        'attach-input',
        'task-a',
        `--session=${'s'.repeat(MAX_TASK_REFERENCE_ID_LENGTH + 1)}`,
        '--event=event-a',
      ],
      'attach-input has invalid reference: sessionId is required',
    ],
  ])('keeps local validation explicit for %j', async (args, expected) => {
    const { runCli } = await import('../cli.js');
    await expect(runCli(args)).rejects.toThrow(expected);
  });

  it('does not normalize an untyped local error that happens to carry 404', async () => {
    vi.doMock('../commands/core.js', () => ({
      runCoreCommand: vi.fn().mockRejectedValue(
        Object.assign(new Error('attach-input local validation failed'), {
          status: 404,
        }),
      ),
    }));
    const { runCli } = await import('../cli.js');
    await expect(
      runCli(['tasks', 'attach-input', 'task-a', '--session=s', '--event=e']),
    ).rejects.toThrow('attach-input local validation failed');
  });
});
