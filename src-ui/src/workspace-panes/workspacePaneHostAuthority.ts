import type {
  WorkspacePaneInstance,
  WorkspacePaneInstanceId,
} from '@kontourai/station-contracts/workspace-pane';
import type { WorkspacePaneHostDocumentV1 } from '@kontourai/station-contracts/workspace-pane-host';

/**
 * Stable catalog identity only. Host-owned selection, tree geometry, and
 * maximization deliberately do not participate, so local interaction cannot
 * reset the renderer tree.
 */
export function workspacePaneHostAuthorityFingerprint(
  document: WorkspacePaneHostDocumentV1,
): string {
  return JSON.stringify(
    document.instances.map(workspacePaneHostInstanceFingerprint),
  );
}

function workspacePaneHostInstanceFingerprint(
  instance: WorkspacePaneInstance,
): readonly unknown[] {
  return [
    instance.version,
    instance.instanceId,
    instance.descriptorId,
    instance.stateKey,
    Object.entries(instance.boundContext ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ];
}

/** Instances absent from, or changed by, the next authoritative catalog. */
export function workspacePaneHostRevokedInstanceIds(
  previous: readonly WorkspacePaneInstance[],
  next: readonly WorkspacePaneInstance[],
): readonly WorkspacePaneInstanceId[] {
  const nextById = new Map(
    next.map((instance) => [
      instance.instanceId,
      JSON.stringify(workspacePaneHostInstanceFingerprint(instance)),
    ]),
  );
  return previous
    .filter(
      (instance) =>
        nextById.get(instance.instanceId) !==
        JSON.stringify(workspacePaneHostInstanceFingerprint(instance)),
    )
    .map((instance) => instance.instanceId);
}
