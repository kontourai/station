import { MAX_TASK_REFERENCE_ID_LENGTH } from '@kontourai/station-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Protected failures of the task reference families (user inputs, tool
// results, answer support): the CLI prints a family-level message, exits
// nonzero, and never echoes the server's protected diagnostics.

let originalExitCode: typeof process.exitCode;

beforeEach(() => {
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.doUnmock('../commands/core.js');
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
});

function stubFetchResponse(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })),
  );
}

async function runCliCapturing(args: string[]) {
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  const { runCli } = await import('../cli.js');
  await runCli(args);
  return {
    output: stderr.mock.calls.map((call) => call.join(' ')).join('\n'),
    stdout,
  };
}

function expectFailureOutput(
  output: string,
  mode: 'text' | 'json',
  expected: { error: string; status: number; retryable?: true },
) {
  expect(process.exitCode).toBe(1);
  if (mode === 'json')
    expect(JSON.parse(output)).toEqual({ success: false, ...expected });
  else expect(output).toBe(`Error: ${expected.error}`);
}

const MODES = ['text', 'json'] as const;
const withMode = (mode: 'text' | 'json') => (mode === 'json' ? ['--json'] : []);

const API_BASE = '--api-base=http://station.test';

const TOOL_RESULT_COMMANDS = {
  'tasks attach-result': [
    'tasks',
    'attach-result',
    'task-a',
    '--session=session-secret',
    '--event=event-secret',
  ],
  'tasks show-results': ['tasks', 'show-results', 'task-a'],
  'sessions inspect': [
    'sessions',
    'inspect',
    'station',
    'session-secret',
    'event-secret',
  ],
} as const;

const REFERENCE_FAMILIES = [
  {
    family: 'user input',
    message: 'User input references are unavailable.',
    retryMessage:
      'User input references are temporarily unavailable. Retry the request.',
    body: {
      success: false,
      error: 'event=event-secret prompt=private input',
      details: {
        sessionId: 'session-secret',
        prompt: 'private input',
        attachments: [{ name: 'secret.pdf' }],
      },
    },
    secrets: ['event-secret', 'session-secret', 'private input', 'secret.pdf'],
    commands: {
      'tasks attach-input': [
        'tasks',
        'attach-input',
        'task-a',
        '--session=session-secret',
        '--event=event-secret',
      ],
      'tasks show-inputs': ['tasks', 'show-inputs', 'task-a'],
    },
  },
  {
    family: 'tool result',
    message: 'Tool results are unavailable.',
    retryMessage:
      'Tool results are temporarily unavailable. Retry the request.',
    body: {
      success: false,
      error: 'event=event-secret result=private result',
      details: {
        sessionId: 'session-secret',
        result: 'private result',
        paths: ['/private/path'],
      },
    },
    secrets: [
      'event-secret',
      'session-secret',
      'private result',
      '/private/path',
    ],
    commands: TOOL_RESULT_COMMANDS,
  },
] as const;

describe('task reference CLI protected 404/503 failures', () => {
  it.each(
    REFERENCE_FAMILIES.flatMap((family) =>
      Object.entries(family.commands).flatMap(([command, args]) =>
        MODES.flatMap((mode) =>
          ([404, 503] as const).map(
            (status) => [command, mode, status, family, args] as const,
          ),
        ),
      ),
    ),
  )(
    '%s %s %i stays generic and redacts protected diagnostics',
    async (_command, mode, status, family, args) => {
      stubFetchResponse(status, family.body);
      const { output, stdout } = await runCliCapturing([
        ...args,
        API_BASE,
        ...withMode(mode),
      ]);

      expectFailureOutput(
        output,
        mode,
        status === 503
          ? { error: family.retryMessage, status, retryable: true }
          : { error: family.message, status },
      );
      expect(stdout).not.toHaveBeenCalled();
      for (const secret of family.secrets) expect(output).not.toContain(secret);
    },
  );
});

