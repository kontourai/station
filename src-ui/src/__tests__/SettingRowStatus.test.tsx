/** @vitest-environment jsdom */

/**
 * #2144 slice 3 — the status strip a generic settings row carries, and the
 * on-demand layer list behind its trigger.
 *
 * The layer assertions go through the REAL `LazyBoundary` and the REAL
 * dynamic import rather than a stand-in: whether the body loads at all is one
 * of the things under test, and a mocked module would answer that question
 * by construction. What this does NOT prove is which chunk it lands in —
 * that is the entry-bundle ceiling's job (`scripts/check-prepush-ui-bundle.mjs`).
 */

import type {
  SettingDefinition,
  SettingProvenanceEntry,
} from '@kontourai/station-contracts/settings-registry';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  inheritanceLayers,
  SettingInheritanceLayers,
} from '../views/settings/SettingInheritanceLayers';
import {
  SettingRowStatus,
  scopeBadgeLabel,
} from '../views/settings/SettingRowStatus';

afterEach(cleanup);

const definition = {
  key: 'defaultWorkspaceIsolation',
  scope: 'station',
  descriptor: { kind: 'enum', values: ['shared', 'worktree'] },
  label: 'New chat workspace',
  help: 'New chats in a project that names no workspace of its own run in this one.',
  description: 'Shared runs every chat in the project’s own checkout.',
  defaultValue: 'shared',
} as unknown as SettingDefinition;

/** The four shapes `GET /config/app` can report for one key. */
const PROVENANCE_SHAPES: Record<string, SettingProvenanceEntry | undefined> = {
  project: { source: 'file', scope: 'project' },
  station: { source: 'file', scope: 'station' },
  env: { source: 'env', envVar: 'STATION_WORKSPACE' },
  default: { source: 'default' },
};

describe('inheritance layers', () => {
  for (const [shape, provenance] of Object.entries(PROVENANCE_SHAPES)) {
    test(`exactly one layer is in effect for the ${shape} shape`, () => {
      const layers = inheritanceLayers({
        definition,
        provenance,
        projectName: 'Atlas',
        projectValue: 'worktree',
        stationValue: 'shared',
      });
      expect(layers.filter((layer) => layer.inEffect)).toHaveLength(1);
      expect(layers.find((layer) => layer.inEffect)?.id).toBe(shape);
    });
  }

  // An unscoped read emits no `scope`, and a key absent from the loaded
  // config gets no entry at all. Both already have an answer above, but only
  // as separate shapes — pin that they land where the docblock says.
  test('a file entry with no scope is the Station layer, and no entry is the default', () => {
    expect(
      inheritanceLayers({ definition, provenance: { source: 'file' } }).find(
        (layer) => layer.inEffect,
      )?.id,
    ).toBe('station');
    expect(
      inheritanceLayers({ definition }).find((layer) => layer.inEffect)?.id,
    ).toBe('default');
  });

  test('a required setting reports no built-in default to fall back to', () => {
    const required = { ...definition, required: true } as SettingDefinition;
    const layers = inheritanceLayers({ definition: required });
    expect(layers.find((layer) => layer.id === 'default')?.value).toBe('none');
  });

  test('a project override still shows the Station value it sits on top of', () => {
    render(
      <SettingInheritanceLayers
        definition={definition}
        provenance={{ source: 'file', scope: 'project' }}
        projectName="Atlas"
        projectValue="worktree"
        stationValue="shared"
      />,
    );
    // The page HAS the Station value; dropping it and saying it could not be
    // shown was a claim the props contradicted.
    const station = screen.getByText('This Station').closest('li')!;
    expect(station.textContent).toContain('shared');
    expect(station.className).not.toContain('--in-effect');
    // What is genuinely unreported is the SOURCE, and the note says only that.
    expect(
      screen.getByText(
        'Whether this Station stores that value or falls back to the default is not reported while an override is in effect.',
      ),
    ).toBeTruthy();
  });

  test('exactly one layer stays in effect once the Station layer is shown beside a project override', () => {
    const layers = inheritanceLayers({
      definition,
      provenance: { source: 'file', scope: 'project' },
      projectValue: 'worktree',
      stationValue: 'shared',
    });
    expect(layers.map((layer) => layer.id)).toEqual([
      'project',
      'station',
      'default',
    ]);
    expect(layers.filter((layer) => layer.inEffect)).toHaveLength(1);
    expect(layers.find((layer) => layer.inEffect)?.id).toBe('project');
  });

  test('a Station that stores nothing reads as the default, not as "none"', () => {
    render(
      <SettingInheritanceLayers
        definition={definition}
        provenance={{ source: 'file', scope: 'project' }}
        projectName="Atlas"
        projectValue="worktree"
      />,
    );
    // "none" said the Station had no value at all. It has one — the registry
    // default — and the list has to say so rather than invent an absence.
    const station = screen.getByText('This Station').closest('li')!;
    expect(station.textContent).toContain('uses the built-in default');
    expect(station.textContent).not.toContain('none');
    // Nothing is unreported in this case: no value in the config document IS
    // the fallback, so the source note would be claiming a doubt that is gone.
    expect(screen.queryByText(/is not reported while an override/)).toBeNull();
  });

  for (const pending of ['reset', 'edit'] as const) {
    test(`a pending ${pending} stops the list claiming any layer is in effect`, () => {
      render(
        <SettingInheritanceLayers
          definition={definition}
          provenance={{ source: 'file', scope: 'project' }}
          pending={pending}
          projectName="Atlas"
          projectValue="worktree"
          stationValue="shared"
        />,
      );
      // The provenance predates the draft, so marking the project layer in
      // effect would describe a resolution the row no longer shows.
      expect(screen.queryByText('in effect')).toBeNull();
      expect(
        screen.getByText(
          'Unsaved change: the layers below describe what is saved.',
        ),
      ).toBeTruthy();
      // The layers themselves are unchanged — only the claim is withheld.
      expect(screen.getByText('Project: Atlas')).toBeTruthy();
    });
  }

  test('with no pending change the in-effect mark is still made', () => {
    render(
      <SettingInheritanceLayers
        definition={definition}
        provenance={{ source: 'file', scope: 'project' }}
        projectName="Atlas"
        projectValue="worktree"
        stationValue="shared"
      />,
    );
    expect(screen.getByText('in effect')).toBeTruthy();
    expect(screen.queryByText(/^Unsaved change/)).toBeNull();
  });

  test('the layer list leads with the definition’s help sentence', () => {
    render(
      <SettingInheritanceLayers
        definition={definition}
        provenance={{ source: 'file', scope: 'project' }}
        projectName="Atlas"
        projectValue="worktree"
      />,
    );
    expect(screen.getByText(definition.help!)).toBeTruthy();
    expect(screen.getByText('Project: Atlas')).toBeTruthy();
  });
});

