import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, test } from 'vitest';
import { ghAttestationArgs } from '../verify-release-cohort.mjs';

/**
 * Behavioural contract for the two-phase native Nightly (#1452, #1453, #1454).
 *
 * These tests derive the property from the workflow graph rather than naming
 * jobs: a job "publishes" if any of its steps carries a provider or authority
 * effect, and the rule is that no publishing job may run before the exact-SHA
 * full-regression receipt. Adding a Play upload to the staging phase, or
 * dropping the regression dependency from a publisher, fails here without
 * anyone having to remember to update a job list.
 *
 * The effect vocabulary below is hand-maintained: a new way of publishing
 * (say `gh release create`, or a raw POST to a registry) must be added to it,
 * and the anchor assertion on the known publishers exists so that a stale
 * vocabulary cannot silently make the rule vacuous.
 */

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
};
type Job = {
  needs?: string | string[];
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  steps?: Step[];
};
type Workflow = { jobs?: Record<string, Job> };

const root = resolve(import.meta.dirname, '../..');
const source = (name: string) =>
  readFileSync(resolve(root, '.github/workflows', name), 'utf8');
const workflow = (name: string) => load(source(name)) as Workflow;
const needsOf = (job: Job) =>
  Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];

/**
 * A step has a provider or authority effect when it can change what a user
 * installs or what the next Nightly reads as authority. Reads of those same
 * authorities (the fail-closed lock and fence checks in planning) are GETs and
 * carry none of these markers.
 */
const EFFECTS: ReadonlyArray<{
  effect: string;
  matches: (step: Step) => boolean;
}> = [
  {
    effect: 'TestFlight upload',
    matches: (s) => !!s.uses?.includes('upload-testflight-build'),
  },
  {
    effect: 'Google Play upload',
    matches: (s) => !!s.run?.includes('play-upload-retry.mjs'),
  },
  {
    effect: 'GitHub release asset upload',
    matches: (s) => !!s.run?.includes('gh release upload'),
  },
  {
    effect: 'GitHub release mutation',
    matches: (s) => !!s.run?.includes('gh release edit'),
  },
  {
    effect: 'deploy-ledger write',
    matches: (s) => !!s.run?.includes('deploy-ledger.mjs'),
  },
  {
    effect: 'ref move',
    matches: (s) => !!s.run && /--request PATCH|--method PATCH/.test(s.run),
  },
  {
    effect: 'ref delete',
    matches: (s) => !!s.run?.includes('--request DELETE'),
  },
  {
    effect: 'annotated authority tag (fence or recovery lock)',
    matches: (s) =>
      !!s.run &&
      s.run.includes('--request POST') &&
      s.run.includes('/git/tags"'),
  },
  { effect: 'npm publish', matches: (s) => !!s.run?.includes('npm publish') },
];

function effectsOf(job: Job): string[] {
  return (job.steps ?? []).flatMap((step) =>
    EFFECTS.filter(({ matches }) => matches(step)).map(
      ({ effect }) =>
        `${effect} in step "${step.name ?? step.uses ?? step.run?.slice(0, 40)}"`,
    ),
  );
}

/**
 * Splits a GitHub `if` expression on its top-level `&&` conjuncts (never
 * inside parentheses), so a guard like
 * `always() && inputs.delivery != 'build' && (a || b)` yields three parts.
 */
function conjuncts(expression: string): string[] {
  const inner = expression.trim().replace(/^\$\{\{|\}\}$/g, '');
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0 && inner.startsWith('&&', index)) {
      parts.push(current.trim());
      current = '';
      index += 1;
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts;
}

/**
 * A called job is unreachable for a caller when one of its top-level guard
 * conjuncts compares an input the caller fixes to a literal the caller does
 * not pass. This is the exact mechanism `testflight-delivery.yml` uses to make
 * its upload job unreachable in `delivery: build` mode.
 */
function unreachableFor(job: Job, inputs: Record<string, unknown>): boolean {
  return conjuncts(job.if ?? '').some((part) => {
    const comparison = part.match(/^inputs\.(\w+) (!=|==) '([^']*)'$/);
    if (!comparison) return false;
    const [, name, operator, literal] = comparison;
    if (!(name in inputs)) return false;
    const value = String(inputs[name]);
    return operator === '!=' ? value === literal : value !== literal;
  });
}

/**
 * Effects of a caller job: its own steps plus every reachable job of a
 * workflow it calls, given the inputs the caller passes.
 */
