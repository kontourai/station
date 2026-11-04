import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listProjectTerminalScripts,
  runProjectTerminalScript,
} from '../client/projects';
import {
  approveTerminalRun,
  declineTerminalRun,
  listConversationTerminalRuns,
} from '../client/terminal-runs';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const run = {
  runId: 'run-1',
  state: 'needs_approval',
  command: 'npm test',
  cwd: '/work/alpha',
  conversationId: 'conv-1',
  projectSlug: 'alpha',
  bindingKey: 'thread:s1',
  createdAt: '2026-11-03T00:00:00.000Z',
  expiresAt: '2026-11-03T00:10:00.000Z',
};

describe('terminal run and script runner clients (#3994)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it("lists a conversation's open runs, and none from a Station without them", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json(200, { success: true, data: { runs: [run] } }),
    );
    await expect(
      listConversationTerminalRuns('http://s.test', 'conv 1'),
    ).resolves.toEqual([run]);
    expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe(
      'http://s.test/api/terminal/runs?conversationId=conv%201',
    );
    vi.mocked(fetch).mockResolvedValueOnce(json(404, { success: false }));
    await expect(
      listConversationTerminalRuns('http://s.test', 'conv-1'),
    ).resolves.toEqual([]);
  });

  it('approves and declines one run by id, and surfaces a refusal', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json(200, { success: true, data: { ...run, state: 'running' } }),
    );
    await expect(
      approveTerminalRun('http://s.test', 'run-1'),
    ).resolves.toMatchObject({ state: 'running' });
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toBe('http://s.test/api/terminal/runs/run-1/approve');
    expect(init?.method).toBe('POST');
    vi.mocked(fetch).mockResolvedValueOnce(
      json(409, {
        success: false,
        error: 'This command was already declined.',
      }),
    );
    await expect(declineTerminalRun('http://s.test', 'run-1')).rejects.toThrow(
      'This command was already declined.',
    );
  });

  it('lists and runs package scripts in the Project binding', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(404, { success: false }));
    await expect(
      listProjectTerminalScripts('http://s.test', 'alpha'),
    ).resolves.toBeNull();
    vi.mocked(fetch).mockResolvedValueOnce(
      json(200, { success: true, data: { terminalId: 't-1', cwd: '/w' } }),
    );
    await expect(
      runProjectTerminalScript('http://s.test', 'alpha', 'test'),
    ).resolves.toEqual({ terminalId: 't-1' });
    expect(
      JSON.parse(String(vi.mocked(fetch).mock.calls[1]![1]?.body)),
    ).toEqual({ bindingKey: 'project', script: 'test' });
  });
});
