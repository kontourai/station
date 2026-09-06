/** @vitest-environment jsdom */

import {
  parseWorkspacePaneInstance,
  toWorkspacePaneRendererId,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneHostDocumentV1 } from '@kontourai/station-contracts/workspace-pane-host';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import { navigationStore } from '../../contexts/navigation-store';
import {
  admitRestoredFilePreviewPaneInstance as admitRestoredFilePreviewPaneInstanceWithProjectId,
  createFilePreviewPaneInstance as createFilePreviewPaneInstanceWithProjectId,
  filePreviewPanePresentationLabel as filePreviewPanePresentationLabelWithProjectId,
  removeRemovedFilePreviewPaneState as removeRemovedFilePreviewPaneStateWithProjectId,
} from '../filePreviewPaneInstance';
import {
  createFilePreviewPaneStatePreparation,
  FILE_PREVIEW_PANE_STATE_STORAGE_PREFIX,
  readFilePreviewPaneState,
  writeFilePreviewPaneState,
} from '../filePreviewPaneStateStorage';
import { WorkspacePaneHost } from '../WorkspacePaneHost';
import {
  useWorkspacePaneHostOpenAction,
  type WorkspacePaneHostOpenAction,
} from '../WorkspacePaneHostOpenContext';
import { workspacePaneHostTabIdentity } from '../workspacePaneHostIdentity';
import type { WorkspacePaneHostLockManager } from '../workspacePaneHostLease';
import type { WorkspacePaneHostOpenOutcome } from '../workspacePaneHostOpenOutcome';
import { WorkspacePaneHostRuntime } from '../workspacePaneHostRuntime';
import {
  persistWorkspacePaneHost,
  workspacePaneHostStorageKey,
} from '../workspacePaneHostStorage';
import {
  createWorkspacePaneOperationalEventContext,
  InMemoryWorkspacePaneOperationalEventSink,
} from '../workspacePaneOperationalEvents';

const TEST_PROJECT_ID = 'project';
const createFilePreviewPaneInstance = (
  state: Parameters<typeof createFilePreviewPaneInstanceWithProjectId>[0],
  nonce?: string,
) => createFilePreviewPaneInstanceWithProjectId(state, TEST_PROJECT_ID, nonce);
const admitRestoredFilePreviewPaneInstance = (
  projectSlug: string,
  candidate: unknown,
  storage: Parameters<
    typeof admitRestoredFilePreviewPaneInstanceWithProjectId
  >[3],
) =>
  admitRestoredFilePreviewPaneInstanceWithProjectId(
    TEST_PROJECT_ID,
    projectSlug,
    candidate,
    storage,
  );
const filePreviewPanePresentationLabel = (
  projectSlug: string,
  instance: Parameters<typeof filePreviewPanePresentationLabelWithProjectId>[2],
  storage: Parameters<typeof filePreviewPanePresentationLabelWithProjectId>[3],
) =>
  filePreviewPanePresentationLabelWithProjectId(
    TEST_PROJECT_ID,
    projectSlug,
    instance,
    storage,
  );
const removeRemovedFilePreviewPaneState = (
  projectSlug: string,
  instance: Parameters<
    typeof removeRemovedFilePreviewPaneStateWithProjectId
  >[2],
  storage: Parameters<typeof removeRemovedFilePreviewPaneStateWithProjectId>[3],
) =>
  removeRemovedFilePreviewPaneStateWithProjectId(
    TEST_PROJECT_ID,
    projectSlug,
    instance,
    storage,
  );

const one = parseWorkspacePaneInstance({
  version: '1.0',
  descriptorId: 'One',
  instanceId: 'one',
  stateKey: 'one',
})!;
const two = parseWorkspacePaneInstance({
  version: '1.0',
  descriptorId: 'Two',
  instanceId: 'two',
  stateKey: 'two',
})!;
const three = parseWorkspacePaneInstance({
  version: '1.0',
  descriptorId: 'Three',
  instanceId: 'three',
  stateKey: 'three',
})!;
const four = parseWorkspacePaneInstance({
  version: '1.0',
  descriptorId: 'Four',
  instanceId: 'four',
  stateKey: 'four',
})!;
const five = parseWorkspacePaneInstance({
  version: '1.0',
  descriptorId: 'Five',
  instanceId: 'five',
  stateKey: 'five',
})!;

function operationalContext(
  instance: WorkspacePaneInstance,
  document: WorkspacePaneHostDocumentV1,
) {
  const descriptor = {
    version: '1.0',
    id: instance.descriptorId,
    name: instance.descriptorId,
    rendererId: toWorkspacePaneRendererId(`renderer:${instance.descriptorId}`),
    renderer: { kind: 'builtin-component', name: 'workspace-pane' },
    placement: { supportedRegions: ['primary'] },
    modes: [{ id: 'default' }],
    provenance: { origin: 'builtin' },
    lifecycle: { stage: 'stable' },
  } as WorkspacePaneDescriptor;
  return createWorkspacePaneOperationalEventContext(
    document,
    descriptor,
    instance,
    {
      source: 'primary',
      rendererId: descriptor.rendererId,
      renderer: descriptor.renderer,
      contributorProvenance: descriptor.provenance,
      requiredCapabilities: [],
    },
  );
}

function lifecycleEventNames(sink: InMemoryWorkspacePaneOperationalEventSink) {
  return sink.events.map(
    (event) => (event.payload.data as { event: string }).event,
  );
}

function hostDocument(): WorkspacePaneHostDocumentV1 {
  return {
    version: '1.1',
    id: 'host',
    scope: { kind: 'project', projectId: 'project', layoutId: 'layout' },
    instances: [one, two, three],
    activeInstanceId: one.instanceId,
    root: {
      type: 'split',
      id: 'split',
      orientation: 'horizontal',
      ratio: 0.5,
      first: {
        type: 'tabs',
        id: 'left',
        instanceIds: [one.instanceId, two.instanceId],
        selectedInstanceId: one.instanceId,
      },
      second: {
        type: 'tabs',
        id: 'right',
        instanceIds: [three.instanceId],
        selectedInstanceId: three.instanceId,
      },
    },
  };
}

function flatHostDocument(
  activeInstanceId = one.instanceId,
): WorkspacePaneHostDocumentV1 {
  return {
    ...hostDocument(),
    activeInstanceId,
    root: {
      type: 'tabs',
      id: 'flat',
      instanceIds: [one.instanceId, two.instanceId, three.instanceId],
      selectedInstanceId: activeInstanceId,
    },
  };
}

function expectTabOwnership(
  groups: readonly {
    id: string;
    instanceIds: readonly string[];
  }[],
) {
  const owners = screen.getAllByRole('tablist', {
    name: 'Workspace panes',
  });
  expect(owners).toHaveLength(groups.length);
  for (const [index, group] of groups.entries()) {
    const owner = owners[index]!;
    const ids = group.instanceIds.map((instanceId) =>
      workspacePaneHostTabIdentity(group.id, instanceId),
    );
    expect(owner.getAttribute('aria-owns')).toBe(ids.join(' '));
    expect(owner.querySelector('[role="tab"]')).toBeNull();
    for (const id of ids) {
      const tab = globalThis.document.getElementById(id);
      expect(tab?.getAttribute('role')).toBe('tab');
      expect(owner.contains(tab)).toBe(false);
    }
    for (const close of screen.queryAllByRole('button', { name: /Close / })) {
      expect(owner.contains(close)).toBe(false);
      expect(ids).not.toContain(close.id);
    }
  }
}

function sharedStorageClients() {
  const values = new Map<string, string>();
  const client = () => ({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
  });
  return { first: client(), second: client() };
}

function singlePaneHostDocument(
  id: string,
  instance: WorkspacePaneInstance,
  layoutId = 'coding',
): WorkspacePaneHostDocumentV1 {
  return {
    version: '1.1',
    id,
    scope: { kind: 'project', projectId: 'project', layoutId },
    instances: [instance],
    activeInstanceId: instance.instanceId,
    root: {
      type: 'tabs',
      id: 'root',
      instanceIds: [instance.instanceId],
      selectedInstanceId: instance.instanceId,
    },
  };
}

const permissiveTestLockManager: WorkspacePaneHostLockManager = {
  request: async (_name, _options, callback) => callback({}),
};

function queuedExclusiveTestLockManager(): WorkspacePaneHostLockManager {
  const held = new Set<string>();
  const waiting = new Map<string, (() => void)[]>();
  const releaseNext = (name: string) => {
    const next = waiting.get(name)?.shift();
    if (next) next();
  };
  return {
    request: async (name, options, callback) => {
      if (options.ifAvailable && held.has(name)) {
        await callback(null);
        return;
      }
      if (held.has(name)) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            waiting.set(
              name,
              (waiting.get(name) ?? []).filter(
                (candidate) => candidate !== resolve,
              ),
            );
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (options.signal?.aborted) {
            abort();
            return;
          }
          options.signal?.addEventListener('abort', abort, { once: true });
          waiting.set(name, [...(waiting.get(name) ?? []), resolve]);
        });
      }
      held.add(name);
      try {
        await callback({});
      } finally {
        held.delete(name);
        releaseNext(name);
      }
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window.navigator, 'locks', {
    configurable: true,
    value: permissiveTestLockManager,
  });
  navigationStore.navigate('/projects/project/layouts/layout', { pane: null });
});

