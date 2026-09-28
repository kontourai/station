/**
 * #2377 C2b review, the structural half of
 * `body-read-deadline-coverage.test.ts` (a structural rule, proved
 * structurally): every catch in the SDK source around a response-body read
 * that does not also cover the request starts with `rethrowDeadline(...)`,
 * and every body reader chained with `.catch` goes through
 * `unlessDeadline(...)`. A new helper written the old way fails here by name.
 * It walks the SDK source tree, so it runs as a repo scan
 * (`REPO_SCAN_SUITES`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../', import.meta.url).pathname;
const READ = /\.(json|text|arrayBuffer|blob|formData|bytes)\(\)/;
const ISSUES =
  /\b(getJson|mutateJson|request|fetch|authenticatedFetch|postJson)\(/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === '__tests__' ? [] : sources(path);
    return /\.tsx?$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** The text between a `{` at `open` and its matching `}`. */
function block(source: string, open: number): { body: string; end: number } {
  let depth = 1;
  let index = open + 1;
  while (depth > 0 && index < source.length) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    index += 1;
  }
  return { body: source.slice(open + 1, index - 1), end: index };
}

interface Site {
  where: string;
  guarded: boolean;
}

function bodyReadCatches(): Site[] {
  const sites: Site[] = [];
  for (const file of sources(SRC)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/try \{/g)) {
      const tryBlock = block(source, match.index! + match[0].length - 1);
      const handler = /^\s*catch\s*(\((\w+)\))?\s*\{/.exec(
        source.slice(tryBlock.end, tryBlock.end + 80),
      );
      if (!handler) continue;
      if (!READ.test(tryBlock.body) || ISSUES.test(tryBlock.body)) continue;
      const catchOpen = tryBlock.end + handler[0].length - 1;
      const catchBody = block(source, catchOpen).body;
      const first = catchBody.trim().split('\n')[0] ?? '';
      const line = source.slice(0, match.index).split('\n').length;
      sites.push({
        where: `${relative(SRC, file)}:${line}`,
        guarded:
          handler[2] !== undefined &&
          first.startsWith(`rethrowDeadline(${handler[2]});`),
      });
    }
    for (const match of source.matchAll(
      /\.(?:json|text|arrayBuffer|blob|formData|bytes)\(\)\s*\.catch\(/g,
    )) {
      const line = source.slice(0, match.index).split('\n').length;
      const after = source.slice(match.index! + match[0].length).trimStart();
      sites.push({
        where: `${relative(SRC, file)}:${line} (.catch)`,
        guarded: after.startsWith('unlessDeadline('),
      });
    }
  }
  return sites;
}

describe('every SDK body-read catch passes a deadline on', () => {
  it('holds every catch around a body read to the shared guard', () => {
    const sites = bodyReadCatches();
    // Anchor: the scan really finds the unwrap helpers (a broken scan that
    // finds nothing must not pass).
    expect(sites.length).toBeGreaterThanOrEqual(40);
    expect(
      sites.filter((site) => !site.guarded).map((site) => site.where),
    ).toEqual([]);
  });
});
