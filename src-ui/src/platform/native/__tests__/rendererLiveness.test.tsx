/** @vitest-environment jsdom */
import { render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createNativeRendererMountCommit } from '../rendererLiveness';

describe('NativeRendererMountCommit', () => {
  it('commits only after layout mount and only once across StrictMode and remounts', async () => {
    const commitRendererMount = vi.fn(async () => ({
      status: 'ok' as const,
      value: undefined,
    }));
    const resolve = vi.fn(async () => ({
      platform: 'tauri' as const,
      getCapabilityReport: vi.fn(async () => ({
        status: 'ok' as const,
        value: { platform: 'macos' as const, capabilities: [] },
      })),
      commitRendererMount,
    }));
    const MountCommit = createNativeRendererMountCommit(resolve as never);

    expect(resolve).not.toHaveBeenCalled();
    const first = render(
      <StrictMode>
        <MountCommit />
      </StrictMode>,
    );
    await waitFor(() => expect(commitRendererMount).toHaveBeenCalledOnce());

    first.unmount();
    render(
      <StrictMode>
        <MountCommit />
      </StrictMode>,
    );
    await Promise.resolve();
    expect(resolve).toHaveBeenCalledOnce();
    expect(commitRendererMount).toHaveBeenCalledOnce();
  });

  it('does not expose a native mount command in the browser adapter', async () => {
    const commitRendererMount = vi.fn();
    const MountCommit = createNativeRendererMountCommit(
      async () =>
        ({
          platform: 'web' as const,
          commitRendererMount,
        }) as never,
    );

    render(<MountCommit />);
    await Promise.resolve();
    expect(commitRendererMount).not.toHaveBeenCalled();
  });

  it('does not invoke desktop readiness from a native-mobile build', async () => {
    const commitRendererMount = vi.fn();
    const getCapabilityReport = vi.fn(async () => ({
      status: 'ok' as const,
      value: { platform: 'ios' as const, capabilities: [] },
    }));
    const MountCommit = createNativeRendererMountCommit(
      async () =>
        ({
          platform: 'tauri' as const,
          getCapabilityReport,
          commitRendererMount,
        }) as never,
    );

    render(<MountCommit />);
    await waitFor(() => expect(getCapabilityReport).toHaveBeenCalledOnce());
    expect(commitRendererMount).not.toHaveBeenCalled();
  });

  it('fails closed without retrying or rendering diagnostic UI', async () => {
    const commitRendererMount = vi.fn(async () => ({
      status: 'error' as const,
      command: 'commit-renderer-mount' as const,
      message: 'host unavailable',
    }));
    const MountCommit = createNativeRendererMountCommit(
      async () =>
        ({
          platform: 'tauri' as const,
          getCapabilityReport: vi.fn(async () => ({
            status: 'ok' as const,
            value: { platform: 'linux' as const, capabilities: [] },
          })),
          commitRendererMount,
        }) as never,
    );

    const view = render(<MountCommit />);
    await waitFor(() => expect(commitRendererMount).toHaveBeenCalledOnce());
    expect(view.container.childElementCount).toBe(0);
  });
});
