import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AutomationRule } from '@kontourai/station-contracts/automation';

/**
 * A real `GET /repos/kontourai/station/actions/runs/<id>` response (a red
 * scheduled Main: Qualification run), with the actor and the commit
 * author/message replaced by placeholders and the referenced-workflow list
 * cut to one entry. Every key GitHub returns is kept, so the normalizer reads
 * the exact REST shape. A fresh copy per call.
 */
export function realWorkflowRun(): Record<string, any> {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, 'github-workflow-run.json'), 'utf8'),
  );
}

/** The fixture run, moved to `updatedAt` and otherwise overridden. */
export function workflowRun(
  overrides: Readonly<{
    id?: number;
    runAttempt?: number;
    conclusion?: string;
    event?: string;
    headBranch?: string | null;
    headRepository?: string;
    updatedAt: string;
  }>,
): Record<string, any> {
  const run = realWorkflowRun();
  if (overrides.id !== undefined) {
    run.id = overrides.id;
    run.html_url = `https://github.com/kontourai/station/actions/runs/${overrides.id}`;
  }
  if (overrides.runAttempt !== undefined)
    run.run_attempt = overrides.runAttempt;
  if (overrides.conclusion !== undefined) run.conclusion = overrides.conclusion;
  if (overrides.event !== undefined) run.event = overrides.event;
  if (overrides.headBranch !== undefined)
    run.head_branch = overrides.headBranch;
  if (overrides.headRepository !== undefined)
    run.head_repository = {
      ...run.head_repository,
      full_name: overrides.headRepository,
    };
  run.updated_at = overrides.updatedAt;
  return run;
}

/** The design's qualification rule (section 4). */
export const QUALIFICATION_RULE: AutomationRule = {
  id: 'rule-qualification',
  name: 'Repair main qualification',
  enabled: true,
  sourceId: 'source-1',
  match: {
    type: 'github.workflow_run.completed',
    where: {
      'workflow.path': '.github/workflows/main-qualification.yml',
      'run.head_branch': 'main',
      'run.head_repository': 'kontourai/station',
      'run.event': ['schedule', 'workflow_dispatch'],
      'run.conclusion': ['failure', 'timed_out'],
    },
  },
  episode: {
    keyFields: ['repository', 'workflow.path', 'run.head_branch'],
    closeOn: {
      type: 'github.workflow_run.completed',
      where: {
        'workflow.path': '.github/workflows/main-qualification.yml',
        'run.head_branch': 'main',
        'run.head_repository': 'kontourai/station',
        'run.conclusion': 'success',
      },
    },
    maxAttempts: 1,
  },
  action: { kind: 'notify', priority: 'high' },
  rateLimit: { maxStartsPerHour: 2 },
};
