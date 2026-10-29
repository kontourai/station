import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_SERVER_PORT } from '../commands/helpers.js';

const LOOPBACK_API_BASE = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('station workload status', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let output: string[];

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    output = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(console, 'log').mockImplementation((...parts) => {
      output.push(parts.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  test('reads the workload budget route and prints it', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          enforcement: { state: 'ready', platform: 'linux' },
          hostMemoryBytes: 17179869184,
          limits: { memoryMaxBytes: 5153751040 },
          sources: { memory: 'default', totalMemory: 'default' },
        },
      }),
    );
    const { runSurfaceCommand } = await import('../commands/surfaces.js');
    await runSurfaceCommand('workload', ['status']);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${LOOPBACK_API_BASE}/api/system/workload`,
    );
    const printed = output.join('');
    expect(printed).toContain('"state": "ready"');
    expect(printed).toContain('"memoryMaxBytes": 5153751040');
  });

  test('an older Station that lacks the route is reported, not printed as success', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: false, error: 'Not Found' }, 404),
    );
    const { runSurfaceCommand } = await import('../commands/surfaces.js');
    await expect(runSurfaceCommand('workload', ['status'])).rejects.toThrow(
      /does not report workload budgets/,
    );
    await expect(runSurfaceCommand('workload', ['set'])).rejects.toThrow(
      "Unknown workload action. Use 'status'.",
    );
  });

  test('a target flag it does not read is refused, not silently replaced by the default Station', async () => {
    const { runSurfaceCommand } = await import('../commands/surfaces.js');
    await expect(
      runSurfaceCommand('workload', [
        'status',
        '--home=/tmp/other-home',
        '--instance=wb-shot',
      ]),
    ).rejects.toThrow(
      'station workload does not accept --home, --instance. Choose the Station with --station=<name> or --api-base=<url>',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
