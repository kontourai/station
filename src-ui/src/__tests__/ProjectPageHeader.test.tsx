/**
 * @vitest-environment jsdom
 *
 * archive#3317 — the project header's working-directory affordances.
 *
 * The defect was affordance, not data: the path rendered as one tail-ellipsized
 * line whose edit pencil only appeared on hover (invisible on touch), and no
 * copy action existed. These tests pin the parent/leaf split (leaf emphasized,
 * mirroring the chat dock's treatment), the always-rendered edit icon, the copy
 * action, and the settings button's accessible name (icon-only on mobile).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

// The haptic is a second success channel: a confirmation buzz for a copy that
// never happened is the same lie as the label. Pinned here the way the sibling
// HighlightedCodeBlock suite pins it (archive#3339) — without this mock
// restoring the unconditional `triggerHaptic('light')` kept every test green.
const triggerHaptic = vi.fn();
vi.mock('../platform/native/haptics', () => ({
  triggerHaptic: (...args: unknown[]) => triggerHaptic(...args),
}));

import { ProjectPageHeader } from '../views/project-page/ProjectPageHeader';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  triggerHaptic.mockReset();
  Object.assign(navigator, { clipboard: undefined });
});

function renderHeader(
  overrides: Partial<Parameters<typeof ProjectPageHeader>[0]> = {},
) {
  const props = {
    apiBase: '',
    project: {
      name: 'Station',
      workingDirectory: '/Users/me/dev/github/station',
    },
    gitStatus: null,
    editingDir: false,
    setEditingDir: vi.fn(),
    dirDraft: '',
    setDirDraft: vi.fn(),
    updateWorkingDirectory: vi.fn(),
    navigateToSettings: vi.fn(),
    ...overrides,
  };
  const { unmount } = render(<ProjectPageHeader {...props} />);
  return { ...props, unmount };
}

describe('ProjectPageHeader working directory (station#3317)', () => {
  test('splits the path into parent and emphasized leaf', () => {
    renderHeader();

    const parent = document.querySelector(
      '.project-page__dir-parent',
    ) as HTMLElement;
    const leaf = document.querySelector(
      '.project-page__dir-leaf',
    ) as HTMLElement;
    expect(parent.textContent).toBe('/Users/me/dev/github/');
    expect(leaf.textContent).toBe('station');
    // The bidi isolate that keeps `~`/`/` from reordering under the line's
    // rtl start-ellipsis (archive#304); parent and leaf both sit inside it.
    const isolate = document.querySelector(
      '.project-page__dir-path-text',
    ) as HTMLElement;
    expect(isolate.getAttribute('dir')).toBe('ltr');
    expect(isolate.textContent).toBe('/Users/me/dev/github/station');
  });

  test('the edit button names the path it edits, and the cut line offers it whole (#2799)', () => {
    renderHeader();

    // The visible line may be cut at its start; its aria-label replaces the
    // text, so the path has to be in the name for a screen reader to hear it.
    const editButton = screen.getByRole('button', {
      name: 'Edit working directory /Users/me/dev/github/station',
    });
    expect(
      editButton
        .querySelector('.project-page__dir-path')
        ?.getAttribute('title'),
    ).toBe('/Users/me/dev/github/station');
  });

  test('edit affordance is rendered, not hover-revealed, and opens the editor', () => {
    const props = renderHeader();

    const editButton = screen.getByRole('button', {
      name: 'Edit working directory /Users/me/dev/github/station',
    });
    expect(editButton.querySelector('.project-page__dir-edit-icon')).not.toBe(
      null,
    );

    fireEvent.click(editButton);
    expect(props.setDirDraft).toHaveBeenCalledWith(
      '/Users/me/dev/github/station',
    );
    expect(props.setEditingDir).toHaveBeenCalledWith(true);
  });

  test('copy action writes the full path and reports success only once the write resolved', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderHeader();

    const button = screen.getByRole('button', {
      name: 'Copy working directory path',
    });
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith('/Users/me/dev/github/station');
    await waitFor(() => expect(button.textContent).toBe('Copied'));
    expect(
      document.querySelector('.project-page__dir-copy-status')?.textContent,
    ).toBe('Working directory path copied.');
    expect(button.className).not.toContain('project-page__dir-copy--failed');
    expect(triggerHaptic).toHaveBeenCalledTimes(1);
    expect(triggerHaptic).toHaveBeenCalledWith('light');
  });

  // The two real failures: a rejected write (permission refused), and no
  // `navigator.clipboard` at all — which is every plain-http:// origin, i.e.
  // Station reached over the LAN from another device. Both used to render as
  // "Copied" (archive#3317).
  // ONE failure case here, not the primitive's matrix. Which clipboard states
  // resolve `false` (absent, no `writeText`, rejected, throwing) is
  // `copyToClipboard`'s own contract, pinned in
  // `src-ui/src/lib/__tests__/clipboard.test.ts` -- 'resolves false when the
  // origin has no clipboard API at all'. What is this header's to prove is that
  // it derives its affordance from that boolean rather than from the call.
  test('a rejected clipboard write never claims a copy', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    renderHeader();

    const button = screen.getByRole('button', {
      name: 'Copy working directory path',
    });
    fireEvent.click(button);
    await waitFor(() => expect(button.textContent).toBe("Can't copy"));
    expect(button.textContent).not.toBe('Copied');
    expect(button.className).toContain('project-page__dir-copy--failed');
    expect(
      document.querySelector('.project-page__dir-copy-status')?.textContent,
    ).toBe(
      'This browser refused clipboard access. Click the path to edit it, then copy it from the field.',
    );
    // The haptic is a second success channel — no confirmation buzz for
    // something that did not happen.
    expect(triggerHaptic).not.toHaveBeenCalled();
  });

  test('the copy reset timer is cleared on unmount', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    const { unmount } = renderHeader();

    const button = screen.getByRole('button', {
      name: 'Copy working directory path',
    });
    fireEvent.click(button);
    await waitFor(() => expect(button.textContent).toBe('Copied'));
    clearTimeoutSpy.mockClear();
    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  test('without a working directory: set prompt, no copy action', () => {
    renderHeader({ project: { name: 'Station' } });

    expect(
      screen.getByRole('button', { name: 'Set working directory' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Copy working directory path' }),
    ).toBe(null);
  });

  test('settings button keeps an accessible name when the label is icon-only', () => {
    const props = renderHeader();

    const settings = screen.getByRole('button', { name: 'Project settings' });
    fireEvent.click(settings);
    expect(props.navigateToSettings).toHaveBeenCalled();
  });
});

describe('ProjectPageHeader folder refusal (#2412 review)', () => {
  // The editor's path field asks the file browser for suggestions.
  function renderEditing(
    overrides: Partial<Parameters<typeof ProjectPageHeader>[0]> = {},
  ) {
    const props = {
      apiBase: '',
      project: { name: 'Station', workingDirectory: '/srv/station' },
      gitStatus: null,
      editingDir: true,
      setEditingDir: vi.fn(),
      dirDraft: '/elsewhere',
      setDirDraft: vi.fn(),
      updateWorkingDirectory: vi.fn(),
      navigateToSettings: vi.fn(),
      ...overrides,
    };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProjectPageHeader {...props} />
      </QueryClientProvider>,
    );
  }

  test('a refused folder change is shown under the editor, which stays open', () => {
    renderEditing({
      workingDirectoryError:
        "Only this Station's operator, or a device the operator allowed to run commands, can choose a Project's folder. Nothing was saved.",
    });
    expect(screen.getByRole('alert').textContent).toContain(
      "can choose a Project's folder",
    );
  });

  test('no refusal, no alert', () => {
    renderEditing();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the header draws the project icon', () => {
  test('a stored image is drawn beside the name; a refused value falls back to initials', () => {
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    const first = renderHeader({
      project: {
        name: 'Station',
        icon: image,
        workingDirectory: '/Users/me/dev/github/station',
      },
    });
    const identity = document.querySelector('.project-page__identity');
    expect(identity?.querySelector('img')?.getAttribute('src')).toBe(image);
    first.unmount();

    renderHeader({
      project: {
        name: 'Station',
        icon: 'https://example.com/logo.png',
        workingDirectory: '/Users/me/dev/github/station',
      },
    });
    const fallback = document.querySelector('.project-page__identity');
    expect(fallback?.querySelector('img')).toBeNull();
    expect(fallback?.querySelector('.brand-icon__initials')?.textContent).toBe(
      'ST',
    );
  });
});
