/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { transport } = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock('../authenticatedTransport', () => ({
  nativeAuthenticatedTransport: transport,
}));

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
  beforeEach(() => transport.mockReset());
  it('retries a status error and commits only the later exact generation', async () => {
    const native = adapter([
      { status: 'error' },
      { status: 'ok', value: running(3) },
    ]);
    transport.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          instanceId: 'desktop-sidecar-stable',
          bootId: 'boot-3',
        }),
        { status: 200 },
      ),
    );
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
  it('rejects mismatched identity and retries the current generation', async () => {
    const native = adapter([
      { status: 'ok', value: running(2) },
      ...Array.from({ length: 4 }, () => ({ status: 'ok', value: running(3) })),
    ]);
    transport
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            instanceId: 'desktop-sidecar-stable',
            bootId: 'wrong',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            instanceId: 'desktop-sidecar-stable',
            bootId: 'boot-3',
          }),
          { status: 200 },
        ),
      );
    await expect(proveAndCommitStartupReadiness(native as never)).resolves.toBe(
      true,
    );
    expect(native.commitStartupReadiness).toHaveBeenCalledTimes(1);
    expect(native.commitStartupReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 3 }),
    );
  });
  it('pulls and proves a current ticket even when its native event was missed', async () => {
    const native = {
      ...adapter([{ status: 'ok', value: running(4) }]),
      subscribeToStartupReadinessRetry: vi.fn(() => ({ dispose: vi.fn() })),
    };
    transport.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          instanceId: 'desktop-sidecar-stable',
          bootId: 'boot-4',
        }),
        { status: 200 },
      ),
    );
    const proof = startStartupReadinessProof(native as never);
    await vi.waitFor(() => {
      expect(native.commitStartupReadiness).toHaveBeenCalledWith(
        expect.objectContaining({ generation: 4 }),
      );
    });
    expect(native.subscribeToStartupReadinessRetry).toHaveBeenCalledOnce();
    proof.dispose();
  });
});
