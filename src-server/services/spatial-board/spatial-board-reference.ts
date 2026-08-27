import type { WorkReference } from '@kontourai/station-contracts';

/**
 * Exact persisted/HTTP boundary for personal Work Board references. This is
 * server-local because it validates Station's storage and route ingress, not
 * a public contracts vocabulary.
 */
export function isSpatialBoardWorkReference(
  value: unknown,
): value is WorkReference {
  const text = (candidate: unknown) =>
    typeof candidate === 'string' &&
    candidate.length > 0 &&
    new TextEncoder().encode(candidate).byteLength <= 4096 &&
    ![...candidate].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
  if (!value || typeof value !== 'object') return false;
  const reference = value as Record<string, unknown>;
  const keys = Object.keys(reference);
  const exact = (expected: readonly string[]) =>
    keys.length === expected.length &&
    expected.every((key) => keys.includes(key));
  if (
    reference.kind === 'project' ||
    reference.kind === 'session' ||
    reference.kind === 'approval' ||
    reference.kind === 'agent'
  )
    return exact(['kind', 'id']) && text(reference.id);
  if (reference.kind === 'task')
    return (
      exact(['kind', 'id', 'projectId']) &&
      text(reference.id) &&
      text(reference.projectId)
    );
  if (reference.kind === 'receipt')
    return reference.owner === 'scheduler-run'
      ? exact(['kind', 'owner', 'id']) && text(reference.id)
      : reference.owner === 'independent-review' &&
          exact(['kind', 'owner', 'id', 'projectSlug']) &&
          text(reference.id) &&
          text(reference.projectSlug);
  if (reference.kind === 'run')
    return (
      reference.owner === 'flow' &&
      exact(
        reference.gateId === undefined
          ? ['kind', 'owner', 'id', 'projectId']
          : ['kind', 'owner', 'id', 'projectId', 'gateId'],
      ) &&
      text(reference.id) &&
      text(reference.projectId) &&
      (reference.gateId === undefined || text(reference.gateId))
    );
  return (
    reference.kind === 'artifact' &&
    reference.owner === 'run-output' &&
    exact(['kind', 'owner', 'id', 'runId']) &&
    text(reference.id) &&
    text(reference.runId)
  );
}
