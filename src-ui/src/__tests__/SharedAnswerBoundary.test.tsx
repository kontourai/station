/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { lazy } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharedAnswerBoundary } from '../views/share/SharedAnswerBoundary';

/**
 * archive#1423 — the share page sits above the app shell,
 * so nothing else catches a throw or a failed chunk fetch. Both used to
 * white-screen indistinguishably, which makes an honest message impossible.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function Boom(): never {
  throw new Error('render exploded');
}

describe('SharedAnswerBoundary', () => {
  it('renders its children when nothing fails', () => {
    render(
      <SharedAnswerBoundary>
        <p>The shared answer.</p>
      </SharedAnswerBoundary>,
    );
    expect(screen.getByText('The shared answer.')).toBeTruthy();
  });

  it('names a render failure instead of showing a blank page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(
      <SharedAnswerBoundary>
        <Boom />
      </SharedAnswerBoundary>,
    );

    expect(
      screen.getByText('This shared answer could not be displayed'),
    ).toBeTruthy();
// The honesty rule the whole feature holds to: a page that failed to read
// anything must not imply anything about the answer.
    expect(screen.getByText(/nothing was successfully read/)).toBeTruthy();
    expect(container.textContent).not.toBe('');
  });

  it('offers a reload rather than leaving the recipient stuck', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <SharedAnswerBoundary>
        <Boom />
      </SharedAnswerBoundary>,
    );
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('shows a non-blank fallback while the page chunk is still loading', () => {
    const Never = lazy(() => new Promise<never>(() => {}));
    const { container } = render(
      <SharedAnswerBoundary>
        <Never />
      </SharedAnswerBoundary>,
    );
// A null Suspense fallback is another silent white page. The fallback is
// now the shared region skeleton, which paints placeholder
// blocks and names the wait in its accessible label rather than in visible
// copy — so "non-blank" is asserted on rendered marks, not on textContent.
    expect(screen.getByLabelText('Loading the shared answer')).toBeTruthy();
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
  });

  it('reports a failed chunk fetch as a failure, not as an empty share', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Failing = lazy(() =>
      Promise.reject(new Error('Failed to fetch dynamically imported module')),
    );
    render(
      <SharedAnswerBoundary>
        <Failing />
      </SharedAnswerBoundary>,
    );

    expect(
      await screen.findByText('This shared answer could not be displayed'),
    ).toBeTruthy();
  });
});
