import { describe, expect, test } from 'vitest';
import {
  findFreePort,
  findFreePortBlock,
  findPreferredPortBlock,
} from '../lib/free-ports.mjs';

/**
 * Regression guard for a suite-wide flake.
 *
 * `findFreePortBlock` asks the OS for an ephemeral port and then probes the
 * `size - 1` ports above it. When the OS hands back a start near the top of the
 * ephemeral range, that walk runs past 65535 — and `server.listen()` rejects an
 * out-of-range port by throwing *synchronously*, so the `'error'` listener
 * never fires and the RangeError escapes as an unhandled rejection:
 *
 *   RangeError: options.port should be >= 0 and < 65536. Received 65536
 *
 * It surfaced as an unrelated integration test dying mid-run, which is the
 * expensive kind of failure to diagnose: the crash lands in whichever harness
 * happened to draw the unlucky port.
 */
describe('free-ports', () => {
  test('allocates a single port inside the valid range', async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  test('keeps every port of a contiguous block inside the valid range', async () => {
    const size = 6;
    const start = await findFreePortBlock(size);
    expect(start).toBeGreaterThan(0);
    expect(start + size - 1).toBeLessThanOrEqual(65535);
  });

  test('does not throw when a preferred block would run past the top of the range', async () => {
    // 65530 leaves only 6 ports below the ceiling, so a block of 8 must step
    // past it. Before the guard this threw RangeError instead of moving on.
    const start = await findPreferredPortBlock(65530, 8);
    expect(start + 7).toBeLessThanOrEqual(65535);
  });

  test('does not throw when the preferred start is itself out of range', async () => {
    const start = await findPreferredPortBlock(70000, 4);
    expect(start).toBeGreaterThan(0);
    expect(start + 3).toBeLessThanOrEqual(65535);
  });
});
