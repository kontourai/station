import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let originalExitCode: typeof process.exitCode;

const safeResult = {
  resultId: 'event/1',
  name: 'tool',
  terminalStatus: 'success',
  content: [{ type: 'text', text: 'authorized result' }],
  truncated: false,
  omittedParts: 0,
  omittedTextBytes: 0,
  omittedMetadataBytes: 0,
};

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

describe('task tool-result CLI operations', () => {
  it('attaches through the canonical SDK client and prints the created reference', async () => {
    const { fetch, stdout } = await runCliWithFetch(
      [
        'tasks',
        'attach-result',
        'task / 1',
        '--session=session/1',
        '--event=event/1',
        '--api-base=http://station.test',
      ],
      new Response(
        JSON.stringify({
          success: true,
          data: {
            id: 'link-1',
            sourceType: 'task',
            sourceId: 'task / 1',
            targetType: 'tool_result',
            targetId: 'tool-result/session%2F1/event%2F1',
            relationType: 'references_tool_result',
            confidence: 1,
            createdAt: '2026-08-25T00:00:00.000Z',
            source: 'user',
          },
        }),
      ),
    );

    expect(fetch).toHaveBeenCalledWith(
      'http://station.test/api/tasks/task%20%2F%201/references',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          kind: 'tool-result',
          sessionId: 'session/1',
          eventId: 'event/1',
          sourceSurface: 'cli',
        }),
      }),
    );
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining('"id": "link-1"'),
    );
  });

  it.each([
    ['text', []],
    ['json', ['--json']],
  ])('shows authorized results in %s mode', async (_mode, modeArgs) => {
    const { fetch, stdout } = await runCliWithFetch(
      [
        'tasks',
        'show-results',
        'task/a',
        '--api-base=http://station.test',
        ...modeArgs,
      ],
      new Response(
        JSON.stringify({
          success: true,
          data: [{ id: 'link-1', state: 'available', result: safeResult }],
        }),
      ),
    );

    expect(fetch).toHaveBeenCalledWith(
      'http://station.test/api/tasks/task%2Fa/tool-result-references',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual([
      { id: 'link-1', state: 'available', result: safeResult },
    ]);
    const rendered = String(stdout.mock.calls[0]?.[0]);
    if (modeArgs.length === 0) expect(rendered).toContain('\n');
    else expect(rendered).not.toContain('\n');
  });

  it.each([
    ['text', []],
    ['json', ['--json']],
  ])(
    'inspects the exact session/result tuple in %s mode',
    async (_mode, modeArgs) => {
      const { fetch, stdout } = await runCliWithFetch(
        [
          'sessions',
          'inspect',
          'station',
          'session/1',
          'event/1',
          '--api-base=http://station.test',
          ...modeArgs,
        ],
        new Response(
          JSON.stringify({
            success: true,
            data: {
              sessionId: 'session/1',
              eventId: 'event/1',
              result: safeResult,
            },
          }),
        ),
      );

      expect(fetch).toHaveBeenCalledWith(
        'http://station.test/api/orchestration/sessions/session%2F1/tool-results/event%2F1',
        expect.objectContaining({ method: 'GET' }),
      );
      expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual(safeResult);
      const rendered = String(stdout.mock.calls[0]?.[0]);
      if (modeArgs.length === 0) expect(rendered).toContain('\n');
      else expect(rendered).not.toContain('\n');
    },
  );
});
