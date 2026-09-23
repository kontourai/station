import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import config from '../../vitest.config';
import {
  COVERAGE_SHARD_DIRECTORY,
  COVERAGE_SHARD_REPORT,
  COVERAGE_SLICE_TIMEOUT_SCALE,
  CoverageMergeRefused,
  coverageShardIds,
  evaluateCoverageThresholds,
  loadCoverageThresholds,
  mergeCoverageShards,
  runCoverageCorpus,
  validateCoverageThresholds,
} from '../run-coverage-corpus.mjs';
import {
  buildVitestCommand,
  corpusDescriptors,
  descriptorFiles,
  ORDINARY_SHARD_COUNT,
  VITEST_CORPUS_GROUP_NAMES,
} from '../run-vitest-corpus.mjs';

const THRESHOLDS = { lines: 75, statements: 75, functions: 75, branches: 75 };

const location = (line: number) => ({
  start: { line, column: 0 },
  end: { line, column: 10 },
});

/** One istanbul file record with two statements, one function, one branch. */
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

const roots: string[] = [];
function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'station-coverage-corpus-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function writeShard(shardRoot: string, id: string, data: unknown) {
  mkdirSync(join(shardRoot, id), { recursive: true });
  writeFileSync(
    join(shardRoot, id, COVERAGE_SHARD_REPORT),
    typeof data === 'string' ? data : JSON.stringify(data),
  );
}

// Each slice alone covers half of the file; together they cover all of it.
function halfCoverage(id: string, index: number) {
  return {
    '/src/a.ts': fileCoverage('/src/a.ts', {
      s: index % 2 === 0 ? [1, 0] : [0, 1],
      f: [index % 2 === 0 ? 1 : 0],
      b: index % 2 === 0 ? [1, 0] : [0, 1],
    }),
    [`/src/${id}.ts`]: fileCoverage(`/src/${id}.ts`, {
      s: [1, 1],
      f: [1],
      b: [1, 1],
    }),
  };
}

describe('coverage shard plan', () => {
  it('names every corpus slice exactly once, in corpus order', () => {
    const ids = coverageShardIds();
    const descriptors = corpusDescriptors();
    expect(ids).toEqual(
      descriptors.map((descriptor) => descriptor.resultName ?? descriptor.name),
    );
    expect(new Set(ids).size).toBe(ids.length);
    // All eight ordinary hash shards, each once.
    expect(ids.filter((id) => id.startsWith('ordinary-'))).toEqual(
      Array.from(
        { length: ORDINARY_SHARD_COUNT },
        (_, index) => `ordinary-${index + 1}-of-${ORDINARY_SHARD_COUNT}`,
      ),
    );
    // Every other resource group, whole, once: a new group joins the plan
    // through the corpus runner or this fails.
    expect(ids.filter((id) => !id.startsWith('ordinary-'))).toEqual(
      VITEST_CORPUS_GROUP_NAMES.filter((name) => name !== 'ordinary'),
    );
    expect(() =>
      coverageShardIds([{ name: 'shared-output' }, { name: 'shared-output' }]),
    ).toThrow(/more than once/);
    expect(() => coverageShardIds([])).toThrow(/no slices/);
  });

  it('reaches every corpus file through exactly one slice', () => {
    const groups = {
      ordinary: ['o-1.test.ts', 'o-2.test.ts', 'o-3.test.ts'],
      processHeavy: ['h-1.test.ts', 'h-2.test.ts'],
      processExclusive: ['x.test.ts'],
      coordinatorExclusive: ['c.test.ts'],
      credentialLedgerExclusive: ['l.test.ts'],
      sharedOutput: ['s.test.ts'],
      dogfoodReconcile: ['scripts/__tests__/station-dogfood-reconcile.test.ts'],
    };
    const descriptors = corpusDescriptors();
    const ordinary = descriptors.filter(({ name }) => name === 'ordinary');
    const others = descriptors.filter(({ name }) => name !== 'ordinary');

    // Serialized groups receive explicit file lists: disjoint and exhaustive.
    const explicit = others.flatMap((descriptor) =>
      descriptorFiles(groups, descriptor),
    );
    expect(new Set(explicit).size).toBe(explicit.length);
    expect([...explicit].sort()).toEqual(
      Object.entries(groups)
        .filter(([key]) => key !== 'ordinary')
        .flatMap(([, files]) => files)
        .sort(),
    );

    // Ordinary shards are one command differing only in Vitest's own
    // exhaustive hash split, with k running over 1..n exactly once.
    const commands = ordinary.map((descriptor) =>
      buildVitestCommand(descriptor, groups.ordinary, {
        coverageDirectory: '/cov',
      }),
    );
    const withoutShard = commands.map((command) =>
      command.filter((argument) => !argument.startsWith('--shard=')),
    );
    for (const command of withoutShard)
      expect(command).toEqual(withoutShard[0]);
    expect(
      commands.map((command) =>
        command.find((argument) => argument.startsWith('--shard=')),
      ),
    ).toEqual(
      Array.from(
        { length: ORDINARY_SHARD_COUNT },
        (_, index) => `--shard=${index + 1}/${ORDINARY_SHARD_COUNT}`,
      ),
    );
  });
});

