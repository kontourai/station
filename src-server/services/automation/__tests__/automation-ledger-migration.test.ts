import { createRequire } from 'node:module';
import { join } from 'node:path';
import type {
  AutomationRule,
  AutomationSource,
} from '@kontourai/station-contracts/automation';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { recordAutomationEvent } from '../automation-intake.js';
import { createAutomationLedger } from '../automation-ledger.js';
import { normalizeGitHubWorkflowRun } from '../github-workflow-run.js';
import {
  QUALIFICATION_RULE,
  workflowRun,
} from './fixtures/workflow-run-fixture.js';

const makeTempDir = trackTempDirs();
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (
    path: string,
  ) => {
    exec(sql: string): void;
    prepare(sql: string): { all: (...args: unknown[]) => unknown[] };
    close(): void;
  };
};

const SOURCE: AutomationSource = {
  id: 'source-1',
  kind: 'github-poll',
  name: 'station',
  repository: 'kontourai/station',
  enabled: true,
  grants: [
    { projectId: 'station', agentId: 'repairer', actions: ['dispatch-task'] },
  ],
};
const RULE: AutomationRule = {
  ...QUALIFICATION_RULE,
  sourceId: SOURCE.id,
  mode: 'live',
};

/**
 * #4511/#4513: a ledger written before this change has neither `retry` nor
 * `task_id` and keeps the old `(rule_id, episode_id)` unique index. Opening
 * it adds both columns, backfills `task_id` from the retained body and
 * replaces the index, so the Task read finds its intent and a retry can be
 * retained beside the original.
 */
test('an existing ledger is migrated in place: task lookup works and the episode index admits retries', () => {
  const directory = makeTempDir('automation-ledger-migration-');
  const ledger = createAutomationLedger({ directory });
  const normalized = normalizeGitHubWorkflowRun(
    workflowRun({
      conclusion: 'failure',
      updatedAt: new Date(Date.now() - 1000).toISOString(),
    }),
    { source: SOURCE, receivedAt: Date.now() },
  );
  if (normalized.kind !== 'event') throw new Error(normalized.reason);
  recordAutomationEvent({
    ledger,
    rules: [RULE],
    source: SOURCE,
    event: normalized.event,
    transportId: normalized.event.semanticKey,
    now: Date.now(),
  });
  const intent = ledger.listActionIntents()[0]!;
  ledger.updateIntent(
    intent.intentId,
    { taskId: 'task-1', taskCreatedAt: new Date().toISOString() },
    Date.now(),
  );
  ledger.close();

  // Reshape the file into the pre-change schema.
  const db = new DatabaseSync(join(directory, 'automation.sqlite'));
  db.exec(`DROP INDEX automation_action_intents_episode_retry;
DROP INDEX automation_action_intents_task;
ALTER TABLE automation_action_intents DROP COLUMN task_id;
ALTER TABLE automation_action_intents DROP COLUMN retry;
CREATE UNIQUE INDEX automation_action_intents_episode ON automation_action_intents(rule_id, episode_id);`);
  db.close();

  const reopened = createAutomationLedger({ directory });
  expect(reopened.intentForTask('task-1')?.intentId).toBe(intent.intentId);
  reopened.close();
  const check = new DatabaseSync(join(directory, 'automation.sqlite'));
  const indexes = (
    check.prepare('PRAGMA index_list(automation_action_intents)').all() as {
      name: string;
    }[]
  ).map(({ name }) => name);
  check.close();
  expect(indexes).toContain('automation_action_intents_episode_retry');
  expect(indexes).not.toContain('automation_action_intents_episode');
});
