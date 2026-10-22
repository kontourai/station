import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { rootCertificates } from 'node:tls';
import vm from 'node:vm';
import { load } from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { collectPnpmAudits } from '../lib/pnpm-advisory.mjs';
import { auditReleaseSource } from '../release-advisory-gate.mjs';

const temp = trackTempDirs();
const root = resolve(import.meta.dirname, '../..');
function git(dir: string, ...args: string[]) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  }).trim();
}
function repository(files: Record<string, string>) {
  const dir = temp('release-advisory-');
  git(dir, 'init', '-q');
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(resolve(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  git(dir, 'add', '.');
  git(
    dir,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture',
  );
  return { root: dir, sha: git(dir, 'rev-parse', 'HEAD') };
}
const emptyPolicy = { version: 2, exceptions: [], residuals: [] };
function fixture() {
  const source = repository({
    'package.json': '{"name":"candidate","packageManager":"pnpm@11.25.0"}',
    'packages/sdk/package.json': '{"name":"sdk"}',
    'packages/shared/package.json': '{"name":"shared"}',
    '.npmrc': 'ignore-scripts=true\n',
    'pnpm-workspace.yaml': 'packages: [packages/sdk, packages/shared]\n',
    'pnpm-lock.yaml': `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      vulnerable: {specifier: 1.0.0, version: 1.0.0}
  packages/sdk: {}
  packages/shared: {}
packages:
  vulnerable@1.0.0: {resolution: {integrity: fixture}}
snapshots:
  vulnerable@1.0.0: {}
`,
    // A tag-controlled acceptance must never become the release policy.
    'scripts/dependency-advisory-exceptions.json': JSON.stringify({
      ...emptyPolicy,
      exceptions: [
        {
          scope: 'root',
          package: 'vulnerable',
          advisory: 'GHSA-aaaa-bbbb-cccc',
          severity: 'high',
          owner: 'candidate',
          reason: 'tag cannot waive',
          trackingIssue: 'https://github.com/example/repo/issues/1',
          expires: '2099-01-01',
        },
      ],
    }),
  });
  const policy = repository({
    'scripts/dependency-advisory-exceptions.json': JSON.stringify(emptyPolicy),
  });
  return {
    sourceRoot: source.root,
    sourceSha: source.sha,
    policyRoot: policy.root,
    policySha: policy.sha,
  };
}
function registry(advisory: boolean) {
  return {
    advisories: advisory
      ? {
          1: {
            severity: 'high',
            module_name: 'vulnerable',
            github_advisory_id: 'GHSA-aaaa-bbbb-cccc',
            title: 'fixture advisory',
            findings: [{ version: '1.0.0', paths: ['.>vulnerable'] }],
          },
        }
      : {},
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: advisory ? 1 : 0,
        critical: 0,
      },
    },
  };
}
const collect =
  (raw: unknown) =>
  (scopes: Array<{ scope: string }>, options: { root: string }) =>
    collectPnpmAudits(scopes, { ...options, run: async () => raw });

