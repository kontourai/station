// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * station#1815 / #2663. `detectCliOnPath` is the only place adoption touches
 * the host. Since #2663 it answers with `findCliBinaryAsync` — the resolution
 * the engine spawns use — instead of a process-PATH-only `which`.
 *
 * The lookup is mocked here deliberately. What has to be proven at this seam
 * is the answer mapping and that the caller's cancellation and ceiling are
 * honoured: a probe nobody is waiting for is never even started, a pending
 * one stops being waited for, and a caller who passes nothing keeps an
 * unbounded wait. The real lookup against a real HOME is proven in
 * `native-engine-adoption.path-resolution.process.test.ts`.
 */
const auth = vi.hoisted(() => ({
  // The sync read of what is known now. Null by default, so every case below
  // except the one about it exercises the awaited lookup.
  findCliBinary: vi.fn((_command: string): string | null => null),
  findCliBinaryAsync: vi.fn(
    async (_command: string): Promise<string | null> =>
      '/home/u/.local/bin/muse',
  ),
}));

vi.mock('../../providers/auth/cli-auth.js', () => ({
  findCliBinary: auth.findCliBinary,
  findCliBinaryAsync: auth.findCliBinaryAsync,
}));

const { detectCliOnPath } = await import('../cli-detection.js');

/** A lookup that settles only when the test says so. */
function pendingLookup(): (value: string | null) => void {
  let settle: (value: string | null) => void = () => {};
  auth.findCliBinaryAsync.mockImplementationOnce(
    () =>
      new Promise<string | null>((resolve) => {
        settle = resolve;
      }),
  );
  return (value) => settle(value);
}

beforeEach(() => {
  auth.findCliBinaryAsync.mockClear();
  auth.findCliBinary.mockClear();
  vi.useRealTimers();
});

describe('detectCliOnPath', () => {
  test('reports an installation exactly when the shared resolver finds a binary', async () => {
    await expect(detectCliOnPath('muse')).resolves.toBe(true);
    expect(auth.findCliBinaryAsync).toHaveBeenCalledWith('muse');

    auth.findCliBinaryAsync.mockResolvedValueOnce(null);
    await expect(detectCliOnPath('muse')).resolves.toBe(false);

    auth.findCliBinaryAsync.mockRejectedValueOnce(new Error('boom'));
    await expect(detectCliOnPath('muse')).resolves.toBe(false);
  });

  test('answers a hit already known without awaiting the login-shell lookup', async () => {
    // #2663 review: the awaited lookup waits on the `$SHELL -ic` capture
    // before searching, so a CLI on the process PATH read as absent to a
    // caller whose budget ran out first.
    auth.findCliBinary.mockReturnValueOnce('/usr/bin/codex');

    await expect(detectCliOnPath('codex', { timeoutMs: 2_000 })).resolves.toBe(
      true,
    );
    expect(auth.findCliBinary).toHaveBeenCalledWith('codex');
    expect(auth.findCliBinaryAsync).not.toHaveBeenCalled();
  });

  test('leaves an optionless caller exactly as unbounded as it was', async () => {
    vi.useFakeTimers();
    const settle = pendingLookup();
    let answer: boolean | undefined;
    const probe = detectCliOnPath('claude').then((value) => {
      answer = value;
    });
    // Far past any ceiling a caller could have meant: still waiting.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(answer).toBeUndefined();
    settle('/usr/local/bin/claude');
    await probe;
    expect(answer).toBe(true);
  });

  test('stops waiting at the ceiling and answers false', async () => {
    vi.useFakeTimers();
    const settle = pendingLookup();
    let answer: boolean | undefined;
    const probe = detectCliOnPath('codex', { timeoutMs: 10_000 }).then(
      (value) => {
        answer = value;
      },
    );
    await vi.advanceTimersByTimeAsync(9_999);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await probe;
    expect(answer).toBe(false);
    // A late answer changes nothing for a caller that has been answered.
    settle('/usr/local/bin/codex');
    expect(answer).toBe(false);
  });

  test('stops waiting when the caller aborts mid-probe', async () => {
    const settle = pendingLookup();
    const controller = new AbortController();
    const probe = detectCliOnPath('codex', { signal: controller.signal });
    controller.abort();
    await expect(probe).resolves.toBe(false);
    settle('/usr/local/bin/codex');
  });

  test('never starts a locator for a caller that has already given up', async () => {
    const controller = new AbortController();
    controller.abort();

    const detected = await detectCliOnPath('codex', {
      signal: controller.signal,
    });

    // Asserted before the answer, deliberately: "resolved false" would also
    // hold for a lookup that ran. The first lookup in a process is what
    // spawns the shared `$SHELL -ic` PATH capture, and the caller of an
    // aborted probe is a runtime that has already begun tearing down.
    expect(auth.findCliBinaryAsync).not.toHaveBeenCalled();
    expect(auth.findCliBinary).not.toHaveBeenCalled();
    expect(detected).toBe(false);
  });
});
