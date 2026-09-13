import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** @vitest-environment jsdom */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import {
  panePreviewAccent,
  WorkspacePaneAvailabilityList,
} from '../WorkspacePaneAvailabilityList';
import type { WorkspacePaneAvailabilityCatalogEntry } from '../workspacePaneAvailabilityPresentation';
import { presentWorkspacePaneAvailability } from '../workspacePaneAvailabilityPresentation';
import { builtinWorkspacePaneGlyph } from '../workspacePaneGlyphs';

function entry(
  name: string,
  availability: WorkspacePaneAvailabilityCatalogEntry['availability'],
): WorkspacePaneAvailabilityCatalogEntry {
  return {
    descriptor: {
      id: `pane.${name.toLowerCase()}` as never,
      name,
      description: `${name} description`,
    },
    instance: { instanceId: `instance.${name.toLowerCase()}` as never },
    availability,
  };
}

const available = entry('Files', {
  state: 'available',
  reason: { code: 'ready', source: 'resolver' },
});
const unavailable = entry('Preview', {
  state: 'not-configured',
  reason: { code: 'missing-project', source: 'context' },
  action: { type: 'setup', code: 'select-project' },
});
const comingSoon: WorkspacePaneAvailabilityCatalogEntry = {
  descriptor: {
    id: 'pane.preview' as never,
    name: 'Browser Preview',
    description: 'Validated local preview',
  },
  availability: {
    state: 'coming-soon',
    reason: { code: 'coming-soon', source: 'product-rollout' },
    action: { type: 'learn-more', code: 'view-rollout' },
  },
};

