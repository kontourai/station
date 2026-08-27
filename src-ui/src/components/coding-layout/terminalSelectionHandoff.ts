import { redactSecrets } from '@kontourai/station-shared/redaction';

/**
 * The terminal itself remains an unfiltered rendering of the user's shell.
 * This scan is deliberately limited to the one boundary that moves selected
 * terminal text into an agent-facing composer, and receives the complete
 * xterm selection rather than a stream chunk.
 */
export function selectionContainsCredential(selection: string): boolean {
  return redactSecrets(selection) !== selection;
}

function literalFence(selection: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...[...selection.matchAll(/`+/g)].map((match) => match[0].length),
  );
  return '`'.repeat(Math.max(3, longestBacktickRun + 1));
}

export function buildTerminalSelectionHandoff({
  selection,
  cwd,
}: {
  selection: string;
  cwd: string;
}): string {
  const fence = literalFence(selection);
  return [
    `Terminal output (working directory: ${JSON.stringify(cwd)}):`,
    fence,
    selection,
    fence,
  ].join('\n');
}
