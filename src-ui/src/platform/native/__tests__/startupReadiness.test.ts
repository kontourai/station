/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

import {
  proveAndCommitStartupReadiness,
  startStartupReadinessProof,
} from '../startupReadiness';

const running = (generation = 2) => ({
  phase: 'running',
  ownership: 'sidecar',
  generation,
  instanceId: 'desktop-sidecar-stable',
  bootId: `boot-${generation}`,
  apiBase: 'http://127.0.0.1:4123',
});
const adapter = (statuses: unknown[]) => ({
  platform: 'tauri' as const,
  getBundledServerStatus: vi.fn(async () => statuses.shift()),
  commitStartupReadiness: vi.fn(async () => ({
    status: 'ok',
    value: undefined,
  })),
  commitStartupRecoveryUi: vi.fn(async () => ({
    status: 'ok',
    value: undefined,
  })),
});

describe('desktop startup readiness proof', () => {
  it('retries a status error and commits only the later exact generation', async () => {
    const native = adapter([
      { status: 'error' },
      { status: 'ok', value: running(3) },
    ]);
    await expect(proveAndCommitStartupReadiness(native as never)).resolves.toBe(
      true,
    );
    expect(native.commitStartupReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 3 }),
    );
  });
  it('does not fabricate recovery for an owned missing ticket', async () => {
    const native = adapter(
      Array.from({ length: 5 }, () => ({
        status: 'ok',
        value: { phase: 'starting', ownership: 'sidecar' },
      })),
    );
    await expect(proveAndCommitStartupReadiness(native as never)).resolves.toBe(
      false,
    );
    expect(native.getBundledServerStatus).toHaveBeenCalledTimes(5);
    expect(native.commitStartupRecoveryUi).not.toHaveBeenCalled();
  });
  it('commits truthful service recovery without a sidecar ticket', async () => {
    const native = adapter([
      { status: 'ok', value: { phase: 'stopped', ownership: 'service' } },
    ]);
    await expect(proveAndCommitStartupReadiness(native as never)).resolves.toBe(
      true,
    );
    expect(native.commitStartupRecoveryUi).toHaveBeenCalledOnce();
  });
  it('retries when the native host refuses a stale or unproved generation', async () => {
    const native = adapter([
      { status: 'ok', value: running(2) },
      { status: 'ok', value: running(3) },
    ]);
    native.commitStartupReadiness
      .mockResolvedValueOnce({ status: 'error', value: undefined })
      .mockResolvedValueOnce({ status: 'ok', value: undefined });
    await expect(proveAndCommitStartupReadiness(native as never)).resolves.toBe(
      true,
    );
    expect(native.commitStartupReadiness).toHaveBeenCalledTimes(2);
    expect(native.commitStartupReadiness).toHaveBeenLastCalledWith(
      expect.objectContaining({ generation: 3 }),
    );
  });
  it('pulls and proves a current ticket even when its native event was missed', async () => {
    const native = {
      ...adapter([{ status: 'ok', value: running(4) }]),
      subscribeToStartupReadinessRetry: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const proof = startStartupReadinessProof(native as never);
    await vi.waitFor(() => {
      expect(native.commitStartupReadiness).toHaveBeenCalledWith(
        expect.objectContaining({ generation: 4 }),
      );
    });
    expect(native.subscribeToStartupReadinessRetry).toHaveBeenCalledOnce();
    proof.dispose();
  });
  it('coalesces retry events and ignores them after one successful commit', async () => {
    let retry: (() => void) | undefined;
    let settleCommit:
      | ((value: { status: 'ok'; value: undefined }) => void)
      | undefined;
    const native = {
      ...adapter([{ status: 'ok', value: running(8) }]),
      commitStartupReadiness: vi.fn(
        () =>
          new Promise<{ status: 'ok'; value: undefined }>((resolve) => {
            settleCommit = resolve;
          }),
      ),
      subscribeToStartupReadinessRetry: vi.fn((listener: () => void) => {
        retry = listener;
        return { dispose: vi.fn() };
      }),
    };
    const proof = startStartupReadinessProof(native as never);
    await vi.waitFor(() =>
      expect(native.commitStartupReadiness).toHaveBeenCalledOnce(),
    );

    retry?.();
    retry?.();
    retry?.();
    expect(native.commitStartupReadiness).toHaveBeenCalledOnce();

    settleCommit?.({ status: 'ok', value: undefined });
    await vi.waitFor(() =>
      expect(native.commitStartupReadiness).toHaveBeenCalledOnce(),
    );
    retry?.();
    await Promise.resolve();
    expect(native.commitStartupReadiness).toHaveBeenCalledOnce();
    proof.dispose();
  });
  it('aborts an in-flight retry delay before disposing its subscription', async () => {
    const disposeSubscription = vi.fn();
    const native = {
      ...adapter([{ status: 'error' }]),
      subscribeToStartupReadinessRetry: vi.fn(() => ({
        dispose: disposeSubscription,
      })),
    };
    const proof = startStartupReadinessProof(native as never);
    await Promise.resolve();
    await Promise.resolve();
    expect(native.getBundledServerStatus).toHaveBeenCalledOnce();

    proof.dispose();
    proof.dispose();
    await Promise.resolve();

    expect(disposeSubscription).toHaveBeenCalledOnce();
    expect(native.getBundledServerStatus).toHaveBeenCalledOnce();
    expect(native.commitStartupReadiness).not.toHaveBeenCalled();
  });
  it('owns a parent signal that was already aborted before lazy proof startup', async () => {
    const disposeSubscription = vi.fn();
    const native = {
      ...adapter([{ status: 'ok', value: running(6) }]),
      subscribeToStartupReadinessRetry: vi.fn(() => ({
        dispose: disposeSubscription,
      })),
    };
    const parent = new AbortController();
    parent.abort();

    const proof = startStartupReadinessProof(native as never, parent.signal);

    await Promise.resolve();
    expect(disposeSubscription).toHaveBeenCalledOnce();
    expect(native.getBundledServerStatus).not.toHaveBeenCalled();
    expect(native.commitStartupReadiness).not.toHaveBeenCalled();
    proof.dispose();
    expect(disposeSubscription).toHaveBeenCalledOnce();
  });
  it('cancels a retry delay before a sixth-sidecar poll can begin', async () => {
    const native = adapter([{ status: 'error' }]);
    const controller = new AbortController();
    const pending = proveAndCommitStartupReadiness(
      native as never,
      controller.signal,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(native.getBundledServerStatus).toHaveBeenCalledOnce();
    controller.abort();
    await expect(pending).resolves.toBe(false);
    expect(native.getBundledServerStatus).toHaveBeenCalledOnce();
  });
});
