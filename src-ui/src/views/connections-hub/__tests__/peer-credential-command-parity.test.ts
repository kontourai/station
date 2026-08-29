/**
 * #765 D3: the Computers page told users to run `station environment peers
 * add` while `station environment --help` (packages/cli/src/help.ts) listed
 * no `peers` action — the verb was real (environment.ts implements and
 * dispatches it; docs/reference/cli.md documents it) but the help table had
 * drifted, so the product appeared to instruct a command the CLI disowned.
 *
 * This test pins the whole chain for whatever command the UI hands out:
 * the copied string must appear verbatim in the CLI dispatcher's own USAGE
 * text (the ground truth for what actually parses — environment.ts's
 * usage-honesty tests tie that text to the parser) AND be advertised by the
 * help table's `environment` entry. Reading the CLI sources as text keeps
 * this in the UI project without importing CLI modules (whose help table
 * resolves runtime context at import time).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { PEER_CREDENTIAL_COMMAND } from '../peer-credential-command';

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);
const readSource = (path: string) =>
  readFileSync(resolve(repoRoot, path), 'utf8');

/** The `environment: { ... }` topic block of the CLI help table. */
function environmentHelpBlock(): string {
  const source = readSource('packages/cli/src/help.ts');
  const start = source.indexOf('\n  environment: {');
  expect(
    start,
    'help.ts no longer declares an environment topic',
  ).toBeGreaterThan(0);
  const end = source.indexOf('\n  },', start);
  expect(end, 'environment help block is unterminated').toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Computers page CLI instruction stays a real, advertised CLI command (#765 D3)', () => {
  const tokens = PEER_CREDENTIAL_COMMAND.split(' ');

  test('the instruction is a station environment subcommand', () => {
    expect(tokens[0]).toBe('station');
    expect(tokens[1]).toBe('environment');
    expect(tokens.length).toBeGreaterThanOrEqual(3);
  });

  test('the CLI dispatcher itself parses the instructed command (environment.ts USAGE)', () => {
    const environmentSource = readSource(
      'packages/cli/src/commands/environment.ts',
    );
    // USAGE is what runEnvironmentCommand throws for a malformed invocation;
    // environment.ts's own usage-honesty tests hold it to the parser. If the
    // verb is ever renamed or removed there, this line disappears with it.
    expect(environmentSource).toContain(`  ${PEER_CREDENTIAL_COMMAND} `);
  });

  test('`station environment --help` advertises the instructed verb (help.ts)', () => {
    const block = environmentHelpBlock();
    // A usage line for the exact command the UI copies…
    expect(block).toContain(`'${PEER_CREDENTIAL_COMMAND} `);
    // …and the subcommand named in the actions vocabulary, so the help output
    // and unknown-action suggestions both own it.
    expect(block).toContain(`'${tokens[2]}',`);
  });
});
