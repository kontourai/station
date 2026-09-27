import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { mergeCoverageCorpus } from '../merge-coverage-shards.mjs';
import {
  COVERAGE_SHARD_DIRECTORY,
  COVERAGE_SHARD_REPORT,
  coverageShardIds,
} from '../run-coverage-corpus.mjs';

const THRESHOLDS = { lines: 75, statements: 75, functions: 75, branches: 75 };

const location = (line: number) => ({
  start: { line, column: 0 },
  end: { line, column: 10 },
});

function fileCoverage(
  path: string,
  hits: { s: [number, number]; f: [number]; b: [number, number] },
) {
  return {
    path,
    statementMap: { 0: location(1), 1: location(2) },
    fnMap: {
      0: { name: 'f', decl: location(1), loc: location(1), line: 1 },
    },
    branchMap: {
      0: {
        loc: location(2),
        type: 'if',
        locations: [location(2), location(2)],
        line: 2,
      },
    },
    s: { 0: hits.s[0], 1: hits.s[1] },
    f: { 0: hits.f[0] },
    b: { 0: [...hits.b] },
  };
}

function fullCoverage(id: string) {
  return {
    [`/src/${id}.ts`]: fileCoverage(`/src/${id}.ts`, {
      s: [1, 1],
      f: [1],
      b: [1, 1],
    }),
  };
}

const makeTempDir = trackTempDirs();
function tempRoot() {
  return makeTempDir('station-merge-coverage-shards-');
}

function writeShard(shardRoot: string, id: string, data: unknown) {
  mkdirSync(join(shardRoot, id), { recursive: true });
  writeFileSync(
    join(shardRoot, id, COVERAGE_SHARD_REPORT),
    JSON.stringify(data),
  );
}

describe('hosted coverage merge job (#2416)', () => {
  it('merges every uploaded shard and evaluates thresholds, running no corpus of its own', async () => {
    const root = tempRoot();
    const ids = coverageShardIds();
    ids.forEach((id) =>
      writeShard(join(root, COVERAGE_SHARD_DIRECTORY), id, fullCoverage(id)),
    );
    const result = await mergeCoverageCorpus({
      root,
      loadThresholds: async () => THRESHOLDS,
      log: () => {},
    });
    expect(result.mergeError).toBeNull();
    expect(result.thresholds?.passed).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('fails closed when a shard artifact never arrived, naming it', async () => {
    const root = tempRoot();
    const ids = coverageShardIds();
    const missing = ids[0];
    ids
      .filter((id) => id !== missing)
      .forEach((id) =>
        writeShard(join(root, COVERAGE_SHARD_DIRECTORY), id, fullCoverage(id)),
      );
    const lines: string[] = [];
    const result = await mergeCoverageCorpus({
      root,
      loadThresholds: async () => THRESHOLDS,
      log: (line) => lines.push(line),
    });
    expect(result.mergeError).toMatch(new RegExp(`slice ${missing}: missing`));
    expect(result.thresholds).toBeNull();
    expect(result.passed).toBe(false);
    expect(lines.at(-1)).toMatch(
      /FAIL: merge refused; thresholds not evaluated/,
    );
  });
});