test('queues a contended reader, restores before its takeover, and keeps readers usable', async () => {
  const lockManager = queuedExclusiveTestLockManager();
  const supplied = hostDocument();
  if (supplied.root.type !== 'split' || supplied.root.first.type !== 'tabs')
    throw new Error('expected split host');
  const persisted: WorkspacePaneHostDocumentV1 = {
    ...supplied,
    activeInstanceId: two.instanceId,
    root: {
      ...supplied.root,
      first: {
        ...supplied.root.first,
        selectedInstanceId: two.instanceId,
      },
    },
  };
  expect(persistWorkspacePaneHost(localStorage, persisted)).toBe(true);

  const owner = render(
    <WorkspacePaneHost
      document={supplied}
      lockManager={lockManager}
      renderPane={(pane) => <div>{pane.descriptorId}</div>}
    />,
  );
  expect(within(owner.container).getByRole('status').textContent).toContain(
    'saved in this tab',
  );
  expect(
    within(owner.container)
      .getByRole('tab', { name: 'Two' })
      .getAttribute('aria-selected'),
  ).toBe('true');

  const reader = render(
    <WorkspacePaneHost
      document={supplied}
      lockManager={lockManager}
      renderPane={(pane) => <div>{pane.descriptorId}</div>}
    />,
  );
  expect(within(reader.container).getByRole('status').textContent).toContain(
    'open in another tab',
  );
  expect(
    within(reader.container)
      .getByRole('button', { name: 'Close Two' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(
    within(reader.container)
      .getByRole('separator')
      .getAttribute('aria-disabled'),
  ).toBe('true');
  const ownerSeparator = within(owner.container).getByRole('separator');
  await act(async () => {
    fireEvent.keyDown(ownerSeparator, { key: 'ArrowRight' });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  const ownerDocument = JSON.parse(
    localStorage.getItem(
      workspacePaneHostStorageKey(supplied.scope, supplied.id),
    ) ?? 'null',
  ) as WorkspacePaneHostDocumentV1;
  expect(ownerDocument.root).toMatchObject({ ratio: 0.55 });
  await act(async () => {
    fireEvent.keyDown(within(reader.container).getByRole('separator'), {
      key: 'ArrowRight',
    });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  const afterReaderAction = JSON.parse(
    localStorage.getItem(
      workspacePaneHostStorageKey(supplied.scope, supplied.id),
    ) ?? 'null',
  ) as WorkspacePaneHostDocumentV1;
  expect(afterReaderAction.root).toMatchObject({ ratio: 0.55 });
  fireEvent.click(within(reader.container).getByRole('tab', { name: 'Three' }));
  expect(
    within(reader.container)
      .getByRole('tab', { name: 'Three' })
      .getAttribute('aria-selected'),
  ).toBe('true');

  owner.unmount();
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(within(reader.container).getByRole('status').textContent).toContain(
    'saved in this tab',
  );
  expect(
    within(reader.container)
      .getByRole('tab', { name: 'Two' })
      .getAttribute('aria-selected'),
  ).toBe('true');
  expect(
    within(reader.container)
      .getByRole('separator')
      .getAttribute('aria-valuenow'),
  ).toBe('55');
});

test('aborts a queued reader before acquisition and never publishes its view', async () => {
  const lockManager = queuedExclusiveTestLockManager();
  const supplied = hostDocument();
  const owner = render(
    <WorkspacePaneHost
      document={supplied}
      lockManager={lockManager}
      renderPane={(pane) => <div>{pane.descriptorId}</div>}
    />,
  );
  const persistedBeforeReaderUnmount = localStorage.getItem(
    workspacePaneHostStorageKey(supplied.scope, supplied.id),
  );
  const reader = render(
    <WorkspacePaneHost
      document={supplied}
      lockManager={lockManager}
      renderPane={(pane) => <div>{pane.descriptorId}</div>}
    />,
  );
  reader.unmount();
  await act(async () => {
    owner.unmount();
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(
    localStorage.getItem(
      workspacePaneHostStorageKey(supplied.scope, supplied.id),
    ),
  ).toBe(persistedBeforeReaderUnmount);
});

test('reports unavailable locking without unlocking persistence or navigation', () => {
  const view = render(
    <WorkspacePaneHost
      document={flatHostDocument(one.instanceId)}
      lockManager={null}
      renderPane={(pane) => <div>{pane.descriptorId}</div>}
    />,
  );
  expect(within(view.container).getByRole('status').textContent).toContain(
    'cannot be saved right now',
  );
  expect(within(view.container).getByRole('status').textContent).toContain(
    'read-only',
  );
  expect(
    within(view.container)
      .getByRole('button', { name: 'Close Two' })
      .hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(within(view.container).getByRole('tab', { name: 'Two' }));
  expect(
    within(view.container)
      .getByRole('tab', { name: 'Two' })
      .getAttribute('aria-selected'),
  ).toBe('true');
});

test('reports a rejected lock request as unavailable', async () => {
  const view = render(
    <WorkspacePaneHost
      document={flatHostDocument(one.instanceId)}
      lockManager={{
        request: async () => {
          throw new Error('Web Locks unavailable');
        },
      }}
      renderPane={(pane) => <div>{pane.descriptorId}</div>}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(within(view.container).getByRole('status').textContent).toContain(
    'cannot be saved right now',
  );
});

test('renders accessible recursive tabs, roves with keys, returns focus on close, and resizes with a separator', async () => {
  const onChange = vi.fn();
  render(
    <WorkspacePaneHost
      document={hostDocument()}
      onDocumentChange={onChange}
      renderPane={(pane) => <div>{pane.descriptorId} content</div>}
    />,
  );
  const tabs = screen.getAllByRole('tab');
  expect(tabs).toHaveLength(3);
  expectTabOwnership([
    { id: 'left', instanceIds: ['one', 'two'] },
    { id: 'right', instanceIds: ['three'] },
  ]);
  expect(screen.getAllByRole('tabpanel')).toHaveLength(2);
  const separator = screen.getByRole('separator', {
    name: 'Resize workspace pane groups',
  });
  expect(separator.getAttribute('aria-valuenow')).toBe('50');
  fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
  expect(
    screen.getByRole('tab', { name: 'Two' }).getAttribute('aria-selected'),
  ).toBe('true');
  fireEvent.keyDown(screen.getByRole('tab', { name: 'Two' }), { key: 'Home' });
  expect(
    screen.getByRole('tab', { name: 'One' }).getAttribute('aria-selected'),
  ).toBe('true');
  await act(async () => {
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ root: expect.objectContaining({ ratio: 0.55 }) }),
  );
  fireEvent.keyDown(screen.getByRole('tab', { name: 'One' }), { key: 'End' });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close Two' }));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  expect(screen.queryByRole('tab', { name: 'Two' })).toBeNull();
  expectTabOwnership([
    { id: 'left', instanceIds: ['one'] },
    { id: 'right', instanceIds: ['three'] },
  ]);
  expect(globalThis.document.activeElement).toBe(
    screen.getByRole('tab', { name: 'One' }),
  );
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ activeInstanceId: 'one' }),
  );
});

test('updates tablist ownership after reordered, split, and closed layouts', async () => {
  render(
    <WorkspacePaneHost
      document={hostDocument()}
      onDocumentChange={vi.fn()}
      renderPane={(pane) => <div>{pane.descriptorId} content</div>}
    />,
  );
  expectTabOwnership([
    { id: 'left', instanceIds: ['one', 'two'] },
    { id: 'right', instanceIds: ['three'] },
  ]);

  fireEvent.click(screen.getByRole('button', { name: 'Pane actions for One' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move tab right' }));
  expectTabOwnership([
    { id: 'left', instanceIds: ['two', 'one'] },
    { id: 'right', instanceIds: ['three'] },
  ]);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close Two' }));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  expectTabOwnership([
    { id: 'left', instanceIds: ['one'] },
    { id: 'right', instanceIds: ['three'] },
  ]);

  fireEvent.click(screen.getByRole('button', { name: 'Pane actions for One' }));
  fireEvent.click(
    screen.getByRole('menuitem', { name: 'Collapse other pane group' }),
  );
  expectTabOwnership([{ id: 'left', instanceIds: ['one'] }]);

  fireEvent.click(screen.getByRole('button', { name: 'Pane actions for One' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Restore split' }));
  expectTabOwnership([
    { id: 'left', instanceIds: ['one'] },
    { id: 'right', instanceIds: ['three'] },
  ]);
});

test('coalesces a resize burst into one animation frame and one host publication', async () => {
  const onChange = vi.fn();
  render(
    <WorkspacePaneHost
      document={hostDocument()}
      onDocumentChange={onChange}
      renderPane={(pane) => <div>{pane.descriptorId} content</div>}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  onChange.mockClear();
  const frames: FrameRequestCallback[] = [];
  const requestFrame = globalThis.requestAnimationFrame;
  const cancelFrame = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  globalThis.cancelAnimationFrame = () => {};
  try {
    const separator = screen.getByRole('separator', {
      name: 'Resize workspace pane groups',
    });
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(frames).toHaveLength(1);
    await act(async () => {
      frames[0]?.(0);
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        root: expect.objectContaining({ ratio: 0.55 }),
      }),
    );
  } finally {
    globalThis.requestAnimationFrame = requestFrame;
    globalThis.cancelAnimationFrame = cancelFrame;
  }
});

test('compact projection is reset-safe, mounts only focus, and moves DOM focus with roving keys', async () => {
  render(
    <WorkspacePaneHost
      compact
      document={hostDocument()}
      presentationLabel={(pane) =>
        pane.instanceId === one.instanceId ? 'File Preview — src/one.ts' : null
      }
      renderPane={(pane) => <div>{pane.descriptorId} content</div>}
    />,
  );
  const oneTab = screen.getByRole('tab', {
    name: 'File Preview — src/one.ts',
  });
  expect(screen.getByText('One content')).toBeTruthy();
  expect(screen.queryByText('Three content')).toBeNull();
  fireEvent.keyDown(oneTab, { key: 'End' });
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  expect(globalThis.document.activeElement).toBe(
    screen.getByRole('tab', { name: 'Three' }),
  );
  expect(screen.getByText('Three content')).toBeTruthy();
});

test('host commands use typed catalog requests, reducer operations, and declared pop-out support', async () => {
  const onDocumentChange = vi.fn();
  const onOpenCatalog = vi.fn();
  const onPopOut = vi.fn(async () => ({ status: 'opened' as const }));
  render(
    <WorkspacePaneHost
      document={hostDocument()}
      onDocumentChange={onDocumentChange}
      onOpenCatalog={onOpenCatalog}
      popOut={{ state: 'supported', request: onPopOut }}
      renderPane={(pane) => <div>{pane.descriptorId} content</div>}
    />,
  );
  const openMenu = () =>
    fireEvent.click(
      screen.getByRole('button', { name: 'Pane actions for One' }),
    );

  openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open pane catalog' }));
  expect(onOpenCatalog).toHaveBeenLastCalledWith({
    type: 'add',
    targetGroupId: 'left',
  });

  openMenu();
  fireEvent.click(
    screen.getByRole('menuitem', { name: 'Choose pane to split right' }),
  );
  expect(onOpenCatalog).toHaveBeenLastCalledWith({
    type: 'split',
    targetGroupId: 'left',
    orientation: 'horizontal',
    placement: 'after',
  });

  openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Move tab right' }));
  expect(onDocumentChange).toHaveBeenLastCalledWith(
    expect.objectContaining({
      root: expect.objectContaining({
        first: expect.objectContaining({ instanceIds: ['two', 'one'] }),
      }),
    }),
  );

  openMenu();
  fireEvent.click(
    screen.getByRole('menuitem', { name: 'Collapse other pane group' }),
  );
  expect(screen.queryByText('Three content')).toBeNull();

  openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Restore split' }));
  expect(screen.getByText('Three content')).toBeTruthy();

  openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Maximize pane' }));
  expect(screen.getAllByRole('tabpanel')).toHaveLength(1);

  openMenu();
  fireEvent.click(
    screen.getByRole('menuitem', { name: 'Restore workspace panes' }),
  );
  expect(screen.getAllByRole('tabpanel')).toHaveLength(2);

  openMenu();
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pop out pane' }));
    await Promise.resolve();
  });
  expect(onPopOut).toHaveBeenCalledWith(one);
});

test('pop-out retains a bounded failure and returns focus to the invoking command', async () => {
  const nativeDetails = 'native route /private/path rejected';
  render(
    <WorkspacePaneHost
      document={flatHostDocument()}
      popOut={{
        state: 'supported',
        request: async () => ({ status: 'failed' }),
      }}
      renderPane={(pane) => <div>{pane.descriptorId}</div>}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Pane actions for One' }));
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  const command = screen.getByRole('menuitem', { name: 'Pop out pane' });
  command.focus();
  await act(async () => {
    fireEvent.click(command);
    await Promise.resolve();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  expect(screen.getByRole('alert').textContent).toBe(
    'Station could not open this pane in a separate window. Try again.',
  );
  expect(screen.getByRole('alert').textContent).not.toContain(nativeDetails);
  expect(globalThis.document.activeElement).toBe(command);
});

test('layout catalog placement opens through the controller as the sole document writer', async () => {
  let hostOpen: WorkspacePaneHostOpenAction | null = null;
  const onDocumentChange = vi.fn();
  render(
    <WorkspacePaneHost
      document={hostDocument()}
      onDocumentChange={onDocumentChange}
      onOpenActionChange={(action) => {
        hostOpen = action;
      }}
      renderPane={(pane) => <div>{pane.descriptorId} content</div>}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  onDocumentChange.mockClear();

  let opened: WorkspacePaneHostOpenOutcome | undefined;
  act(() => {
    opened = hostOpen?.open(four, undefined, {
      type: 'add',
      targetGroupId: 'right',
    });
  });
  expect(opened).toEqual({ ok: true });
  await act(async () => {
    await Promise.resolve();
  });
  expect(onDocumentChange).toHaveBeenLastCalledWith(
    expect.objectContaining({
      root: expect.objectContaining({
        second: expect.objectContaining({ instanceIds: ['three', 'four'] }),
      }),
    }),
  );

  act(() => {
    opened = hostOpen?.open(five, undefined, {
      type: 'split',
      targetGroupId: 'right',
      orientation: 'vertical',
      placement: 'after',
    });
  });
  expect(opened).toEqual({ ok: true });
  await act(async () => {
    await Promise.resolve();
  });
  expect(onDocumentChange).toHaveBeenLastCalledWith(
    expect.objectContaining({
      root: expect.objectContaining({
        second: expect.objectContaining({
          orientation: 'vertical',
          first: expect.objectContaining({ instanceIds: ['three', 'four'] }),
          second: expect.objectContaining({ instanceIds: ['five'] }),
        }),
      }),
    }),
  );
});

/**
 * #1596. Drives the real controller — no mock of `open` — for the two refusals
 * only the controller can produce, and pairs each with an open that succeeds
 * under the same host so a refusal-shaped constant would not satisfy it.
 */
test('answers a refused open with the reason the controller derived', async () => {
  let hostOpen: WorkspacePaneHostOpenAction | null = null;
  let outcome: WorkspacePaneHostOpenOutcome | undefined;

  // `lockManager={null}` is the production "no Web Locks" path: the host runs
  // read-only and never holds the layout's persistence lease.
  const readOnly = render(
    <WorkspacePaneHost
      document={singlePaneHostDocument('no-lease-host', one)}
      lockManager={null}
      onOpenActionChange={(action) => {
        hostOpen = action;
      }}
      renderPane={(pane) => <div>{pane.descriptorId} content</div>}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(within(readOnly.container).getByRole('status').textContent).toContain(
    'cannot be saved right now',
  );
  act(() => {
    outcome = hostOpen?.open(two);
  });
  expect(outcome).toEqual({ ok: false, reason: 'no-lease' });
  expect(within(readOnly.container).getAllByRole('tab')).toHaveLength(1);
  readOnly.unmount();

  const admitting = render(
    <WorkspacePaneHost
      document={singlePaneHostDocument('admission-host', one)}
      admitOpenInstance={(instance) => instance.instanceId !== two.instanceId}
      onOpenActionChange={(action) => {
        hostOpen = action;
      }}
      renderPane={(pane) => <div>{pane.descriptorId} content</div>}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    outcome = hostOpen?.open(two);
  });
  expect(outcome).toEqual({ ok: false, reason: 'refused' });
  act(() => {
    outcome = hostOpen?.open(three);
  });
  expect(outcome).toEqual({ ok: true });
  await act(async () => {
    await Promise.resolve();
  });
  expect(
    within(admitting.container)
      .getAllByRole('tab')
      .map((tab) => tab.textContent),
  ).toEqual(['One', 'Three']);
});

test('focuses an existing pane without admitting a duplicate instance', async () => {
  let hostOpen: WorkspacePaneHostOpenAction | null = null;
  const onDocumentChange = vi.fn();
  render(
    <WorkspacePaneHost
      document={hostDocument()}
      onDocumentChange={onDocumentChange}
      onOpenActionChange={(action) => {
        hostOpen = action;
      }}
      renderPane={(pane) => <div>{pane.descriptorId} content</div>}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  onDocumentChange.mockClear();

  let duplicate: WorkspacePaneHostOpenOutcome | undefined;
  let focused = false;
  act(() => {
    duplicate = hostOpen?.open(two);
    focused = hostOpen?.focusExisting?.(two.instanceId) ?? false;
  });
  expect(duplicate).toEqual({ ok: false, reason: 'already-open' });
  expect(focused).toBe(true);
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });

  expect(onDocumentChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ activeInstanceId: two.instanceId }),
  );
  const tab = screen.getByRole('tab', { name: 'Two' });
  expect(tab.getAttribute('aria-selected')).toBe('true');
  expect(globalThis.document.activeElement).toBe(tab);
});

test.each([
  { name: 'chromeless', presentation: 'chromeless' as const },
  { name: 'compact', compact: true },
  { name: 'tabbed' },
])(
  'publishes focusExisting through the $name production provider',
  async (props) => {
    let focused = false;
    function FocusConsumer() {
      const host = useWorkspacePaneHostOpenAction();
      return (
        <button
          type="button"
          onClick={() => {
            focused = host?.focusExisting?.(two.instanceId) ?? false;
          }}
        >
          Focus existing from {props.name}
        </button>
      );
    }
    render(
      <WorkspacePaneHost
        document={hostDocument()}
        {...props}
        renderPane={() => <FocusConsumer />}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(
      screen.getAllByRole('button', {
        name: `Focus existing from ${props.name}`,
      })[0]!,
    );

    expect(focused).toBe(true);
  },
);

test('compact commands target the active persisted group and disable flattened reordering', async () => {
  const onDocumentChange = vi.fn();
  const onOpenCatalog = vi.fn();
  render(
    <WorkspacePaneHost
      compact
      document={hostDocument()}
      onDocumentChange={onDocumentChange}
      onOpenCatalog={onOpenCatalog}
      renderPane={(pane) => <div>{pane.descriptorId} content</div>}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  onDocumentChange.mockClear();
  const openMenu = () =>
    fireEvent.click(
      screen.getByRole('button', { name: 'Pane actions for One' }),
    );

  openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open pane catalog' }));
  expect(onOpenCatalog).toHaveBeenLastCalledWith({
    type: 'add',
    targetGroupId: 'left',
  });

  openMenu();
  fireEvent.click(
    screen.getByRole('menuitem', { name: 'Choose pane to split below' }),
  );
  expect(onOpenCatalog).toHaveBeenLastCalledWith({
    type: 'split',
    targetGroupId: 'left',
    orientation: 'vertical',
    placement: 'after',
  });

  openMenu();
  expect(
    screen
      .getByRole('menuitem', { name: 'Move tab right' })
      .getAttribute('disabled'),
  ).not.toBeNull();
  expect(
    screen.getByText(
      'Tab reordering is unavailable while panes are shown in the compact view.',
    ),
  ).toBeTruthy();
  expect(onDocumentChange).not.toHaveBeenCalled();
});

test('maximized commands target the selected persisted group and disable synthetic reordering', async () => {
  const onDocumentChange = vi.fn();
  const onOpenCatalog = vi.fn();
  render(
    <WorkspacePaneHost
      document={hostDocument()}
      onDocumentChange={onDocumentChange}
      onOpenCatalog={onOpenCatalog}
      renderPane={(pane) => <div>{pane.descriptorId} content</div>}
    />,
  );
  const openMenu = () =>
    fireEvent.click(
      screen.getByRole('button', { name: 'Pane actions for One' }),
    );
  openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Maximize pane' }));
  onDocumentChange.mockClear();

  openMenu();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open pane catalog' }));
  expect(onOpenCatalog).toHaveBeenLastCalledWith({
    type: 'add',
    targetGroupId: 'left',
  });

  openMenu();
  fireEvent.click(
    screen.getByRole('menuitem', { name: 'Choose pane to split right' }),
  );
  expect(onOpenCatalog).toHaveBeenLastCalledWith({
    type: 'split',
    targetGroupId: 'left',
    orientation: 'horizontal',
    placement: 'after',
  });

  openMenu();
  expect(
    screen
      .getByRole('menuitem', { name: 'Move tab right' })
      .getAttribute('disabled'),
  ).not.toBeNull();
  expect(
    screen.getByText(
      'Tab reordering is unavailable while this pane is maximized.',
    ),
  ).toBeTruthy();
  expect(onDocumentChange).not.toHaveBeenCalled();
});

test('renderer display intent reuses host maximize and preserves the exact occurrence', () => {
  const onDocumentChange = vi.fn();
  render(
    <WorkspacePaneHost
      document={flatHostDocument()}
      onDocumentChange={onDocumentChange}
      renderPane={(pane, presentation) => (
        <button
          type="button"
          onClick={() =>
            presentation.requestDisplayMode(
              presentation.displayMode === 'inline' ? 'fullscreen' : 'inline',
            )
          }
        >
          {pane.instanceId}:{presentation.displayMode}
        </button>
      )}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'one:inline' }));
  const maximized = onDocumentChange.mock.calls.at(-1)?.[0];
  expect(maximized.maximizedInstanceId).toBe(one.instanceId);
  expect(maximized.instances).toEqual(flatHostDocument().instances);
  expect(screen.getByRole('button', { name: 'one:fullscreen' })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'one:fullscreen' }));
  const restored = onDocumentChange.mock.calls.at(-1)?.[0];
  expect(restored.maximizedInstanceId).toBeUndefined();
  expect(restored.instances).toEqual(flatHostDocument().instances);
});

test('unsupported pop-out remains visible with its host-provided explanation', () => {
  render(
    <WorkspacePaneHost
      document={flatHostDocument()}
      popOut={{
        state: 'unsupported',
        reason: 'Pop-out is not supported by this workspace.',
      }}
      renderPane={(pane) => <div>{pane.descriptorId}</div>}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Pane actions for One' }));
  expect(
    screen
      .getByRole('menuitem', { name: 'Pop out pane' })
      .getAttribute('disabled'),
  ).not.toBeNull();
  expect(
    screen.getByText('Pop-out is not supported by this workspace.'),
  ).toBeTruthy();
});

test('pop-out resolves the selected occurrence before enabling its command', () => {
  const availability = vi.fn(() => ({
    state: 'unsupported' as const,
    reason: 'This pane occurrence cannot open in a separate window.',
  }));
  render(
    <WorkspacePaneHost
      document={flatHostDocument()}
      popOut={{ availability }}
      renderPane={(pane) => <div>{pane.descriptorId}</div>}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Pane actions for One' }));
  expect(availability).toHaveBeenCalledWith(one);
  expect(
    screen
      .getByRole('menuitem', { name: 'Pop out pane' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(
    screen.getByText('This pane occurrence cannot open in a separate window.'),
  ).toBeTruthy();
});

test('command menus move focus with menu keys and return it to their trigger', async () => {
  render(
    <WorkspacePaneHost
      document={flatHostDocument()}
      onOpenCatalog={vi.fn()}
      renderPane={(pane) => <div>{pane.descriptorId}</div>}
    />,
  );
  const trigger = screen.getByRole('button', { name: 'Pane actions for One' });
  fireEvent.click(trigger);
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  expect(globalThis.document.activeElement).toBe(
    screen.getByRole('menuitem', { name: 'Open pane catalog' }),
  );
  fireEvent.keyDown(globalThis.document.activeElement!, { key: 'ArrowDown' });
  expect(globalThis.document.activeElement).toBe(
    screen.getByRole('menuitem', { name: 'Choose pane to split right' }),
  );
  fireEvent.keyDown(globalThis.document.activeElement!, { key: 'Escape' });
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  expect(globalThis.document.activeElement).toBe(trigger);
});

test('compact close returns focus to the surviving tab and back returns focus to the tablist', async () => {
  render(
    <WorkspacePaneHost
      compact
      document={flatHostDocument(two.instanceId)}
      renderPane={(pane) => <div>{pane.descriptorId} content</div>}
    />,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close Two' }));
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  const successor = screen.getByRole('tab', { name: 'Three' });
  expect(globalThis.document.activeElement).toBe(successor);
  fireEvent.click(screen.getByRole('button', { name: 'Back to pane tabs' }));
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  expect(globalThis.document.activeElement).toBe(successor);
});

test('dirty close requires an explicit production confirmation before removing the pane', async () => {
  const runtime = new WorkspacePaneHostRuntime();
  runtime.register(one.instanceId, {
    mount: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(),
    dispose: vi.fn(),
  });
  runtime.register(two.instanceId, {
    mount: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(),
    dispose: vi.fn(),
    beforeClose: () => ({ confirm: 'dirty' }),
  });
  runtime.register(three.instanceId, {
    mount: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(),
    dispose: vi.fn(),
  });
  render(
    <WorkspacePaneHost
      document={hostDocument()}
      runtime={runtime}
      renderPane={(pane) => <div>{pane.descriptorId}</div>}
    />,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close Two' }));
  });
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Two' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.getByRole('tab', { name: 'Two' })).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close Two' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close pane' }));
  });
  expect(screen.queryByRole('tab', { name: 'Two' })).toBeNull();
});

test('a pane with no bespoke label is named by its descriptor, never by its id', () => {
  // archive#3971: the tab strip printed `pane:builtin:coding:file-browser` at
  // people while every descriptor carried a name the whole time. Each element
  // is named in its own assertion so a regression says which one went back to
  // showing an id.
  const preview = createFilePreviewPaneInstance(
    {
      version: '1.0' as const,
      projectSlug: 'project',
      path: 'src/named-by-descriptor.ts',
      wrap: true,
    },
    'e'.repeat(32),
  )!;

  render(
    <WorkspacePaneHost
      document={singlePaneHostDocument('descriptor-named-host', preview)}
      renderPane={() => <div>Pane</div>}
    />,
  );

  expect(screen.getByRole('tab', { name: 'File Preview' })).toBeTruthy();
  expect(screen.queryByRole('tab', { name: preview.descriptorId })).toBeNull();
});

test.each([
  [one.instanceId, 'One', 'two'],
  [two.instanceId, 'Two', 'three'],
  [three.instanceId, 'Three', 'two'],
] as const)(
  'active close removes %s atomically and focuses the filtered successor',
  async (instanceId, label, successor) => {
    const runtime = new WorkspacePaneHostRuntime();
    const dispose = vi.fn();
    for (const pane of [one, two, three])
      runtime.register(pane.instanceId, {
        mount: vi.fn(),
        suspend: vi.fn(),
        resume: vi.fn(),
        dispose,
      });
    const onDocumentChange = vi.fn();
    const { unmount } = render(
      <WorkspacePaneHost
        document={flatHostDocument(instanceId)}
        runtime={runtime}
        onDocumentChange={onDocumentChange}
        renderPane={(pane) => <div>{pane.descriptorId}</div>}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `Close ${label}` }));
    });
    expect(onDocumentChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeInstanceId: successor }),
    );
    expect(
      onDocumentChange.mock.calls
        .at(-1)?.[0]
        .instances.map((pane: typeof one) => pane.instanceId),
    ).not.toContain(instanceId);
    expect(dispose).toHaveBeenCalledTimes(1);
    unmount();
  },
);

test('hydrates the exact persisted scope before its first pane render', () => {
  const persisted = flatHostDocument(two.instanceId);
  persistWorkspacePaneHost(window.localStorage, persisted);
  const renders: string[] = [];
  render(
    <WorkspacePaneHost
      document={flatHostDocument(one.instanceId)}
      renderPane={(pane) => {
        renders.push(pane.instanceId);
        return <div>{pane.descriptorId}</div>;
      }}
    />,
  );
  expect(renders[0]).toBe(two.instanceId);
});

test('production host sink orders an opened occurrence before its ready callback and a user close terminal fact', async () => {
  const runtime = new WorkspacePaneHostRuntime();
  const sink = new InMemoryWorkspacePaneOperationalEventSink();
  let host: WorkspacePaneHostOpenAction | null = null;
  render(
    <WorkspacePaneHost
      document={singlePaneHostDocument('operational-open-close', one)}
      runtime={runtime}
      operationalEventSink={sink}
      operationalEventContext={operationalContext}
      onOpenActionChange={(next) => {
        host = next;
      }}
      renderPane={(pane) => <div>{pane.descriptorId} content</div>}
    />,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  sink.events.splice(0);

  let opened: WorkspacePaneHostOpenOutcome | undefined;
  await act(async () => {
    opened = host?.open(two);
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(opened).toEqual({ ok: true });
  const afterOpen = lifecycleEventNames(sink);
  expect(afterOpen.indexOf('opened')).toBeGreaterThanOrEqual(0);
  expect(afterOpen.indexOf('ready')).toBeGreaterThan(
    afterOpen.indexOf('opened'),
  );

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close Two' }));
    await Promise.resolve();
  });
  expect(lifecycleEventNames(sink)).toContain('closed');
  expect(
    sink.events.find(
      (event) => (event.payload.data as { event: string }).event === 'closed',
    )?.payload.data,
  ).toMatchObject({ event: 'closed', closeReason: 'user' });
});

test('production host sink reports restored before its ready callback', async () => {
  const restored = singlePaneHostDocument('operational-restore', two);
  expect(persistWorkspacePaneHost(window.localStorage, restored)).toBe(true);
  const sink = new InMemoryWorkspacePaneOperationalEventSink();
  const mark = vi.spyOn(performance, 'mark');
  let hostRestoreEvents = 0;
  const onHostRestore = () => {
    hostRestoreEvents += 1;
  };
  window.addEventListener('station:perf:host-restored', onHostRestore);
  try {
    render(
      <WorkspacePaneHost
        document={singlePaneHostDocument('operational-restore', one)}
        runtime={new WorkspacePaneHostRuntime()}
        operationalEventSink={sink}
        operationalEventContext={operationalContext}
        renderPane={(pane) => <div>{pane.descriptorId} content</div>}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const names = lifecycleEventNames(sink);
    expect(names.indexOf('restored')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('ready')).toBeGreaterThan(names.indexOf('restored'));
    expect(hostRestoreEvents).toBe(1);
    expect(mark).toHaveBeenCalledWith('station:perf:host-restored');
  } finally {
    window.removeEventListener('station:perf:host-restored', onHostRestore);
  }
});

test('catalog revocation retains its last known context until disposal and durable publish complete', async () => {
  const runtime = new WorkspacePaneHostRuntime();
  const sink = new InMemoryWorkspacePaneOperationalEventSink();
  let catalogIds = new Set([one.instanceId, two.instanceId, three.instanceId]);
  const contextFromCurrentCatalog = (
    instance: WorkspacePaneInstance,
    document: WorkspacePaneHostDocumentV1,
  ) =>
    catalogIds.has(instance.instanceId)
      ? operationalContext(instance, document)
      : null;
  const source = flatHostDocument(one.instanceId);
  const { rerender } = render(
    <WorkspacePaneHost
      document={source}
      runtime={runtime}
      operationalEventSink={sink}
      operationalEventContext={contextFromCurrentCatalog}
      renderPane={(pane) => <div>{pane.descriptorId} content</div>}
    />,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  sink.events.splice(0);
  catalogIds = new Set([two.instanceId, three.instanceId]);
  const revoked: WorkspacePaneHostDocumentV1 = {
    ...flatHostDocument(two.instanceId),
    instances: [two, three],
    root: {
      type: 'tabs',
      id: 'flat',
      instanceIds: [two.instanceId, three.instanceId],
      selectedInstanceId: two.instanceId,
    },
  };
  await act(async () => {
    rerender(
      <WorkspacePaneHost
        document={revoked}
        runtime={runtime}
        operationalEventSink={sink}
        operationalEventContext={contextFromCurrentCatalog}
        renderPane={(pane) => <div>{pane.descriptorId} content</div>}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  const closed = sink.events.find(
    (event) => (event.payload.data as { event: string }).event === 'closed',
  );
  expect(closed?.payload.data).toMatchObject({
    event: 'closed',
    closeReason: 'catalog-revoked',
  });
  const persisted = JSON.parse(
    window.localStorage.getItem(
      workspacePaneHostStorageKey(source.scope, source.id),
    ) ?? 'null',
  ) as WorkspacePaneHostDocumentV1;
  expect(
    persisted.instances.map((instance) => instance.instanceId),
  ).not.toContain(one.instanceId);
});

test('compact host owns runtime callbacks while mounting only the active renderer child', async () => {
  const runtime = new WorkspacePaneHostRuntime();
  const renders: string[] = [];
  render(
    <WorkspacePaneHost
      compact
      document={flatHostDocument(one.instanceId)}
      runtime={runtime}
      renderPane={(pane) => {
        renders.push(pane.instanceId);
        return <div>{pane.descriptorId} content</div>;
      }}
    />,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(runtime.isMounted(one.instanceId)).toBe(true);
  expect(runtime.isMounted(two.instanceId)).toBe(false);
  expect(renders).not.toContain(two.instanceId);

  await act(async () => {
    fireEvent.click(screen.getByRole('tab', { name: 'Two' }));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(runtime.isMounted(two.instanceId)).toBe(true);
  expect(renders).toContain(two.instanceId);
});

test('rejects a 24th dynamic preview without leaking state, then recovers after successful close cleanup', async () => {
  let sequence = 0;
  function Opener() {
    const host = useWorkspacePaneHostOpenAction();
    return (
      <button
        type="button"
        onClick={() => {
          sequence += 1;
          const state = {
            version: '1.0' as const,
            projectSlug: 'project',
            path: `src/file-${sequence}.ts`,
            wrap: true,
          };
          const instance = createFilePreviewPaneInstance(
            state,
            sequence.toString(16).padStart(32, '0'),
          );
          if (!instance || !host) return;
          host.open(
            instance,
            createFilePreviewPaneStatePreparation(
              localStorage,
              instance.stateKey,
              state,
            ),
          );
        }}
      >
        Open preview
      </button>
    );
  }

  render(
    <WorkspacePaneHost
      document={{
        version: '1.1',
        id: 'capacity-host',
        scope: { kind: 'project', projectId: 'project', layoutId: 'coding' },
        instances: [one],
        activeInstanceId: one.instanceId,
        root: {
          type: 'tabs',
          id: 'root',
          instanceIds: [one.instanceId],
          selectedInstanceId: one.instanceId,
        },
      }}
      presentationLabel={(instance) =>
        filePreviewPanePresentationLabel('project', instance, localStorage)
      }
      onInstanceRemoved={(instance) =>
        removeRemovedFilePreviewPaneState('project', instance, localStorage)
      }
      renderPane={() => <Opener />}
    />,
  );

  for (let index = 0; index < 24; index += 1)
    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
  const previewStateCount = () =>
    Object.keys(localStorage).filter((key) =>
      key.startsWith(FILE_PREVIEW_PANE_STATE_STORAGE_PREFIX),
    ).length;
  expect(screen.getAllByRole('tab')).toHaveLength(24);
  expect(previewStateCount()).toBe(23);

  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Close File Preview — src/file-1.ts',
      }),
    );
  });
  expect(previewStateCount()).toBe(22);

  fireEvent.click(screen.getByRole('button', { name: 'Open preview' }));
  expect(screen.getAllByRole('tab')).toHaveLength(24);
  expect(previewStateCount()).toBe(23);
});

test('authority revocation cleans all 23 preview states before capacity is reused', async () => {
  const previews = Array.from({ length: 23 }, (_, offset) => {
    const index = offset + 1;
    const state = {
      version: '1.0' as const,
      projectSlug: 'project',
      path: `src/revoked-${index}.ts`,
      wrap: true,
    };
    const instance = createFilePreviewPaneInstance(
      state,
      index.toString(16).padStart(32, '0'),
    )!;
    expect(
      writeFilePreviewPaneState(localStorage, instance.stateKey, state),
    ).toBe(true);
    return instance;
  });
  const initial: WorkspacePaneHostDocumentV1 = {
    version: '1.1',
    id: 'revocation-capacity-host',
    scope: { kind: 'project', projectId: 'project', layoutId: 'coding' },
    instances: [one, ...previews],
    activeInstanceId: one.instanceId,
    root: {
      type: 'tabs',
      id: 'root',
      instanceIds: [one.instanceId, ...previews.map((pane) => pane.instanceId)],
      selectedInstanceId: one.instanceId,
    },
  };
  const authoritative: WorkspacePaneHostDocumentV1 = {
    ...initial,
    instances: [one],
    root: {
      type: 'tabs',
      id: 'root',
      instanceIds: [one.instanceId],
      selectedInstanceId: one.instanceId,
    },
  };
  const removeState = (instance: WorkspacePaneInstance) =>
    removeRemovedFilePreviewPaneState('project', instance, localStorage);
  const { rerender } = render(
    <WorkspacePaneHost
      document={initial}
      onInstanceRemoved={removeState}
      renderPane={() => <div>Pane</div>}
    />,
  );

  await act(async () => {
    rerender(
      <WorkspacePaneHost
        document={authoritative}
        onInstanceRemoved={removeState}
        renderPane={() => <div>Pane</div>}
      />,
    );
  });
  const previewStateCount = () =>
    Object.keys(localStorage).filter((key) =>
      key.startsWith(FILE_PREVIEW_PANE_STATE_STORAGE_PREFIX),
    ).length;
  expect(previewStateCount()).toBe(0);

  for (let index = 24; index <= 46; index += 1) {
    const state = {
      version: '1.0' as const,
      projectSlug: 'project',
      path: `src/replacement-${index}.ts`,
      wrap: true,
    };
    const instance = createFilePreviewPaneInstance(
      state,
      index.toString(16).padStart(32, '0'),
    )!;
    expect(
      writeFilePreviewPaneState(localStorage, instance.stateKey, state),
    ).toBe(true);
  }
  expect(previewStateCount()).toBe(23);
});

test('close publishes its removal but preserves state referenced by another layout', async () => {
  const state = {
    version: '1.0' as const,
    projectSlug: 'project',
    path: 'src/shared-layout.ts',
    wrap: true,
  };
  const preview = createFilePreviewPaneInstance(state, 'd'.repeat(32))!;
  expect(writeFilePreviewPaneState(localStorage, preview.stateKey, state)).toBe(
    true,
  );
  expect(
    persistWorkspacePaneHost(
      localStorage,
      singlePaneHostDocument('other-layout-reference', preview, 'review'),
    ),
  ).toBe(true);
  const current: WorkspacePaneHostDocumentV1 = {
    version: '1.1',
    id: 'shared-close-host',
    scope: { kind: 'project', projectId: 'project', layoutId: 'coding' },
    instances: [one, preview],
    activeInstanceId: preview.instanceId,
    root: {
      type: 'tabs',
      id: 'root',
      instanceIds: [one.instanceId, preview.instanceId],
      selectedInstanceId: preview.instanceId,
    },
  };
  render(
    <WorkspacePaneHost
      document={current}
      onInstanceRemoved={(instance) =>
        removeRemovedFilePreviewPaneState('project', instance, localStorage)
      }
      renderPane={() => <div>Pane</div>}
    />,
  );

  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', {
        // The pane's declared name, not its id (archive#3971).
        name: 'Close File Preview',
      }),
    );
  });
  expect(readFilePreviewPaneState(localStorage, preview.stateKey)).toEqual(
    state,
  );
  const persisted = JSON.parse(
    localStorage.getItem(
      workspacePaneHostStorageKey(current.scope, current.id),
    ) ?? 'null',
  ) as WorkspacePaneHostDocumentV1;
  expect(persisted.instances).toEqual([one]);
});

test('failed state prepare rolls durable and live host persistence back', () => {
  const { first, second } = sharedStorageClients();
  for (let index = 1; index <= 24; index += 1) {
    const state = {
      version: '1.0' as const,
      projectSlug: 'project',
      path: `src/referenced-${index}.ts`,
      wrap: true,
    };
    const instance = createFilePreviewPaneInstance(
      state,
      index.toString(16).padStart(32, '0'),
    )!;
    expect(writeFilePreviewPaneState(second, instance.stateKey, state)).toBe(
      true,
    );
    expect(
      persistWorkspacePaneHost(
        second,
        singlePaneHostDocument(
          `reference-${index}`,
          instance,
          `layout-${index}`,
        ),
      ),
    ).toBe(true);
  }
  const rejectedState = {
    version: '1.0' as const,
    projectSlug: 'project',
    path: 'src/rejected.ts',
    wrap: true,
  };
  const rejected = createFilePreviewPaneInstance(
    rejectedState,
    'f'.repeat(32),
  )!;
  function RejectedOpener() {
    const host = useWorkspacePaneHostOpenAction();
    return (
      <button
        type="button"
        onClick={() =>
          host?.open(
            rejected,
            createFilePreviewPaneStatePreparation(
              first,
              rejected.stateKey,
              rejectedState,
            ),
          )
        }
      >
        Rejected open
      </button>
    );
  }
  const document = singlePaneHostDocument('rollback-host', one);
  render(
    <WorkspacePaneHost
      document={document}
      storage={first}
      renderPane={() => <RejectedOpener />}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Rejected open' }));

  expect(screen.getAllByRole('tab')).toHaveLength(1);
  expect(readFilePreviewPaneState(first, rejected.stateKey)).toBeNull();
  const persisted = JSON.parse(
    first.getItem(workspacePaneHostStorageKey(document.scope, document.id)) ??
      'null',
  ) as WorkspacePaneHostDocumentV1;
  expect(persisted.instances).toEqual([one]);
});

test.each(['false', 'throw'] as const)(
  'state prepare that writes then returns %s rolls back and cannot admit on remount',
  (outcome) => {
    const { first } = sharedStorageClients();
    const state = {
      version: '1.0' as const,
      projectSlug: 'project',
      path: `src/prepare-${outcome}.ts`,
      wrap: true,
    };
    const preview = createFilePreviewPaneInstance(
      state,
      outcome === 'false' ? '7'.repeat(32) : '8'.repeat(32),
    )!;
    const statePreparation = createFilePreviewPaneStatePreparation(
      first,
      preview.stateKey,
      state,
    );
    let opened: WorkspacePaneHostOpenOutcome | undefined;
    function Opener() {
      const host = useWorkspacePaneHostOpenAction();
      return (
        <button
          type="button"
          onClick={() => {
            opened = host?.open(preview, {
              prepare: () => {
                expect(statePreparation.prepare()).toBe(true);
                if (outcome === 'throw') throw new Error('prepare rejected');
                return false;
              },
              rollback: statePreparation.rollback,
            });
          }}
        >
          Rejected prepared open
        </button>
      );
    }
    const document = singlePaneHostDocument(`prepare-${outcome}-host`, one);
    const mounted = render(
      <WorkspacePaneHost
        document={document}
        storage={first}
        renderPane={() => <Opener />}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Rejected prepared open' }),
    );

    expect(opened).toEqual({ ok: false, reason: 'not-persisted' });
    expect(readFilePreviewPaneState(first, preview.stateKey)).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    mounted.unmount();
    render(
      <WorkspacePaneHost
        document={document}
        storage={first}
        admitRestoredInstance={(candidate) =>
          admitRestoredFilePreviewPaneInstance('project', candidate, first)
        }
        renderPane={(pane) => <div>{pane.descriptorId}</div>}
      />,
    );
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.queryByRole('tab', { name: 'File Preview' })).toBeNull();
  },
);

test('host rollback failure still rolls state back and cannot admit on remount', () => {
  const values = new Map<string, string>();
  const document = singlePaneHostDocument('failed-host-rollback', one);
  const hostKey = workspacePaneHostStorageKey(document.scope, document.id);
  let rejectHostWrites = false;
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (rejectHostWrites && key === hostKey)
        throw new Error('host rollback unavailable');
      values.set(key, value);
    },
    removeItem: (key: string) => values.delete(key),
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
  };
  const state = {
    version: '1.0' as const,
    projectSlug: 'project',
    path: 'src/failed-host-rollback.ts',
    wrap: true,
  };
  const preview = createFilePreviewPaneInstance(state, '9'.repeat(32))!;
  const statePreparation = createFilePreviewPaneStatePreparation(
    storage,
    preview.stateKey,
    state,
  );
  let opened: WorkspacePaneHostOpenOutcome | undefined;
  function Opener() {
    const host = useWorkspacePaneHostOpenAction();
    return (
      <button
        type="button"
        onClick={() => {
          opened = host?.open(preview, {
            prepare: () => {
              expect(statePreparation.prepare()).toBe(true);
              rejectHostWrites = true;
              return false;
            },
            rollback: statePreparation.rollback,
          });
        }}
      >
        Fail host rollback
      </button>
    );
  }
  const mounted = render(
    <WorkspacePaneHost
      document={document}
      storage={storage}
      renderPane={() => <Opener />}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Fail host rollback' }));

  expect(opened).toEqual({ ok: false, reason: 'not-persisted' });
  expect(readFilePreviewPaneState(storage, preview.stateKey)).toBeNull();
  expect(
    (
      JSON.parse(
        storage.getItem(hostKey) ?? 'null',
      ) as WorkspacePaneHostDocumentV1
    ).instances,
  ).toContainEqual(preview);
  expect(screen.getAllByRole('tab')).toHaveLength(1);

  rejectHostWrites = false;
  mounted.unmount();
  render(
    <WorkspacePaneHost
      document={document}
      storage={storage}
      admitRestoredInstance={(candidate) =>
        admitRestoredFilePreviewPaneInstance('project', candidate, storage)
      }
      renderPane={(pane) => <div>{pane.descriptorId}</div>}
    />,
  );
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  expect(screen.queryByRole('tab', { name: 'File Preview' })).toBeNull();
});

test('durable prepare failure rejects open before invoking state commit', () => {
  const values = new Map<string, string>();
  let rejectWrites = false;
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (rejectWrites) throw new Error('storage unavailable');
      values.set(key, value);
    },
    removeItem: (key: string) => values.delete(key),
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
  };
  const preparation = {
    prepare: vi.fn(() => true),
    rollback: vi.fn(),
  };
  function DurableFailureOpener() {
    const host = useWorkspacePaneHostOpenAction();
    return (
      <button type="button" onClick={() => host?.open(two, preparation)}>
        Durable failure open
      </button>
    );
  }
  const document = singlePaneHostDocument('durable-failure-host', one);
  render(
    <WorkspacePaneHost
      document={document}
      storage={storage}
      renderPane={() => <DurableFailureOpener />}
    />,
  );
  rejectWrites = true;
  fireEvent.click(screen.getByRole('button', { name: 'Durable failure open' }));

  expect(preparation.prepare).not.toHaveBeenCalled();
  expect(preparation.rollback).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  const persisted = JSON.parse(
    storage.getItem(workspacePaneHostStorageKey(document.scope, document.id)) ??
      'null',
  ) as WorkspacePaneHostDocumentV1;
  expect(persisted.instances).toEqual([one]);
});

test('authoritative catalog replacement revokes stale panes, lifecycle ownership, persistence, and navigation', async () => {
  const runtime = new WorkspacePaneHostRuntime();
  const dispose = vi.fn();
  for (const pane of [one, two, three]) {
    runtime.register(pane.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose,
    });
  }
  const rendered: string[] = [];
  const onDocumentChange = vi.fn();
  const onInstanceRemoved = vi.fn();
  navigationStore.navigate('/projects/project/layouts/layout', { pane: 'one' });
  const { rerender } = render(
    <WorkspacePaneHost
      document={flatHostDocument(one.instanceId)}
      runtime={runtime}
      onDocumentChange={onDocumentChange}
      onInstanceRemoved={onInstanceRemoved}
      renderPane={(pane) => {
        rendered.push(pane.instanceId);
        return <div>{pane.descriptorId} content</div>;
      }}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });

  const revoked: WorkspacePaneHostDocumentV1 = {
    ...flatHostDocument(two.instanceId),
    instances: [two, three],
    root: {
      type: 'tabs',
      id: 'flat',
      instanceIds: [two.instanceId, three.instanceId],
      selectedInstanceId: two.instanceId,
    },
  };
  await act(async () => {
    rerender(
      <WorkspacePaneHost
        document={revoked}
        runtime={runtime}
        onDocumentChange={onDocumentChange}
        onInstanceRemoved={onInstanceRemoved}
        renderPane={(pane) => {
          rendered.push(pane.instanceId);
          return <div>{pane.descriptorId} content</div>;
        }}
      />,
    );
    await Promise.resolve();
  });

  expect(screen.queryByRole('tab', { name: 'One' })).toBeNull();
  expect(screen.queryByText('One content')).toBeNull();
  expect(rendered.at(-1)).not.toBe(one.instanceId);
  expect(onDocumentChange).toHaveBeenLastCalledWith(
    expect.objectContaining({
      activeInstanceId: two.instanceId,
      instances: [two, three],
    }),
  );
  expect(runtime.visibleInstanceIds()).not.toContain(one.instanceId);
  expect(runtime.setFocused(one.instanceId)).toBe(false);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(onInstanceRemoved).toHaveBeenCalledWith(one);
  expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(
    onInstanceRemoved.mock.invocationCallOrder[0]!,
  );
  expect(new URL(window.location.href).searchParams.get('pane')).toBe(
    two.instanceId,
  );
  const persisted = JSON.parse(
    window.localStorage.getItem(
      workspacePaneHostStorageKey(revoked.scope, revoked.id),
    ) ?? 'null',
  ) as WorkspacePaneHostDocumentV1;
  expect(persisted.instances.map((pane) => pane.instanceId)).toEqual([
    two.instanceId,
    three.instanceId,
  ]);
});

