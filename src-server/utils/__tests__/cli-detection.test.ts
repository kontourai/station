// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * station#1815. `detectCliOnPath` is the only place adoption touches the host,
 * and until now it accepted neither cancellation nor a ceiling — which is why
 * shutdown's only options were to hang on a probe or to stop waiting and
 * release the home while the probe (and the registry write behind it) was
 * still running.
 *
 * The locator child is mocked here deliberately. What has to be proven at
 * this seam is that the caller's cancellation and ceiling REACH
 * `execFile` — that a probe nobody is waiting for is never even started, and
 * that a caller who passes nothing keeps exactly the unbounded behaviour it
 * had. Node's own kill-on-abort is its documented contract, not this
 * function's, and asserting it here would mean a spawned child and a
 * constant wall-clock bound of the kind `vitest-resource-manifest.mjs`
 * warns against.
 */
const child = vi.hoisted(() => ({
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      callback(null, '/usr/local/bin/claude\n');
      return {} as unknown;
    },
  ),
}));

vi.mock('node:child_process', () => ({ execFile: child.execFile }));

const { detectCliOnPath } = await import('../cli-detection.js');

function lastOptions(): Record<string, unknown> {
  const call = child.execFile.mock.calls.at(-1);
  if (!call) throw new Error('the locator was never invoked');
  return call[2];
}

beforeEach(() => {
  child.execFile.mockClear();
});

describe('detectCliOnPath', () => {
  test('reports an installation only for a locator that printed a path', async () => {
    await expect(detectCliOnPath('claude')).resolves.toBe(true);

    child.execFile.mockImplementationOnce((_f, _a, _o, callback) => {
      // A locator exiting 0 with no path — a shell-wrapper edge case, and not
      // an installation.
      callback(null, '   \n');
      return {} as unknown;
    });
    await expect(detectCliOnPath('claude')).resolves.toBe(false);

    child.execFile.mockImplementationOnce((_f, _a, _o, callback) => {
      callback(new Error('exit 1'), '');
      return {} as unknown;
    });
    await expect(detectCliOnPath('claude')).resolves.toBe(false);
  });

  test('leaves an optionless caller exactly as unbounded as it was', async () => {
    await detectCliOnPath('claude');
    // `timeout: 0` is Node's own "no ceiling"; anything else here would turn
    // a slow host into "not installed" on `/api/system/status`, which never
    // asked for a ceiling.
    expect(lastOptions()).toMatchObject({ signal: undefined, timeout: 0 });
  });

  test('forwards the caller cancellation and ceiling to the locator', async () => {
    const controller = new AbortController();
    await detectCliOnPath('codex', {
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    expect(lastOptions()).toMatchObject({
      signal: controller.signal,
      timeout: 10_000,
    });
  });

  test('never starts a locator for a caller that has already given up', async () => {
    const controller = new AbortController();
    controller.abort();

    const detected = await detectCliOnPath('codex', {
      signal: controller.signal,
    });

    // Asserted before the answer, deliberately. "Resolved false" would also
    // hold for a locator that ran and was killed — the mock here does not
    // honour a signal, so only this assertion discriminates. `execFile` with
    // an aborted signal still creates the child before killing it, and the
    // caller of an aborted probe is a runtime that has already begun tearing
    // its home down.
    expect(child.execFile).not.toHaveBeenCalled();
    expect(detected).toBe(false);
  });
});
