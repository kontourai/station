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

  test('a boundary that shares its loader renders at once on a later mount, without a second import', async () => {
    const load = vi.fn(async () => ({
      default: ({ label }: { label: string }) => <div>{label}</div>,
    }));

    render(
      <LazyBoundary
        load={load}
        componentProps={{ label: 'First mark' }}
        pending={<div>Pending first</div>}
        shareAcrossMounts
      />,
    );
    expect(await screen.findByText('First mark')).toBeTruthy();

    render(
      <LazyBoundary
        load={load}
        componentProps={{ label: 'Second mark' }}
        pending={<div>Pending second</div>}
        shareAcrossMounts
      />,
    );
    // Synchronously after mount: no pending state, no second import.
    expect(screen.queryByText('Pending second')).toBeNull();
    expect(screen.getByText('Second mark')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  test('after a shared rejection, a boundary mounted later imports again', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValueOnce({ default: () => <div>Loaded later</div> });

    const first = render(
      <LazyBoundary
        load={load}
        componentProps={{}}
        pending={null}
        unavailable={() => <div>Unavailable</div>}
        shareAcrossMounts
      />,
    );
    expect(await screen.findByText('Unavailable')).toBeTruthy();
    first.unmount();

    render(
      <LazyBoundary
        load={load}
        componentProps={{}}
        pending={null}
        shareAcrossMounts
      />,
    );
    expect(await screen.findByText('Loaded later')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });

  test('without sharing, each mount suspends and imports on its own, as before', async () => {
    const load = vi.fn(async () => ({
      default: ({ label }: { label: string }) => <div>{label}</div>,
    }));

    render(
      <LazyBoundary
        load={load}
        componentProps={{ label: 'First surface' }}
        pending={null}
      />,
    );
    expect(await screen.findByText('First surface')).toBeTruthy();

    render(
      <LazyBoundary
        load={load}
        componentProps={{ label: 'Second surface' }}
        pending={<div>Pending second</div>}
      />,
    );
    expect(screen.getByText('Pending second')).toBeTruthy();
    expect(await screen.findByText('Second surface')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('with sharing, Retry after a rejection imports again and renders', async () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValueOnce({ default: () => <div>Loaded on retry</div> });

    render(
      <LazyBoundary
        load={load}
        componentProps={{}}
        pending={null}
        unavailable={(onRetry) => (
          <button type="button" onClick={onRetry}>
            Try the chunk again
          </button>
        )}
        shareAcrossMounts
      />,
    );

    fireEvent.click(
      await screen.findByRole('button', { name: 'Try the chunk again' }),
    );
    expect(await screen.findByText('Loaded on retry')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });
});
