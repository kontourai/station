/** @vitest-environment jsdom */

import type { SessionInventoryProjection } from '@kontourai/station-contracts/session-inventory';
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { SessionInventory } from '../SessionInventory';
import { buildSessionInventoryViewModel } from '../session-inventory-view';
import { renderSessionInventoryDom } from '../session-inventory-dom';

const projection: SessionInventoryProjection = {
  version: 'station.session-inventory/v1',
  scope: { kind: 'whole-session', sessionId: 'session' },
  groups: [
    {
      id: 'inputs',
      owner: { owner: 'thread', id: 'inputs' },
      state: 'available',
      count: { kind: 'at-least', value: 2 },
      gaps: [],
      continuation: 'next',
      items: [
        {
          kind: 'thread-authored-input',
          key: 'input',
          owner: { owner: 'thread', id: 'input' },
          relations: ['observed-during'],
          sessionId: 'session',
          eventId: 'event',
          turnId: 'turn',
          inputKind: 'message',
          attachmentDescriptors: [],
        },
      ],
    },
    {
      id: 'outputs',
      owner: { owner: 'thread', id: 'outputs' },
      state: 'available',
      count: { kind: 'exact', value: 1 },
      gaps: [],
      items: [
        {
          kind: 'station-session-output',
          key: 'output',
          owner: { owner: 'thread', id: 'output' },
          relations: ['contributed-to'],
          output: {
            ref: { sessionId: 'session', eventId: 'event-output' },
            turnId: 'turn',
            toolCallId: 'call',
            declaredAt: '2026-08-27T00:00:00.000Z',
            label: '<script>\u202E'.repeat(80),
            descriptor: {
              kind: 'workspace-file',
              relativePath: 'very-long-name',
              digest: 'a'.repeat(64),
              length: 1,
            },
          },
        },
      ],
    },
    {
      id: 'sources',
      owner: { owner: 'surface', id: 'sources' },
      state: 'not-captured',
      items: [],
      gaps: [{ kind: 'not-captured' }],
    },
  ],
};

describe('Session inventory view model', () => {
  test('renders hostile labels as inert text without links or images', () => {
    const root = document.createElement('section');
    renderSessionInventoryDom(
      root,
      buildSessionInventoryViewModel(
        projection,
        { scope: projection.scope, groupId: 'outputs' },
        'compact',
      ),
    );
    expect(root.textContent).toContain('<script>');
    expect(root.querySelectorAll('a,img,script')).toHaveLength(0);
  });
  test('has identical compact and full occurrence keys and exact count copy', () => {
    const selection = {
      scope: projection.scope,
      groupId: 'outputs' as const,
      itemKey: 'output',
    };
    const compact = buildSessionInventoryViewModel(
      projection,
      selection,
      'compact',
    );
    const full = buildSessionInventoryViewModel(projection, selection, 'full');
    expect(compact.groups.map((group) => group.key)).toEqual(
      full.groups.map((group) => group.key),
    );
    expect(
      compact.groups.map((group) => group.items.map((item) => item.key)),
    ).toEqual(full.groups.map((group) => group.items.map((item) => item.key)));
    expect(full.groups.find((group) => group.id === 'inputs')?.count).toBe(
      '2+',
    );
    expect(full.groups.find((group) => group.id === 'outputs')?.count).toBe(
      '1',
    );
    expect(
      full.groups.find((group) => group.id === 'outputs')?.items[0]?.relation,
    ).toBe('Contributed to this answer');
  });

  test('repairs a vanished selected item to its own group heading, not a neighbor', () => {
    const model = buildSessionInventoryViewModel(projection, {
      scope: projection.scope,
      groupId: 'outputs',
      itemKey: 'gone',
    });
    expect(model.repairedSelection).toBe(true);
    expect(model.selection).toEqual({
      scope: projection.scope,
      groupId: 'outputs',
    });
  });

  test('repairs a stale scope to the projection scope', () => {
    const model = buildSessionInventoryViewModel(projection, {
      scope: { kind: 'current-answer', sessionId: 'session', turnId: 'other' },
      groupId: 'outputs',
    });
    expect(model.repairedSelection).toBe(true);
    expect(model.selection.scope).toEqual(projection.scope);
  });

  test('renders hostile owner labels as inert isolated text', () => {
    const model = buildSessionInventoryViewModel(projection, {
      scope: projection.scope,
      groupId: 'outputs',
      itemKey: 'output',
    });
    const view = render(<SessionInventory model={model} onSelect={() => {}} />);
    expect(screen.getByText(/<script>/).tagName).toBe('BDI');
    expect(screen.queryByRole('link')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Select item 1 in Outputs' }),
    ).toBeTruthy();
    view.rerender(
      <SessionInventory
        model={buildSessionInventoryViewModel(projection, {
          scope: projection.scope,
          groupId: 'sources',
        })}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText('Not captured by this owner.')).toBeTruthy();
  });

  test('keeps available owner gaps visible and derives an Attention cue', () => {
    const withGap = {
      ...projection,
      groups: projection.groups.map((group) =>
        group.id === 'outputs'
          ? { ...group, gaps: [{ kind: 'unavailable' as const }] }
          : group,
      ),
    };
    const model = buildSessionInventoryViewModel(withGap, {
      scope: withGap.scope,
      groupId: 'attention',
    });
    expect(model.groups.find((group) => group.id === 'outputs')?.gaps).toEqual([
      'This owner is unavailable.',
    ]);
    expect(
      model.groups.find((group) => group.id === 'attention')?.stateCopy,
    ).toBe('Some owner context needs attention.');
  });

  test('derives Attention from every typed owner gap independently of selection', () => {
    const withAllGaps = {
      ...projection,
      groups: projection.groups.map((group) =>
        group.id === 'inputs'
          ? { ...group, gaps: [{ kind: 'not-captured' as const }] }
          : group.id === 'outputs'
            ? { ...group, gaps: [{ kind: 'unsupported-version' as const }] }
            : group,
      ),
    };
    const model = buildSessionInventoryViewModel(withAllGaps, {
      scope: withAllGaps.scope,
      groupId: 'outputs',
    });
    expect(
      model.groups.find((group) => group.id === 'attention')?.gaps,
    ).toEqual(
      expect.arrayContaining([
        'Not captured by this owner.',
        'This owner does not provide this projection version.',
      ]),
    );
  });

  test('uses occurrence-local headings and focuses only its repaired pane', () => {
    const first = buildSessionInventoryViewModel(projection, {
      scope: projection.scope,
      groupId: 'outputs',
      itemKey: 'gone',
    });
    const second = buildSessionInventoryViewModel(projection, {
      scope: projection.scope,
      groupId: 'sources',
    });
    render(
      <>
        <SessionInventory model={first} onSelect={() => {}} repairFocus />
        <SessionInventory model={second} onSelect={() => {}} />
      </>,
    );
    const headings = screen.getAllByRole('heading', { name: /Outputs/ });
    expect(headings).toHaveLength(1);
    expect(document.activeElement).toBe(headings[0]);
    expect(
      screen.getAllByRole('region', { name: 'Session inventory' }),
    ).toHaveLength(2);
  });
});
