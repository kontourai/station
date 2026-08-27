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

async function runCliWithFetch(
  args: string[],
  response: Response,
): Promise<{
  fetch: ReturnType<typeof vi.fn>;
  stdout: ReturnType<typeof vi.spyOn>;
}> {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetch);
  const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  const { runCli } = await import('../cli.js');
  await runCli(args);
  return { fetch, stdout };
}

describe('task user-input CLI operations', () => {
  it('attaches through the canonical SDK client and prints the created reference', async () => {
    const { fetch, stdout } = await runCliWithFetch(
      [
        'tasks',
        'attach-input',
        'task / 1',
        '--session=session/1',
        '--event=event/1',
        '--api-base=http://station.test',
      ],
      new Response(JSON.stringify({ success: true, data: { id: 'link-1' } })),
    );

    expect(fetch).toHaveBeenCalledWith(
      'http://station.test/api/tasks/task%20%2F%201/references',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          kind: 'user-input',
          sessionId: 'session/1',
          eventId: 'event/1',
          sourceSurface: 'cli',
        }),
      }),
    );
    expect(stdout).toHaveBeenCalledWith('{\n  "id": "link-1"\n}');
  });

  it.each([
    ['text', []],
    ['json', ['--json']],
  ])('shows authorized inputs in %s mode', async (_mode, modeArgs) => {
    const { fetch, stdout } = await runCliWithFetch(
      [
        'tasks',
        'show-inputs',
        'task/a',
        '--api-base=http://station.test',
        ...modeArgs,
      ],
      new Response(
        JSON.stringify({
          success: true,
          data: [
            {
              id: 'link-1',
              state: 'available',
              sessionId: 'session-1',
              eventId: 'event-1',
              turnId: 'turn-1',
              input: {
                prompt: 'authorized input',
                attachments: [
                  { name: 'brief.pdf', mediaType: 'application/pdf', size: 9 },
                ],
              },
            },
          ],
        }),
      ),
    );

    expect(fetch).toHaveBeenCalledWith(
      'http://station.test/api/tasks/task%2Fa/user-input-references',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual([
      expect.objectContaining({
        input: {
          prompt: 'authorized input',
          attachments: [
            { name: 'brief.pdf', mediaType: 'application/pdf', size: 9 },
          ],
        },
      }),
    ]);
    const rendered = String(stdout.mock.calls[0]?.[0]);
    if (modeArgs.length === 0) expect(rendered).toContain('\n');
    else expect(rendered).not.toContain('\n');
  });
});
