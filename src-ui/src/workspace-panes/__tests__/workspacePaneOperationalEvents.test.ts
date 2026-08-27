import {
  toWorkspacePaneRendererId,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneHostDocumentV1 } from '@kontourai/station-contracts/workspace-pane-host';
import { describe, expect, test } from 'vitest';
import { WorkspacePaneHostRuntime } from '../workspacePaneHostRuntime';
import {
  createWorkspacePaneOperationalEventContext,
  InMemoryWorkspacePaneOperationalEventSink,
  WorkspacePaneOperationalEventTracker,
} from '../workspacePaneOperationalEvents';

const instance = {
  version: '1.0',
  descriptorId: 'pane:plugin:review',
  instanceId: 'instance:review',
  stateKey: 'state:review',
  boundContext: { projectId: 'project-1' },
} as WorkspacePaneInstance;
const descriptor = {
  version: '1.0',
  id: instance.descriptorId,
  name: 'Review',
  rendererId: toWorkspacePaneRendererId('renderer:plugin:review'),
  renderer: { kind: 'plugin-component', name: 'review' },
  placement: { supportedRegions: ['primary'] },
  modes: [{ id: 'default' }],
  provenance: { origin: 'plugin', pluginId: 'review-plugin' },
  lifecycle: { stage: 'stable' },
} as WorkspacePaneDescriptor;
const document = {
  version: '1.1',
  id: 'host:review',
  scope: { kind: 'project', projectId: 'project-1', layoutId: 'layout-1' },
  instances: [instance],
  root: { type: 'tabs', id: 'tabs:review', instanceIds: [instance.instanceId] },
  activeInstanceId: instance.instanceId,
} as WorkspacePaneHostDocumentV1;

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    key: () => null,
    get length() {
      return values.size;
    },
  };
}

describe('WorkspacePaneOperationalEventTracker', () => {
  test('deduplicates opened/ready across a reload checkpoint but retains resumed', () => {
    const target = storage();
    const sink = new InMemoryWorkspacePaneOperationalEventSink();
    const context = createWorkspacePaneOperationalEventContext(
      document,
      descriptor,
      instance,
      {
        source: 'primary',
        rendererId: descriptor.rendererId,
        renderer: descriptor.renderer,
        contributorProvenance: descriptor.provenance,
        requiredCapabilities: ['trusted-plugin-react'],
      },
    );
    if (!context) throw new Error('fixture context must be valid');
    const first = new WorkspacePaneOperationalEventTracker(target, sink);
    first.emit(context, 'opened');
    first.emit(context, 'ready');
    const reloaded = new WorkspacePaneOperationalEventTracker(target, sink);
    expect(reloaded.emit(context, 'opened')).toBeNull();
    expect(reloaded.emit(context, 'ready')).toBeNull();
    reloaded.emit(context, 'resumed');
    expect(
      sink.events.map(
        (event) => (event.payload.data as { event: string }).event,
      ),
    ).toEqual(['opened', 'ready', 'resumed']);
  });

  test('rejects a renderer/provenance escalation before sink delivery', () => {
    const sink = new InMemoryWorkspacePaneOperationalEventSink();
    const context = createWorkspacePaneOperationalEventContext(
      document,
      descriptor,
      instance,
      {
        source: 'primary',
        renderer: { kind: 'plugin-component', name: 'review' },
        contributorProvenance: { origin: 'builtin' },
        requiredCapabilities: ['trusted-plugin-react'],
      },
    );
    expect(context).toBeNull();
    expect(sink.events).toHaveLength(0);
  });

  test('emits ready, suspended, and resumed only from successful runtime callbacks', async () => {
    const sink = new InMemoryWorkspacePaneOperationalEventSink();
    const runtime = new WorkspacePaneHostRuntime();
    const context = createWorkspacePaneOperationalEventContext(
      document,
      descriptor,
      instance,
      {
        source: 'primary',
        rendererId: descriptor.rendererId,
        renderer: descriptor.renderer,
        contributorProvenance: descriptor.provenance,
        requiredCapabilities: ['trusted-plugin-react'],
      },
    );
    if (!context) throw new Error('fixture context must be valid');
    const tracker = new WorkspacePaneOperationalEventTracker(storage(), sink);
    expect(
      runtime.register(instance.instanceId, {
        mount: () => undefined,
        suspend: () => undefined,
        resume: () => undefined,
        dispose: () => undefined,
      }),
    ).toBe(true);
    const report = (transition: { kind: 'ready' | 'resumed' | 'suspended' }) =>
      tracker.emit(context, transition.kind);
    await runtime.reconcileVisible([instance.instanceId], report);
    await runtime.reconcileVisible([], report);
    await runtime.reconcileVisible([instance.instanceId], report);
    expect(
      sink.events.map(
        (event) => (event.payload.data as { event: string }).event,
      ),
    ).toEqual(['ready', 'suspended', 'resumed']);
  });
});
