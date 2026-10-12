import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const workflowPath = resolve(root, '.github/workflows/codex-pr-review.yml');
const source = readFileSync(workflowPath, 'utf8');
const document = load(source) as Record<string, any>;

const FLOW_AGENTS_REVIEW_ACTION =
  'kontourai/flow-agents/.github/actions/codex-pr-review';
// The composite pin is bumped by dependabot in the workflow file only — this
// test file is outside every dependabot manifest, so a hardcoded SHA here
// goes stale on the next bump and the finds below return undefined
// (b0adbb4 -> 9c0ea5a red exactly that way). Derive the pin and assert the
// invariants that must survive every bump: the action appears at least once,
// every appearance shares ONE pin, and the pin is a full-length immutable
// commit SHA — never a branch or tag.
const REVIEW_PINS = [
  ...source.matchAll(
    new RegExp(
      `uses:\\s*${FLOW_AGENTS_REVIEW_ACTION.replaceAll('.', '\\.')}@([0-9a-f]+)`,
      'g',
    ),
  ),
].map((match) => match[1]);
const FLOW_AGENTS_REVIEW_PIN = REVIEW_PINS[0];
const FLOW_AGENTS_REVIEW = `${FLOW_AGENTS_REVIEW_ACTION}@${FLOW_AGENTS_REVIEW_PIN}`;
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const UPLOAD_ARTIFACT =
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
const expression = (value: string) => `\${{ ${value} }}`;

describe('standalone Codex PR review workflow', () => {
  it('pins the review composite to one immutable full-length SHA everywhere it appears', () => {
    expect(REVIEW_PINS.length).toBeGreaterThan(0);
    expect(new Set(REVIEW_PINS).size).toBe(1);
    expect(FLOW_AGENTS_REVIEW_PIN).toMatch(/^[0-9a-f]{40}$/);
  });

  it('uses the trusted workflow-run ingress rather than candidate-controlled PR execution', () => {
    expect(document.on).toEqual({
      workflow_run: {
        workflows: ['PR: Secret scan'],
        types: ['completed'],
      },
      workflow_dispatch: {
        inputs: {
          pr_number: {
            description: 'Pull request number to review at its current head',
            required: true,
            type: 'string',
          },
        },
      },
    });
    expect(source).not.toMatch(/^\s+pull_request(?:_target)?:/m);
    expect(document.permissions).toEqual({ contents: 'read' });
  });

  it('reviews only exact same-repository PR heads with the pinned report-only action', () => {
    const review = document.jobs.review;
    expect(review.needs).toBe('gate');
    expect(review.if).toContain("needs.gate.outputs.admit == 'true'");
    expect(review.if).toContain("needs.gate.outputs.same_repository == 'true'");
    expect(review.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'write',
    });

    const checkout = review.steps.find(
      (step: Record<string, any>) => step.uses === CHECKOUT,
    );
    expect(checkout.with).toEqual({
      repository: expression('needs.gate.outputs.head_repository'),
      ref: expression('needs.gate.outputs.head_sha'),
      'fetch-depth': 0,
      'persist-credentials': false,
    });

    const codex = review.steps.find(
      (step: Record<string, any>) => step.uses === FLOW_AGENTS_REVIEW,
    );
    expect(codex.with).toEqual({
      // Engine selection: one org/repo variable, defaulting to codex. The
      // kiro credential is separate by design — the composite never reads
      // openai-api-key on the kiro path, so this expression pair cannot
      // leak the OpenAI secret cross-vendor.
      engine: expression("vars.REVIEW_ENGINE || 'codex'"),
      'api-key': expression(
        "vars.REVIEW_ENGINE == 'kiro' && secrets.KIRO_API_KEY || ''",
      ),
      // Provider override: an org/repo secret CODEX_REVIEW_API_KEY takes
      // precedence, falling back to the official OPENAI_API_KEY — absent
      // configuration is byte-identical to the pre-override workflow.
      'openai-api-key': expression(
        'secrets.CODEX_REVIEW_API_KEY || secrets.OPENAI_API_KEY',
      ),
      'github-token': expression('github.token'),
      repository: expression('github.repository'),
      'pull-request': expression('needs.gate.outputs.number'),
      'base-sha': expression('needs.gate.outputs.base_sha'),
      'head-sha': expression('needs.gate.outputs.head_sha'),
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    });
    // The base-URL override rides step env (composite steps inherit it) and
    // must default to the official endpoint when the variable is unset.
    expect(codex.env).toEqual({
      OPENAI_BASE_URL: expression(
        "vars.CODEX_REVIEW_BASE_URL || 'https://api.openai.com/v1'",
      ),
    });
    expect(source.match(/secrets\.OPENAI_API_KEY/g)).toHaveLength(1);
    expect(source.match(/secrets\.CODEX_REVIEW_API_KEY/g)).toHaveLength(1);
  });

  it('retains the validated result without invoking Builder or Flow', () => {
    const upload = document.jobs.review.steps.find(
      (step: Record<string, any>) => step.uses === UPLOAD_ARTIFACT,
    );
    expect(upload.with).toMatchObject({
      path: expression("steps.review.outputs['result-file']"),
      'if-no-files-found': 'error',
      'retention-days': 30,
    });
    expect(source).not.toMatch(
      /builder\.build|builder\.publish-learn|flow-agents workflow/,
    );
  });

  it('records fork coverage as NOT_VERIFIED without either credential', () => {
    const fork = document.jobs['record-fork-gap'];
    expect(fork.needs).toBe('gate');
    expect(fork.if).toContain("needs.gate.outputs.admit == 'true'");
    expect(fork.if).toContain("needs.gate.outputs.same_repository != 'true'");
    expect(fork.permissions).toEqual({ contents: 'read' });

    const codex = fork.steps.find(
      (step: Record<string, any>) => step.uses === FLOW_AGENTS_REVIEW,
    );
    expect(codex.with['openai-api-key']).toBe('');
    expect(codex.with['github-token']).toBe('');
    expect(codex.name).toContain('NOT_VERIFIED');
    expect(fork.steps.some((step: Record<string, any>) => step.run)).toBe(true);
  });

  it('admits reviews only through a read-only gate that runs the trusted default branch', () => {
    const gate = document.jobs.gate;
    expect(gate.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      actions: 'read',
    });
    const checkout = gate.steps.find(
      (step: Record<string, any>) => step.uses === CHECKOUT,
    );
    expect(checkout.with).toEqual({
      ref: expression('github.sha'),
      'persist-credentials': false,
    });
    const run = gate.steps.find((step: Record<string, any>) => step.run);
    expect(run.run).toBe('node scripts/advisory-review-gate.mjs');
    expect(
      gate.steps.find((step: Record<string, any>) => step.run).env,
    ).toEqual({
      GH_TOKEN: expression('github.token'),
      EVENT_NAME: expression('github.event_name'),
      PULL_REQUEST: expression(
        'github.event.workflow_run.pull_requests[0].number || inputs.pr_number',
      ),
      EVENT_HEAD_SHA: expression('github.event.workflow_run.head_sha'),
    });
    // No credential beyond the workflow token reaches the gate.
    expect(JSON.stringify(gate)).not.toMatch(/secrets\./);
    // The review jobs must wait for the gate rather than run on every event.
    for (const [name, job] of Object.entries<Record<string, any>>(
      document.jobs,
    )) {
      if (name !== 'gate') expect(job.needs, name).toBe('gate');
    }
  });
});
