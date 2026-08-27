import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * station#3549: every path that starts a provider engine must apply the
 * session agent's credential-profile pin first.
 *
 * Four review rounds produced the same defect three times, and the last of
 * them found the reason: the pin is applied by CALLERS, and one caller —
 * cold restored-session materialization — never had it. A pinned agent's
 * session, recovered after a restart, ran on the connection's account. The
 * live-start path had been corrected three times over while that path sat
 * uncovered, because nothing made the set of engine-start paths reviewable.
 *
 * This is an allowlist, not a count. A count-ratchet fails on whoever gates
 * next and misattributes by design; an allowlist fails on whoever ADDS a
 * path, and tells them exactly what they have joined. It is the same shape as
 * `PAIRING_SCOPE_FAMILY_INHERITED_LEAVES` in `pairing-route-scopes.ts`, whose
 * gate caught an undeclared route in this very arc: a human confirms each
 * entry, and a new one cannot appear silently.
 *
 * If you are here because this test failed, you added a way to start an
 * engine. Answer one question before adding your file below: **does the
 * `ProviderSessionStartInput` you hand the adapter carry
 * `credentialProfileRef`?** If you did not deliberately resolve it, the
 * session will run on whichever account the connection happens to select,
 * and the user will be billed for it silently.
 */
const ENGINE_START_PATHS: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'src-server/services/orchestration/orchestration-session-state.ts',
    why: 'Cold restored-session materialization. Applies the pin via `applyCredentialProfile`, fail-closed (station#3549 round 4).',
  },
  {
    file: 'src-server/services/orchestration/orchestration-service.ts',
    why: 'Live start and credential-profile restart. Both route through `resolveSessionAgentForStart`, which applies the pin.',
  },
];

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');

/**
 * Deliberately narrow: only a direct `adapter.startSession(` / `.startSession(`
 * on a provider adapter. The delegation seam
 * (`execution-target-execution.ts`) calls its own injected `deps.startSession`,
 * which routes back through `sessionCommands.execute` and therefore through
 * the orchestration paths above — it does not reach an adapter itself.
 */
function filesStartingAnEngine(): string[] {
  const out = execFileSync(
    'git',
    ['grep', '-l', 'adapter.startSession(', '--', 'src-server'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return out
    .split('\n')
    .filter(Boolean)
    .filter((file) => !file.includes('__tests__') && !file.includes('.test.'))
    .filter((file) => {
      // git grep matches comment text too: internal-stop-suppression.ts names
      // `adapter.startSession()` in a docblock and started reading as an
      // engine-start path, which would force a FALSE declaration ("this file
      // starts engines safely") for a file that starts none. Strip comments
      // before deciding a file really calls the seam. Same comment-evasion
      // class as the route-scan incident this repo already records.
      const source = readFileSync(join(REPO_ROOT, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      return source.includes('adapter.startSession(');
    });
}

describe('every engine-start path applies the credential pin (station#3549)', () => {
  test('no undeclared path starts a provider engine', () => {
    const declared = new Set(ENGINE_START_PATHS.map((entry) => entry.file));
    const undeclared = filesStartingAnEngine().filter(
      (file) => !declared.has(file),
    );
    expect(
      undeclared,
      'A new engine-start path appeared. Does the input you hand the adapter carry `credentialProfileRef`? If not, the session runs on the wrong account, silently. Declare it in ENGINE_START_PATHS with why it is safe.',
    ).toEqual([]);
  });

  test('every declared path still exists', () => {
    // An allowlist that outlives its entries stops describing the code.
    const actual = new Set(filesStartingAnEngine());
    const stale = ENGINE_START_PATHS.filter(
      (entry) => !actual.has(entry.file),
    ).map((entry) => entry.file);
    expect(stale, 'Remove entries that no longer start an engine.').toEqual([]);
  });
});
