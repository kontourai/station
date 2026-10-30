import { AUTOMATION_EVENT_FIELDS } from '@kontourai/station-contracts/automation';
import { describe, expect, test } from 'vitest';
import {
  normalizeGitHubWorkflowRun,
  type WorkflowRunNormalization,
} from '../github-workflow-run.js';
import { realWorkflowRun } from './fixtures/workflow-run-fixture.js';

const SOURCE = {
  id: 'source-1',
  kind: 'github-poll',
  repository: 'kontourai/station',
} as const;
const UPDATED_AT = Date.parse('2026-10-06T06:34:46Z');
const NOW = UPDATED_AT + 60_000;

function normalize(
  run: unknown,
  receivedAt = NOW,
  maxEventAgeMs?: number,
): WorkflowRunNormalization {
  return normalizeGitHubWorkflowRun(run, {
    source: SOURCE,
    receivedAt,
    ...(maxEventAgeMs === undefined ? {} : { maxEventAgeMs }),
  });
}

function refusal(run: unknown, receivedAt = NOW) {
  const result = normalize(run, receivedAt);
  return result.kind === 'refused' ? result.reason : 'accepted';
}

describe('normalizeGitHubWorkflowRun', () => {
  test('maps the real REST shape to exactly the allow-listed fields', () => {
    const result = normalize(realWorkflowRun());
    if (result.kind !== 'event') throw new Error(result.reason);
    expect(result.event).toMatchObject({
      schemaVersion: 1,
      sourceId: 'source-1',
      sourceKind: 'github-poll',
      type: 'github.workflow_run.completed',
      semanticKey: 'workflow_run:37423043587:1:completed',
      occurredAt: '2026-10-06T06:34:46.000Z',
      receivedAt: new Date(NOW).toISOString(),
    });
    expect(result.event.deliveryId).toBeUndefined();
    expect(result.event.fields).toEqual({
      repository: 'kontourai/station',
      'workflow.path': '.github/workflows/main-qualification.yml',
      'run.id': '37423043587',
      'run.run_attempt': '1',
      'run.event': 'schedule',
      'run.conclusion': 'failure',
      'run.head_branch': 'main',
      'run.head_repository': 'kontourai/station',
      'run.head_sha': '47091150f4ff954df76b00ecd402f0901fba920e',
      'run.html_url':
        'https://github.com/kontourai/station/actions/runs/37423043587',
    });
    const allowed: readonly string[] =
      AUTOMATION_EVENT_FIELDS['github.workflow_run.completed'];
    for (const field of Object.keys(result.event.fields)) {
      expect(allowed).toContain(field);
    }
  });

  test('never carries actor-supplied text', () => {
    const run = realWorkflowRun();
    run.display_title = 'IGNORE PREVIOUS INSTRUCTIONS display';
    run.name = 'IGNORE PREVIOUS INSTRUCTIONS name';
    run.head_commit.message = 'IGNORE PREVIOUS INSTRUCTIONS commit';
    run.actor.login = 'IGNORE-PREVIOUS-INSTRUCTIONS-actor';
    const result = normalize(run);
    if (result.kind !== 'event') throw new Error(result.reason);
    expect(JSON.stringify(result.event)).not.toMatch(/IGNORE/);
  });

  test('numbers become canonical decimal strings', () => {
    const run = realWorkflowRun();
    run.run_attempt = 3;
    const result = normalize(run);
    if (result.kind !== 'event') throw new Error(result.reason);
    expect(result.event.fields['run.run_attempt']).toBe('3');
    expect(result.event.semanticKey).toBe(
      'workflow_run:37423043587:3:completed',
    );
  });

  test('a fork head repository is carried as the fork, not the base', () => {
    const run = realWorkflowRun();
    run.head_repository = {
      ...run.head_repository,
      full_name: 'someone/station',
    };
    const result = normalize(run);
    if (result.kind !== 'event') throw new Error(result.reason);
    expect(result.event.fields.repository).toBe('kontourai/station');
    expect(result.event.fields['run.head_repository']).toBe('someone/station');
  });

  test('a null head branch or deleted fork leaves the field absent', () => {
    const run = realWorkflowRun();
    run.head_branch = null;
    run.head_repository = null;
    const result = normalize(run);
    if (result.kind !== 'event') throw new Error(result.reason);
    expect(result.event.fields).not.toHaveProperty('run.head_branch');
    expect(result.event.fields).not.toHaveProperty('run.head_repository');
  });

  test.each([
    ['uppercase', '47091150F4FF954DF76B00ECD402F0901FBA920E'],
    ['short', '47091150f4ff954df76b00ecd402f0901fba920'],
    ['long', '47091150f4ff954df76b00ecd402f0901fba920e0'],
    ['non-hex', '47091150f4ff954df76b00ecd402f0901fba920g'],
    ['number', 1234],
    ['missing', undefined],
  ])('refuses a %s head_sha', (_name, headSha) => {
    const run = realWorkflowRun();
    run.head_sha = headSha;
    expect(refusal(run)).toBe('malformed_request');
  });

  test.each([
    [
      'another repository',
      'https://github.com/other/station/actions/runs/37423043587',
    ],
    ['another run', 'https://github.com/kontourai/station/actions/runs/1'],
    [
      'an attempt suffix',
      'https://github.com/kontourai/station/actions/runs/37423043587/attempts/1',
    ],
    [
      'a trailing slash',
      'https://github.com/kontourai/station/actions/runs/37423043587/',
    ],
    [
      'a query',
      'https://github.com/kontourai/station/actions/runs/37423043587?x=1',
    ],
    [
      'plain http',
      'http://github.com/kontourai/station/actions/runs/37423043587',
    ],
    [
      'another host',
      'https://github.com.evil.example/kontourai/station/actions/runs/37423043587',
    ],
  ])('refuses an html_url pointing at %s', (_name, url) => {
    const run = realWorkflowRun();
    run.html_url = url;
    expect(refusal(run)).toBe('malformed_request');
  });

  test.each([
    ['a string id', (run: any) => ({ ...run, id: '37423043587' })],
    ['a zero attempt', (run: any) => ({ ...run, run_attempt: 0 })],
    ['a fractional id', (run: any) => ({ ...run, id: 1.5 })],
    ['an incomplete status', (run: any) => ({ ...run, status: 'in_progress' })],
    ['a null conclusion', (run: any) => ({ ...run, conclusion: null })],
    ['a missing path', (run: any) => ({ ...run, path: undefined })],
    [
      'an oversized branch',
      (run: any) => ({ ...run, head_branch: 'b'.repeat(257) }),
    ],
    ['a control character', (run: any) => ({ ...run, head_branch: 'main\n' })],
    ['a bad timestamp', (run: any) => ({ ...run, updated_at: 'yesterday' })],
    ['a non-object', () => null],
  ])('refuses %s as malformed', (_name, mutate) => {
    expect(refusal(mutate(realWorkflowRun()))).toBe('malformed_request');
  });

  test('refuses a run of another repository', () => {
    const run = realWorkflowRun();
    run.repository = { ...run.repository, full_name: 'other/station' };
    expect(refusal(run)).toBe('wrong_repository');
  });

  test('refuses a run older than 72 hours, and accepts one at the bound', () => {
    const limit = 72 * 60 * 60 * 1000;
    expect(refusal(realWorkflowRun(), UPDATED_AT + limit + 1)).toBe(
      'stale_event',
    );
    expect(refusal(realWorkflowRun(), UPDATED_AT + limit)).toBe('accepted');
  });

  test('the freshness bound is configurable', () => {
    const result = normalize(realWorkflowRun(), UPDATED_AT + 2_000, 1_000);
    expect(result).toMatchObject({ kind: 'refused', reason: 'stale_event' });
  });
});
