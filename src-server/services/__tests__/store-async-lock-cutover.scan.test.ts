/**
 * The source ratchets of `store-async-lock-cutover.test.ts`, moved here
 * unchanged (#2176): both walk the whole `src-server` tree, which no import
 * edge connects to a test, so the `repo-scans` pull-request job runs this
 * file. The behavioural cutover cases stay in the original.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') return [];
      return productionTypeScriptFiles(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [path]
      : [];
  });
}

/**
 * Drop comment-only lines before the identifier scans below. The ratchets
 * red on a bare content regex, so a doc comment that merely NAMES a sync API
 * reads as an offender — #1837 tripped exactly that way when its docblock
 * started mentioning `acquireStationHomeMaintenanceLease` in prose. The
 * identifier scans are about code: a line that begins with a comment token
 * cannot call anything, so excluding it cannot hide a real offender, while
 * any code line containing the identifier (import or call site) still
 * matches.
 */
function stripCommentLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return (
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('*') &&
        !trimmed.startsWith('/*')
      );
    })
    .join('\n');
}

it('keeps synchronous file-mutation lock acquisition out of server production', () => {
  // The two lock-owning storage primitives that moved to packages/shared
  // (json-file-storage, tool-server-credential-store) stay in scope by name —
  // a sync-lock regression in them would otherwise be invisible. The rest of
  // packages/shared is deliberately NOT swept: lifecycle-events.ts defines
  // the sync lock, and shared has pre-existing non-server sync consumers.
  const movedStoragePrimitives = [
    join(process.cwd(), 'packages/shared/src/json-file-storage.ts'),
    join(process.cwd(), 'packages/shared/src/tool-server-credential-store.ts'),
  ];
  const offenders = [
    ...productionTypeScriptFiles(join(process.cwd(), 'src-server')),
    ...movedStoragePrimitives,
  ].filter((path) =>
    /\bacquireFileMutationLock\b/.test(
      stripCommentLines(readFileSync(path, 'utf8')),
    ),
  );
  expect(offenders).toEqual([]);
});

it('keeps synchronous Station-home maintenance out of server production', () => {
  // Server boot may use the shared sync lifecycle APIs only through
  // non-server CLI/archive callers. A direct import here would recreate the
  // event-loop-blocking quarantine path even if no raw mutation lock appears.
  const offenders = productionTypeScriptFiles(
    join(process.cwd(), 'src-server'),
  ).filter((path) =>
    /\bacquireStationHomeMaintenanceLease\b/.test(
      stripCommentLines(readFileSync(path, 'utf8')),
    ),
  );
  expect(offenders).toEqual([]);
});
