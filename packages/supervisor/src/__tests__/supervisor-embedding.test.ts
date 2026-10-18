/**
 * runSupervisor embedded in-process with an injected exit and clock: after a
 * stop, no timer it scheduled may remain pending.
 */
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import { connectControl } from '../control-client.ts';
import type { Clock } from '../generation-manager.ts';
import { resolveControlEndpoint } from '../protocol.ts';
import { runSupervisor } from '../supervisor.ts';
import { FAKE_CORE, freePort } from './harness.ts';

const makeTempDir = trackTempDirs();
const savedPort = process.env.FAKE_CORE_PORT;

afterEach(() => {
  if (savedPort === undefined) delete process.env.FAKE_CORE_PORT;
  else process.env.FAKE_CORE_PORT = savedPort;
});

class TrackingClock implements Clock {
  readonly pending = new Set<NodeJS.Timeout>();
  created = 0;
  now(): number {
    return Date.now();
  }
  setTimeout(callback: () => void, ms: number): unknown {
    this.created += 1;
    const timer = setTimeout(() => {
      this.pending.delete(timer);
      callback();
    }, ms);
    this.pending.add(timer);
    return timer;
  }
  clearTimeout(timer: unknown): void {
    this.pending.delete(timer as NodeJS.Timeout);
    clearTimeout(timer as NodeJS.Timeout);
  }
}

describe('embedded supervisor', () => {
  it('leaves no timer pending after a stop with an injected exit', async () => {
    process.env.FAKE_CORE_PORT = String(await freePort());
    const home = makeTempDir('sup-embed-');
    const endpoint = resolveControlEndpoint({ home, instance: 'embed' });
    const clock = new TrackingClock();
    const logs: string[] = [];
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    void runSupervisor({
      entry: FAKE_CORE,
      buildRoot: dirname(FAKE_CORE),
      endpoint,
      instance: 'embed',
      exit: (code) => resolveExit(code),
      log: (message) => logs.push(message),
      clock,
      processHooks: false,
      selfCheckIntervalMs: 200,
    });
    const connection = await vi.waitFor(
      async () => {
        const client = await connectControl({
          path: endpoint.path,
          tokenPath: endpoint.tokenPath,
        });
        const reply = await client.request({ type: 'status', id: 's' }, [
          'status.result',
        ]);
        if (
          reply.type !== 'status.result' ||
          reply.status.state !== 'serving'
        ) {
          client.close();
          throw new Error('not serving yet');
        }
        return client;
      },
      { timeout: 20_000, interval: 100 },
    );
    // Let the self-check run a few times before stopping.
    await vi.waitFor(() => expect(clock.created).toBeGreaterThan(2), {
      timeout: 5_000,
    });
    await connection.request({ type: 'stop', id: 'x' }, ['stop.result']);
    expect(await exited, logs.join('\n')).toBe(0);
    expect(clock.pending.size, logs.join('\n')).toBe(0);
  }, 60_000);
});
