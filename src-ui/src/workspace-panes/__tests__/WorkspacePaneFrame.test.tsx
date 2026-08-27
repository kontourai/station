/** @vitest-environment jsdom */

import type { WorkspacePaneInstanceId } from '@kontourai/station-contracts/workspace-pane';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { WorkspacePaneFrame } from '../WorkspacePaneFrame';
import { WorkspacePaneHostRuntime } from '../workspacePaneHostRuntime';

function ThrowingPane(): never {
  throw new Error('intentional pane failure');
}

describe('WorkspacePaneFrame', () => {
  test('owns the mounted renderer callbacks consumed by the host runtime', async () => {
    const runtime = new WorkspacePaneHostRuntime();
    const instanceId = 'one' as WorkspacePaneInstanceId;
    const view = render(
      <WorkspacePaneFrame
        instanceId={instanceId}
        paneName="Example pane"
        runtime={runtime}
      >
        <p>Pane content</p>
      </WorkspacePaneFrame>,
    );
    const frame = view.container.querySelector<HTMLElement>(
      'section[data-workspace-pane-lifecycle]',
    );
    if (!frame) throw new Error('expected pane frame');

    await act(async () => {
      await runtime.reconcileVisible([instanceId]);
    });
    expect(frame.dataset.workspacePaneLifecycle).toBe('ready');
    await act(async () => {
      await runtime.reconcileVisible([]);
    });
    expect(frame.dataset.workspacePaneLifecycle).toBe('suspended');
    await act(async () => {
      await runtime.reconcileVisible([instanceId]);
    });
    expect(frame.dataset.workspacePaneLifecycle).toBe('ready');
    await act(async () => {
      await runtime.revoke(instanceId);
    });
    expect(frame.dataset.workspacePaneLifecycle).toBe('disposed');
  });

  test('contains a local renderer failure and exposes a working retry', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const onFailure = vi.fn();
    const onRetry = vi.fn();
    render(
      <WorkspacePaneFrame
        instanceId={'one' as WorkspacePaneInstanceId}
        paneName="Example pane"
        onFailure={onFailure}
        onRetry={onRetry}
      >
        <ThrowingPane />
      </WorkspacePaneFrame>,
    );

    expect(screen.getByText('Example pane could not open')).toBeTruthy();
    expect(onFailure).toHaveBeenCalledWith('one');
    fireEvent.click(screen.getByRole('button', { name: 'Retry pane' }));
    expect(onRetry).toHaveBeenCalledWith('one');
    expect(screen.getByText('Example pane could not open')).toBeTruthy();
    consoleError.mockRestore();
  });
});
