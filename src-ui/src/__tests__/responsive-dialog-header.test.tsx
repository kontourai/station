/**
 * @vitest-environment jsdom
 *
 * archive#1825: the project switcher's (and five sibling sheets')
 * title/close-button header used to be hand-rolled markup styled by
 * `.session-model-picker__header`, a class defined only in
 * `SessionModelPicker.css` — a stylesheet Vite lazy-chunks alongside
 * `SessionModelPicker.tsx` and only loads once the model picker itself has
 * been opened. Any sheet in this family opened *first* (the common case —
 * e.g. the project switcher) rendered its header with no flex layout at all:
 * `display: block`, so the close button drew directly over the tail of the
 * title text. Confirmed against a real Chromium render at
 * `.responsive-dialog-header { display: block }` pre-fix, with the title and
 * close-button boxes touching at the exact same x-coordinate (no gap).
 *
 * Vitest's jsdom environment does not perform real CSS layout (this repo's
 * config leaves `test.css` at its default `false`, and jsdom itself has no
 * box-layout engine even when it does), so a DOM-only assertion cannot
 * observe the overlap directly. This suite instead pins the two things that
 * jointly guarantee the geometry: (1) every sheet in the family renders the
 * ONE shared `ResponsiveDialogHeader` component rather than a bespoke
 * `<div>`, and (2) the CSS class that component renders is defined in the
 * eagerly loaded entry stylesheet (`index.css`, imported directly by
 * `main.tsx`) with a real flex/space-between/shrinkable layout, and is
 * *not* redefined in the lazy `SessionModelPicker.css` chunk it used to live
 * in exclusively.
 *
 * Known limits of the CSS-source checks below (both are textual, not a real
 * cascade/specificity engine): the `index.css` check reads the LAST bare
 * `.responsive-dialog-header {... }` block in the file (matching CSS's own
 * equal-specificity "last one wins" behavior for a repeated bare selector),
 * but cannot detect a HIGHER-specificity selector elsewhere in the same file
 * overriding it regardless of source order. The lazy-sheet check matches any
 * selector that mentions `.responsive-dialog-header` at all — including a
 * scoped/compound one like `.session-model-picker .responsive-dialog-header
 * { display: block }` — not only a bare redeclaration, but it is still a
 * textual scan of one file, not a build-time cascade resolution.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { ChatDockProjectSwitcherSheet } from '../components/chat-dock/ChatDockProjectSwitcherSheet';
import { ResponsiveDialogHeader } from '../components/ResponsiveDialogSurface';

const SRC_UI_ROOT = path.resolve(__dirname, '..');

function readSource(relativePath: string): string {
  return readFileSync(path.join(SRC_UI_ROOT, relativePath), 'utf8');
}

// Every render site that shares this header, per the repo's own family
// (archive#1825's brief: "check the other sheets/modals in this
// family for the same pattern before inventing a one-off fix").
const HEADER_CONSUMERS = [
  'components/chat-dock/ChatDockProjectSwitcherSheet.tsx',
  'components/home/SnoozeMenu.tsx',
  'components/chat-dock/ChatDockMobileOverflowSheet.tsx',
  'components/chat-dock/ComposerActionsMenu.tsx',
  'components/project-sidebar/ProjectSidebarStatus.tsx',
  'components/badges/ComposerModeSheet.tsx',
  // archive#4254 extracted the model picker's dialog chrome into
  // ModelPickerDialogFrame so the new-chat flow could reuse it. The header
  // moved with it, so this entry follows the code to where the guarantee now
  // lives rather than being dropped — dropping it would have retired the
  // check for BOTH consumers (SessionModelPicker and NewChatModal), which
  // each render their body through this one frame and no longer own a header
  // of their own.
  'components/session/ModelPickerDialogFrame.tsx',
];

describe('shared dialog header (station#1825 item 1)', () => {
  test('every sheet in the ResponsiveDialogSurface family renders the shared ResponsiveDialogHeader, not a one-off <div>', () => {
    for (const file of HEADER_CONSUMERS) {
      const source = readSource(file);
      expect(source, `${file} should render <ResponsiveDialogHeader`).toMatch(
        /<ResponsiveDialogHeader\b/,
      );
      expect(
        source,
        `${file} should not hand-roll the old session-model-picker__header markup`,
      ).not.toMatch(/session-model-picker__header/);
    }
  });

  test('the header class is defined in the eagerly loaded entry stylesheet with a non-colliding flex layout', () => {
    const mainEntry = readSource('main.tsx');
    expect(mainEntry).toMatch(/^import ['"]\.\/index\.css['"];?$/m);

    const indexCss = readSource('index.css');
    // Global, and reads the LAST match: a bare `.responsive-dialog-header`
    // selector repeated later in the same file wins the cascade at equal
    // specificity, so checking only the first occurrence (as this used to)
    // would pass even if a later, conflicting block reintroduced the bug.
    const rules = [
      ...indexCss.matchAll(/\.responsive-dialog-header\s*\{([^}]*)\}/g),
    ];
    expect(
      rules.length,
      '.responsive-dialog-header rule should exist in index.css',
    ).toBeGreaterThan(0);
    const body = rules.at(-1)![1];
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/justify-content:\s*space-between/);

    // The title block must be allowed to shrink so a long title/subtitle
    // wraps or truncates instead of pushing the close button out of the row
    // at narrow widths — the "never collide at any width" requirement.
    const titleBlockRule = indexCss.match(
      /\.responsive-dialog-header > div\s*\{([^}]*)\}/,
    );
    expect(titleBlockRule).toBeTruthy();
    expect(titleBlockRule![1]).toMatch(/min-width:\s*0/);

    // The close button itself must never shrink out of the row.
    const closeButtonRule = indexCss.match(
      /\.responsive-dialog-close\s*\{([^}]*)\}/,
    );
    expect(closeButtonRule).toBeTruthy();
    expect(closeButtonRule![1]).toMatch(/flex:\s*0 0 auto/);
  });

  test('the header class is NOT redefined in the lazy-loaded SessionModelPicker.css chunk (the actual pre-fix defect)', () => {
    const lazyCss = readSource('components/session/SessionModelPicker.css');
    // Strip /* */ comments first — this file's own explanatory comment
    // legitimately names both classes in prose, and without stripping,
    // `[^{]*` below would run straight through the comment and match the
    // NEXT unrelated rule's opening brace, producing a false failure.
    const codeOnly = lazyCss.replace(/\/\*[\s\S]*?\*\//g, '');
    // Matches any selector that mentions the class before an opening brace —
    // not only a bare `.responsive-dialog-header {` redeclaration, but also
    // a scoped/compound selector like `.session-model-picker
    //responsive-dialog-header { display: block }`, which would reintroduce
    // the bug just as effectively while slipping past an exact-selector
    // check. Still a textual scan, not a real selector parser, so this is a
    // "the class name is not used as a selector at all in this file" check,
    // not a full disproof of every possible reintroduction.
    expect(codeOnly).not.toMatch(/\.responsive-dialog-header[^{]*\{/);
    expect(codeOnly).not.toMatch(/\.session-model-picker__header[^{]*\{/);
  });

  test('ResponsiveDialogHeader renders the title and the close button as the only two children of one header row, close button last', () => {
    render(
      <ResponsiveDialogHeader
        title="Switch project"
        closeLabel="Close project switcher"
        onClose={vi.fn()}
      />,
    );
    const header = screen
      .getByText('Switch project')
      .closest('.responsive-dialog-header') as HTMLElement;
    expect(header).toBeTruthy();
    expect(header.children).toHaveLength(2);
    // The close button must be the LAST child — the title's own wrapper div
    // is first — so a shared `justify-content: space-between` unambiguously
    // pins the button to the trailing edge instead of an arbitrary position.
    expect(header.children[1].tagName).toBe('BUTTON');
    expect(header.children[1].getAttribute('aria-label')).toBe(
      'Close project switcher',
    );
  });

  test('the project switcher sheet renders its header via the shared component with the close button reachable and last in the header row', () => {
    render(
      <ChatDockProjectSwitcherSheet
        anchorRef={createRef<HTMLElement>()}
        boundProjectSlug="alpha"
        projects={[]}
        onOpenProject={vi.fn()}
        onSwitchProject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Switch project' });
    const header = dialog.querySelector('.responsive-dialog-header');
    expect(header).toBeTruthy();
    const closeButton = screen.getByRole('button', {
      name: 'Close project switcher',
    });
    expect(header?.contains(closeButton)).toBe(true);
    expect(header?.lastElementChild).toBe(closeButton);

    fireEvent.click(closeButton);
  });
});
