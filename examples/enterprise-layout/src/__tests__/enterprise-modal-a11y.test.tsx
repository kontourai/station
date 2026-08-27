/**
 * @vitest-environment jsdom
 *
 * Regression cover for the enterprise-layout accessibility repair:
 * overlay stacking/structure, native-button row semantics, topmost-only
 * Escape, Tab containment, and opener focus restoration.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const { useState } = React;

// The enterprise example predates the root Vitest JSX-runtime convention and
// intentionally has no TypeScript project. Keep this compatibility local to
// the focused regression instead of declaring the entire example type-safe.
Object.assign(globalThis, { React });

vi.mock('@kontourai/station-sdk', () => ({
  useToast: () => ({ showToast: vi.fn() }),
  useNavigation: () => ({ setLayoutTab: vi.fn() }),
  useSendToChat: () => ({ sendToChat: vi.fn() }),
}));

vi.mock('../hooks/useProjectSlug', () => ({
  useProjectSlug: () => 'enterprise',
}));

const idleMutation = { mutateAsync: vi.fn(), isPending: false };

vi.mock('../data', () => ({
  relTime: () => 'just now',
  sortByAccessFrequency: <T,>(items: T[]) => items,
  useAccountAccess: () => ({ record: vi.fn() }),
  useCalendarEvents: () => ({ data: [], isLoading: false }),
  useMyAccounts: () => ({
    data: [{ id: 'a-1', name: 'Acme', territory: 'West', segment: 'Mid' }],
    isLoading: false,
  }),
  useMyOpportunities: () => ({ data: [], isLoading: false }),
  useMyTasks: () => ({ data: [], isLoading: false }),
  useEnhanceNote: () => idleMutation,
  useHasVault: () => false,
  useVaultSave: () => idleMutation,
}));

vi.mock('../data/notes-hooks', () => ({
  useNoteTree: () => ({ data: [], isLoading: false }),
  useFilteredNotes: () => ({
    data: [
      {
        path: 'notes/alpha.md',
        name: 'alpha.md',
        frontmatter: { title: 'Alpha', territory: 'West', type: 'brief' },
      },
    ],
    isLoading: false,
  }),
  useNoteContent: () => ({ data: null }),
  useSaveNote: () => idleMutation,
  useUpdateNote: () => idleMutation,
  useDeleteNote: () => idleMutation,
}));

vi.mock('../components/NotesSidebar', () => ({ NotesSidebar: () => null }));
vi.mock('../components/NoteFilterBar', () => ({ NoteFilterBar: () => null }));
vi.mock('../components/NoteActions', () => ({ NoteActions: () => null }));
vi.mock('../components/NoteEditor', () => ({ NoteEditor: () => null }));

import { ConfirmModal } from '../components/ConfirmModal';
import { SearchModal } from '../components/SearchModal';
import { Notes } from '../Notes';
import { Portfolio } from '../Portfolio';

afterEach(() => {
  vi.clearAllMocks();
});

// ─── CSS contract ─────────────────────────────────────────────────────────────

// Resolved from the working directory rather than `import.meta.url`: under the
// jsdom environment that URL is not a file: URL.
const layoutCssPath = [
  'examples/enterprise-layout/src/layout.css',
  'src/layout.css',
]
  .map((candidate) => resolve(process.cwd(), candidate))
  .find((candidate) => existsSync(candidate));

if (!layoutCssPath) throw new Error('enterprise-layout layout.css not found');

const layoutCss = readFileSync(layoutCssPath, 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** Declarations of the rule whose selector list contains `selector`. */
function declarationsFor(selector: string): string | null {
  for (const chunk of layoutCss.split('}')) {
    const brace = chunk.lastIndexOf('{');
    if (brace === -1) continue;
    const head = chunk.slice(0, brace);
    const selectors = head
      .slice(head.lastIndexOf('{') + 1)
      .split(',')
      .map((entry) => entry.trim());
    if (selectors.includes(selector)) return chunk.slice(brace + 1);
  }
  return null;
}

describe('row and overlay style contract', () => {
  test('every native row button carries the explicit unstyled full-width reset', () => {
    for (const selector of [
      '.notes-list-item',
      '.dashboard-account-row',
      '.search-modal-result-item',
    ]) {
      const declarations = declarationsFor(selector);
      expect(declarations, `${selector} has no reset rule`).not.toBeNull();
      expect(declarations).toContain('display: block');
      expect(declarations).toContain('width: 100%');
      expect(declarations).toContain('box-sizing: border-box');
      expect(declarations).toContain('border: none');
      expect(declarations).toContain('background: none');
      expect(declarations).toContain('font: inherit');
      expect(declarations).toContain('color: inherit');
      expect(declarations).toContain('text-align: left');
      expect(declarations).toContain('appearance: none');
    }
  });

  test('backdrop fills the overlay and the dialog stacks above it', () => {
    const backdrop = declarationsFor('.enterprise-modal-backdrop--fill');
    expect(backdrop).toContain('position: absolute');
    expect(backdrop).toContain('inset: 0');
    expect(backdrop).toContain('width: 100%');
    expect(backdrop).toContain('height: 100%');

    const dialogLayer = declarationsFor('.enterprise-modal-layer');
    expect(dialogLayer).toContain('position: relative');
    expect(dialogLayer).toContain('z-index: 1');
  });

  test('row children that became spans keep their block flow', () => {
    for (const selector of [
      '.notes-list-item-title',
      '.notes-list-item-meta',
      '.search-modal-result-name',
      '.search-modal-result-meta',
    ]) {
      expect(declarationsFor(selector), selector).toContain('display: block');
    }
  });
});

// ─── Overlay structure ────────────────────────────────────────────────────────

