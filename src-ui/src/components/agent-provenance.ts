import type { AgentData } from '../contexts/AgentsContext';

/**
 * Is this row one of the engines Station found on this machine, or one the
 * user authored? DESIGN.md §2's two bands, and §5 reuses the same answer.
 *
 * It reads `provenance.origin`, the server's record of how the definition was
 * first created (`AgentSpec.provenance`, written by engine detection). The
 * first cut read `engineDefault`, which looks like the same question and is
 * not: `engineDefault` means "no Agent FILE exists behind this identity yet",
 * and since #3627 seeds are materialised in place — so on a real home every
 * engine had a file, every row answered `false`, and the list rendered one
 * band called "Your agents" holding four engines the user never authored.
 * Caught live at 1440 in this lane's own capture.
 *
 * `engineDefault` still counts: an engine that has NOT been materialised yet
 * is an engine row too, and it has no spec to carry provenance.
 */
export function isEngineProvenanceAgent(
  agent: Pick<AgentData, 'engineDefault' | 'provenance'>,
): boolean {
  return (
    agent.engineDefault === true ||
    agent.provenance?.origin === 'engine-detection'
  );
}

/** DESIGN.md §2's band labels, spoken in one place. */
export const ENGINE_BAND_LABEL = 'Engines on this machine';
export const AUTHORED_BAND_LABEL = 'Your agents';