test('pending revocation preserves a reauthorized same-ID preview and reconciles its renderer', async () => {
  const runtime = new WorkspacePaneHostRuntime();
  const state = {
    version: '1.0' as const,
    projectSlug: 'project',
    path: 'src/reauthorized.ts',
    wrap: true,
  };
  const preview = createFilePreviewPaneInstance(state, 'c'.repeat(32))!;
  expect(writeFilePreviewPaneState(localStorage, preview.stateKey, state)).toBe(
    true,
  );
  let releaseDispose!: () => void;
  const dispose = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        releaseDispose = resolve;
      }),
  );
  const mount = vi.fn();
  let acceptedRegistrations = 0;
  const renderPane = (pane: WorkspacePaneInstance) => {
    if (pane.instanceId === preview.instanceId) {
      const accepted = runtime.register(pane.instanceId, {
        mount,
        suspend: vi.fn(),
        resume: vi.fn(),
        dispose,
      });
      if (accepted) acceptedRegistrations += 1;
    }
    return <div>{pane.descriptorId}</div>;
  };
  const initial: WorkspacePaneHostDocumentV1 = {
    version: '1.1',
    id: 'reauthorization-host',
    scope: { kind: 'project', projectId: 'project', layoutId: 'coding' },
    instances: [one, preview],
    activeInstanceId: preview.instanceId,
    root: {
      type: 'tabs',
      id: 'root',
      instanceIds: [one.instanceId, preview.instanceId],
      selectedInstanceId: preview.instanceId,
    },
  };
  const removed: WorkspacePaneHostDocumentV1 = {
    ...initial,
    instances: [one],
    activeInstanceId: one.instanceId,
    root: {
      type: 'tabs',
      id: 'root',
      instanceIds: [one.instanceId],
      selectedInstanceId: one.instanceId,
    },
  };
  const onInstanceRemoved = vi.fn((instance: WorkspacePaneInstance) =>
    removeRemovedFilePreviewPaneState('project', instance, localStorage),
  );
  const { rerender } = render(
    <WorkspacePaneHost
      document={initial}
      runtime={runtime}
      onInstanceRemoved={onInstanceRemoved}
      renderPane={renderPane}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(acceptedRegistrations).toBe(1);
  mount.mockClear();

  await act(async () => {
    rerender(
      <WorkspacePaneHost
        document={removed}
        runtime={runtime}
        onInstanceRemoved={onInstanceRemoved}
        renderPane={renderPane}
      />,
    );
    await Promise.resolve();
  });
  expect(releaseDispose).toBeTypeOf('function');
  rerender(
    <WorkspacePaneHost
      document={initial}
      runtime={runtime}
      onInstanceRemoved={onInstanceRemoved}
      renderPane={renderPane}
    />,
  );
  expect(readFilePreviewPaneState(localStorage, preview.stateKey)).toEqual(
    state,
  );

  await act(async () => {
    releaseDispose();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(onInstanceRemoved).not.toHaveBeenCalled();
  expect(readFilePreviewPaneState(localStorage, preview.stateKey)).toEqual(
    state,
  );
  expect(acceptedRegistrations).toBe(2);
  expect(mount).toHaveBeenCalled();
  expect(runtime.visibleInstanceIds()).toContain(preview.instanceId);
  expect(screen.getByRole('tab', { name: 'File Preview' })).toBeTruthy();
});

test('keeps a failed authoritative cleanup tombstoned through the controller retry until explicit recovery', async () => {
  const runtime = new WorkspacePaneHostRuntime();
  let rejectFirstDispose!: (reason?: unknown) => void;
  const dispose = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirstDispose = reject;
        }),
    )
    .mockImplementationOnce(() => {
      throw new Error('bounded controller retry fails');
    });
  runtime.register(one.instanceId, {
    mount: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(),
    dispose,
  });
  for (const pane of [two, three]) {
    runtime.register(pane.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose: vi.fn(),
    });
  }
  const { rerender } = render(
    <WorkspacePaneHost
      document={flatHostDocument(one.instanceId)}
      runtime={runtime}
      renderPane={(pane) => <div>{pane.descriptorId}</div>}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });
  const revoked: WorkspacePaneHostDocumentV1 = {
    ...flatHostDocument(two.instanceId),
    instances: [two, three],
    root: {
      type: 'tabs',
      id: 'flat',
      instanceIds: [two.instanceId, three.instanceId],
      selectedInstanceId: two.instanceId,
    },
  };
  await act(async () => {
    rerender(
      <WorkspacePaneHost
        document={revoked}
        runtime={runtime}
        renderPane={(pane) => <div>{pane.descriptorId}</div>}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(rejectFirstDispose).toBeTypeOf('function');

  await act(async () => {
    // A referentially new source snapshot with the same authority fingerprint
    // must not cancel the active cleanup/replacement recovery.
    rerender(
      <WorkspacePaneHost
        document={{ ...revoked, instances: [...revoked.instances] }}
        runtime={runtime}
        renderPane={(pane) => <div>{pane.descriptorId}</div>}
      />,
    );
    rejectFirstDispose(new Error('initial revocation cleanup fails'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(dispose).toHaveBeenCalledTimes(2);
  expect(runtime.isRevoked(one.instanceId)).toBe(true);
  expect(runtime.requiresCleanup(one.instanceId)).toBe(true);
  expect(runtime.setFocused(one.instanceId)).toBe(false);
  expect(
    runtime.register(one.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose: vi.fn(),
    }),
  ).toBe(false);

  await expect(runtime.retryRevokedCleanup(one.instanceId)).resolves.toBe(true);
  expect(runtime.isRevoked(one.instanceId)).toBe(false);
  expect(runtime.requiresCleanup(one.instanceId)).toBe(false);
  expect(
    runtime.register(one.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose: vi.fn(),
    }),
  ).toBe(true);
});

test('delayed close arbitration preserves a newer selected pane for state, navigation, and focus', async () => {
  const runtime = new WorkspacePaneHostRuntime();
  let allowClose!: (value: 'allow') => void;
  runtime.register(one.instanceId, {
    mount: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(),
    dispose: vi.fn(),
    beforeClose: () =>
      new Promise<'allow'>((resolve) => {
        allowClose = resolve;
      }),
  });
  for (const pane of [two, three]) {
    runtime.register(pane.instanceId, {
      mount: vi.fn(),
      suspend: vi.fn(),
      resume: vi.fn(),
      dispose: vi.fn(),
    });
  }
  const onDocumentChange = vi.fn();
  render(
    <WorkspacePaneHost
      document={flatHostDocument(one.instanceId)}
      runtime={runtime}
      onDocumentChange={onDocumentChange}
      renderPane={(pane) => <div>{pane.descriptorId}</div>}
    />,
  );
  await act(async () => {
    await Promise.resolve();
  });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Close One' }));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(allowClose).toBeTypeOf('function');
  fireEvent.click(screen.getByRole('tab', { name: 'Three' }));
  await act(async () => {
    allowClose('allow');
    await Promise.resolve();
  });

  expect(onDocumentChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ activeInstanceId: three.instanceId }),
  );
  expect(new URL(window.location.href).searchParams.get('pane')).toBe(
    three.instanceId,
  );
  await act(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  expect(globalThis.document.activeElement).toBe(
    screen.getByRole('tab', { name: 'Three' }),
  );
});

/**
 * archive#3793. The persistence lease is elected once per (storage, lock name,
 * lock manager) — not once per render. Its effect used to depend on the
 * `emitOperationalEvent` callback, which is rebuilt whenever the consumer's
 * `operationalEventContext` identity changes; every host consumer passes that
 * as an inline arrow, so an ordinarily re-rendering parent aborted the
 * in-flight `navigator.locks.request` and asked for the lock again on every
 * commit — re-hydrating the document from storage and dispatching `restore`
 * each time it was granted (8,276 effect entries in 5s, measured pre-#3781).
 *
 * The counting manager below is the honest detector: it records one entry per
 * `request`, so N renders that change nothing but callback identity must still
 * read exactly one lease request.
 */
test('elects the persistence lease once across renders that only rebuild consumer callbacks', async () => {
  const requests: string[] = [];
  const countingLockManager: WorkspacePaneHostLockManager = {
    request: async (name, _options, callback) => {
      requests.push(name);
      await callback({});
    },
  };
  const supplied = singlePaneHostDocument('lease-entry-count', one);
  const renderHostWith = (nonce: number) => (
    <WorkspacePaneHost
      document={supplied}
      lockManager={countingLockManager}
      operationalEventSink={new InMemoryWorkspacePaneOperationalEventSink()}
      // Rebuilt every render, exactly as ProjectLayoutRenderer builds it.
      operationalEventContext={(instance, hostDocument) =>
        operationalContext(instance, hostDocument)
      }
      operationalAvailability={() => undefined}
      renderPane={(pane) => (
        <div>
          {pane.descriptorId} {nonce}
        </div>
      )}
    />
  );

  const view = render(renderHostWith(0));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(requests).toHaveLength(1);

  for (let nonce = 1; nonce <= 5; nonce += 1) {
    view.rerender(renderHostWith(nonce));
    await act(async () => {
      await Promise.resolve();
    });
  }

  expect(requests).toEqual([
    workspacePaneHostStorageKey(supplied.scope, supplied.id),
  ]);
});

/**
 * archive#3795, at the seam that pays for it: the persistence lease restores
 * the stored document on every grant, and `restore` used to mint a new
 * document identity whether or not anything had changed — so every
 * re-election re-ran the `[state.document]` effects, including the one that
 * WRITES the document back to storage. Restoring a document nobody edited
 * must write nothing.
 */
test('a lease re-election that restores an unchanged document writes nothing', async () => {
  const writes: string[] = [];
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(key);
      values.set(key, value);
    },
    removeItem: (key: string) => values.delete(key),
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
  };
  const supplied = singlePaneHostDocument('idempotent-restore', one);
  // Behaviorally identical, freshly identified: a re-election, not a change of
  // lock semantics.
  const grantingLockManager = (): WorkspacePaneHostLockManager => ({
    request: async (_name, _options, callback) => callback({}),
  });

  const view = render(
    <WorkspacePaneHost
      document={supplied}
      storage={storage}
      lockManager={grantingLockManager()}
      renderPane={(pane) => <div>{pane.descriptorId}</div>}
    />,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(writes.length).toBeGreaterThan(0);
  writes.length = 0;

  view.rerender(
    <WorkspacePaneHost
      document={supplied}
      storage={storage}
      lockManager={grantingLockManager()}
      renderPane={(pane) => <div>{pane.descriptorId}</div>}
    />,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(writes).toEqual([]);
});
