/** @vitest-environment jsdom */

import { parseWorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneHostDocumentV1 } from '@kontourai/station-contracts/workspace-pane-host';
import { describe, expect, test } from 'vitest';
import { workspacePaneHostStorageKey } from '../workspacePaneHostStorage';
import {
  closeWorkspacePaneHostDocument,
  prepareWorkspacePaneHostOpen,
} from '../workspacePaneHostTransactions';

const one = parseWorkspacePaneInstance({
  version: '1.0',
  descriptorId: 'one',
  instanceId: 'one',
  stateKey: 'one',
})!;
const two = parseWorkspacePaneInstance({
  version: '1.0',
  descriptorId: 'two',
  instanceId: 'two',
  stateKey: 'two',
})!;

function document(): WorkspacePaneHostDocumentV1 {
  return {
    version: '1.1',
    id: 'host',
    scope: { kind: 'project', projectId: 'project', layoutId: 'layout' },
    instances: [one],
    activeInstanceId: one.instanceId,
    root: {
      type: 'tabs',
      id: 'root',
      instanceIds: [one.instanceId],
      selectedInstanceId: one.instanceId,
    },
  };
}

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    adapter: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  };
}

describe('workspace pane host transactions', () => {
  test('commits a real catalog contribution without losing its plugin provenance', () => {
    const pane = parseWorkspacePaneInstance({
      ...two,
      boundContext: {
        projectId: 'project',
        contribution: {
          id: 'builder:sessions',
          version: '1.0.0',
          sourceIdentity: {
            id: 'builder',
            kind: 'local',
            source: 'file:///plugins/builder',
          },
          provenance: { origin: 'plugin', pluginId: 'builder' },
        },
      },
    })!;
    const before = document();
    const { adapter, values } = storage();
    const result = prepareWorkspacePaneHostOpen({
      state: { document: before, rendererFailures: {} },
      instance: pane,
      storage: adapter,
      owner: Symbol('plugin'),
      preparation: { prepare: () => true, rollback: () => {} },
    });
    expect(result).toMatchObject({ ok: true });
    const persisted = JSON.parse(
      values.get(workspacePaneHostStorageKey(before.scope, before.id)) ??
        'null',
    );
    expect(persisted.instances).toEqual([one, pane]);
  });

  test('rolls host persistence back before a rejected pane preparation becomes visible', () => {
    const before = document();
    const { adapter, values } = storage();
    const events: string[] = [];

    const result = prepareWorkspacePaneHostOpen({
      state: { document: before, rendererFailures: {} },
      instance: two,
      storage: adapter,
      owner: Symbol('test'),
      preparation: {
        prepare: () => {
          events.push('prepare');
          return false;
        },
        rollback: () => events.push('rollback'),
      },
    });

    expect(result).toEqual({ ok: false, reason: 'not-persisted' });
    expect(events).toEqual(['prepare', 'rollback']);
    const persisted = JSON.parse(
      values.get(workspacePaneHostStorageKey(before.scope, before.id)) ?? '',
    );
    expect(persisted.instances).toEqual([one]);
  });

  test('names the reason a prepared open produced no next state', () => {
    const before = document();
    const { adapter } = storage();
    const owner = Symbol('reasons');

    // Already open: decided from the document, before anything is written.
    expect(
      prepareWorkspacePaneHostOpen({
        state: { document: before, rendererFailures: {} },
        instance: one,
        storage: adapter,
        owner,
      }),
    ).toEqual({ ok: false, reason: 'already-open' });

    // Refused: the host document model declines a placement into a group it
    // does not have, so the reducer never adds the occurrence.
    expect(
      prepareWorkspacePaneHostOpen({
        state: { document: before, rendererFailures: {} },
        instance: two,
        storage: adapter,
        owner,
        action: {
          type: 'add-existing-instance',
          instance: two,
          targetGroupId: 'absent',
        },
      }),
    ).toEqual({ ok: false, reason: 'refused' });

    // Not persisted: the durable write itself fails, after the reducer agreed.
    expect(
      prepareWorkspacePaneHostOpen({
        state: { document: before, rendererFailures: {} },
        instance: two,
        storage: {
          getItem: adapter.getItem,
          setItem: () => {
            throw new Error('quota');
          },
          removeItem: adapter.removeItem,
        },
        owner,
      }),
    ).toEqual({ ok: false, reason: 'not-persisted' });
  });

  test('computes close eligibility before committing a lifecycle close', () => {
    expect(
      closeWorkspacePaneHostDocument(document(), one.instanceId),
    ).toBeNull();
    const multi = {
      ...document(),
      instances: [one, two],
      root: {
        type: 'tabs' as const,
        id: 'root',
        instanceIds: [one.instanceId, two.instanceId],
        selectedInstanceId: one.instanceId,
      },
    };
    expect(
      closeWorkspacePaneHostDocument(multi, two.instanceId)?.instances,
    ).toEqual([one]);
  });
});
