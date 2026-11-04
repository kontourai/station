import { containsKnownCredential } from '@kontourai/station-shared/redaction';

/**
 * The terminal itself remains an unfiltered rendering of the user's shell.
 * This scan is deliberately limited to the one boundary that moves selected
 * terminal text into an agent-facing composer, and receives the complete
 * emulator selection rather than a stream chunk.
 */
export function selectionContainsCredential(selection: string): boolean {
  return containsKnownCredential(selection);
}
