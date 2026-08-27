/** @vitest-environment jsdom */

import { parseWorkspacePaneInstance } from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneHostDocumentV1 } from '@kontourai/station-contracts/workspace-pane-host';
import { describe, expect, test, vi } from 'vitest';
import { navigationStore } from '../../contexts/navigation-store';
import {
  readWorkspacePaneHostSelection,
  writeWorkspacePaneHostSelection,
} from '../workspacePaneHostNavigation';
import { WorkspacePaneHostRuntime } from '../workspacePaneHostRuntime';
import {
  hydrateWorkspacePaneHost,
  persistWorkspacePaneHost,
  workspacePaneHostStorageKey,
} from '../workspacePaneHostStorage';

function document(): WorkspacePaneHostDocumentV1 {
  const one = parseWorkspacePaneInstance({
    version: '1.0',
    descriptorId: 'one',
    instanceId: 'one',
    stateKey: 'one',
  })!;
  return {
    version: '1.1',
    id: 'host',
    scope: {
      kind: 'task',
      projectId: 'project',
      taskId: 'task',
      layoutId: 'layout',
    },
    instances: [one],
    root: { type: 'tabs', id: 'root', instanceIds: [one.instanceId] },
    activeInstanceId: one.instanceId,
  };
}

describe('Workspace Pane host storage and navigation bridge', () => {
  test('persists only under the exact Project/Task/Layout/document scope and validates hydration', () => {
    const host = document();
    const storage = new Map<string, string>();
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };
    expect(persistWorkspacePaneHost(adapter, host)).toBe(true);
    expect(workspacePaneHostStorageKey(host.scope, host.id)).toContain(
      'task:task:project:layout:host',
    );
    expect(
      hydrateWorkspacePaneHost(adapter, host.scope, host.id, host.instances)
        .document,
    ).toMatchObject({
      ...host,
      root: { ...host.root, selectedInstanceId: 'one' },
    });
    expect(
      hydrateWorkspacePaneHost(
        adapter,
        {
          kind: 'task',
          projectId: 'project',
          taskId: 'other-task',
          layoutId: 'layout',
        },
        host.id,
        host.instances,
      ).document,
    ).toBeNull();
  });

  test('projects selection through the existing navigation store snapshot', () => {
    navigationStore.navigate('/projects/project/layouts/layout', {
      pane: null,
    });
    const host = document();
    writeWorkspacePaneHostSelection(host, host.activeInstanceId);
    expect(new URL(window.location.href).searchParams.get('pane')).toBe('one');
    expect(readWorkspacePaneHostSelection(host)).toBe('one');
    expect(
      readWorkspacePaneHostSelection({
        ...host,
        scope: { kind: 'project', projectId: 'other', layoutId: 'layout' },
      }),
    ).toBeNull();
    navigationStore.navigate('/projects/other/layouts/layout');
    expect(readWorkspacePaneHostSelection(host)).toBeNull();
  });

  test('uses UTF-8 bytes and strict validation at the storage boundary', () => {
    const host = document();
    const storage = new Map<string, string>();
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    };
    storage.set(
      workspacePaneHostStorageKey(host.scope, host.id),
      '🧪'.repeat(20_000),
    );
    expect(
      hydrateWorkspacePaneHost(adapter, host.scope, host.id, host.instances)
        .document,
    ).toBeNull();
    expect(
      persistWorkspacePaneHost(adapter, {
        ...host,
        id: 'x'.repeat(129),
      } as WorkspacePaneHostDocumentV1),
    ).toBe(false);
  });
});