function effectsOfCaller(job: Job): string[] {
  const own = effectsOf(job);
  if (!job.uses) return own;
  const called = workflow(job.uses.replace('./.github/workflows/', ''));
  return [
    ...own,
    ...Object.entries(called.jobs ?? {})
      .filter(([, calledJob]) => !unreachableFor(calledJob, job.with ?? {}))
      .flatMap(([id, calledJob]) =>
        // Recurse so a call two levels down (nightly → staging → delivery)
        // is seen from the top-level caller too.
        effectsOfCaller(calledJob).map(
          (effect) => `${job.uses}#${id}: ${effect}`,
        ),
      ),
  ];
}

describe('two-phase native Nightly', () => {
  test('the guard model reads the real delivery workflow: upload is unreachable in build mode and reachable in upload mode', () => {
    const delivery = workflow('testflight-delivery.yml');
    const upload = delivery.jobs?.upload ?? {};
    const build = delivery.jobs?.deliver ?? {};
    expect(unreachableFor(upload, { delivery: 'build' })).toBe(true);
    expect(unreachableFor(upload, { delivery: 'upload' })).toBe(false);
    expect(unreachableFor(upload, {})).toBe(false);
    expect(unreachableFor(build, { delivery: 'upload' })).toBe(true);
    expect(unreachableFor(build, { delivery: 'build' })).toBe(false);
    // A guard that only mentions the input inside parentheses does not make
    // the job unreachable; only a top-level conjunct does.
    expect(
      unreachableFor(
        { if: `$\{{ always() && (inputs.delivery != 'build' || true) }}` },
        { delivery: 'build' },
      ),
    ).toBe(false);
  });

  test('no job with a provider or authority effect runs before the exact-SHA full-regression receipt', () => {
    const nightly = workflow('nightly.yml');
    const publishers: string[] = [];
    for (const [id, job] of Object.entries(nightly.jobs ?? {})) {
      const effects = effectsOfCaller(job);
      if (effects.length === 0) continue;
      publishers.push(id);
      expect(
        needsOf(job),
        `${id} publishes (${effects.join('; ')}) so it must need full-regression`,
      ).toContain('full-regression');
      expect(
        job.if,
        `${id} must refuse anything but a literal regression success`,
      ).toContain("needs['full-regression'].result == 'success'");
    }
    // The rule must have found the real publishers, or it proves nothing.
    expect(publishers.sort()).toEqual(['native-cohort', 'nightly-cli']);
  });

  test('the staging phase builds, signs, and stages but has no provider or authority effect', () => {
    const stage = workflow('nightly-native-stage.yml');
    for (const [id, job] of Object.entries(stage.jobs ?? {})) {
      expect(
        effectsOfCaller(job),
        `${id} must not publish; staging runs before the regression verdict`,
      ).toEqual([]);
    }
    // The only ref it may write is the version-code reservation, which a
    // failed night simply burns. Anything else durable belongs to phase two.
    const refWrites = source('nightly-native-stage.yml')
      .split('\n')
      .filter((line) => line.includes('--request POST'));
    expect(refWrites.length).toBeGreaterThan(0);
    for (const line of refWrites) {
      expect(
        line,
        'staging may only POST the lightweight reservation ref',
      ).toContain('/git/refs"');
      expect(line).not.toContain('/git/tags"');
    }
    expect(source('nightly-native-stage.yml')).toContain(
      'reservation_ref="refs/tags/$tag"',
    );
  });

  test('the publishing cohort starts only after staging succeeded and can never rebuild what it publishes', () => {
    const nightly = workflow('nightly.yml');
    const cohortCaller = nightly.jobs?.['native-cohort'] ?? {};
    expect(needsOf(cohortCaller)).toContain('native-stage');
    expect(cohortCaller.if).toContain(
      "needs['native-stage'].result == 'success'",
    );
    const staging = nightly.jobs?.['native-stage'] ?? {};
    expect(needsOf(staging)).toEqual(['test-gate']);
    expect(staging.if).not.toContain('full-regression');

    const cohort = workflow('nightly-native-cohort.yml');
    const buildInvocations = Object.entries(cohort.jobs ?? {}).flatMap(
      ([id, job]) =>
        (job.steps ?? [])
          .filter((step) =>
            /npx tauri (android |ios )?build\b|cargo build/.test(
              step.run ?? '',
            ),
          )
          .map((step) => `${id}: ${step.name}`),
    );
    expect(buildInvocations).toEqual([]);

    // iOS: the cohort asks the delivery workflow for upload only, and the
    // upload job consumes exactly the artifact the build job retained.
    const delivery = workflow('testflight-delivery.yml');
    expect(cohort.jobs?.['deliver-ios']?.with?.delivery).toBe('upload');
    expect(
      workflow('nightly-native-stage.yml').jobs?.['stage-ios']?.with?.delivery,
    ).toBe('build');
    const build = delivery.jobs?.deliver ?? {};
    const upload = delivery.jobs?.upload ?? {};
    const staged = (build.steps ?? []).find(
      (step) =>
        step.uses?.startsWith('actions/upload-artifact@') &&
        String(step.with?.name).includes('-ios-staged-'),
    );
    const download = (upload.steps ?? []).find((step) =>
      step.uses?.startsWith('actions/download-artifact@'),
    );
    expect(download?.with?.name).toBe(staged?.with?.name);
    expect(
      (upload.steps ?? []).some((step) =>
        /npx tauri ios build|xcodebuild/.test(step.run ?? ''),
      ),
    ).toBe(false);
    // In build mode the upload job is unreachable; in upload mode the build
    // job is skipped and upload must still run; a failed build never uploads.
    expect(build.if).toBe(`$\{{ inputs.delivery != 'upload' }}`);
    const guard = upload.if ?? '';
    expect(guard).toContain("inputs.delivery != 'build'");
    expect(guard).toContain("needs.deliver.result == 'success'");
    expect(guard).toContain(
      "(inputs.delivery == 'upload' && needs.deliver.result == 'skipped')",
    );
    expect(guard).not.toMatch(
      /needs\.deliver\.result != 'failure'|always\(\)\s*}}/,
    );
  });

  test('a run artifact handed between jobs keeps one workspace-relative root', () => {
    // upload-artifact roots a multi-path upload at the paths' least common
    // ancestor; a single path outside the workspace (for example under
    // runner.temp) silently nests everything under the runner's work dir and
    // the consuming job's relative reads then find nothing.
    const handoffs: string[] = [];
    for (const name of [
      'testflight-delivery.yml',
      'nightly-native-stage.yml',
      'nightly-native-cohort.yml',
    ]) {
      for (const [id, job] of Object.entries(workflow(name).jobs ?? {})) {
        for (const step of job.steps ?? []) {
          if (!step.uses?.startsWith('actions/upload-artifact@')) continue;
          const paths = String(step.with?.path ?? '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
          handoffs.push(`${name}#${id}`);
          for (const path of paths) {
            expect(path, `${name}#${id} uploads ${path}`).not.toMatch(
              /runner\.temp|RUNNER_TEMP|^\//,
            );
          }
        }
      }
    }
    expect(handoffs).toContain('testflight-delivery.yml#deliver');
    expect(handoffs).toContain('testflight-delivery.yml#upload');
  });

  test('the protected verifier checks staged bytes against the workflow that actually attests them', () => {
    const attestsStagedBytes = (name: string) =>
      Object.values(workflow(name).jobs ?? {}).some((job) =>
        (job.steps ?? []).some(
          (step) =>
            step.uses?.startsWith('actions/attest-build-provenance@') &&
            /cohort-(android|macos)\//.test(
              String(step.with?.['subject-path']),
            ),
        ),
      );
    const signers = [
      'nightly-native-stage.yml',
      'nightly-native-cohort.yml',
    ].filter(attestsStagedBytes);
    expect(signers).toEqual(['nightly-native-stage.yml']);
    const args = ghAttestationArgs('staged/file', 'a'.repeat(40));
    const identity = args[args.indexOf('--cert-identity') + 1];
    expect(identity).toBe(
      `https://github.com/kontourai/station/.github/workflows/${signers[0]}@refs/heads/main`,
    );

    // The final receipt is attested by the cohort's protected finalize job and
    // verified before the ledger token is minted, under that same identity.
    const cohort = workflow('nightly-native-cohort.yml');
    const finalAttest = Object.entries(cohort.jobs ?? {}).filter(([, job]) =>
      (job.steps ?? []).some(
        (step) =>
          step.uses?.startsWith('actions/attest-build-provenance@') &&
          String(step.with?.['subject-path']).includes(
            'final-cohort-receipt.json',
          ),
      ),
    );
    expect(finalAttest.map(([id]) => id)).toEqual(['protected-finalize']);
    const verify = (
      cohort.jobs?.['record-native-completion']?.steps ?? []
    ).find((step) =>
      step.run?.includes(
        'gh attestation verify cohort/final-cohort-receipt.json',
      ),
    );
    expect(verify?.run).toContain(
      '.github/workflows/nightly-native-cohort.yml@refs/heads/main',
    );
  });
});
