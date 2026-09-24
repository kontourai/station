/**
 * #2324: the live Claude CLI 2.1.281 captures of turns the engine opened on
 * its own (`fixtures/claude-2.1.281-*.jsonl`), shared by the adapter suite
 * (`claude-provider-turns.fixture.test.ts`) and the service suite
 * (`claude-provider-turns.service.test.ts`).
 *
 * The suites import this module rather than reading the captures by path:
 * the path-read pin scanner never pins `fixtures/` (see
 * `scripts/lib/path-read-pin-scan.mjs`), so a suite reading them directly
 * would be a blind spot on `UNREPORTED_PATH_READING_SUITES`. Through this
 * module both suites have an import edge that the module graph schedules.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CLAUDE_PROVIDER_TURN_FIXTURES = [
  'background-bash',
  'background-agent',
  'interrupt-provider-turn',
  'send-before-task-notification',
  'send-folded-into-provider-turn',
  'send-races-provider-turn-start',
] as const;

export type ClaudeProviderTurnFixtureName =
  (typeof CLAUDE_PROVIDER_TURN_FIXTURES)[number];

/** One capture line: an SDK message as the CLI emitted it, or a probe action. */
export interface ClaudeProviderTurnFixtureLine {
  t: number;
  msg?: Record<string, unknown>;
  probe?: string;
}

/** The capture's raw text, exactly as recorded. */
export function readClaudeProviderTurnFixture(
  name: ClaudeProviderTurnFixtureName,
): string {
  return readFileSync(
    fileURLToPath(
      new URL(`./fixtures/claude-2.1.281-${name}.jsonl`, import.meta.url),
    ),
    'utf8',
  );
}

/** The capture parsed into its lines. */
export function loadClaudeProviderTurnFixture(
  name: ClaudeProviderTurnFixtureName,
): ClaudeProviderTurnFixtureLine[] {
  return readClaudeProviderTurnFixture(name)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ClaudeProviderTurnFixtureLine);
}
