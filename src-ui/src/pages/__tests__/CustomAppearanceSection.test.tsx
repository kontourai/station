/** @vitest-environment jsdom */

import type { CustomAppearanceDocument } from '@kontourai/station-contracts/custom-appearance';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const query = {
  data: undefined as CustomAppearanceDocument | undefined,
  error: null as unknown,
  isPending: false,
  isError: false,
  refetch: vi.fn(),
};
const mutate = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  customAppearanceKey: () => ['me', 'appearance'],
  useCustomAppearanceQuery: () => query,
  useCustomAppearanceMutation: () => ({
    mutate,
    reset: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueryData: vi.fn() }),
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'a',
    isCurrent: () => true,
  }),
}));
const preview = vi.fn();
vi.mock('../../lib/custom-appearance/preview', () => ({
  previewCustomAppearance: (...args: unknown[]) => preview(...args),
}));

const { CustomAppearanceSection } = await import('../CustomAppearanceSection');

const appearance = (name: string) => ({
  version: 1 as const,
  name,
  palette: {},
  css: '',
});
const doc = (
  patch: Partial<CustomAppearanceDocument> = {},
): CustomAppearanceDocument => ({
  revision: 'r1',
  active: null,
  proposal: null,
  renderReport: null,
  ...patch,
});

beforeEach(() => {
  Object.assign(query, {
    data: undefined,
    error: null,
    isPending: false,
    isError: false,
  });
  mutate.mockClear();
  preview.mockClear();
});

describe('Custom appearance section', () => {
  test('loading shows a skeleton', () => {
    query.isPending = true;
    render(<CustomAppearanceSection />);
    expect(screen.getByText('Loading custom appearance')).toBeTruthy();
  });

  test('a failed read offers Retry, which refetches', () => {
    query.isError = true;
    query.error = Object.assign(new Error('down'), { status: 503 });
    render(<CustomAppearanceSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(query.refetch).toHaveBeenCalled();
  });

  test('an older Station without the route hides the section', () => {
    query.isError = true;
    query.error = Object.assign(new Error('missing'), { status: 404 });
    const { container } = render(<CustomAppearanceSection />);
    expect(container.textContent).toBe('');
  });

  test('none in use offers Create and no Turn off', () => {
    query.data = doc();
    render(<CustomAppearanceSection />);
    expect(screen.getByText(/Station uses your theme as it is/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Turn off custom appearance' }),
    ).toBeNull();
  });

  test('turning it off saves none with the read revision', () => {
    query.data = doc({ active: appearance('Harbor') });
    render(<CustomAppearanceSection />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Turn off custom appearance' }),
    );
    expect(mutate.mock.calls[0]![0]).toEqual({
      kind: 'save',
      revision: 'r1',
      appearance: null,
    });
  });

  test('a proposal previews as an agent proposal naming its id, and Dismiss dismisses', () => {
    query.data = doc({
      proposal: {
        id: 'p1',
        appearance: appearance('Rounded'),
        proposedAt: '2026-11-15T00:00:00.000Z',
      },
    });
    render(<CustomAppearanceSection />);
    expect(screen.getByText(/“Rounded” from an agent/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(preview).toHaveBeenCalledWith(
      appearance('Rounded'),
      expect.objectContaining({ fromAgent: true, proposalId: 'p1' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(mutate.mock.calls[0]![0]).toEqual({
      kind: 'dismiss',
      revision: 'r1',
    });
  });
});
