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

async function runCliFailure(input: {
  args: string[];
  status: 404 | 409 | 503;
  error: string;
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: input.error,
          details: {
            report: '/private/reports/answer.json',
            excerpt: 'private answer excerpt',
            id: 'bundle-secret',
          },
        }),
        { status: input.status },
      ),
    ),
  );
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  const { runCli } = await import('../cli.js');
  await runCli(input.args);

  return { stderr, stdout };
}

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
    const { stderr, stdout } = await runCliFailure(input);
    const output = stderr.mock.calls.map((call) => call.join(' ')).join('\n');

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
