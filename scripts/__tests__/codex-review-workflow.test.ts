import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const workflowPath = resolve(root, '.github/workflows/codex-pr-review.yml');
const source = readFileSync(workflowPath, 'utf8');
const document = load(source) as Record<string, any>;

const FLOW_AGENTS_REVIEW =
  'kontourai/flow-agents/.github/actions/codex-pr-review@7f8b66336b73452a2932fc3d9295b5af05bfed0c';
const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const UPLOAD_ARTIFACT =
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
const expression = (value: string) => `\${{ ${value} }}`;

describe('standalone Codex PR review workflow', () => {
  it('uses the trusted workflow-run ingress rather than candidate-controlled PR execution', () => {
    expect(document.on).toEqual({
      workflow_run: {
        workflows: ['Secret Scan'],
        types: ['completed'],
      },
    });
    expect(source).not.toMatch(/^\s+pull_request(?:_target)?:/m);
    expect(document.permissions).toEqual({ contents: 'read' });
  });

  it('reviews only exact same-repository PR heads with the pinned report-only action', () => {
    const review = document.jobs.review;
    expect(review.if).toContain(
      "github.event.workflow_run.event == 'pull_request'",
    );
    expect(review.if).toContain(
      'github.event.workflow_run.head_repository.full_name == github.repository',
    );
    expect(review.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'write',
    });

    const checkout = review.steps.find(
      (step: Record<string, any>) => step.uses === CHECKOUT,
    );
    expect(checkout.with).toEqual({
      repository: expression(
        'github.event.workflow_run.head_repository.full_name',
      ),
      ref: expression('github.event.workflow_run.head_sha'),
      'fetch-depth': 0,
      'persist-credentials': false,
    });

    const codex = review.steps.find(
      (step: Record<string, any>) => step.uses === FLOW_AGENTS_REVIEW,
    );
    expect(codex.with).toEqual({
      'openai-api-key': expression('secrets.OPENAI_API_KEY'),
      'github-token': expression('github.token'),
      repository: expression('github.repository'),
      'pull-request': expression(
        'github.event.workflow_run.pull_requests[0].number',
      ),
      'base-sha': expression(
        'github.event.workflow_run.pull_requests[0].base.sha',
      ),
      'head-sha': expression('github.event.workflow_run.head_sha'),
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
    });
    expect(source.match(/secrets\.OPENAI_API_KEY/g)).toHaveLength(1);
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
    expect(fork.if).toContain(
      'github.event.workflow_run.head_repository.full_name != github.repository',
    );
    expect(fork.permissions).toEqual({ contents: 'read' });

    const codex = fork.steps.find(
      (step: Record<string, any>) => step.uses === FLOW_AGENTS_REVIEW,
    );
    expect(codex.with['openai-api-key']).toBe('');
    expect(codex.with['github-token']).toBe('');
    expect(codex.name).toContain('NOT_VERIFIED');
    expect(fork.steps.some((step: Record<string, any>) => step.run)).toBe(true);
  });
});