describe('coverage merge', () => {
  it('merges every expected slice, adding hit counts', async () => {
    const shardRoot = join(tempRoot(), 'shards');
    const ids = ['one', 'two'];
    ids.forEach((id, index) =>
      writeShard(shardRoot, id, halfCoverage(id, index)),
    );
    const map = await mergeCoverageShards({ shardRoot, shardIds: ids });
    expect(map.files().sort()).toEqual([
      '/src/a.ts',
      '/src/one.ts',
      '/src/two.ts',
    ]);
    expect(map.fileCoverageFor('/src/a.ts').toJSON().s).toEqual({ 0: 1, 1: 1 });
    expect(map.getCoverageSummary().statements.pct).toBe(100);
  });

  it('refuses when a slice is missing, naming every absent slice', async () => {
    const shardRoot = join(tempRoot(), 'shards');
    writeShard(shardRoot, 'one', halfCoverage('one', 0));
    const refused = mergeCoverageShards({
      shardRoot,
      shardIds: ['one', 'two', 'three'],
    });
    await expect(refused).rejects.toBeInstanceOf(CoverageMergeRefused);
    await expect(refused).rejects.toThrow(/slice two: missing/);
    await expect(refused).rejects.toThrow(/slice three: missing/);
  });

  it('refuses when no slice directory exists at all', async () => {
    await expect(
      mergeCoverageShards({
        shardRoot: join(tempRoot(), 'absent'),
        shardIds: ['one'],
      }),
    ).rejects.toThrow(/slice one: missing/);
    await expect(
      mergeCoverageShards({ shardRoot: tempRoot(), shardIds: [] }),
    ).rejects.toThrow(/no slices expected/);
  });

  it('refuses an empty, malformed, or non-istanbul slice', async () => {
    const shardRoot = join(tempRoot(), 'shards');
    writeShard(shardRoot, 'empty', {});
    writeShard(shardRoot, 'truncated', '{"/src/a.ts": {');
    writeShard(shardRoot, 'array', []);
    writeShard(shardRoot, 'shapeless', { '/src/a.ts': { path: '/src/a.ts' } });
    writeShard(shardRoot, 'good', halfCoverage('good', 0));
    const refused = mergeCoverageShards({
      shardRoot,
      shardIds: ['empty', 'truncated', 'array', 'shapeless', 'good'],
    });
    await expect(refused).rejects.toThrow(/slice empty: report is empty/);
    await expect(refused).rejects.toThrow(/slice truncated: invalid JSON/);
    await expect(refused).rejects.toThrow(
      /slice array: report is not an istanbul coverage object/,
    );
    await expect(refused).rejects.toThrow(/slice shapeless: entry .* lacks/);
  });

  it('refuses a slice directory the plan does not name', async () => {
    const shardRoot = join(tempRoot(), 'shards');
    writeShard(shardRoot, 'one', halfCoverage('one', 0));
    writeShard(shardRoot, 'ordinary-1-of-4', halfCoverage('stale', 1));
    await expect(
      mergeCoverageShards({ shardRoot, shardIds: ['one'] }),
    ).rejects.toThrow(/unexpected entry ordinary-1-of-4/);
  });
});

