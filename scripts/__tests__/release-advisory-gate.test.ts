import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
      `\${{ inputs.policy_sha || github.event.repository.default_branch }}`,
    );
    const gate = steps.find((step) =>
      step.run?.includes(
        'node release-policy/scripts/release-advisory-gate.mjs',
      ),
    );
    expect(gate?.run).toContain(
      '--source-root "$GITHUB_WORKSPACE" --source-sha "$RELEASE_SHA" --policy-sha "$policy_sha"',
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