function renderConfirm(overrides: Partial<Parameters<typeof ConfirmModal>[0]>) {
  return render(
    <ConfirmModal
      isOpen
      title="Delete event"
      message="This cannot be undone."
      onConfirm={vi.fn()}
      onCancel={vi.fn()}
      {...overrides}
    />,
  );
}

describe('ConfirmModal overlay structure', () => {
  test('keeps the fixed flex overlay wrapper around backdrop and dialog', () => {
    renderConfirm({});

    const overlay = document.querySelector('.modal-overlay');
    expect(overlay).not.toBeNull();
    // A wrapper, not a control: the centering flex box must not itself be
    // the dismissal button.
    expect(overlay?.tagName).toBe('DIV');

    const backdrop = screen.getByRole('button', { name: 'Dismiss dialog' });
    const dialog = screen.getByRole('dialog');
    expect(backdrop.parentElement).toBe(overlay);
    expect(dialog.parentElement).toBe(overlay);
    expect(backdrop.className).toContain('enterprise-modal-backdrop--fill');
    expect(dialog.className).toContain('enterprise-modal-layer');
    // Dialog paints after the backdrop in the same stacking context.
    expect(
      backdrop.compareDocumentPosition(dialog) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('backdrop is outside the tab order but still clickable', () => {
    const onCancel = vi.fn();
    renderConfirm({ onCancel });

    const backdrop = screen.getByRole('button', { name: 'Dismiss dialog' });
    expect(backdrop.getAttribute('tabindex')).toBe('-1');

    fireEvent.click(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

// ─── Row semantics ────────────────────────────────────────────────────────────

function expectPhrasingRow(row: HTMLElement) {
  expect(row.tagName).toBe('BUTTON');
  expect(row.getAttribute('type')).toBe('button');
  // <button> may only contain phrasing content — a <div> child is invalid.
  expect(row.querySelectorAll('div')).toHaveLength(0);
}

describe('native row buttons use phrasing content', () => {
  test('Notes rows', () => {
    const { container } = render(<Notes />);
    const rows = container.querySelectorAll<HTMLElement>('.notes-list-item');
    expect(rows).toHaveLength(1);
    for (const row of rows) expectPhrasingRow(row);
    expect(rows[0].querySelector('.notes-list-item-title')?.tagName).toBe(
      'SPAN',
    );
    expect(rows[0].querySelector('.notes-list-item-meta')?.tagName).toBe(
      'SPAN',
    );
  });

  test('Portfolio account rows', () => {
    const { container } = render(<Portfolio />);
    const rows = container.querySelectorAll<HTMLElement>(
      '.dashboard-account-row',
    );
    expect(rows).toHaveLength(1);
    for (const row of rows) expectPhrasingRow(row);
  });

  test('Search result rows', async () => {
    const onSearch = vi
      .fn()
      .mockResolvedValue([
        { id: 'r-1', name: 'Acme', website: 'acme.test', type: 'account' },
      ]);
    const { container } = render(
      <SearchModal
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        type="account"
        onSearch={onSearch}
      />,
    );

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'acme' },
    });

    await waitFor(
      () => {
        expect(
          container.querySelectorAll('.search-modal-result-item'),
        ).toHaveLength(1);
      },
      { timeout: 2000 },
    );

    const row = container.querySelector<HTMLElement>(
      '.search-modal-result-item',
    );
    expect(row).not.toBeNull();
    if (row) expectPhrasingRow(row);
  });
});

// ─── Keyboard and focus ───────────────────────────────────────────────────────

describe('topmost dialog keyboard behavior', () => {
  test('Escape closes only the topmost dialog, then the one beneath it', () => {
    const onCancelOuter = vi.fn();
    const onCancelInner = vi.fn();

    function Stack({ innerOpen }: { innerOpen: boolean }) {
      return (
        <>
          <ConfirmModal
            isOpen
            title="Outer"
            message="Outer dialog"
            onConfirm={vi.fn()}
            onCancel={onCancelOuter}
          />
          <ConfirmModal
            isOpen={innerOpen}
            title="Inner"
            message="Inner dialog"
            onConfirm={vi.fn()}
            onCancel={onCancelInner}
          />
        </>
      );
    }

    const { rerender } = render(<Stack innerOpen />);

    const dialogs = screen.getAllByRole('dialog');
    expect(dialogs).toHaveLength(2);
    const [outer, inner] = dialogs;

    fireEvent.keyDown(inner, { key: 'Escape' });
    expect(onCancelInner).toHaveBeenCalledTimes(1);
    expect(onCancelOuter).not.toHaveBeenCalled();

    // The outer dialog ignores Escape while it is not topmost.
    fireEvent.keyDown(outer, { key: 'Escape' });
    expect(onCancelOuter).not.toHaveBeenCalled();

    rerender(<Stack innerOpen={false} />);

    fireEvent.keyDown(outer, { key: 'Escape' });
    expect(onCancelOuter).toHaveBeenCalledTimes(1);
    expect(onCancelInner).toHaveBeenCalledTimes(1);
  });

  test('Tab wraps within the topmost dialog', () => {
    render(
      <SearchModal
        isOpen
        onClose={vi.fn()}
        onSelect={vi.fn()}
        type="account"
        onSearch={vi.fn().mockResolvedValue([])}
      />,
    );

    const dialog = screen.getByRole('dialog');
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>('button, input'),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    expect(first).not.toBe(last);

    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  test('opens on a meaningful control and restores the opener on close', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Delete note
          </button>
          <ConfirmModal
            isOpen={open}
            title="Delete note"
            message="This cannot be undone."
            onConfirm={vi.fn()}
            onCancel={() => setOpen(false)}
          />
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Delete note' });
    opener.focus();
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
