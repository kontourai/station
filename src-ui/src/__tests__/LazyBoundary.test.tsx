// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { LazyBoundary } from '../components/LazyBoundary';

describe('LazyBoundary', () => {
  test('keeps component props coupled to the loaded component type', () => {
    const load = async () => ({
      default: ({ required }: { required: string }) => <div>{required}</div>,
    });

    const valid = (
      <LazyBoundary
        load={load}
        componentProps={{ required: 'checked' }}
        pending={null}
      />
    );
    expect(valid).toBeTruthy();

    const invalid = (
      <LazyBoundary
        load={load}
        // @ts-expect-error -- loader props and componentProps must stay coupled.
        componentProps={{ renamed: 'unchecked' }}
        pending={null}
      />
    );
    expect(invalid).toBeTruthy();
  });

  test('contains a rejected import and retries it without unmounting siblings', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValueOnce({ default: () => <div>Loaded transcript</div> });
    const composerClick = vi.fn();

    render(
      <>
        <button type="button" onClick={composerClick}>
          Composer action
        </button>
        <LazyBoundary
          load={load}
          componentProps={{}}
          pending={<div>Loading transcript</div>}
        />
      </>,
    );

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Unable to load this part of Station.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Composer action' }));
    expect(composerClick).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Loaded transcript')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  test('shows its supplied skeleton fallback until the import resolves', async () => {
    let resolveImport:
      | ((module: { default: () => ReactElement }) => void)
      | undefined;
    const load = vi.fn(
      () =>
        new Promise<{ default: () => ReactElement }>((resolve) => {
          resolveImport = resolve;
        }),
    );

    render(
      <LazyBoundary
        load={load}
        componentProps={{}}
        pending={<div role="status">Conversation skeleton</div>}
      />,
    );

    expect(screen.getByRole('status').textContent).toContain(
      'Conversation skeleton',
    );
    resolveImport?.({ default: () => <div>Loaded conversation</div> });
    expect(await screen.findByText('Loaded conversation')).toBeTruthy();
  });
});
