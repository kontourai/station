/** @vitest-environment jsdom */
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ChatDock } from '../ChatDock';

const probe = vi.fn();
vi.mock('../../../workspace-panes/AmbientChatDockPaneHost', () => ({
  AmbientChatDockPaneHost: (props: unknown) => {
    probe(props);
    return null;
  },
}));

describe('ChatDock region forwarding', () => {
  beforeEach(() => probe.mockClear());

  test('forwards regionId through LazyBoundary', async () => {
    render(<ChatDock regionId="right" />);
    await waitFor(() => expect(probe).toHaveBeenCalled());
    expect(probe.mock.calls.at(-1)?.[0]).toMatchObject({ regionId: 'right' });
  });

  // A second mount in the same document (kontourai/station#1301):
  // `loadAmbientChatDockPaneHost` must hand each `lazy()` its own promise or
  // this render never returns. The spin is synchronous, so vitest's 30s
  // `testTimeout` never gets to fire: a regression hangs the file rather
  // than failing it.
  test('the legacy mount forwards no region and keeps the chat renderer', async () => {
    const onRequestAuth = vi.fn();
    render(<ChatDock onRequestAuth={onRequestAuth} />);
    await waitFor(() => expect(probe).toHaveBeenCalled());
    const props = probe.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(props.regionId).toBeUndefined();
    expect(props.onRequestAuth).toBe(onRequestAuth);
    expect(typeof props.renderChatPane).toBe('function');
  });
});