describe('WorkspacePaneAvailabilityList', () => {
  test('presents every known pane and opens an available one via its explicit Open action', () => {
    const onSelect = vi.fn();
    render(
      <WorkspacePaneAvailabilityList
        entries={[available, unavailable]}
        onSelect={onSelect}
        onAction={vi.fn()}
        canExecuteAction={() => true}
      />,
    );

    // The available card carries an explicit Open action — never a whole-card
    // click that means different things per state (archive#3318).
    expect(screen.getByRole('button', { name: 'Open Files' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Preview Setup needed' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Files Available' }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open Files' }));
    expect(onSelect).toHaveBeenCalledWith(available);
  });

  // The safety half of the state-polymorphism fix. Independent
  // rendered the remediation action AND the Open action on an unavailable card
  // and no assertion caught it — every existing check was about what a card
  // DOES carry. An Open button on a pane that cannot open is the whole defect
  // archive#3318 removed, so it is pinned negatively, per card, here.
  test('an unavailable card carries its state badge and remediation but never an Open action', () => {
    const onSelect = vi.fn();
    render(
      <WorkspacePaneAvailabilityList
        entries={[unavailable, available]}
        onSelect={onSelect}
        onAction={vi.fn()}
        canExecuteAction={() => true}
      />,
    );

    const cards = Array.from(
      document.querySelectorAll('.workspace-pane-availability-list__card'),
    );
    expect(cards).toHaveLength(2);
    const [unavailableCard, availableCard] = cards;

    // Unavailable: state badge (as a toggle) + remediation, and no Open.
    expect(
      unavailableCard.querySelector(
        '.workspace-pane-availability-list__state-toggle',
      )?.textContent,
    ).toBe('Setup needed');
    expect(
      unavailableCard.querySelector('.workspace-pane-availability-list__remedy')
        ?.textContent,
    ).toBe('Select Project');
    expect(
      unavailableCard.querySelector('.workspace-pane-availability-list__open'),
    ).toBe(null);
    expect(
      within(unavailableCard as HTMLElement).queryByRole('button', {
        name: /^Open /,
      }),
    ).toBe(null);

    // Available: Open, and no remediation to confuse it with.
    expect(
      availableCard.querySelector('.workspace-pane-availability-list__open')
        ?.textContent,
    ).toBe('Open');
    expect(
      availableCard.querySelector('.workspace-pane-availability-list__remedy'),
    ).toBe(null);
    expect(
      availableCard.querySelector(
        '.workspace-pane-availability-list__state-toggle',
      ),
    ).toBe(null);
  });

  test('renders a deterministic generated preview placeholder per pane id', () => {
    const accentsByName = () =>
      new Map(
        [
          ...document.querySelectorAll<HTMLElement>(
            '.workspace-pane-availability-list__card',
          ),
        ].map((card) => [
          card.querySelector('.workspace-pane-availability-list__name')
            ?.textContent,
          card
            .querySelector<HTMLElement>(
              '.workspace-pane-availability-list__preview',
            )
            ?.style.getPropertyValue('--pane-preview-accent'),
        ]),
      );

    const first = render(
      <WorkspacePaneAvailabilityList
        entries={[available, unavailable]}
        onSelect={vi.fn()}
        onAction={vi.fn()}
        canExecuteAction={() => true}
      />,
    );
    const beforeReorder = accentsByName();
    expect([...beforeReorder.keys()]).toEqual(['Files', 'Preview']);
    // Two panes, two accents: an accent that is constant would pass the
    // reorder check below without deriving anything from the id.
    expect(new Set(beforeReorder.values()).size).toBe(2);
    first.unmount();

    // The SAME panes in the opposite catalog order keep their own accents —
    // the derivation reads the descriptor id, not the render position.
    render(
      <WorkspacePaneAvailabilityList
        entries={[unavailable, available]}
        onSelect={vi.fn()}
        onAction={vi.fn()}
        canExecuteAction={() => true}
      />,
    );
    const afterReorder = accentsByName();
    expect([...afterReorder.keys()]).toEqual(['Preview', 'Files']);
    expect(afterReorder.get('Files')).toBe(beforeReorder.get('Files'));
    expect(afterReorder.get('Preview')).toBe(beforeReorder.get('Preview'));
    // And it is the exported derivation, not an unrelated constant.
    expect(afterReorder.get('Files')).toBe(panePreviewAccent('pane.files'));

    const preview = document.querySelector(
      '.workspace-pane-availability-list__preview',
    ) as HTMLElement;
    // Decorative only — the pane's name and state remain the textual signal.
    expect(preview.getAttribute('aria-hidden')).toBe('true');
  });

  // #765 F4: Coding and Chat both rendered a giant letter "C". Built-in
  // panes carry their real icon on the tile; #1536 E8 replaced the remaining
  // letter fallback with a contributed-pane glyph, so no tile spells one
  // letter of the name the card already prints beside it.
  test('renders a built-in pane’s real glyph on the tile instead of a letter placeholder', () => {
    const builtinChat: WorkspacePaneAvailabilityCatalogEntry = {
      ...available,
      descriptor: {
        ...available.descriptor,
        renderer: { kind: 'builtin-component', name: 'workspace-chat' },
      },
    };
    render(
      <WorkspacePaneAvailabilityList
        entries={[builtinChat]}
        onSelect={vi.fn()}
      />,
    );

    const preview = document.querySelector(
      '.workspace-pane-availability-list__preview',
    ) as HTMLElement;
    expect(
      preview.querySelector('.workspace-pane-availability-list__preview-icon'),
    ).toBeTruthy();
    expect(
      preview.querySelector('.workspace-pane-availability-list__preview-glyph'),
    ).toBe(null);
  });

  test('gives same-initial built-ins distinct tile glyphs (Coding vs Chat)', () => {
    const coding = builtinWorkspacePaneGlyph({
      kind: 'builtin-component',
      name: 'coding',
    });
    const chat = builtinWorkspacePaneGlyph({
      kind: 'builtin-component',
      name: 'workspace-chat',
    });
    expect(coding).toBeTruthy();
    expect(chat).toBeTruthy();
    expect(coding).not.toBe(chat);
  });

  // #1536 E8: the audit found a plugin pane's tile rendering a lone capital
  // "S". A contributed pane with neither `icon` nor `previewImage` gets a real
  // glyph, and the letter placeholder is gone from every branch.
  test('renders a contributed-pane glyph, not a name initial, for renderers this build does not recognise', () => {
    const pluginPane: WorkspacePaneAvailabilityCatalogEntry = {
      ...available,
      descriptor: {
        ...available.descriptor,
        name: 'SDK Patterns',
        renderer: { kind: 'plugin-component', name: 'some-plugin-pane' },
      },
    };
    render(
      <WorkspacePaneAvailabilityList
        entries={[pluginPane]}
        onSelect={vi.fn()}
      />,
    );

    const preview = document.querySelector(
      '.workspace-pane-availability-list__preview',
    ) as HTMLElement;
    expect(
      preview.querySelector('.workspace-pane-availability-list__preview-icon'),
    ).toBeTruthy();
    expect(preview.textContent).toBe('');
    expect(
      document.querySelector(
        '.workspace-pane-availability-list__preview-glyph',
      ),
    ).toBe(null);
    // The name is still on the card, in full, where it belongs.
    expect(
      document.querySelector('.workspace-pane-availability-list__name')
        ?.textContent,
    ).toBe('SDK Patterns');
  });

  test('a pane with no renderer at all still gets a glyph rather than a letter', () => {
    render(
      <WorkspacePaneAvailabilityList
        entries={[available]}
        onSelect={vi.fn()}
      />,
    );

    expect(
      document.querySelector('.workspace-pane-availability-list__preview-icon'),
    ).toBeTruthy();
    expect(
      document.querySelector(
        '.workspace-pane-availability-list__preview-glyph',
      ),
    ).toBe(null);
  });

  test('a descriptor-supplied icon string still outranks the built-in glyph', () => {
    const iconed: WorkspacePaneAvailabilityCatalogEntry = {
      ...available,
      descriptor: {
        ...available.descriptor,
        icon: '📁',
        renderer: { kind: 'builtin-component', name: 'workspace-chat' },
      },
    };
    render(
      <WorkspacePaneAvailabilityList entries={[iconed]} onSelect={vi.fn()} />,
    );

    expect(
      document.querySelector('.workspace-pane-availability-list__preview-glyph')
        ?.textContent,
    ).toBe('📁');
    expect(
      document.querySelector('.workspace-pane-availability-list__preview-icon'),
    ).toBe(null);
  });

  test('renders a descriptor-supplied preview image when present', () => {
    const withPreview: WorkspacePaneAvailabilityCatalogEntry = {
      ...available,
      descriptor: {
        ...available.descriptor,
        previewImage: '/assets/panes/files-preview.png',
      },
    };
    render(
      <WorkspacePaneAvailabilityList
        entries={[withPreview]}
        onSelect={vi.fn()}
      />,
    );

    const image = document.querySelector(
      '.workspace-pane-availability-list__preview-image',
    ) as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('/assets/panes/files-preview.png');
    expect(image.getAttribute('alt')).toBe('');
  });

  test('reports an exact occurrence already open in this workspace instead of offering a duplicate open', () => {
    const onSelect = vi.fn();
    render(
      <WorkspacePaneAvailabilityList
        entries={[available]}
        onSelect={onSelect}
        isOpen={() => true}
      />,
    );

    const trigger = screen.getByRole('button', {
      name: 'Files Open in this workspace',
    });
    trigger.focus();
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getByText('This pane is already open in this workspace.'),
    ).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('keeps unavailable panes focusable and exposes their bounded explanation and action', () => {
    const onSelect = vi.fn();
    const onAction = vi.fn();
    render(
      <WorkspacePaneAvailabilityList
        entries={[unavailable]}
        onSelect={onSelect}
        onAction={onAction}
        canExecuteAction={() => true}
      />,
    );

    const trigger = screen.getByRole('button', {
      name: 'Preview Setup needed',
    });
    expect(trigger.hasAttribute('disabled')).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-describedby')).toBeTruthy();

    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getByText('Choose a Project before opening this pane.'),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Select Project' }));
    expect(onAction).toHaveBeenCalledWith(
      unavailable,
      unavailable.availability.action,
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('keeps an unplaced known descriptor focusable without selecting it', () => {
    const onSelect = vi.fn();
    render(
      <WorkspacePaneAvailabilityList
        entries={[comingSoon]}
        onSelect={onSelect}
      />,
    );

    const trigger = screen.getByRole('button', {
      name: 'Browser Preview Coming soon',
    });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('This pane has not rolled out yet.')).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('supports touch-equivalent click activation and only disables an in-flight pane', () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <WorkspacePaneAvailabilityList
        entries={[unavailable]}
        onSelect={onSelect}
        onAction={vi.fn()}
        canExecuteAction={() => true}
      />,
    );
    const trigger = screen.getByRole('button', {
      name: 'Preview Setup needed',
    });

    fireEvent.pointerDown(trigger, { pointerType: 'touch' });
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    rerender(
      <WorkspacePaneAvailabilityList
        entries={[unavailable]}
        onSelect={onSelect}
        onAction={vi.fn()}
        canExecuteAction={() => true}
        isPending={() => true}
      />,
    );
    expect(
      (
        screen.getByRole('button', {
          name: 'Preview Setup needed',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test('maps bounded state, reason, and action codes without host diagnostics', () => {
    expect(presentWorkspacePaneAvailability(unavailable.availability)).toEqual({
      state: 'not-configured',
      stateLabel: 'Setup needed',
      reasonCode: 'missing-project',
      reasonLabel: 'Choose a Project before opening this pane.',
      action: { type: 'setup', code: 'select-project' },
      actionLabel: 'Select Project',
    });
  });

  test('names the remote-extension gate and routes to Registry only for a renderer absence', () => {
    const onReviewInRegistry = vi.fn();
    const rendererMissing = {
      ...entry('Remote review', {
        state: 'temporarily-unavailable' as const,
        reason: { code: 'renderer-missing' as const, source: 'renderer' },
        action: {
          type: 'learn-more' as const,
          code: 'view-renderer-requirements' as const,
        },
      }),
      rendererGate: 'remote-isolation' as const,
    };
    render(
      <WorkspacePaneAvailabilityList
        entries={[rendererMissing, unavailable]}
        onSelect={vi.fn()}
        onReviewInRegistry={onReviewInRegistry}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Remote review/ }));
    expect(
      screen.getByText('Extensions are disabled for this Station'),
    ).toBeTruthy();
    expect(screen.queryByText('Temporarily unavailable')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review in Registry' }));
    expect(onReviewInRegistry).toHaveBeenCalledOnce();

    expect(
      presentWorkspacePaneAvailability(rendererMissing.availability)
        .reasonLabel,
    ).toBe('The pane renderer is currently unavailable.');
  });

  test('keeps the ordinary renderer action when a gated host cannot review Registry', () => {
    const onAction = vi.fn(() => 'Checking the current pane availability.');
    const gated = {
      ...entry('Remote retry', {
        state: 'temporarily-unavailable' as const,
        reason: { code: 'renderer-missing' as const, source: 'renderer' },
        action: {
          type: 'retry' as const,
          code: 'retry-availability-check' as const,
        },
      }),
      rendererGate: 'remote-isolation' as const,
    };
    render(
      <WorkspacePaneAvailabilityList
        entries={[gated]}
        onSelect={vi.fn()}
        onAction={onAction}
        canExecuteAction={() => true}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Remote retry/ }));
    expect(
      screen.getByText('Extensions are disabled for this Station'),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Review in Registry' }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onAction).toHaveBeenCalledWith(gated, gated.availability.action);
  });

  test.each([
    [
      'with a remote-extension gate',
      'remote-isolation',
      'Extensions are disabled for this Station',
    ],
    [
      'without a remote-extension gate',
      undefined,
      'The pane renderer has not been confirmed.',
    ],
  ] as const)(
    'presents renderer-unknown %s truthfully',
    (_name, rendererGate, copy) => {
      const unknown = {
        ...entry('Unknown renderer', {
          state: 'temporarily-unavailable' as const,
          reason: { code: 'renderer-unknown' as const, source: 'renderer' },
        }),
        ...(rendererGate ? { rendererGate } : {}),
      };
      render(
        <WorkspacePaneAvailabilityList
          entries={[unknown]}
          onSelect={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /Unknown renderer/ }));
      expect(screen.getByText(copy)).toBeTruthy();
    },
  );

  test.each([
    [
      'rollout unknown',
      {
        state: 'unsupported',
        reason: { code: 'rollout-unknown', source: 'product-rollout' },
        action: { type: 'learn-more', code: 'view-rollout' },
      },
      'This pane’s rollout status has not been confirmed.',
      'Learn about rollout',
    ],
    [
      'distribution policy unknown',
      {
        state: 'not-configured',
        reason: {
          code: 'distribution-policy-unknown',
          source: 'distribution-policy',
        },
        action: { type: 'learn-more', code: 'view-distribution-policy' },
      },
      'This pane’s distribution policy has not been confirmed.',
      'View distribution policy',
    ],
  ] as const)(
    'presents truthful %s copy',
    (_name, availability, reasonLabel, actionLabel) => {
      expect(presentWorkspacePaneAvailability(availability)).toMatchObject({
        reasonLabel,
        actionLabel,
      });
    },
  );

  // archive#1868: the trigger's accessible name used to come from a
  // hand-written `aria-label`, while the DOM rendered two adjacent inline
  // spans. AT read the right thing; the VISIBLE text concatenated
  // ("CodingAvailable") — which is what text selection, find-in-page, and any
  // CSS-less render get. These pin the name as DERIVED from content.
  test('derives accessible names from rendered spans, with no aria-label override (station#1868)', () => {
    render(
      <WorkspacePaneAvailabilityList
        entries={[available, unavailable]}
        onSelect={() => {}}
      />,
    );

    // Both named controls compose their name from spans actually rendered
    // (`aria-labelledby`), never a hand-written `aria-label` assertion.
    const openButton = screen.getByRole('button', { name: 'Open Files' });
    expect(openButton.hasAttribute('aria-label')).toBe(false);
    expect(openButton.getAttribute('aria-labelledby')).toBeTruthy();

    const badge = screen.getByRole('button', { name: 'Preview Setup needed' });
    expect(badge.hasAttribute('aria-label')).toBe(false);
    expect(badge.getAttribute('aria-labelledby')).toBeTruthy();

    // And the visible card text is separated. Before the 1868 fix this was
    // "FilesAvailable" with no separator anywhere in the DOM.
    const card = openButton.closest(
      '.workspace-pane-availability-list__card',
    ) as HTMLElement;
    expect(card.textContent).toMatch(/Files:\s*Available/);

    // The separator is real content, never aria-hidden — marking it hidden
    // would drop it from any name-from-content derivation and collapse the
    // visible text back to "FilesAvailable".
    const separator = card.querySelector(
      '.workspace-pane-availability-list__separator',
    );
    expect(separator).not.toBeNull();
    expect(separator?.getAttribute('aria-hidden')).toBeNull();
  });

  // archive#1868: the component referenced `workspace-pane-availability-*`
  // classes across six files while ZERO stylesheet defined them, so the
  // catalog rendered with browser-default list chrome. This asserts the
  // stylesheet exists AND covers every class the component actually emits, so
  // a future class cannot be added against a stylesheet nobody wrote.
  test('has a stylesheet covering every class it renders (station#1868)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const componentSource = readFileSync(
      join(here, '..', 'WorkspacePaneAvailabilityList.tsx'),
      'utf8',
    );
    const stylesheet = readFileSync(
      join(here, '..', 'WorkspacePaneAvailabilityList.css'),
      'utf8',
    );

    const used = new Set(
      [
        ...componentSource.matchAll(
          /workspace-pane-availability-list__[a-z-]+/g,
        ),
      ]
        .map((match) => match[0])
        // `__item--` is a template-literal prefix; its concrete modifiers are
        // asserted separately below.
        .filter((name) => !name.endsWith('--')),
    );
    expect(used.size).toBeGreaterThan(0);
    for (const className of used) {
      expect(
        stylesheet.includes(`.${className}`),
        `${className} is rendered but has no rule in WorkspacePaneAvailabilityList.css`,
      ).toBe(true);
    }
    // The state modifiers are composed at runtime, so match them by hand
    // against the presentation states the component can produce
    // (`WorkspacePaneAvailabilityState`).
    for (const state of [
      'available',
      'coming-soon',
      'not-configured',
      'unsupported',
      'permission-required',
      'temporarily-unavailable',
    ]) {
      expect(
        stylesheet.includes(
          `.workspace-pane-availability-list__card--${state}`,
        ),
        `card--${state} has no rule`,
      ).toBe(true);
    }
  });

  // Responsive-action-surface inventory evidence (archive#3318). jsdom computes
  // no layout, so this does NOT measure 44px — it derives the one link the
  // inventory entry claims: these buttons sit in a container whose class the
  // shared mobile floor selector in index.css actually matches. Asserting the
  // DOM class and the stylesheet rule separately is what makes "inherits the
  // shared floor" a checked statement instead of an assumed one.
  test('card actions sit inside the container the shared mobile 44px floor selects', () => {
    render(
      <WorkspacePaneAvailabilityList
        entries={[available, unavailable]}
        onSelect={vi.fn()}
        onAction={vi.fn()}
        canExecuteAction={() => true}
      />,
    );

    const actionRows = Array.from(
      document.querySelectorAll('.workspace-pane-availability-list__actions'),
    );
    expect(actionRows.length).toBeGreaterThan(0);
    for (const row of actionRows) {
      // The selector arm that matches is `[class*="__actions"]`.
      expect(row.className).toContain('__actions');
      // The floor applies to DIRECT children only, so the buttons must be
      // direct children of this row — not nested in a wrapper.
      const buttons = Array.from(row.querySelectorAll('button'));
      expect(buttons.length).toBeGreaterThan(0);
      for (const button of buttons) expect(button.parentElement).toBe(row);
    }

    const indexCss = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../index.css'),
      'utf8',
    );
    const mobileBlock = indexCss.slice(
      indexCss.indexOf(
        '@media (max-width: 768px), (max-height: 540px) and (pointer: coarse)',
      ),
    );
    // The direct-child touch-floor combinator appears more than once in this
    // block (`.responsive-surface-actions` has its own). Pick the rule whose
    // selector list actually contains the arm that matches this component's
    // container, rather than whichever comes first.
    const COMBINATOR = '> :is(button, a, .button, [role="button"])';
    const floorRules: { selectors: string; body: string }[] = [];
    for (let at = mobileBlock.indexOf(COMBINATOR); at > -1; ) {
      floorRules.push({
        selectors: mobileBlock.slice(Math.max(0, at - 400), at),
        body: mobileBlock.slice(at, mobileBlock.indexOf('\n  }', at)),
      });
      at = mobileBlock.indexOf(COMBINATOR, at + 1);
    }
    const sharedFloor = floorRules.find((rule) =>
      rule.selectors.includes('[class*="__actions"]'),
    );
    expect(sharedFloor, 'no shared __actions touch-floor rule').toBeDefined();
    expect(sharedFloor?.body).toContain('min-height: 44px');
    expect(sharedFloor?.body).toContain('min-width: 44px');

    // archive#3348. The state toggle is the card's other tap target and it
    // stays in `__heading` — it is the state badge, and the shared floor only
    // reaches `__actions` children. So it must declare the floor itself, and
    // both halves of that sentence are checked: it is still outside the shared
    // row, AND its own coarse-pointer rule carries the 44px minimums.
    const toggle = document.querySelector(
      '.workspace-pane-availability-list__state-toggle',
    );
    expect(toggle).not.toBe(null);
    expect(toggle?.closest('.workspace-pane-availability-list__actions')).toBe(
      null,
    );

    const componentCss = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../WorkspacePaneAvailabilityList.css',
      ),
      'utf8',
    );
    const coarseAt = componentCss.indexOf('@media (pointer: coarse)');
    expect(coarseAt, 'no coarse-pointer block').toBeGreaterThan(-1);
    const coarseBlock = componentCss.slice(coarseAt);
    const toggleRuleAt = coarseBlock.indexOf(
      '.workspace-pane-availability-list__state-toggle {',
    );
    expect(toggleRuleAt, 'state toggle has no coarse rule').toBeGreaterThan(-1);
    // Scoped to that rule's own body — an unscoped search over the block would
    // be satisfied by any other rule in it.
    const toggleRule = coarseBlock.slice(
      toggleRuleAt,
      coarseBlock.indexOf('\n  }', toggleRuleAt),
    );
    expect(toggleRule).toContain('min-height: 44px');
    expect(toggleRule).toContain('min-width: 44px');
  });

  /**
   * #1536 H1: a loading state labelled as an outage. On every cold load a
   * plugin pane read "Temporarily unavailable" for 3–10 seconds before
   * flipping to "Available" — the renderer had not arrived yet, which the
   * resolver cannot distinguish from a renderer that is gone.
   */
  describe('a renderer fact that has not settled', () => {
    const loading: WorkspacePaneAvailabilityCatalogEntry = {
      descriptor: {
        id: 'pane.remote-review' as never,
        name: 'Remote review',
        description: 'A plugin-hosted pane',
      },
      availability: {
        state: 'temporarily-unavailable',
        reason: { code: 'renderer-missing', source: 'renderer' },
        action: { type: 'retry', code: 'retry-availability-check' },
      },
      rendererResolution: 'pending',
    };

    test('reads as loading, not as an outage, and offers no retry', () => {
      render(
        <WorkspacePaneAvailabilityList
          entries={[loading]}
          onSelect={vi.fn()}
          onAction={vi.fn()}
        />,
      );

      expect(screen.getByText('Loading…')).toBeTruthy();
      expect(screen.queryByText('Temporarily unavailable')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
    });

    test('still names a refusal the resolver already settled', () => {
      // The pending fact must not swallow a reason the reader can act on:
      // this pane is refused for a missing Project, which is known.
      render(
        <WorkspacePaneAvailabilityList
          entries={[{ ...unavailable, rendererResolution: 'pending' }]}
          onSelect={vi.fn()}
          onAction={vi.fn()}
        />,
      );

      expect(screen.getByText('Setup needed')).toBeTruthy();
      expect(screen.queryByText('Loading…')).toBeNull();
    });
  });
});
