// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { AnswerBasisAffordance } from '../AnswerBasisAffordance';

const query = vi.hoisted(() => vi.fn());
const mocks = vi.hoisted(() => {
  class MockAnswerBasisRequestError extends Error {
    constructor(readonly status: number) {
      super('Answer basis unavailable');
    }
  }
  return { MockAnswerBasisRequestError };
});
vi.mock('@kontourai/station-sdk/answer-basis', () => ({
  useAnswerBasisQuery: query,
  AnswerBasisRequestError: mocks.MockAnswerBasisRequestError,
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
  /**
   * #1536 B3. The route answers 404 when Station recorded no basis for the
   * turn and keeps 503 for a read it could not perform. Collapsing both into
   * "Unavailable" made a healthy instance accuse itself of a failure.
   */
  test('a recorded-nothing 404 reads as an absence, not a failure', () => {
    query.mockReturnValue({
      data: undefined,
      error: new mocks.MockAnswerBasisRequestError(404),
    });
    render(
      <AnswerBasisAffordance
        sessionId="session"
        turnId="turn"
        enabled
        onOpen={() => undefined}
      />,
    );
    expect(screen.getByRole('button').textContent).toBe('Basis · Not recorded');
  });

  test('a read that could not be performed still reads as unavailable', () => {
    query.mockReturnValue({
      data: undefined,
      error: new mocks.MockAnswerBasisRequestError(503),
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
  });
});
