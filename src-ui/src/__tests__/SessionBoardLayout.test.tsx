/**
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

const consoleBoardView = vi.fn((_props: unknown) => (
  <div>Canonical console board</div>
));

vi.mock('../views/ConsoleBoardView', () => ({
  ConsoleBoardView: (props: unknown) => consoleBoardView(props),
}));

import { SessionBoardLayout } from '../components/session/SessionBoardLayout';

test('adapts the published Console board view instead of re-implementing it', () => {
  render(
    <SessionBoardLayout
      projectSlug="demo"
      layoutSlug="session-board"
      config={{}}
    />,
  );

  expect(screen.getByText('Canonical console board')).toBeTruthy();
  expect(consoleBoardView).toHaveBeenCalledWith(
    expect.objectContaining({ projectSlug: 'demo' }),
  );
});
