import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
} from '../../../packages/contracts/src/workspace-pane.ts';

import {
  createWorkspacePaneHostRequest,
  mapElectronWebContentsView,
  mapTauriSeparateWindow,
  resolveRestorationAction,
} from './workspace-pane-adapter.ts';

const descriptor = {
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  id: 'pane:builtin:workspace-preview:browser-preview',
  name: 'Browser Preview',
  description: 'Inspect a validated local browser preview for a workspace.',
  rendererId: 'renderer:builtin:builtin-component:workspace-browser-preview',
  renderer: {
    kind: 'builtin-component',
    name: 'workspace-browser-preview',
  },
  placement: {
    supportedRegions: ['primary', 'secondary', 'standalone'],
    preferredRegion: 'secondary',
  },
  contextRequirement: { project: true },
  provenance: { origin: 'builtin' },
  lifecycle: { stage: 'preview' },
};
const instance = {
  version: WORKSPACE_PANE_CONTRACT_VERSION,
  descriptorId: descriptor.id,
  instanceId: 'browser-preview:project:project-uuid-1',
  stateKey: 'browser-preview:project:project-uuid-1',
  boundContext: { projectId: 'project-uuid-1' },
};
const approvedTarget = 'http://127.0.0.1:5173/';

test('current Browser Preview descriptor and restoration instance satisfy the actual contracts', () => {
  const parsedDescriptor = parseWorkspacePaneDescriptor(descriptor);
  const parsedInstance = parseWorkspacePaneInstance(instance);

  assert.deepEqual(parsedDescriptor, descriptor);
  assert.deepEqual(parsedInstance, instance);
});

test('Tauri and Electron adapters receive the same parsed pane identity and separately approved local target', () => {
  const request = createWorkspacePaneHostRequest(
    descriptor,
    instance,
    approvedTarget,
  );

  assert.deepEqual(mapTauriSeparateWindow(request).request, request);
  assert.deepEqual(mapElectronWebContentsView(request).request, request);
  assert.equal(request.approvedTarget, approvedTarget);
});

test('runtime host data and non-local restoration targets are rejected at the experiment boundary', () => {
  assert.throws(() =>
    createWorkspacePaneHostRequest(
      { ...descriptor, bounds: { x: 0, y: 0 } },
      instance,
      approvedTarget,
    ),
  );
  assert.throws(() =>
    createWorkspacePaneHostRequest(
      descriptor,
      { ...instance, nativeHandle: 'window-1' },
      approvedTarget,
    ),
  );
  assert.throws(
    () =>
      createWorkspacePaneHostRequest(
        descriptor,
        instance,
        'https://example.com',
      ),
    /exact loopback host/,
  );
});

test('unavailable native hosting selects an explicit external open action', () => {
  const request = createWorkspacePaneHostRequest(
    descriptor,
    instance,
    approvedTarget,
  );

  assert.deepEqual(
    resolveRestorationAction(request, false, 'Host unavailable on iOS'),
    {
      kind: 'external-open-action',
      request,
      reason: 'Host unavailable on iOS',
    },
  );
});
