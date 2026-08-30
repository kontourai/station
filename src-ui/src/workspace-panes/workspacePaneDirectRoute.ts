import type {
  WorkspacePaneDescriptor,
  WorkspacePaneInstance,
} from '@kontourai/station-contracts/workspace-pane';
import { getPathForView } from '../app-shell/routing';
import type { NavigationView } from '../types';

/**
 * These renderers read the selected Coding layout's configuration. Their direct
 * route must therefore carry that layout identity rather than asking a
 * renderer to recover it from ambient navigation state.
 */
export function workspacePaneRequiresLayoutIdentity(
  descriptor: Partial<Pick<WorkspacePaneDescriptor, 'renderer'>>,
): boolean {
  return (
    descriptor.renderer?.kind === 'builtin-component' &&
    (descriptor.renderer.name === 'coding' ||
      descriptor.renderer.name === 'workspace-coding-file-browser' ||
      descriptor.renderer.name === 'workspace-coding-diff' ||
      descriptor.renderer.name === 'workspace-coding-terminal')
  );
}

export function workspacePaneDirectRoute(
  projectSlug: string,
  descriptor: Pick<WorkspacePaneDescriptor, 'id'> &
    Partial<Pick<WorkspacePaneDescriptor, 'renderer'>>,
  instance: Pick<WorkspacePaneInstance, 'instanceId'>,
  layoutSlug?: string | null,
): string | null {
  const requiresLayout = workspacePaneRequiresLayoutIdentity(descriptor);
  const selectedLayout = layoutSlug?.trim();
  if (requiresLayout && !selectedLayout) return null;

  const view: NavigationView = requiresLayout
    ? {
        type: 'workspace-pane',
        projectSlug,
        layoutSlug: selectedLayout!,
        descriptorId: descriptor.id,
        instanceId: instance.instanceId,
      }
    : {
        type: 'workspace-pane',
        projectSlug,
        descriptorId: descriptor.id,
        instanceId: instance.instanceId,
      };
  return getPathForView(view);
}