describe('coverage thresholds', () => {
  it('passes on the merged report even when no slice meets them alone', async () => {
    const ids = ['one', 'two'];
    const slice = (id: string, index: number) => ({
      '/src/a.ts': halfCoverage(id, index)['/src/a.ts'],
    });
    for (const [index, id] of ids.entries()) {
      const alone = join(tempRoot(), 'alone');
      writeShard(alone, id, slice(id, index));
      const map = await mergeCoverageShards({
        shardRoot: alone,
        shardIds: [id],
      });
      const result = evaluateCoverageThresholds(
        map.getCoverageSummary().toJSON(),
        THRESHOLDS,
      );
      expect(result.passed, id).toBe(false);
    }
    const shardRoot = join(tempRoot(), 'shards');
    ids.forEach((id, index) => writeShard(shardRoot, id, slice(id, index)));
    const merged = await mergeCoverageShards({ shardRoot, shardIds: ids });
    const result = evaluateCoverageThresholds(
      merged.getCoverageSummary().toJSON(),
      THRESHOLDS,
    );
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('fails a metric below its threshold and one that measured nothing', () => {
    const result = evaluateCoverageThresholds(
      {
        lines: { total: 10, covered: 9, pct: 90 },
        statements: { total: 10, covered: 5, pct: 50 },
        functions: { total: 0, covered: 0, pct: 100 },
        branches: { total: 4, covered: 3, pct: 75 },
      },
      THRESHOLDS,
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      'statements: 50% does not meet the 75% threshold',
      'functions: nothing measured in the merged report',
    ]);
  });

  it('requires all four thresholds and reads them from the Vitest config', async () => {
    expect(() =>
      validateCoverageThresholds({ lines: 30, statements: 30, functions: 50 }),
    ).toThrow(/branches/);
    expect(() => validateCoverageThresholds(undefined)).toThrow(/lines/);
    expect(await loadCoverageThresholds()).toEqual(
      validateCoverageThresholds(config.test?.coverage?.thresholds),
    );
  });
});

describe('coverage corpus run', () => {
  function planWriter(root: string, ids: readonly string[], skip?: string) {
    return async (options: {
      coverageRoot: string;
      keepGoing: boolean;
      timeoutScale: number;
    }) => {
      expect(options.coverageRoot).toBe(join(root, COVERAGE_SHARD_DIRECTORY));
      expect(options.keepGoing).toBe(true);
      expect(options.timeoutScale).toBe(COVERAGE_SLICE_TIMEOUT_SCALE);
      ids.forEach((id, index) => {
        if (id !== skip)
          writeShard(options.coverageRoot, id, halfCoverage(id, index));
      });
      return { passed: true, results: [] };
    };
  }

  it('evaluates thresholds on the merged report of every slice', async () => {
    const root = tempRoot();
    const ids = coverageShardIds();
    const result = await runCoverageCorpus({
      root,
      runCorpus: planWriter(root, ids) as never,
      loadThresholds: async () => THRESHOLDS,
      log: () => {},
    });
    expect(result.mergeError).toBeNull();
    expect(result.thresholds?.passed).toBe(true);
    expect(result.passed).toBe(true);

    const strict = await runCoverageCorpus({
      root,
      runCorpus: planWriter(root, ids) as never,
      loadThresholds: async () => ({
        ...THRESHOLDS,
        statements: 100,
        lines: 100,
      }),
      log: () => {},
    });
    // The per-slice files are all fully covered; `/src/a.ts` is complete
    // only once the slices are merged, so 100% is met on the merge alone.
    expect(strict.thresholds?.passed).toBe(true);
    expect(strict.passed).toBe(true);
  });

  it('fails when a slice left no report, even though the corpus passed', async () => {
    const root = tempRoot();
    const ids = coverageShardIds();
    const lines: string[] = [];
    const result = await runCoverageCorpus({
      root,
      runCorpus: planWriter(root, ids, 'process-heavy') as never,
      loadThresholds: async () => THRESHOLDS,
      log: (line) => lines.push(line),
    });
    expect(result.corpus.passed).toBe(true);
    expect(result.mergeError).toMatch(/slice process-heavy: missing/);
    expect(result.thresholds).toBeNull();
    expect(result.passed).toBe(false);
    expect(lines.at(-1)).toMatch(
      /FAIL: .*merge refused; thresholds not evaluated/,
    );
  });

  it('never lets a previous run stand in for a slice', async () => {
    const root = tempRoot();
    const ids = coverageShardIds();
    ids.forEach((id, index) =>
      writeShard(
        join(root, COVERAGE_SHARD_DIRECTORY),
        id,
        halfCoverage(id, index),
      ),
    );
    const result = await runCoverageCorpus({
      root,
      runCorpus: (async () => ({ passed: true, results: [] })) as never,
      loadThresholds: async () => THRESHOLDS,
      log: () => {},
    });
    expect(result.mergeError).toMatch(new RegExp(`slice ${ids[0]}: missing`));
    expect(result.passed).toBe(false);
  });

  it('fails when the corpus failed even if every slice reported', async () => {
    const root = tempRoot();
    const ids = coverageShardIds();
    const result = await runCoverageCorpus({
      root,
      runCorpus: (async (options: { coverageRoot: string }) => {
        ids.forEach((id, index) =>
          writeShard(options.coverageRoot, id, halfCoverage(id, index)),
        );
        return { passed: false, results: [] };
      }) as never,
      loadThresholds: async () => THRESHOLDS,
      log: () => {},
    });
    expect(result.thresholds?.passed).toBe(true);
    expect(result.passed).toBe(false);
  });
});
