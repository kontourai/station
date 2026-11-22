/** @vitest-environment jsdom */

import type {
  CustomAppearanceDocument,
  CustomAppearanceLibraryDocument,
} from '@kontourai/station-contracts/custom-appearance';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const query = {
  data: undefined as CustomAppearanceDocument | undefined,
  error: null as unknown,
  isPending: false,
  isError: false,
  refetch: vi.fn(),
};
const mutate = vi.fn();
const libraryMutate = vi.fn();
const libraryQuery = {
  data: undefined as CustomAppearanceLibraryDocument | undefined,
  isPending: false,
  isError: false,
  error: null,
  refetch: vi.fn(),
};
const saveAppearance = vi.fn();
vi.mock('@kontourai/station-sdk/client', () => ({
  saveCustomAppearance: (...args: unknown[]) => saveAppearance(...args),
  getCustomAppearance: vi.fn(),
  keepCustomAppearanceProposal: vi.fn(),
  reportCustomAppearanceRender: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  customAppearanceKey: () => ['me', 'appearance'],
  useCustomAppearanceQuery: () => query,
  useCustomAppearanceLibraryQuery: () => libraryQuery,
  useCustomAppearanceLibraryMutation: () => ({
    mutate: libraryMutate,
    reset: vi.fn(),
    isPending: false,
    isError: false,
    isSuccess: false,
  }),
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
const proposalPreview = vi.fn(async (..._args: unknown[]) => undefined);
const proposalDismiss = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('../../lib/custom-appearance/proposal-actions', () => ({
  previewAppearanceProposal: (...args: unknown[]) => proposalPreview(...args),
  dismissAppearanceProposal: (...args: unknown[]) => proposalDismiss(...args),
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
  libraryMutate.mockClear();
  saveAppearance.mockReset();
  saveAppearance.mockResolvedValue(doc());
  Object.assign(libraryQuery, {
    data: { revision: 'library-1', themes: [] },
    isPending: false,
    isError: false,
  });
  preview.mockClear();
  proposalPreview.mockClear();
  proposalDismiss.mockClear();
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
    expect(proposalPreview).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: 'p1' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(proposalDismiss).toHaveBeenCalledWith(
      expect.objectContaining({ proposalId: 'p1' }),
    );
  });
});

describe('Appearance studio', () => {
  test('the disabled preview retains the manual editor and direct Save', () => {
    query.data = doc();
    render(<CustomAppearanceSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(screen.queryByText('Visual style')).toBeNull();
    expect(screen.getByLabelText('CSS')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'save', revision: 'r1' }),
      expect.anything(),
    );
  });

  test('visual controls and color pickers build a preview while CSS stays collapsed', () => {
    query.data = doc();
    render(<CustomAppearanceSection studioEnabled />);
    fireEvent.click(screen.getByRole('button', { name: 'New theme' }));
    expect(screen.queryByLabelText('CSS')).toBeNull();
    fireEvent.change(screen.getByRole('slider', { name: /Panel opacity/ }), {
      target: { value: '0.65' },
    });
    fireEvent.change(screen.getByRole('slider', { name: /Corner rounding/ }), {
      target: { value: '20' },
    });
    fireEvent.change(screen.getByLabelText('Accent color picker'), {
      target: { value: '#123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining({
        visual: { panelOpacity: 0.65, radius: 20 },
        palette: { dark: { accent: '#123456' } },
      }),
      expect.objectContaining({ fromAgent: false }),
    );
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced CSS' }));
    expect(screen.getByLabelText('CSS')).toBeTruthy();
  });

  test('a saved theme applies only after the protected preview is kept', async () => {
    const saved = appearance('Harbor');
    query.data = doc();
    libraryQuery.data = {
      revision: 'library-1',
      themes: [
        {
          id: 'theme-1',
          name: 'Harbor',
          appearance: saved,
          favorite: false,
          createdAt: '2026-11-17',
          updatedAt: '2026-11-17',
        },
      ],
    };
    render(<CustomAppearanceSection studioEnabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(saveAppearance).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    expect(preview).toHaveBeenCalledWith(
      saved,
      expect.objectContaining({ fromAgent: false }),
    );
    preview.mock.calls[0]![1].onKeep();
    await waitFor(() =>
      expect(saveAppearance).toHaveBeenCalledWith(
        'http://station.test',
        { revision: 'r1', appearance: saved },
        expect.anything(),
      ),
    );
  });

  test('import opens an unsaved draft, preserves its image, and never applies it immediately', async () => {
    query.data = doc();
    render(<CustomAppearanceSection studioEnabled />);
    const imported = {
      ...appearance('Imported harbor'),
      visual: {
        background: {
          dataUrl:
            'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0n8AAAAASUVORK5CYII=',
          size: 'cover',
          position: 'center',
          dim: 0.4,
        },
      },
    };
    const file = new File([''], 'harbor.station-theme.json', {
      type: 'application/json',
    });
    Object.defineProperty(file, 'text', {
      value: async () =>
        JSON.stringify({
          format: 'station-appearance',
          version: 1,
          appearance: imported,
        }),
    });
    fireEvent.change(screen.getByLabelText('Theme pack file'), {
      target: { files: [file] },
    });
    await screen.findByText(
      'Imported theme draft. Preview it before applying.',
    );
    expect(screen.getByLabelText('Name')).toHaveProperty(
      'value',
      'Imported harbor',
    );
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
    expect(saveAppearance).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(preview).toHaveBeenCalledWith(imported, expect.anything());
  });

  test('invalid packs keep the library visible and offer another file', async () => {
    query.data = doc();
    render(<CustomAppearanceSection studioEnabled />);
    const file = new File([''], 'invalid.json');
    Object.defineProperty(file, 'text', {
      value: async () =>
        JSON.stringify({
          format: 'station-appearance',
          version: 99,
          appearance: appearance('Bad'),
        }),
    });
    fireEvent.change(screen.getByLabelText('Theme pack file'), {
      target: { files: [file] },
    });
    await screen.findByText('Theme pack did not open');
    expect(
      screen.getByRole('button', { name: 'Choose theme pack' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New theme' })).toBeTruthy();
    expect(preview).not.toHaveBeenCalled();
  });

  test('editing a saved theme replaces that library entry without applying it', () => {
    query.data = doc();
    libraryQuery.data = {
      revision: 'library-1',
      themes: [
        {
          id: 'theme-1',
          name: 'Harbor',
          appearance: appearance('Harbor'),
          favorite: true,
          createdAt: '2026-11-17',
          updatedAt: '2026-11-17',
        },
      ],
    };
    render(<CustomAppearanceSection studioEnabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Harbor updated' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save to library' }));
    expect(libraryMutate).toHaveBeenCalledWith(
      {
        kind: 'save',
        revision: 'library-1',
        id: 'theme-1',
        appearance: appearance('Harbor updated'),
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
    const next = {
      revision: 'library-2',
      themes: [
        {
          ...libraryQuery.data!.themes[0]!,
          id: 'theme-2',
          name: 'Harbor updated',
          appearance: appearance('Harbor updated'),
        },
      ],
    };
    act(() => {
      libraryQuery.data = next;
      libraryMutate.mock.calls[0]![1].onSuccess(next);
    });
    expect(screen.getByRole('status').textContent).toContain(
      'Saved to your theme library.',
    );
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Harbor final' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save to library' }));
    expect(libraryMutate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'theme-2',
        revision: 'library-2',
        appearance: appearance('Harbor final'),
      }),
      expect.any(Object),
    );
    expect(mutate).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  test('library management sends the selected entry and current library revision', () => {
    query.data = doc();
    libraryQuery.data = {
      revision: 'library-1',
      themes: [
        {
          id: 'theme-1',
          name: 'Harbor',
          appearance: appearance('Harbor'),
          favorite: false,
          createdAt: '2026-11-17',
          updatedAt: '2026-11-17',
        },
      ],
    };
    render(<CustomAppearanceSection studioEnabled />);
    fireEvent.click(
      screen.getByRole('button', { name: 'More actions for Harbor' }),
    );
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Favorite' }));
    expect(libraryMutate).toHaveBeenLastCalledWith({
      kind: 'update',
      revision: 'library-1',
      id: 'theme-1',
      favorite: true,
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'More actions for Harbor' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(libraryMutate).toHaveBeenLastCalledWith({
      kind: 'save',
      revision: 'library-1',
      appearance: appearance('Harbor copy'),
      favorite: false,
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'More actions for Harbor' }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(libraryMutate).toHaveBeenLastCalledWith({
      kind: 'remove',
      revision: 'library-1',
      id: 'theme-1',
    });
    expect(preview).not.toHaveBeenCalled();
  });

  test('an unsupported background file leaves the draft intact and offers recovery', async () => {
    query.data = doc();
    render(<CustomAppearanceSection studioEnabled />);
    fireEvent.click(screen.getByRole('button', { name: 'New theme' }));
    fireEvent.change(screen.getByLabelText('Background image file'), {
      target: {
        files: [
          new File(['<svg />'], 'drawing.svg', { type: 'image/svg+xml' }),
        ],
      },
    });
    await screen.findByText('Choose a PNG, JPEG or WebP image.');
    expect(screen.getByText('Image did not load')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(preview.mock.calls[0]![0].visual).toBeUndefined();
  });

  test('a failed library read offers recovery while theme creation stays available', () => {
    query.data = doc();
    libraryQuery.isError = true;
    libraryQuery.data = undefined;
    render(<CustomAppearanceSection studioEnabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(libraryQuery.refetch).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'New theme' })).toBeTruthy();
  });
});

test('image preparation blocks Preview, direct Save and library Save until decoding settles', async () => {
  query.data = doc();
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  class PendingImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = '';
  }
  URL.createObjectURL = () => 'blob:pending-image';
  URL.revokeObjectURL = () => undefined;
  vi.stubGlobal('Image', PendingImage);
  try {
    render(<CustomAppearanceSection studioEnabled />);
    fireEvent.click(screen.getByRole('button', { name: 'New theme' }));
    fireEvent.change(screen.getByLabelText('Background image file'), {
      target: {
        files: [new File(['image'], 'background.png', { type: 'image/png' })],
      },
    });
    for (const name of ['Preview', 'Save', 'Save to library']) {
      expect(
        (screen.getByRole('button', { name }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    expect(mutate).not.toHaveBeenCalled();
    expect(libraryMutate).not.toHaveBeenCalled();
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.unstubAllGlobals();
  }
});
