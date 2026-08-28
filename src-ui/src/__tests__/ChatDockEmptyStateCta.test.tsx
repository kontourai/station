// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { Empty } from '../components/state';

// archive#800: the dock's empty state carries its own action now instead of
// instructing "Click “New” above" — copy that named a control rendering as a
// bare + on phone. `ChatDockContentArea` itself pulls in the whole dock body,
// so this covers the action contract the content area renders.
describe('dock empty-state CTA (#800)', () => {
  test('renders a real control that starts a chat', () => {
    const onNewChat = vi.fn();
    render(
      <Empty
        variant="prominent"
        label="No active session"
        action={
          <button
            type="button"
            className="button button--primary"
            onClick={onNewChat}
          >
            Start a chat
          </button>
        }
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start a chat' }));

    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Click .New. above/)).toBeNull();
  });
});
