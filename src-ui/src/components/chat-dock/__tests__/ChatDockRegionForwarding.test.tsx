/** @vitest-environment jsdom */
import { render, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ChatDock } from '../ChatDock';

const probe = vi.fn();
vi.mock('../../../workspace-panes/AmbientChatDockPaneHost', () => ({
  AmbientChatDockPaneHost: (props: unknown) => {
    probe(props);
    return null;
  },
}));

describe('ChatDock region forwarding', () => {
  test('forwards regionId through LazyBoundary', async () => {
    render(<ChatDock regionId="right" onNavigate={vi.fn()} />);
    await waitFor(() => expect(probe).toHaveBeenCalled());
    expect(probe.mock.calls.at(-1)?.[0]).toMatchObject({ regionId: 'right' });
  });
});
