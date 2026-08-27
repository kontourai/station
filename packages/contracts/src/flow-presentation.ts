export const RETIRED_FLOW_DEFINITION_ID = 'station-delivery';

export const STANDARD_FLOW_BUILDER_GUIDANCE =
  'Start or bind the standard Flow/Builder lifecycle so the mutation is recorded as audit evidence';

export function isRetiredFlowDefinition(definitionId: string): boolean {
  return definitionId === RETIRED_FLOW_DEFINITION_ID;
}

/** Presentation policy for persisted Flow identities. Stored identifiers stay intact. */
export function flowRunDisplayIdentity(
  definitionId: string,
  runId?: string,
): string {
  if (isRetiredFlowDefinition(definitionId)) return 'Legacy delivery checks';
  return runId ? `${definitionId} · ${runId}` : definitionId;
}
