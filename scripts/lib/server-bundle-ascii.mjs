import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Node keeps every loaded script's source for lazy compilation. A file that is
// all ASCII is held one byte per character; a single non-ASCII byte makes V8
// hold the whole source as UTF-16, twice its size. For the 22 MB server bundle
// that is 22 MB of heap in every server, and each per-session MCP child pays it
// for its own bundle too. esbuild escapes non-ASCII in string literals but not
// inside regular expression literals or raw template text, so those must be
// written as \u escapes in the source.

const CONTEXT_BYTES = 60;

/** Offsets and context of the first `limit` non-ASCII runs in `bytes`. */
function findNonAsciiRuns(bytes, limit = 10) {
  const runs = [];
  let index = 0;
  while (index < bytes.length && runs.length < limit) {
    if (bytes[index] < 0x80) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < bytes.length && bytes[end] >= 0x80) end += 1;
    const context = bytes
      .subarray(Math.max(0, index - CONTEXT_BYTES), end + CONTEXT_BYTES)
      .toString('utf8')
      .replace(/\s+/g, ' ');
    runs.push({ offset: index, context });
    index = end;
  }
  return runs;
}

/**
 * Throws when any .js or .mjs file directly in `dir`, written at or after
 * `sinceMs`, holds a non-ASCII byte. Older files are left over from earlier
 * builds into the same directory; this build did not produce them.
 */
export function assertAsciiServerBundles(dir, { sinceMs = 0 } = {}) {
  const failures = [];
  for (const name of readdirSync(dir).sort()) {
    if (!/\.m?js$/.test(name)) continue;
    const path = join(dir, name);
    if (statSync(path).mtimeMs < sinceMs) continue;
    const runs = findNonAsciiRuns(readFileSync(path));
    if (runs.length > 0) failures.push({ name, runs });
  }
  if (failures.length === 0) return;
  const lines = failures.flatMap(({ name, runs }) =>
    runs.map(({ offset, context }) => `  ${name} @${offset}: ${context}`),
  );
  throw new Error(
    'Server bundles must be ASCII: one non-ASCII byte makes V8 hold the whole ' +
      'loaded source as UTF-16. Write these characters as \\u escapes in the ' +
      `source (scripts/lib/server-bundle-ascii.mjs):\n${lines.join('\n')}`,
  );
}