describe('scope badge', () => {
  test('names the document that owns the value', () => {
    expect(scopeBadgeLabel('station', { source: 'file' })).toBe('Station');
    expect(scopeBadgeLabel('defaults', undefined)).toBe('Station');
    expect(scopeBadgeLabel('device', undefined)).toBe('This device');
    // A project override is a fact about THIS value and wins over the
    // catalog's fact about the setting.
    expect(
      scopeBadgeLabel('station', { source: 'file', scope: 'project' }),
    ).toBe('Project');
  });

  test('says nothing for a row with no single owner', () => {
    for (const scope of ['mixed', 'temporary', 'informational'] as const) {
      expect(scopeBadgeLabel(scope, { source: 'file' })).toBeUndefined();
    }
    expect(scopeBadgeLabel(undefined, undefined)).toBeUndefined();
  });
});

describe('SettingRowStatus', () => {
  test('the inheritance trigger has an accessible name and loads its body on demand', async () => {
    render(
      <SettingRowStatus
        definition={definition}
        provenance={{ source: 'file', scope: 'station' }}
        catalogScope="station"
        stationValue="worktree"
      />,
    );
    const trigger = screen.getByRole('button', {
      name: 'Where New chat workspace comes from',
    });
    // Closed: the body is not in the tree at all, so nothing has loaded it.
    expect(screen.queryByText(definition.help!)).toBeNull();

    fireEvent.click(trigger);
    expect(await screen.findByText(definition.help!)).toBeTruthy();
    expect(screen.getByText('Stored on this Station')).toBeTruthy();
  });

  test('reset to inherited is offered only for a project override that has something to fall back to', () => {
    const onResetToInherited = vi.fn();
    const { rerender } = render(
      <SettingRowStatus
        definition={definition}
        provenance={{ source: 'file', scope: 'station' }}
        catalogScope="station"
        onResetToInherited={onResetToInherited}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Reset to inherited' })).toBe(
      null,
    );

    rerender(
      <SettingRowStatus
        definition={definition}
        provenance={{ source: 'file', scope: 'project' }}
        catalogScope="station"
        onResetToInherited={onResetToInherited}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset to inherited' }));
    expect(onResetToInherited).toHaveBeenCalledTimes(1);

    // `required` has no inherited value to fall back to, so the affordance is
    // withheld rather than offered and then refused.
    rerender(
      <SettingRowStatus
        definition={{ ...definition, required: true } as SettingDefinition}
        provenance={{ source: 'file', scope: 'project' }}
        catalogScope="station"
        onResetToInherited={onResetToInherited}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Reset to inherited' })).toBe(
      null,
    );
  });
});