describe('task tool-result CLI SDK failures', () => {
  it.each([
    ['tasks attach-result', 'json', 401, 'response'],
    ['tasks attach-result', 'text', 403, 'response'],
    ['tasks attach-result', 'json', 0, 'network'],
    ['tasks attach-result', 'text', 200, 'malformed'],
    ['tasks show-results', 'text', 401, 'response'],
    ['tasks show-results', 'json', 403, 'response'],
    ['tasks show-results', 'text', 0, 'network'],
    ['tasks show-results', 'json', 200, 'malformed'],
    ['sessions inspect', 'json', 401, 'response'],
    ['sessions inspect', 'text', 403, 'response'],
    ['sessions inspect', 'json', 0, 'network'],
    ['sessions inspect', 'text', 200, 'malformed'],
  ] as const)(
    '%s %s turns SDK failures with status %i (%s) into generic output',
    async (command, mode, status, failureKind) => {
      if (failureKind === 'network') {
        vi.stubGlobal(
          'fetch',
          vi
            .fn()
            .mockRejectedValue(
              new Error('network event=event-secret result=private result'),
            ),
        );
      } else {
        stubFetchResponse(
          status,
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
        );
      }
      const { output, stdout } = await runCliCapturing([
        ...TOOL_RESULT_COMMANDS[command],
        API_BASE,
        ...withMode(mode),
      ]);

      expectFailureOutput(output, mode, {
        error: 'Tool results are unavailable.',
        status,
      });
      expect(stdout).not.toHaveBeenCalled();
      for (const secret of REFERENCE_FAMILIES[1].secrets)
        expect(output).not.toContain(secret);
    },
  );
});

describe('task reference CLI local validation', () => {
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
  ])('keeps local validation explicit for %j', async (args, expected) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const { runCli } = await import('../cli.js');
    await expect(runCli(args)).rejects.toThrow(expected);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [
      ['tasks', 'attach-input', 'task-a', '--session=s', '--event=e'],
      'attach-input',
    ],
    [['sessions', 'inspect', 'station', 'session-a', 'event-a'], 'inspect'],
  ])(
    'does not normalize an untyped local error that happens to carry 404: %j',
    async (args, action) => {
      vi.doMock('../commands/core.js', () => ({
        runCoreCommand: vi.fn().mockRejectedValue(
          Object.assign(new Error(`${action} local validation failed`), {
            status: 404,
          }),
        ),
      }));
      const { runCli } = await import('../cli.js');
      await expect(runCli(args)).rejects.toThrow(
        `${action} local validation failed`,
      );
    },
  );
});

describe('answer-support CLI protected failures', () => {
  it.each([
    {
      label: '404 text read refusal',
      args: ['tasks', 'show-support', 'task-a'],
      status: 404 as const,
      error: 'Answer support unavailable',
    },
    {
      label: '409 JSON compare-and-swap conflict',
      args: [
        'tasks',
        'replace-support',
        'task-a',
        '--reference=reference-a',
        '--bundle=bundle-a',
        '--claim=claim-a',
        '--revision=1',
        '--json',
      ],
      status: 409 as const,
      error: 'Answer support conflicts',
    },
    {
      label: '503 JSON retryable read outage',
      args: [
        'tasks',
        'list-support-bundles',
        'task-a',
        '--reference=reference-a',
        '--json',
      ],
      status: 503 as const,
      error: 'Answer support temporarily unavailable',
    },
  ])('$label is generic on stderr and exits nonzero', async (input) => {
    stubFetchResponse(input.status, {
      success: false,
      error: input.error,
      details: {
        report: '/private/reports/answer.json',
        excerpt: 'private answer excerpt',
        id: 'bundle-secret',
      },
    });
    const { output, stdout } = await runCliCapturing(input.args);

    expect(process.exitCode).toBe(1);
    if (input.args.includes('--json')) {
      expect(output).not.toContain('Error:');
      expect(JSON.parse(output)).toMatchObject({
        success: false,
        error: input.error,
        status: input.status,
        ...(input.status === 503 ? { retryable: true } : {}),
      });
    } else {
      expect(output).toBe(`Error: ${input.error}`);
    }
    expect(stdout).not.toHaveBeenCalled();
    for (const protectedValue of [
      '/private/reports/answer.json',
      'private answer excerpt',
      'bundle-secret',
      'reference-a',
    ])
      expect(output).not.toContain(protectedValue);
  });
});
