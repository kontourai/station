/**
 * `station-supervisor --request`: the entry as a client of a running
 * supervisor, run as a child process against a real supervisor child.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import { makeShortHome, SUPERVISOR_MAIN, startSupervisor } from './harness.ts';

const makeTempDir = trackTempDirs();

function request(home: string, args: string[], instance = 'test') {
  const result = spawnSync(
    process.execPath,
    [
      SUPERVISOR_MAIN,
      '--request',
      ...args,
      '--home',
      home,
      '--instance',
      instance,
    ],
    { encoding: 'utf8', timeout: 90_000, windowsHide: true },
  );
  const lines = result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { ...result, lines };
}

describe('station-supervisor --request (child processes)', () => {
  it('exits 3 when no supervisor runs for the home and instance', () => {
    const home = makeTempDir('sup-client-none-');
    const result = request(home, ['status']);
    expect(result.status, result.stderr).toBe(3);
    expect(result.stderr).toContain('no supervisor is running');
    expect(result.lines).toEqual([]);
  });

  it('reports status, runs a handoff with its progress, and stops the supervisor', async () => {
    const home = makeShortHome();
    const supervisor = await startSupervisor({ home });

    const status = request(home, ['status']);
    expect(status.status, status.stderr).toBe(0);
    expect(status.lines).toEqual([
      expect.objectContaining({
        type: 'status.result',
        status: expect.objectContaining({
          state: 'serving',
          active: expect.objectContaining({ generation: 1 }),
        }),
      }),
    ]);

    const handoff = request(home, ['handoff']);
    expect(handoff.status, handoff.stderr).toBe(0);
    expect(handoff.lines.map((line) => line.phase ?? line.type)).toEqual([
      'trial-started',
      'trial-parked',
      'draining',
      'drained',
      'promoted',
      'handoff.result',
    ]);
    expect(handoff.lines.at(-1)).toMatchObject({
      outcome: 'committed',
      generation: 2,
    });

    const stop = request(home, ['stop']);
    expect(stop.status, stop.stderr).toBe(0);
    expect(stop.lines).toEqual([
      expect.objectContaining({ type: 'stop.result', accepted: true }),
      { type: 'stopped' },
    ]);
    // `stopped` means the supervisor closed the channel on its way out.
    expect(await supervisor.exited).toEqual({ code: 0, signal: null });
  }, 120_000);

  it('refuses an unknown request and --entry outside a handoff, exit 2', () => {
    const home = makeTempDir('sup-client-usage-');
    const unknown = request(home, ['restart']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain(
      '--request must be one of status, stop, handoff',
    );
    const entry = request(home, ['status', '--entry', 'x.js']);
    expect(entry.status).toBe(2);
    expect(entry.stderr).toContain('--entry applies only to --request handoff');
  });
});
