import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { collectRepositoryIdentity } from '../lib/test-reliability.mjs';
import {
  executeTransferComparison,
  missingBaselineRootMessage,
  policyAttribution,
  runTransferCapture,
  runTransferGate,
  suggestedBaselineRoot,
  TRANSFER_BASELINE_ROOT_ENV,
  TRANSFER_CAPTURE_LIVENESS_TIMEOUT_MS,
  TRANSFER_CAPTURE_TIMEOUT_ENV,
  transferCaptureLivenessTimeoutMs,
  transferGitEnvironment,
  withTransferGitEnvironment,
} from '../orchestration-transfer-gate.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    // Temp fixtures are owned by this test process and cleaned by the OS when
    // the suite exits; no repository baseline or dependency tree is touched.
    void root;
  }
});

const sha = (char: string) => char.repeat(40);
const phases = () =>
  ['external-engine', 'station-native'].flatMap((scenario) =>
    ['initialEventWindow', 'snapshot', 'live', 'shortReplay', 'fallback'].map(
      (name) => ({
        scenario,
        name,
        wireBytes: 1,
        decodedBytes: 1,
        frames: name === 'initialEventWindow' ? 0 : 1,
        contentEncoding: 'identity',
        compressionRatio: null,
        complete: true,
      }),
    ),
  );

function report(subjectSha: string, baseSha: string) {
  return {
    schemaVersion: 1,
    subjectSha,
    baseSha,
    dirty: false,
    fixtureDigest: 'a'.repeat(64),
    toolDigest: 'b'.repeat(64),
    node: 'v24',
    platform: 'darwin',
    arch: 'arm64',
    phases: phases(),
  };
}

function provenance(identity: string) {
  return {
    headSha: identity,
    dirty: false,
    workspaceDigest: identity,
    dependencyDigest: identity,
    toolchain: identity,
    toolchainIdentity: { identity },
    environmentDigest: identity,
  };
}

function git(root: string, args: string[]) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function twoRootGitFixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-transfer-git-roots-'));
  roots.push(root);
  const candidate = join(root, 'candidate');
  const baseline = join(root, 'baseline');
  git(root, ['init', candidate]);
  git(candidate, ['config', 'user.email', 'transfer-gate@example.test']);
  git(candidate, ['config', 'user.name', 'Transfer gate test']);
  writeFileSync(join(candidate, 'subject.txt'), 'baseline\n');
  git(candidate, ['add', 'subject.txt']);
  git(candidate, ['commit', '-m', 'baseline']);
  const baselineSha = git(candidate, ['rev-parse', 'HEAD']);
  writeFileSync(join(candidate, 'subject.txt'), 'candidate\n');
  git(candidate, ['commit', '-am', 'candidate']);
  const candidateSha = git(candidate, ['rev-parse', 'HEAD']);
  git(root, ['clone', candidate, baseline]);
  git(baseline, ['checkout', '--detach', baselineSha]);
  return { candidate, baseline, baselineSha, candidateSha };
}

function run(overrides: Record<string, unknown> = {}) {
  const outputDir = mkdtempSync(join(tmpdir(), 'station-transfer-gate-'));
  roots.push(outputDir);
  const baseSha = sha('a');
  const candidateSha = sha('b');
  const calls: unknown[] = [];
  const capture = (input: any) => {
    calls.push(input);
    return input.targetRoot === 'candidate'
      ? report(candidateSha, baseSha)
      : report(baseSha, baseSha);
  };
  const result = executeTransferComparison({
    candidateRoot: 'candidate',
    baselineRoot: 'baseline',
    outputDir,
    baseSha,
    candidateSha,
    capture,
    readPolicy: () => ({
      policy: Object.fromEntries(
        [
          'initialEventWindow',
          'snapshot',
          'live',
          'shortReplay',
          'fallback',
        ].map((name) => [name, { wireBytes: 2, decodedBytes: 2, frames: 2 }]),
      ),
    }),
    beforeCandidate: provenance('candidate'),
    beforeBaseline: provenance('baseline'),
    readProvenance: (root: string) => provenance(root),
    assertRoot() {},
    attribute: () => ({ kind: 'INTRODUCTION' }),
    ...overrides,
  } as any);
  return { calls, outputDir, result };
}

