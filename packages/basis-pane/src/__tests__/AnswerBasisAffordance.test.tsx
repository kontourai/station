// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { AnswerBasisAffordance } from '../AnswerBasisAffordance';

const query = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk/answer-basis', () => ({
  useAnswerBasisQuery: query,
}));

describe('AnswerBasisAffordance', () => {
  test('reports checking and captures the invoking button', () => {
    query.mockReturnValue({ data: undefined, error: null });
    const onOpen = vi.fn();
    render(
      <AnswerBasisAffordance
        sessionId="session"
        turnId="turn"
        enabled={false}
        onOpen={onOpen}
      />,
    );
    const button = screen.getByRole('button', { name: 'Basis · Checking…' });
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledWith(button);
  });

  test('names protected failure without leaking detail', () => {
    query.mockReturnValue({
      data: undefined,
      error: new Error('private identity'),
    });
    render(
      <AnswerBasisAffordance
        sessionId="session"
        turnId="turn"
        enabled
        onOpen={() => undefined}
      />,
    );
    expect(screen.getByRole('button').textContent).toBe('Basis · Unavailable');
    expect(document.body.textContent).not.toContain('private identity');
  });
});