describe('trusted release advisory boundary', () => {
  it('the actual CLI retains an operational NOT_VERIFIED receipt and exits 2 without a registry call', () => {
    const inputs = fixture();
    const output = join(temp('release-advisory-operation-'), 'receipt.json');
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'scripts/release-advisory-gate.mjs'),
        '--source-root',
        inputs.sourceRoot,
        '--source-sha',
        inputs.sourceSha,
        '--policy-sha',
        'a'.repeat(40),
        '--output',
        output,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('NOT_VERIFIED');
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
      scanCompleted: false,
      passed: false,
      status: 'NOT_VERIFIED',
    });
  });

  it('uses the real collector boundary: candidate production/registry/lock-directory settings cannot hide dev advisories', async () => {
    const inputs = fixture();
    const lockPath = join(inputs.sourceRoot, 'pnpm-lock.yaml');
    const oldLock = readFileSync(lockPath, 'utf8');
    const changedLock = `${oldLock
      .replace(
        '  packages/sdk: {}',
        '    devDependencies:\n      dev-vulnerable: {specifier: 1.0.0, version: 1.0.0}\n  packages/sdk: {}',
      )
      .replace(
        'snapshots:',
        '  dev-vulnerable@1.0.0: {resolution: {integrity: fixture}}\nsnapshots:',
      )}  dev-vulnerable@1.0.0: {}\n`;
    writeFileSync(lockPath, changedLock);
    writeFileSync(
      join(inputs.sourceRoot, '.npmrc'),
      'production=true\nregistry=https://untrusted.example.test\nstrict-ssl=false\nlockfile-dir=elsewhere\n',
    );
    git(inputs.sourceRoot, 'add', '.');
    git(
      inputs.sourceRoot,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'candidate config attempts suppression',
    );
    inputs.sourceSha = git(inputs.sourceRoot, 'rev-parse', 'HEAD');
    let payload: unknown;
    let responseMode = 'advisory';
    const calls: unknown[][] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.setHeader('content-type', 'application/json');
        if (responseMode === 'unavailable') {
          res.statusCode = 503;
          res.end('{}');
          return;
        }
        if (responseMode === 'malformed') {
          res.end('{');
          return;
        }
        if (
          responseMode === 'clean' ||
          !Object.hasOwn(payload as object, 'dev-vulnerable')
        ) {
          res.end('{}');
          return;
        }
        res.end(
          JSON.stringify({
            'dev-vulnerable': [
              {
                url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff',
                severity: 'high',
                title: 'dev advisory',
                vulnerable_versions: '<2.0.0',
              },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected loopback listener');
    const spy = vi
      .spyOn(https, 'request')
      .mockImplementation((...args: unknown[]) => {
        calls.push(args);
        const callback = args.at(-1);
        if (typeof callback !== 'function')
          throw new Error('Missing real collector response callback');
        return httpRequest(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path: '/',
            method: 'POST',
          },
          (response) => callback(response),
        );
      });
    // Redirect only the actual HTTPS transport to a loopback fixture; do not inject raw audit JSON.
    syncBuiltinESMExports();
    try {
      const receipt = await auditReleaseSource(inputs);
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe(
        'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
      );
      expect(calls[0][1]).toMatchObject({
        rejectUnauthorized: true,
        ca: rootCertificates,
      });
      expect(payload).toEqual({
        'dev-vulnerable': ['1.0.0'],
        vulnerable: ['1.0.0'],
      });
      expect(receipt.passed).toBe(false);
      expect(receipt.result.blockingFindings).toEqual([
        expect.objectContaining({
          scope: 'root',
          reachability: 'full',
          package: 'dev-vulnerable',
          advisory: 'GHSA-dddd-eeee-ffff',
        }),
      ]);
      expect(receipt.result.scopes['root/production'].high).toBe(0);
      responseMode = 'clean';
      expect((await auditReleaseSource(inputs)).passed).toBe(true);
      responseMode = 'malformed';
      await expect(auditReleaseSource(inputs)).rejects.toThrow(
        'not valid JSON',
      );
      responseMode = 'unavailable';
      await expect(auditReleaseSource(inputs)).rejects.toThrow(
        'registry HTTP 503',
      );
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('scans the candidate graph, not the clean policy graph, and refuses its tag-supplied waiver', async () => {
    const inputs = fixture();
    const receipt = await auditReleaseSource({
      ...inputs,
      collect: collect(registry(true)),
    });
    expect(receipt.scanCompleted).toBe(true);
    expect(receipt.passed).toBe(false);
    expect(receipt.result.blockingFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'root',
          package: 'vulnerable',
          advisory: 'GHSA-aaaa-bbbb-cccc',
          reachability: 'full',
        }),
        expect.objectContaining({
          scope: 'root',
          package: 'vulnerable',
          advisory: 'GHSA-aaaa-bbbb-cccc',
          reachability: 'production',
        }),
      ]),
    );
    expect(receipt.result.acceptedFindings).toEqual([]);
    expect(receipt.sourceSha).toBe(inputs.sourceSha);
    expect(receipt.policySha).toBe(inputs.policySha);
    expect(receipt.lockfileSha256).toBe(
      createHash('sha256')
        .update(readFileSync(join(inputs.sourceRoot, 'pnpm-lock.yaml')))
        .digest('hex'),
    );
    expect(Object.keys(receipt.result.scopes)).toHaveLength(6);
  });
  it('admits a clean complete fresh scan with exact source, policy and lock identity', async () => {
    const receipt = await auditReleaseSource({
      ...fixture(),
      collect: collect(registry(false)),
    });
    expect(receipt.passed).toBe(true);
    expect(receipt.scanCompleted).toBe(true);
    expect(receipt.auditedAt).toMatch(/^\d{4}-/);
    expect(Date.parse(receipt.completedAt)).toBeGreaterThanOrEqual(
      Date.parse(receipt.auditedAt),
    );
  });
  it.each(['sourceSha', 'policySha'] as const)(
    'refuses an incorrect %s before registry execution',
    async (field) => {
      const inputs = { ...fixture(), [field]: 'a'.repeat(40) };
      await expect(
        auditReleaseSource({
          ...inputs,
          collect: async () => {
            throw new Error('registry must not run');
          },
        }),
      ).rejects.toThrow('exact source or policy SHA');
    },
  );
  it('refuses a changed candidate lock instead of scanning moving-main bytes', async () => {
    const inputs = fixture();
    writeFileSync(
      join(inputs.sourceRoot, 'pnpm-lock.yaml'),
      `${readFileSync(join(inputs.sourceRoot, 'pnpm-lock.yaml'), 'utf8')}\n`,
    );
    await expect(
      auditReleaseSource({ ...inputs, collect: collect(registry(false)) }),
    ).rejects.toThrow('differs from the exact source');
  });
  it('rejects source drift during a successful scan', async () => {
    const inputs = fixture();
    await expect(
      auditReleaseSource({
        ...inputs,
        collect: async (scopes, options) => {
          const docs = await collect(registry(false))(scopes, options);
          writeFileSync(
            join(inputs.sourceRoot, 'package.json'),
            '{"name":"changed"}',
          );
          return docs;
        },
      }),
    ).rejects.toThrow('differs from the exact source');
  });
  it.each([
    'registry failure',
    'malformed response',
    'incomplete views',
    'invalid policy',
  ])('does not call %s a clean scan', async (failure) => {
    const inputs = fixture();
    let scanner = collect(registry(false));
    if (failure === 'registry failure')
      scanner = async () => {
        throw new Error('registry unavailable');
      };
    if (failure === 'malformed response') scanner = collect({});
    if (failure === 'incomplete views') scanner = async () => [];
    if (failure === 'invalid policy') {
      writeFileSync(
        join(inputs.policyRoot, 'scripts/dependency-advisory-exceptions.json'),
        '{invalid',
      );
      git(inputs.policyRoot, 'add', '.');
      git(
        inputs.policyRoot,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'invalid policy',
      );
      inputs.policySha = git(inputs.policyRoot, 'rev-parse', 'HEAD');
    }
    await expect(
      auditReleaseSource({ ...inputs, collect: scanner }),
    ).rejects.toThrow();
  });
});

