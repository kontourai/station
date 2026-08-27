/**
 * Compile-only host-adapter seam for Station #1376.
 *
 * This experiment consumes the current Workspace Pane and Browser Preview
 * parsers directly. It deliberately does not establish a renderer,
 * availability decision, native capability, or release path. The approved
 * target is supplied separately because it is not a Workspace Pane descriptor
 * or instance field.
 */
import { normalizeLocalBrowserPreviewUrl } from '../../../packages/contracts/src/workspace-browser-preview.ts';
import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from '../../../packages/contracts/src/workspace-pane.ts';

const RUNTIME_ONLY_KEYS = new Set([
  'nativeHandle',
  'webContentsId',
  'windowLabel',
  'bounds',
  'focused',
  'zOrder',
  'cookieStore',
  'processId',
]);

export interface WorkspacePaneHostRequest {
  descriptorId: string;
  rendererId: string;
  instanceId: string;
  stateKey: string;
  approvedTarget: string;
}

function assertNoRuntimeOnlyFields(value: object, label: string): void {
  for (const key of RUNTIME_ONLY_KEYS) {
    if (key in value) {
      throw new Error(`${label} cannot contain runtime-only ${key}`);
    }
  }
}

function parseDescriptor(value: unknown): WorkspacePaneDescriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Workspace Pane descriptor must be an object');
  }
  assertNoRuntimeOnlyFields(value, 'Workspace Pane descriptor');
  const descriptor = parseWorkspacePaneDescriptor(value);
  if (!descriptor) {
    throw new Error('Workspace Pane descriptor does not satisfy contract 1.0');
  }
  return descriptor;
}

function parseInstance(
  value: unknown,
  descriptor: WorkspacePaneDescriptor,
): WorkspacePaneInstance {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Workspace Pane instance must be an object');
  }
  assertNoRuntimeOnlyFields(value, 'Workspace Pane instance');
  const instance = parseWorkspacePaneInstance(value);
  if (!instance) {
    throw new Error('Workspace Pane instance does not satisfy contract 1.0');
  }
  if (instance.descriptorId !== descriptor.id) {
    throw new Error(
      'Workspace Pane instance must retain its descriptor identity',
    );
  }
  return instance;
}

export function createWorkspacePaneHostRequest(
  descriptorInput: unknown,
  instanceInput: unknown,
  approvedTargetInput: unknown,
): Readonly<WorkspacePaneHostRequest> {
  const descriptor = parseDescriptor(descriptorInput);
  const instance = parseInstance(instanceInput, descriptor);
  const approvedTarget = normalizeLocalBrowserPreviewUrl(approvedTargetInput);
  return Object.freeze({
    descriptorId: descriptor.id,
    rendererId: descriptor.rendererId,
    instanceId: instance.instanceId,
    stateKey: instance.stateKey,
    approvedTarget,
  });
}

export function mapTauriSeparateWindow(
  request: Readonly<WorkspacePaneHostRequest>,
): Readonly<{
  host: 'tauri-separate-window';
  request: WorkspacePaneHostRequest;
}> {
  return Object.freeze({ host: 'tauri-separate-window', request });
}

export function mapElectronWebContentsView(
  request: Readonly<WorkspacePaneHostRequest>,
): Readonly<{
  host: 'electron-web-contents-view';
  request: WorkspacePaneHostRequest;
}> {
  return Object.freeze({ host: 'electron-web-contents-view', request });
}

export function resolveRestorationAction(
  request: Readonly<WorkspacePaneHostRequest>,
  nativeHostAvailable: boolean,
  reason: string,
):
  | { kind: 'native-host-action'; request: Readonly<WorkspacePaneHostRequest> }
  | {
      kind: 'external-open-action';
      request: Readonly<WorkspacePaneHostRequest>;
      reason: string;
    } {
  if (nativeHostAvailable) return { kind: 'native-host-action', request };
  return { kind: 'external-open-action', request, reason };
}
