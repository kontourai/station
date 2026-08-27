import { describe, expect, test } from 'vitest';
import {
  createDirectAnswerBasisPaneInstance,
  createSessionInventoryBasisPaneInstance,
  createTaskAnswerBasisPaneInstance,
  createWholeTaskBasisPaneInstance,
  isCanonicalBasisWorkspacePaneDescriptor,
  isCanonicalBasisWorkspacePaneInstance,
  WORKSPACE_BASIS_PANE_DESCRIPTOR,
} from '../workspace-basis-pane';

describe('Basis Workspace Pane identity', () => {
  test('declares exact answer and Task modes without ambient dock placement', () => {
    expect(
      isCanonicalBasisWorkspacePaneDescriptor(WORKSPACE_BASIS_PANE_DESCRIPTOR),
    ).toBe(true);
    expect(WORKSPACE_BASIS_PANE_DESCRIPTOR.renderer).toEqual({
      kind: 'builtin-component',
      name: 'workspace-basis',
    });
    expect(WORKSPACE_BASIS_PANE_DESCRIPTOR.placement.supportedRegions).toEqual([
      'primary',
      'secondary',
      'standalone',
    ]);
    expect(WORKSPACE_BASIS_PANE_DESCRIPTOR.placement.preferredRegion).toBe(
      'secondary',
    );
    expect(
      isCanonicalBasisWorkspacePaneDescriptor({
        ...WORKSPACE_BASIS_PANE_DESCRIPTOR,
        modes: [{ id: 'answer' }, { id: 'task' }],
      }),
    ).toBe(false);
    expect(
      isCanonicalBasisWorkspacePaneDescriptor({
        ...WORKSPACE_BASIS_PANE_DESCRIPTOR,
        placement: { supportedRegions: ['primary'] },
      }),
    ).toBe(false);
  });

  test('uses collision-safe exact contexts for direct, selected, and whole Task scopes', () => {
    const direct = createDirectAnswerBasisPaneInstance('project', 'a:b', 'c');
    const other = createDirectAnswerBasisPaneInstance('project', 'a', 'b:c');
    const selected = createTaskAnswerBasisPaneInstance(
      'project',
      'task',
      'answer',
    );
    const whole = createWholeTaskBasisPaneInstance('project', 'task');
    expect(direct?.instanceId).not.toBe(other?.instanceId);
    const sessionInventory = createSessionInventoryBasisPaneInstance(
      'project',
      'session',
    );
    for (const instance of [direct, other, selected, whole, sessionInventory]) {
      expect(instance).not.toBeNull();
      expect(isCanonicalBasisWorkspacePaneInstance(instance!)).toBe(true);
    }
    expect(
      isCanonicalBasisWorkspacePaneInstance({
        ...whole!,
        stateKey: 'forged' as NonNullable<typeof whole>['stateKey'],
      }),
    ).toBe(false);
    expect(
      createDirectAnswerBasisPaneInstance('project', '\ud800', 'turn'),
    ).toBeNull();
    expect(
      createWholeTaskBasisPaneInstance('project', 'x'.repeat(1025)),
    ).toBeNull();
  });
});