type Job = {
  needs?: string | string[];
  if?: string;
  uses?: string;
  with?: Record<string, string>;
  steps?: Array<{
    name?: string;
    run?: string;
    uses?: string;
    with?: Record<string, string>;
  }>;
};
const workflow = (file: string) =>
  load(readFileSync(join(root, '.github/workflows', file), 'utf8')) as {
    jobs: Record<string, Job>;
  };
function condition(expression: string, context: Record<string, unknown>) {
  const script = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  return vm.runInNewContext(script, {
    ...context,
    always: () => true,
    cancelled: () => false,
  });
}
describe('publication graph cannot borrow feature/advisory silence as a pass', () => {
  it('executes the policy-binding shell against real Git history: ancestor allowed, foreign revision refused', () => {
    const job = workflow('release-advisory.yml').jobs.audit;
    const script = job.steps?.find(
      (step) => step.name === 'Bind the trusted default-branch policy snapshot',
    )?.run;
    if (!script) throw new Error('Expected actual policy binding script');
    const inputs = fixture();
    const output = join(temp('release-policy-output-'), 'output');
    const run = (sha: string) =>
      execFileSync('bash', ['-c', script], {
        cwd: inputs.policyRoot,
        env: { ...process.env, POLICY_SHA: sha, GITHUB_OUTPUT: output },
        windowsHide: true,
        timeout: 10_000,
      });
    expect(() => run(inputs.sourceSha)).toThrow();
    expect(() => readFileSync(output)).toThrow();
    writeFileSync(
      join(inputs.policyRoot, 'later'),
      'later trusted main commit',
    );
    git(inputs.policyRoot, 'add', '.');
    git(
      inputs.policyRoot,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'advance trusted main',
    );
    run(inputs.policySha);
    expect(git(inputs.policyRoot, 'rev-parse', 'HEAD')).toBe(inputs.policySha);
    expect(readFileSync(output, 'utf8')).toBe(`sha=${inputs.policySha}\n`);
  });

  it('runs the central tracker create branch with an accountable owner and actionable run receipt', async () => {
    const document = load(
      readFileSync(join(root, '.github/workflows/main-health.yml'), 'utf8'),
    ) as {
      jobs: Record<string, { steps: Array<{ with?: { script?: string } }> }>;
    };
    const script = document.jobs['report-failure'].steps.find(
      (step) => step.with?.script,
    )?.with?.script;
    if (!script) throw new Error('Expected the real tracker script');
    const create = vi.fn();
    const github = {
      rest: { issues: { listForRepo: vi.fn(), create } },
      paginate: async () => [],
    };
    const run = vm.compileFunction(
      `return async function (github, context, process) {\n${script}\n};`,
      [],
      { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
    )();
    await run(
      github,
      {
        repo: { owner: 'kontourai', repo: 'station' },
        payload: { workflow_run: { id: 7 } },
      },
      {
        env: {
          GITHUB_WORKSPACE: root,
          WORKFLOW_NAME: 'Repo: Dependency advisory',
          RUN_URL: 'https://example.test/run/7',
          HEAD_SHA: 'b'.repeat(40),
        },
      },
    );
    expect(create).toHaveBeenCalledOnce();
    const issue = create.mock.calls[0][0];
    expect(issue.title).toBe('Main pipeline red: Repo: Dependency advisory');
    expect(issue.assignees).toEqual(['briananderson1222']);
    expect(readFileSync(join(root, '.github/CODEOWNERS'), 'utf8')).toContain(
      `scripts/dependency-advisory-policy.mjs @${issue.assignees[0]}`,
    );
    expect(issue.body).toContain('https://example.test/run/7');
    expect(issue.body).toContain(
      'separate disclosed findings from scan/registry errors',
    );
    expect(issue.body).toContain('one compatible dependency repair');
  });
  it('separates candidate and policy checkouts and installs before running the trusted entrypoint', () => {
    const audit = workflow('release-advisory.yml').jobs.audit;
    const steps = audit.steps ?? [];
    const source = steps.find(
      (step) => step.with?.ref === `\${{ inputs.source_sha }}`,
    );
    expect(source?.with?.['persist-credentials']).toBe(false);
    const policy = steps.find((step) => step.with?.path === 'release-policy');
    expect(policy?.with?.ref).toBe(
      `refs/heads/\${{ github.event.repository.default_branch }}`,
    );
    const gate = steps.find((step) =>
      step.run?.includes(
        'node release-policy/scripts/release-advisory-gate.mjs',
      ),
    );
    expect(gate?.run).toContain(
      '--source-root "$GITHUB_WORKSPACE" --source-sha "$RELEASE_SHA" --policy-sha "$POLICY_SHA"',
    );
    expect(
      steps.findIndex(
        (step) =>
          step.name ===
          'Install trusted policy tooling independently of the candidate',
      ),
    ).toBeLessThan(steps.indexOf(gate!));
    expect(gate).not.toHaveProperty('continue-on-error');
  });

  it('removes the scan from feature CI rather than swallowing its verdict', () => {
    const ci = workflow('ci.yml');
    expect(
      Object.values(ci.jobs)
        .flatMap((job) => job.steps ?? [])
        .filter((step) =>
          /audit:policy|dependency-advisory-policy|release-advisory-gate/.test(
            step.run ?? '',
          ),
        ),
    ).toEqual([]);
    expect(
      Object.values(ci.jobs).some((job) =>
        job.uses?.includes('release-advisory'),
      ),
    ).toBe(false);
    expect(
      readFileSync(join(root, '.github/workflows/nightly.yml'), 'utf8'),
    ).not.toMatch(/audit:policy|release-advisory/);
    expect(
      workflow('dependency-advisory.yml').jobs.audit.steps?.some(
        (step) => step.run === 'npm run audit:policy',
      ),
    ).toBe(true);
  });
  it('blocks every native release publish, including pointer repair, on the fresh source/policy gate', () => {
    const jobs = workflow('publish-release.yml').jobs;
    expect(jobs.advisory.with).toEqual({
      audit_id: 'publication',
      source_sha: `\${{ needs.resolve.outputs.sha }}`,
      policy_sha: `\${{ needs.resolve.outputs.policy_sha }}`,
    });
    expect([jobs.publish.needs].flat()).toContain('advisory');
    for (const state of ['failure', 'skipped', 'cancelled']) {
      expect(
        condition(jobs.publish.if!, {
          needs: {
            resolve: {
              result: 'success',
              outputs: { pointer_repair_only: 'true' },
            },
            qualification: { result: 'skipped' },
            advisory: { result: state },
          },
        }),
      ).toBe(false);
    }
    expect(
      condition(jobs.publish.if!, {
        needs: {
          resolve: {
            result: 'success',
            outputs: { pointer_repair_only: 'true' },
          },
          qualification: { result: 'skipped' },
          advisory: { result: 'success' },
        },
      }),
    ).toBe(true);
    expect([jobs['host-pointer'].needs].flat()).toContain('publish');
  });
  it('gates tagged container and store producers, not just the final GitHub release', () => {
    const jobs = workflow('release.yml').jobs;
    expect([jobs['full-regression'].needs].flat()).toContain('advisory');
    for (const name of ['container', 'android', 'ios-device'])
      expect([jobs[name].needs].flat()).toContain('full-regression');
  });
  it('requires the gate on manual npm publication but does not audit changeset version PR generation', () => {
    const jobs = workflow('publish-packages.yml').jobs;
    expect(jobs.advisory.if).toBe(
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
    );
    expect([jobs.publish.needs].flat()).toContain('advisory');
    const context = {
      github: { event_name: 'workflow_dispatch', ref: 'refs/heads/main' },
      needs: {
        qualification: { result: 'success' },
        advisory: { result: 'failure' },
      },
    };
    expect(condition(jobs.publish.if!, context)).toBe(false);
    context.github.event_name = 'push';
    expect(condition(jobs.publish.if!, context)).toBe(true);
  });
  it('gates Beta/Stable TestFlight upload and adds zero Nightly audit executions', () => {
    const jobs = workflow('testflight-delivery.yml').jobs;
    for (const channel of ['stable', 'beta']) {
      const context = {
        inputs: { channel, delivery: 'upload' },
        needs: {
          deliver: { result: 'skipped' },
          advisory: { result: 'failure' },
        },
      };
      expect(condition(jobs.advisory.if!, context)).toBe(true);
      expect(condition(jobs.upload.if!, context)).toBe(false);
      context.needs.advisory.result = 'success';
      expect(condition(jobs.upload.if!, context)).toBe(true);
    }
    const nightly = {
      inputs: { channel: 'nightly', delivery: 'upload' },
      needs: {
        deliver: { result: 'skipped' },
        advisory: { result: 'skipped' },
      },
    };
    expect(condition(jobs.advisory.if!, nightly)).toBe(false);
    expect(condition(jobs.upload.if!, nightly)).toBe(true);
  });
});