describe('orchestration transfer gate control flow', () => {
  test('scrubs inherited hook git location before selecting a baseline', () => {
    const env = transferGitEnvironment({
      GIT_DIR: '/candidate/.git',
      GIT_WORK_TREE: '/candidate',
      GIT_INDEX_FILE: '/candidate/index',
      GIT_COMMON_DIR: '/candidate/common',
    });
    expect((env as any).GIT_DIR).toBeUndefined();
    expect((env as any).GIT_WORK_TREE).toBeUndefined();
    expect((env as any).GIT_INDEX_FILE).toBeUndefined();
    expect((env as any).GIT_COMMON_DIR).toBeUndefined();
    expect((env as any).GIT_OBJECT_DIRECTORY).toBeUndefined();
    expect((env as any).GIT_ALTERNATE_OBJECT_DIRECTORIES).toBeUndefined();
    expect((env as any).GIT_CONFIG_PARAMETERS).toBeUndefined();
  });

  test('restores numbered hook config variables after success and failure', () => {
    const prior = process.env.GIT_CONFIG_KEY_0;
    try {
      process.env.GIT_CONFIG_KEY_0 = 'core.worktree';
      expect(
        withTransferGitEnvironment(() => process.env.GIT_CONFIG_KEY_0),
      ).toBeUndefined();
      expect(process.env.GIT_CONFIG_KEY_0).toBe('core.worktree');
      expect(() =>
        withTransferGitEnvironment(() => {
          throw new Error('probe');
        }),
      ).toThrow('probe');
      expect(process.env.GIT_CONFIG_KEY_0).toBe('core.worktree');
    } finally {
      if (prior === undefined) delete process.env.GIT_CONFIG_KEY_0;
      else process.env.GIT_CONFIG_KEY_0 = prior;
    }
  });

  test('uses the intended baseline for real git provenance and capture despite hostile hook state', () => {
    const { candidate, baseline, baselineSha, candidateSha } =
      twoRootGitFixture();
    expect(baselineSha).not.toBe(candidateSha);
    const keys = [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_COMMON_DIR',
      'GIT_CONFIG',
      'GIT_CONFIG_PARAMETERS',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
    ];
    const prior = Object.fromEntries(
      keys.map((key) => [key, process.env[key]]),
    );
    const hostile = {
      GIT_DIR: join(candidate, '.git'),
      GIT_WORK_TREE: candidate,
      GIT_INDEX_FILE: join(candidate, 'hostile-index'),
      GIT_COMMON_DIR: join(candidate, '.git'),
      GIT_CONFIG: join(candidate, 'hostile-config'),
      GIT_CONFIG_PARAMETERS: "'core.abbrev=7'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.worktree',
      GIT_CONFIG_VALUE_0: candidate,
    };
    Object.assign(process.env, hostile);
    try {
      withTransferGitEnvironment(() => {
        const identity = collectRepositoryIdentity({ cwd: baseline });
        expect(identity.worktree).toBe(realpathSync(baseline));
        expect(git(baseline, ['rev-parse', 'HEAD'])).toBe(baselineSha);
        const output = join(baseline, 'capture.json');
        const captured = runTransferCapture({
          candidateRoot: resolve(import.meta.dirname, '../..'),
          targetRoot: baseline,
          output,
          baseSha: baselineSha,
          spawn: ((
            _command: string,
            args: string[],
            options: { env: Record<string, string | undefined> },
          ) => {
            expect(args).toContain(baseline);
            for (const key of keys) expect(options.env[key]).toBeUndefined();
            writeFileSync(
              output,
              JSON.stringify(report(baselineSha, baselineSha)),
            );
            return { status: 0, stdout: '', stderr: '' };
          }) as any,
        });
        expect(captured.subjectSha).toBe(baselineSha);
      });
      expect(
        Object.fromEntries(keys.map((key) => [key, process.env[key]])),
      ).toEqual(hostile);
      expect(() =>
        withTransferGitEnvironment(() => {
          throw new Error('probe');
        }),
      ).toThrow('probe');
      expect(
        Object.fromEntries(keys.map((key) => [key, process.env[key]])),
      ).toEqual(hostile);
    } finally {
      for (const key of keys) {
        if (prior[key] === undefined) delete process.env[key];
        else process.env[key] = prior[key];
      }
    }
  });
  test('fails a capture liveness timeout instead of waiting indefinitely, naming the override', () => {
    expect(TRANSFER_CAPTURE_LIVENESS_TIMEOUT_MS).toBe(60_000);
    let spawnedTimeout: unknown;
    expect(() =>
      runTransferCapture({
        candidateRoot: resolve(import.meta.dirname, '../..'),
        targetRoot: '/fixture-target',
        output: '/fixture-output.json',
        baseSha: sha('a'),
        spawn: (_command: string, _args: string[], options: any) => {
          spawnedTimeout = options.timeout;
          return {
            status: null,
            error: { code: 'ETIMEDOUT' },
            stdout: '',
            stderr: '',
          };
        },
      } as any),
    ).toThrow(
      new RegExp(
        `capture liveness timeout after ${TRANSFER_CAPTURE_LIVENESS_TIMEOUT_MS}ms.*${TRANSFER_CAPTURE_TIMEOUT_ENV}`,
      ),
    );
    expect(spawnedTimeout).toBe(TRANSFER_CAPTURE_LIVENESS_TIMEOUT_MS);
  });

  test('#1279: the liveness bound is overridable from the environment, finite, and reaches the child', () => {
    expect(transferCaptureLivenessTimeoutMs({})).toBe(
      TRANSFER_CAPTURE_LIVENESS_TIMEOUT_MS,
    );
    expect(
      transferCaptureLivenessTimeoutMs({ [TRANSFER_CAPTURE_TIMEOUT_ENV]: '' }),
    ).toBe(TRANSFER_CAPTURE_LIVENESS_TIMEOUT_MS);
    expect(
      transferCaptureLivenessTimeoutMs({
        [TRANSFER_CAPTURE_TIMEOUT_ENV]: ' 180000 ',
      }),
    ).toBe(180_000);
    for (const rejected of ['0', '-5', '1.5', 'abc', 'Infinity', 'NaN'])
      expect(() =>
        transferCaptureLivenessTimeoutMs({
          [TRANSFER_CAPTURE_TIMEOUT_ENV]: rejected,
        }),
      ).toThrow(`${TRANSFER_CAPTURE_TIMEOUT_ENV} must be a positive integer`);

    const prior = process.env[TRANSFER_CAPTURE_TIMEOUT_ENV];
    process.env[TRANSFER_CAPTURE_TIMEOUT_ENV] = '180000';
    try {
      let spawnedTimeout: unknown;
      expect(() =>
        runTransferCapture({
          candidateRoot: resolve(import.meta.dirname, '../..'),
          targetRoot: '/fixture-target',
          output: '/fixture-output.json',
          baseSha: sha('a'),
          spawn: (_command: string, _args: string[], options: any) => {
            spawnedTimeout = options.timeout;
            return {
              status: null,
              error: { code: 'ETIMEDOUT' },
              stdout: '',
              stderr: '',
            };
          },
        } as any),
      ).toThrow('capture liveness timeout after 180000ms');
      expect(spawnedTimeout).toBe(180_000);
    } finally {
      if (prior === undefined) delete process.env[TRANSFER_CAPTURE_TIMEOUT_ENV];
      else process.env[TRANSFER_CAPTURE_TIMEOUT_ENV] = prior;
    }
  });

  test('#1279: a missing baseline root names the env var the pre-push path reads', () => {
    const { candidate, baselineSha } = twoRootGitFixture();
    const prior = process.env[TRANSFER_BASELINE_ROOT_ENV];
    delete process.env[TRANSFER_BASELINE_ROOT_ENV];
    try {
      let message = '';
      try {
        runTransferGate({
          candidateRoot: candidate,
          baselineRoot: '',
          base: baselineSha,
          outputDir: '.kontourai/orchestration-transfer-gate',
          prepareBaseline: false,
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toBe(
        `orchestration transfer gate: ${missingBaselineRootMessage(baselineSha, candidate)}`,
      );
      expect(message).toContain(
        `${TRANSFER_BASELINE_ROOT_ENV}=${suggestedBaselineRoot(candidate, baselineSha)}`,
      );
      expect(message).toContain('--prepare-baseline');
      expect(message).toContain('npm run dependencies:ci');
      expect(message).toContain('npm run dependencies:verify');
      expect(message).toContain(baselineSha);
    } finally {
      if (prior !== undefined) process.env[TRANSFER_BASELINE_ROOT_ENV] = prior;
    }
  });

  test('#1279: suggests a sibling baseline for a lane worktree, not a nested station-worktrees', () => {
    const base = sha('c');
    expect(
      suggestedBaselineRoot('/work/station-worktrees/1279-lane', base),
    ).toBe(
      resolve(
        '/work/station-worktrees',
        `4294-transfer-baseline-${base.slice(0, 12)}`,
      ),
    );
    expect(suggestedBaselineRoot('/work/station', base)).toBe(
      resolve(
        '/work/station-worktrees',
        `4294-transfer-baseline-${base.slice(0, 12)}`,
      ),
    );
  });

  test('captures baseline modules after the candidate removes a contracts export', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-transfer-resolution-'));
    roots.push(root);
    const candidate = join(root, 'candidate');
    const baseline = join(root, 'baseline');
    const output = join(root, 'capture.json');
    for (const subject of [candidate, baseline]) {
      mkdirSync(join(subject, 'node_modules', '@kontourai'), {
        recursive: true,
      });
      mkdirSync(join(subject, 'packages', 'contracts'), { recursive: true });
      writeFileSync(join(subject, 'package.json'), '{"type":"module"}\n');
      writeFileSync(
        join(subject, 'packages', 'contracts', 'package.json'),
        '{"name":"@kontourai/station-contracts","type":"module","exports":{"./agent-identity":"./agent-identity.ts"}}\n',
      );
      symlinkSync(
        '../../packages/contracts',
        join(subject, 'node_modules', '@kontourai', 'station-contracts'),
      );
    }
    writeFileSync(
      join(baseline, 'packages', 'contracts', 'agent-identity.ts'),
      "export const engineRuntimeId = 'baseline-runtime';\n",
    );
    writeFileSync(
      join(candidate, 'packages', 'contracts', 'agent-identity.ts'),
      "export const replacementRuntimeId = 'candidate-runtime';\n",
    );
    mkdirSync(join(candidate, 'src'), { recursive: true });
    writeFileSync(
      join(candidate, 'src', 'tool.ts'),
      "export { replacementRuntimeId } from '@kontourai/station-contracts/agent-identity';\n",
    );
    mkdirSync(join(baseline, 'src'), { recursive: true });
    writeFileSync(
      join(baseline, 'src', 'baseline.ts'),
      "export { engineRuntimeId } from '@kontourai/station-contracts/agent-identity';\n",
    );
    mkdirSync(join(candidate, 'scripts'), { recursive: true });
    writeFileSync(
      join(candidate, 'tsconfig.json'),
      '{"compilerOptions":{"paths":{"@kontourai/station-contracts/*":["./packages/contracts/*"]}}}\n',
    );
    writeFileSync(
      join(
        candidate,
        'scripts',
        'orchestration-transfer-capture.tsconfig.json',
      ),
      '{"extends":"../tsconfig.json","compilerOptions":{"paths":{}}}\n',
    );
    const capture = join(candidate, 'scripts', 'capture.ts');
    writeFileSync(
      capture,
      `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const targetRoot = process.argv[2];
const output = process.argv[3];
const loaded = await import(pathToFileURL(join(targetRoot, 'src/baseline.ts')).href);
const tool = await import(pathToFileURL(join(import.meta.dirname, '../src/tool.ts')).href);
writeFileSync(output, JSON.stringify({
  engineRuntimeId: loaded.engineRuntimeId,
  replacementRuntimeId: tool.replacementRuntimeId,
}));
`,
    );
    mkdirSync(join(candidate, 'node_modules'), { recursive: true });
    symlinkSync(
      resolve(import.meta.dirname, '../../node_modules/tsx'),
      join(candidate, 'node_modules', 'tsx'),
    );

    expect(
      runTransferCapture({
        candidateRoot: candidate,
        targetRoot: baseline,
        output,
        baseSha: sha('a'),
        capture,
        spawn: ((command: string, args: string[], options: object) =>
          spawnSync(
            command,
            ['--import', 'tsx', ...args.slice(1)],
            options,
          )) as any,
      } as any),
    ).toEqual({
      engineRuntimeId: 'baseline-runtime',
      replacementRuntimeId: 'candidate-runtime',
    });
  });

  test('identifies dependency resolution failures without prepare advice', () => {
    expect(() =>
      runTransferCapture({
        candidateRoot: resolve(import.meta.dirname, '../..'),
        targetRoot: '/fixture-target',
        output: '/fixture-output.json',
        baseSha: sha('a'),
        spawn: () => ({
          status: 1,
          stdout: '',
          stderr: "does not provide an export named 'engineRuntimeId'",
        }),
      } as any),
    ).toThrow(
      /dependency resolution failed.*preparing the baseline again will not repair/,
    );
  });

  test('guides baseline setup through the approved lifecycle, never raw npm ci', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../orchestration-transfer-gate.mjs'),
      'utf8',
    );
    expect(source).toContain('npm run dependencies:ci');
    expect(source).toContain('npm run dependencies:verify');
    expect(source).toContain('windowsHide: true');
  });

  test('attributes only typed changed ceilings against real capture rows', () => {
    const prior = {
      policy: { snapshot: { wireBytes: 2, decodedBytes: 2, frames: 1 } },
    };
    const envelope = {
      policy: { snapshot: { wireBytes: 2, decodedBytes: 2, frames: 2 } },
    };
    const baseline = report(sha('a'), sha('a'));
    const candidate = report(sha('b'), sha('a'));
    const common = {
      candidateRoot: '/fixture',
      baseSha: sha('a'),
      envelope,
      baseline,
      candidate,
      readBase: () => JSON.stringify(prior),
      exists: () => true,
    };
    expect(() =>
      policyAttribution({
        ...common,
        read: () =>
          JSON.stringify({
            issue: 'station#4294',
            author: '',
            reason: '',
            priorPolicyDigest: 'wrong',
            newPolicyDigest: 'wrong',
            actualMetrics: [null],
          }),
      } as any),
    ).toThrow('policy attribution does not match');
    const good = policyAttribution({
      ...common,
      read: () => {
        const priorPolicyDigest = createHash('sha256')
          .update(JSON.stringify(prior))
          .digest('hex');
        const newPolicyDigest = createHash('sha256')
          .update(JSON.stringify(envelope))
          .digest('hex');
        return JSON.stringify({
          issue: 'station#4294',
          author: 'Station security',
          reason: 'Measured fixture envelope update.',
          priorPolicyDigest,
          newPolicyDigest,
          actualMetrics: ['external-engine', 'station-native'].map(
            (scenario) => ({
              scenario,
              name: 'snapshot',
              metric: 'frames',
              before: 1,
              after: 2,
              baseline: 1,
              candidate: 1,
            }),
          ),
        });
      },
    } as any);
    expect(good.kind).toBe('ATTRIBUTED');
  });

  test('treats only an absent policy path as introduction', () => {
    const common = {
      candidateRoot: '/fixture',
      baseSha: sha('a'),
      envelope: { policy: {} },
      baseline: report(sha('a'), sha('a')),
      candidate: report(sha('b'), sha('a')),
    };
    expect(
      policyAttribution({
        ...common,
        readBase: () => {
          throw { stderr: 'fatal: path x does not exist in deadbeef' };
        },
      } as any).kind,
    ).toBe('INTRODUCTION');
    expect(
      policyAttribution({
        ...common,
        readBase: () => {
          throw { stderr: 'fatal: path x exists on disk, but not in deadbeef' };
        },
      } as any).kind,
    ).toBe('INTRODUCTION');
    expect(() =>
      policyAttribution({
        ...common,
        readBase: () => {
          throw new Error('EACCES: permission denied');
        },
      } as any),
    ).toThrow('EACCES');
  });

  test('recognizes an equivalent complete policy envelope as unchanged', () => {
    const envelope = { schemaVersion: 1, policy: { snapshot: { frames: 2 } } };
    expect(
      policyAttribution({
        candidateRoot: '/fixture',
        baseSha: sha('a'),
        envelope,
        readBase: () => JSON.stringify(envelope),
      } as any).kind,
    ).toBe('UNCHANGED');
  });
  test('runs exactly two base captures then one candidate in a fresh owned directory', () => {
    const { calls, outputDir, result } = run();
    expect(calls).toHaveLength(3);
    expect(calls.map((call: any) => call.targetRoot)).toEqual([
      'baseline',
      'baseline',
      'candidate',
    ]);
    expect(result.runDir).not.toBe(outputDir);
    expect(
      readFileSync(join(result.runDir, 'comparison.json'), 'utf8'),
    ).toContain('candidateSha');
  });

  test('propagates a failed or zero-output capture instead of reusing an old artifact', () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'station-transfer-gate-'));
    writeFileSync(
      join(outputDir, 'candidate.json'),
      JSON.stringify({ green: true }),
    );
    expect(() =>
      run({
        outputDir,
        capture: () => {
          throw new Error('capture produced no report');
        },
      }),
    ).toThrow('capture produced no report');
  });

  test('rejects a partial candidate matrix before writing comparison evidence', () => {
    expect(() =>
      run({
        capture: (input: any) => {
          const next =
            input.targetRoot === 'candidate'
              ? report(sha('b'), sha('a'))
              : report(sha('a'), sha('a'));
          if (input.targetRoot === 'candidate') next.phases.pop();
          return next;
        },
      }),
    ).toThrow('incomplete or duplicate scenario/phase matrix');
  });

  test('rejects provenance drift after otherwise valid captures', () => {
    expect(() =>
      run({
        readProvenance: (root: string) =>
          provenance(root === 'candidate' ? 'drifted' : 'baseline'),
      }),
    ).toThrow('candidate root drifted during capture');
  });
});