describe('Workspace Pane host runtime', () => {
  test('reconciles visible desktop siblings without making focus lifecycle ownership', async () => {
    const events: string[] = [];
    const runtime = new WorkspacePaneHostRuntime();
    const panes = ['one', 'two', 'three'].map(
      (id) =>
        parseWorkspacePaneInstance({
          version: '1.0',
          descriptorId: id,
          instanceId: id,
          stateKey: id,
        })!,
    );
    for (const pane of panes) {
      runtime.register(pane.instanceId, {
        mount: () => {
          events.push(`${pane.instanceId}:mount`);
        },
        suspend: () => {
          events.push(`${pane.instanceId}:suspend`);
        },
        resume: () => {
          events.push(`${pane.instanceId}:resume`);
        },
        dispose: () => {
          events.push(`${pane.instanceId}:dispose`);
        },
      });
    }
    await runtime.reconcileVisible([panes[0].instanceId, panes[1].instanceId]);
    runtime.setFocused(panes[0].instanceId);
    await runtime.reconcileVisible([panes[1].instanceId, panes[2].instanceId]);
    expect(events).toEqual([
      'one:mount',
      'two:mount',
      'one:suspend',
      'three:mount',
    ]);
    expect(runtime.activeInstanceId).toBe('one');
    expect(runtime.visibleInstanceIds()).toEqual(
      expect.arrayContaining(['two', 'three']),
    );
  });

  test('retry retains unresolved cleanup until disposal succeeds', async () => {
    const runtime = new WorkspacePaneHostRuntime();
    const dispose = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('cleanup');
      })
      .mockImplementationOnce(() => {
        throw new Error('retry cleanup');
      });
    const pane = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'one',
      instanceId: 'one',
      stateKey: 'one',
    })!;
    runtime.register(pane.instanceId, {
      mount: () => {
        throw new Error('partial');
      },
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose,
    });
    await runtime.reconcileVisible([pane.instanceId]);
    expect(runtime.hasFailed(pane.instanceId)).toBe(true);
    expect(await runtime.retry(pane.instanceId)).toBe(false);
    expect(runtime.hasFailed(pane.instanceId)).toBe(true);
  });

  test('orders mount, suspend, resume, dispose and asks dirty/pending panes for confirmation', async () => {
    const first = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'one',
      instanceId: 'one',
      stateKey: 'one',
    })!;
    const second = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'two',
      instanceId: 'two',
      stateKey: 'two',
    })!;
    const events: string[] = [];
    const runtime = new WorkspacePaneHostRuntime();
    runtime.register(first.instanceId, {
      mount: () => {
        events.push('one:mount');
      },
      suspend: () => {
        events.push('one:suspend');
      },
      resume: () => {
        events.push('one:resume');
      },
      dispose: () => {
        events.push('one:dispose');
      },
      beforeClose: () => ({ confirm: 'dirty' }),
    });
    runtime.register(second.instanceId, {
      mount: () => {
        events.push('two:mount');
      },
      suspend: () => {
        events.push('two:suspend');
      },
      resume: () => {
        events.push('two:resume');
      },
      dispose: () => {
        events.push('two:dispose');
      },
      beforeClose: () => ({ confirm: 'pending' }),
    });
    await runtime.activate(first.instanceId);
    await runtime.activate(second.instanceId);
    await runtime.activate(first.instanceId);
    expect(events).toEqual([
      'one:mount',
      'one:suspend',
      'two:mount',
      'two:suspend',
      'one:resume',
    ]);
    await expect(runtime.requestClose(first.instanceId)).resolves.toEqual({
      status: 'confirm',
      reason: 'dirty',
    });
    await runtime.confirmClose(first.instanceId);
    expect(events).toContain('one:dispose');
  });

  test('isolates a local crash without disposing a sibling', async () => {
    const first = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'one',
      instanceId: 'one',
      stateKey: 'one',
    })!;
    const second = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'two',
      instanceId: 'two',
      stateKey: 'two',
    })!;
    const firstDispose = vi.fn();
    const secondDispose = vi.fn();
    const runtime = new WorkspacePaneHostRuntime();
    runtime.register(first.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose: firstDispose,
    });
    runtime.register(second.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose: secondDispose,
    });
    await runtime.activate(first.instanceId);
    await runtime.activate(second.instanceId);
    await runtime.fail(second.instanceId);
    expect(secondDispose).toHaveBeenCalledOnce();
    expect(firstDispose).not.toHaveBeenCalled();
    expect(runtime.isMounted(first.instanceId)).toBe(true);
  });

  test('keeps lifecycle state retryable when callbacks throw', async () => {
    const first = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'one',
      instanceId: 'one',
      stateKey: 'one',
    })!;
    const second = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'two',
      instanceId: 'two',
      stateKey: 'two',
    })!;
    const runtime = new WorkspacePaneHostRuntime();
    const resume = vi.fn();
    runtime.register(first.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume,
      dispose: vi.fn(),
    });
    runtime.register(second.instanceId, {
      mount: () => {
        throw new Error('mount');
      },
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose: vi.fn(),
      beforeClose: () => {
        throw new Error('close');
      },
    });
    await runtime.activate(first.instanceId);
    await expect(runtime.activate(second.instanceId)).resolves.toBe(false);
    expect(runtime.activeInstanceId).toBe(first.instanceId);
    expect(resume).toHaveBeenCalledOnce();
    await expect(runtime.requestClose(second.instanceId)).resolves.toEqual({
      status: 'error',
    });
    expect(runtime.isMounted(first.instanceId)).toBe(true);
  });

  test('clears active ownership when rollback resume also fails and cleans a partial target mount', async () => {
    const first = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'one',
      instanceId: 'one',
      stateKey: 'one',
    })!;
    const second = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'two',
      instanceId: 'two',
      stateKey: 'two',
    })!;
    const dispose = vi.fn();
    const runtime = new WorkspacePaneHostRuntime();
    runtime.register(first.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume: () => {
        throw new Error('rollback');
      },
      dispose: vi.fn(),
    });
    runtime.register(second.instanceId, {
      mount: () => {
        throw new Error('partial');
      },
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose,
    });
    await runtime.activate(first.instanceId);
    await expect(runtime.activate(second.instanceId)).resolves.toBe(false);
    expect(runtime.activeInstanceId).toBeNull();
    expect(dispose).toHaveBeenCalledOnce();
  });

  test('contains suspend, resume, and dispose callback errors without corrupting ownership', async () => {
    const first = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'one',
      instanceId: 'one',
      stateKey: 'one',
    })!;
    const second = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'two',
      instanceId: 'two',
      stateKey: 'two',
    })!;
    const suspendRuntime = new WorkspacePaneHostRuntime();
    suspendRuntime.register(first.instanceId, {
      mount: vi.fn(),
      suspend: () => {
        throw new Error('suspend');
      },
      resume: vi.fn(),
      dispose: vi.fn(),
    });
    suspendRuntime.register(second.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose: vi.fn(),
    });
    await suspendRuntime.activate(first.instanceId);
    await expect(suspendRuntime.activate(second.instanceId)).resolves.toBe(
      false,
    );
    expect(suspendRuntime.activeInstanceId).toBeNull();
    expect(suspendRuntime.hasFailed(first.instanceId)).toBe(true);

    const resumeRuntime = new WorkspacePaneHostRuntime();
    resumeRuntime.register(first.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume: () => {
        throw new Error('resume');
      },
      dispose: vi.fn(),
    });
    resumeRuntime.register(second.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose: vi.fn(),
    });
    await resumeRuntime.activate(first.instanceId);
    await resumeRuntime.activate(second.instanceId);
    await expect(resumeRuntime.activate(first.instanceId)).resolves.toBe(false);
    expect(resumeRuntime.activeInstanceId).toBe(second.instanceId);

    const disposeRuntime = new WorkspacePaneHostRuntime();
    disposeRuntime.register(first.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose: () => {
        throw new Error('dispose');
      },
    });
    await disposeRuntime.activate(first.instanceId);
    await expect(
      disposeRuntime.confirmClose(first.instanceId),
    ).resolves.toEqual({ status: 'error' });
    expect(disposeRuntime.isMounted(first.instanceId)).toBe(true);
    expect(disposeRuntime.activeInstanceId).toBe(first.instanceId);
  });

  test('requires disposal before replacing callbacks for a mounted or failed instance', async () => {
    const pane = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'one',
      instanceId: 'one',
      stateKey: 'one',
    })!;
    const sibling = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'two',
      instanceId: 'two',
      stateKey: 'two',
    })!;
    const oldMount = vi.fn();
    const oldResume = vi.fn();
    const replacementMount = vi.fn();
    const replacementResume = vi.fn();
    const runtime = new WorkspacePaneHostRuntime();
    expect(
      runtime.register(pane.instanceId, {
        mount: oldMount,
        suspend: vi.fn(),
        resume: oldResume,
        dispose: vi.fn(),
      }),
    ).toBe(true);
    await runtime.activate(pane.instanceId);
    expect(
      runtime.register(pane.instanceId, {
        mount: replacementMount,
        suspend: vi.fn(),
        resume: replacementResume,
        dispose: vi.fn(),
      }),
    ).toBe(false);
    runtime.register(sibling.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose: vi.fn(),
    });
    await runtime.activate(sibling.instanceId);
    await runtime.activate(pane.instanceId);
    expect(oldResume).toHaveBeenCalledOnce();
    expect(replacementResume).not.toHaveBeenCalled();
    await runtime.fail(pane.instanceId);
    expect(runtime.hasFailed(pane.instanceId)).toBe(true);
    expect(
      runtime.register(pane.instanceId, {
        mount: replacementMount,
        suspend: vi.fn(),
        resume: replacementResume,
        dispose: vi.fn(),
      }),
    ).toBe(false);
    await expect(runtime.confirmClose(pane.instanceId)).resolves.toEqual({
      status: 'closed',
    });
    expect(
      runtime.register(pane.instanceId, {
        mount: replacementMount,
        suspend: vi.fn(),
        resume: replacementResume,
        dispose: vi.fn(),
      }),
    ).toBe(true);
    await runtime.activate(pane.instanceId);
    expect(replacementMount).toHaveBeenCalledOnce();
    expect(replacementResume).not.toHaveBeenCalled();
  });

  test('tombstones an authoritative revocation until retained cleanup succeeds', async () => {
    const pane = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'one',
      instanceId: 'one',
      stateKey: 'one',
    })!;
    const dispose = vi.fn().mockImplementationOnce(() => {
      throw new Error('first revocation cleanup fails');
    });
    const replacementMount = vi.fn();
    const runtime = new WorkspacePaneHostRuntime();
    runtime.register(pane.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose,
    });
    await expect(runtime.activate(pane.instanceId)).resolves.toBe(true);

    await expect(runtime.revoke(pane.instanceId)).resolves.toEqual({
      status: 'error',
    });
    expect(runtime.isRevoked(pane.instanceId)).toBe(true);
    expect(runtime.requiresCleanup(pane.instanceId)).toBe(true);
    expect(runtime.activeInstanceId).toBeNull();
    expect(runtime.visibleInstanceIds()).not.toContain(pane.instanceId);
    expect(runtime.setFocused(pane.instanceId)).toBe(false);
    await expect(runtime.activate(pane.instanceId)).resolves.toBe(false);
    await expect(runtime.requestClose(pane.instanceId)).resolves.toEqual({
      status: 'missing',
    });
    await runtime.reconcileVisible([pane.instanceId]);
    expect(runtime.visibleInstanceIds()).not.toContain(pane.instanceId);
    expect(
      runtime.register(pane.instanceId, {
        mount: replacementMount,
        suspend: vi.fn(),
        resume: vi.fn(),
        dispose: vi.fn(),
      }),
    ).toBe(false);

    await expect(runtime.retryRevokedCleanup(pane.instanceId)).resolves.toBe(
      true,
    );
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(runtime.isRevoked(pane.instanceId)).toBe(false);
    expect(runtime.requiresCleanup(pane.instanceId)).toBe(false);
    expect(
      runtime.register(pane.instanceId, {
        mount: replacementMount,
        suspend: vi.fn(),
        resume: vi.fn(),
        dispose: vi.fn(),
      }),
    ).toBe(true);
    await expect(runtime.activate(pane.instanceId)).resolves.toBe(true);
    expect(replacementMount).toHaveBeenCalledOnce();
  });

  test('waits for a gated reconciliation mount before cleaning a revoked allocation', async () => {
    const pane = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'one',
      instanceId: 'one',
      stateKey: 'one',
    })!;
    let releaseMount!: () => void;
    const dispose = vi.fn();
    const runtime = new WorkspacePaneHostRuntime();
    runtime.register(pane.instanceId, {
      mount: () =>
        new Promise<void>((resolve) => {
          releaseMount = resolve;
        }),
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose,
    });

    const reconciliation = runtime.reconcileVisible([pane.instanceId]);
    await vi.waitFor(() => expect(releaseMount).toBeTypeOf('function'));
    expect(runtime.requiresCleanup(pane.instanceId)).toBe(true);

    const revocation = runtime.revoke(pane.instanceId);
    expect(runtime.isRevoked(pane.instanceId)).toBe(true);
    expect(runtime.activeInstanceId).toBeNull();
    expect(runtime.visibleInstanceIds()).not.toContain(pane.instanceId);
    expect(dispose).not.toHaveBeenCalled();
    releaseMount();

    await expect(reconciliation).resolves.toEqual(new Set());
    await expect(revocation).resolves.toEqual({ status: 'closed' });
    expect(dispose).toHaveBeenCalledOnce();
    expect(runtime.isMounted(pane.instanceId)).toBe(false);
    expect(runtime.visibleInstanceIds()).not.toContain(pane.instanceId);
    expect(
      runtime.register(pane.instanceId, {
        mount: vi.fn(),
        suspend: vi.fn(),
        resume: vi.fn(),
        dispose: vi.fn(),
      }),
    ).toBe(true);
  });

  test('serializes a gated activate mount with revocation cleanup', async () => {
    const pane = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'one',
      instanceId: 'one',
      stateKey: 'one',
    })!;
    let releaseMount!: () => void;
    const dispose = vi.fn();
    const runtime = new WorkspacePaneHostRuntime();
    runtime.register(pane.instanceId, {
      mount: () =>
        new Promise<void>((resolve) => {
          releaseMount = resolve;
        }),
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose,
    });

    const activation = runtime.activate(pane.instanceId);
    await vi.waitFor(() => expect(releaseMount).toBeTypeOf('function'));
    const revocation = runtime.revoke(pane.instanceId);
    expect(runtime.isRevoked(pane.instanceId)).toBe(true);
    expect(runtime.setFocused(pane.instanceId)).toBe(false);
    releaseMount();

    await expect(activation).resolves.toBe(false);
    await expect(revocation).resolves.toEqual({ status: 'closed' });
    expect(dispose).toHaveBeenCalledOnce();
    expect(runtime.activeInstanceId).toBeNull();
    expect(runtime.visibleInstanceIds()).not.toContain(pane.instanceId);
    expect(
      runtime.register(pane.instanceId, {
        mount: vi.fn(),
        suspend: vi.fn(),
        resume: vi.fn(),
        dispose: vi.fn(),
      }),
    ).toBe(true);
  });

  test('does not resurrect a gated activate resume after revocation', async () => {
    const pane = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'one',
      instanceId: 'one',
      stateKey: 'one',
    })!;
    const sibling = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'two',
      instanceId: 'two',
      stateKey: 'two',
    })!;
    let releaseResume!: () => void;
    const dispose = vi.fn();
    const siblingResume = vi.fn();
    const runtime = new WorkspacePaneHostRuntime();
    runtime.register(pane.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume: () =>
        new Promise<void>((resolve) => {
          releaseResume = resolve;
        }),
      dispose,
    });
    runtime.register(sibling.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume: siblingResume,
      dispose: vi.fn(),
    });
    await expect(runtime.activate(pane.instanceId)).resolves.toBe(true);
    await expect(runtime.activate(sibling.instanceId)).resolves.toBe(true);

    const activation = runtime.activate(pane.instanceId);
    await vi.waitFor(() => expect(releaseResume).toBeTypeOf('function'));
    const revocation = runtime.revoke(pane.instanceId);
    expect(runtime.isRevoked(pane.instanceId)).toBe(true);
    expect(runtime.activeInstanceId).toBe(sibling.instanceId);
    expect(runtime.visibleInstanceIds()).not.toContain(pane.instanceId);
    releaseResume();

    await expect(activation).resolves.toBe(false);
    await expect(revocation).resolves.toEqual({ status: 'closed' });
    expect(dispose).toHaveBeenCalledOnce();
    expect(runtime.activeInstanceId).toBe(sibling.instanceId);
    expect(runtime.visibleInstanceIds()).toContain(sibling.instanceId);
    expect(runtime.visibleInstanceIds()).not.toContain(pane.instanceId);
    expect(runtime.hasFailed(sibling.instanceId)).toBe(false);
    expect(siblingResume).toHaveBeenCalledOnce();
    expect(
      runtime.register(pane.instanceId, {
        mount: vi.fn(),
        suspend: vi.fn(),
        resume: vi.fn(),
        dispose: vi.fn(),
      }),
    ).toBe(true);
  });

  test('does not restore a sibling excluded by a newer reconcile during rollback', async () => {
    const pane = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'one',
      instanceId: 'one',
      stateKey: 'one',
    })!;
    const sibling = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'two',
      instanceId: 'two',
      stateKey: 'two',
    })!;
    let releaseResume!: () => void;
    const siblingResume = vi.fn();
    const runtime = new WorkspacePaneHostRuntime();
    runtime.register(pane.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume: () =>
        new Promise<void>((resolve) => {
          releaseResume = resolve;
        }),
      dispose: vi.fn(),
    });
    runtime.register(sibling.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume: siblingResume,
      dispose: vi.fn(),
    });
    await expect(runtime.activate(pane.instanceId)).resolves.toBe(true);
    await expect(runtime.activate(sibling.instanceId)).resolves.toBe(true);

    const activation = runtime.activate(pane.instanceId);
    await vi.waitFor(() => expect(releaseResume).toBeTypeOf('function'));
    const excludingReconcile = runtime.reconcileVisible([]);
    const revocation = runtime.revoke(pane.instanceId);
    releaseResume();

    await expect(activation).resolves.toBe(false);
    await expect(excludingReconcile).resolves.toEqual(new Set());
    await expect(revocation).resolves.toEqual({ status: 'closed' });
    expect(runtime.activeInstanceId).toBeNull();
    expect(runtime.visibleInstanceIds()).not.toContain(sibling.instanceId);
    expect(runtime.hasFailed(sibling.instanceId)).toBe(false);
    expect(siblingResume).not.toHaveBeenCalled();
  });

  test('retries unresolved partial-mount cleanup before allowing replacement', async () => {
    const pane = parseWorkspacePaneInstance({
      version: '1.0',
      descriptorId: 'one',
      instanceId: 'one',
      stateKey: 'one',
    })!;
    const dispose = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('cleanup after mount');
      })
      .mockImplementationOnce(() => {
        throw new Error('retry cleanup');
      });
    const replacementMount = vi.fn();
    const runtime = new WorkspacePaneHostRuntime();
    runtime.register(pane.instanceId, {
      mount: () => {
        throw new Error('partial mount');
      },
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose,
    });
    await expect(runtime.activate(pane.instanceId)).resolves.toBe(false);
    expect(runtime.hasFailed(pane.instanceId)).toBe(true);
    await expect(runtime.confirmClose(pane.instanceId)).resolves.toEqual({
      status: 'error',
    });
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(
      runtime.register(pane.instanceId, {
        mount: replacementMount,
        suspend: vi.fn(),
        resume: vi.fn(),
        dispose: vi.fn(),
      }),
    ).toBe(false);
    await expect(runtime.confirmClose(pane.instanceId)).resolves.toEqual({
      status: 'closed',
    });
    expect(
      runtime.register(pane.instanceId, {
        mount: replacementMount,
        suspend: vi.fn(),
        resume: vi.fn(),
        dispose: vi.fn(),
      }),
    ).toBe(true);
    await expect(runtime.activate(pane.instanceId)).resolves.toBe(true);
    expect(replacementMount).toHaveBeenCalledOnce();
  });
});
