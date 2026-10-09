import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * Main qualification publishes the Nightly from the commit it just
 * qualified, by calling nightly.yml from inside the qualifying run. These
 * read the real workflow graph: who may start it, what it waits for, the
 * token it hands down, and how nightly.yml substitutes the caller's
 * qualification for its own full-regression receipt.
 */

type Step = { id?: string; name?: string; run?: string; uses?: string };
type Job = {
  name?: string;
  needs?: string | string[];
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: unknown;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
};

const workflowsDir = resolve(import.meta.dirname, '../../.github/workflows');
const read = (name: string) =>
  load(readFileSync(join(workflowsDir, name), 'utf8')) as Workflow;
const qualification = read('main-qualification.yml');
const nightly = read('nightly.yml');
const expr = (inner: string) => `\${{ ${inner} }}`;
const RECEIPT =
  "(needs['full-regression'].result == 'success' || inputs.caller_qualification == 'success')";

describe('Main qualification: the qualified-Nightly entry point', () => {
  const decide = qualification.jobs['nightly-decide'];
  const call = qualification.jobs.nightly;

  it('decides only after qualification succeeded on main', () => {
    expect(decide.needs).toEqual(['qualification']);
    expect(decide.if).toBe(
      expr(
        "vars.STATION_QUALIFIED_NIGHTLY == 'enabled' && github.ref == 'refs/heads/main' && needs.qualification.result == 'success'",
      ),
    );
    expect(decide.permissions).toEqual({ contents: 'read' });
    expect(decide.outputs).toEqual({
      publish: expr('steps.decide.outputs.publish'),
    });
  });

  it('decides with the ledger on origin/main and the live reservation tags', () => {
    const step = decide.steps?.find((candidate) => candidate.id === 'decide');
    expect(step?.run).toContain('git fetch --no-tags origin main');
    expect(step?.run).toContain(
      `git ls-remote --refs "https://github.com/$GITHUB_REPOSITORY" 'refs/tags/nightly-version-code/*' > "$reservations"`,
    );
    expect(step?.run).toContain(
      'node scripts/nightly-qualification-decide.mjs --source-sha "$GITHUB_SHA" --reservation-refs "$reservations" --ledger-ref origin/main',
    );
    // The decide step runs on the qualified commit's own scripts and history.
    const checkout = decide.steps?.[0] as Step & {
      with?: Record<string, unknown>;
    };
    expect(checkout.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(checkout.with).toMatchObject({
      ref: expr('github.sha'),
      'fetch-depth': 0,
      'persist-credentials': false,
    });
  });

  it('calls nightly.yml only when the decision says publish', () => {
    expect(call.needs).toEqual(['qualification', 'nightly-decide']);
    expect(call.if).toBe(
      expr(
        "github.ref == 'refs/heads/main' && needs.qualification.result == 'success' && needs.nightly-decide.outputs.publish == 'true'",
      ),
    );
    expect(call.uses).toBe('./.github/workflows/nightly.yml');
    expect(call.with).toEqual({
      source_sha: expr('github.sha'),
      caller_qualification: expr('needs.qualification.result'),
    });
    expect(call.secrets).toBe('inherit');
  });

  it("grants the call exactly nightly.yml's workflow token", () => {
    // A called workflow can only reduce the caller's token.
    expect(call.permissions).toEqual(nightly.permissions);
    expect(nightly.permissions).toEqual({
      contents: 'write',
      actions: 'read',
      'id-token': 'write',
      attestations: 'write',
    });
    // The rest of the qualification run keeps its read-only token.
    expect(qualification.permissions).toEqual({
      contents: 'read',
      actions: 'read',
    });
  });

  it('qualifies the same commit it hands to the Nightly', () => {
    expect(qualification.jobs.qualification.with).toMatchObject({
      source_sha: expr('github.sha'),
    });
  });

  it('cannot deadlock against, or overlap with, another Nightly', () => {
    expect(qualification.concurrency).toBeUndefined();
    expect(qualification.jobs.qualification.concurrency).toEqual({
      group: 'main-qualification-source',
      'cancel-in-progress': false,
    });
    expect(nightly.concurrency).toEqual({
      group: 'nightly',
      'cancel-in-progress': false,
    });
    expect(qualification.jobs.qualification.concurrency?.group).not.toBe(
      nightly.concurrency?.group,
    );
  });
});

describe('nightly.yml: entry points', () => {
  it('leaves scheduling to qualification and retains manual recovery and the qualified call', () => {
    expect(Object.keys(nightly.on).sort()).toEqual([
      'workflow_call',
      'workflow_dispatch',
    ]);
    expect(qualification.on.schedule).toEqual([{ cron: '17 * * * *' }]);
    expect(
      Object.keys(
        (nightly.on.workflow_dispatch as { inputs: object }).inputs,
      ).sort(),
    ).toEqual(['rebuild_index', 'source_sha']);
    const call = nightly.on.workflow_call as {
      inputs: Record<string, { required: boolean; type: string }>;
    };
    expect(Object.keys(call.inputs).sort()).toEqual([
      'caller_qualification',
      'source_sha',
    ]);
    for (const input of Object.values(call.inputs))
      expect(input).toMatchObject({ required: true, type: 'string' });
  });

  it("runs its own full regression only when the caller's qualification did not succeed", () => {
    const job = nightly.jobs['full-regression'];
    expect(job.uses).toBe('./.github/workflows/full-regression.yml');
    expect(job.if).toContain("inputs.caller_qualification != 'success'");
    // Reuse stays at its default (true) for manual recovery.
    expect(job.with).toEqual({
      source_sha: expr('needs.test-gate.outputs.source_sha'),
    });
  });

  it('admits every publishing leg on either receipt, and still binds each to the event SHA', () => {
    for (const id of [
      'fleet-staging',
      'native-cohort',
      'portable-nightly',
      'nightly-cli',
    ]) {
      const condition = nightly.jobs[id].if ?? '';
      expect(condition, id).toMatch(/^\$\{\{ always\(\) && !cancelled\(\) && /);
      expect(
        condition.replaceAll(
          'needs.full-regression',
          "needs['full-regression']",
        ),
        id,
      ).toContain(RECEIPT);
      // The caller's result never stands in on its own: the source gate must
      // still have passed on this run's SHA.
      expect(condition, id).toMatch(
        /needs(\['test-gate'\]|\.test-gate)\.result == 'success'/,
      );
      expect(condition, id).not.toMatch(
        /\|\| inputs\.caller_qualification == 'success'\)?\s*\|\|/,
      );
    }
    for (const id of ['fleet-staging', 'native-cohort', 'portable-nightly'])
      expect(nightly.jobs[id].if, id).toMatch(
        /needs(\['test-gate'\]|\.test-gate)\.outputs\.source_sha == github\.sha/,
      );
  });

  it('rejects any requested source other than the event SHA in the source gate', () => {
    const source = nightly.jobs['test-gate'].steps?.find(
      (step) => step.id === 'source',
    );
    expect(source?.run).toContain(
      'if [ -n "$REQUESTED_SOURCE_SHA" ] && [ "$REQUESTED_SOURCE_SHA" != "$GITHUB_SHA" ]; then',
    );
    expect(source?.run).toContain('test "$source_sha" = "$GITHUB_SHA"');
  });
});
