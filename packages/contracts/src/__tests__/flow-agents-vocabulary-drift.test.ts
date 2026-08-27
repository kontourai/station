/**
 * Anti-drift tests for Station's flow-agents-aligned vocabulary (roadmap
 * #581, part of epic #580).
 *
 * WHY these tests exist: Station mirrors two pieces of `@kontourai/flow-agents`
 * vocabulary as local TypeScript contracts so the rest of the codebase gets
 * type safety without importing the package everywhere. Mirrors drift
 * silently the moment the upstream package changes its enums on an upgrade —
 * these tests are the upgrade-time alarm: if `npm install` bumps
 * `@kontourai/flow-agents` and either of these facts changes, CI fails here
 * instead of Station quietly validating against a stale vocabulary.
 *
 * (a) `packages/contracts/src/workflow.ts`'s `WORKFLOW_TASK_STATUSES` and
 *     `WORKFLOW_PHASES` must exactly equal the package's own exported
 *     `statuses` (a Set) and `phases` (an array) from its
 *     `cli/workflow-sidecar.js` module (re-exported at the package root).
 * (b) Station's Flow-compatible task-status subset (`TASK_STATUSES` minus
 *     the explicit Station-local `triage` and `canceled` extensions — see
 *     the comment on `TASK_STATUSES` in `task-graph.ts`) must exactly equal
 *     the package's `workItemStatuses` export.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { phases, statuses, workItemStatuses } from '@kontourai/flow-agents';
import { describe, expect, test } from 'vitest';
import { TASK_STATUSES } from '../task-graph.js';
import { WORKFLOW_PHASES, WORKFLOW_TASK_STATUSES } from '../workflow.js';

const require = createRequire(import.meta.url);

interface WorkflowStateSchema {
  properties: {
    flow_run?: {
      required: string[];
      properties: {
        open_gate_ids?: { type: string; uniqueItems?: boolean };
      };
    };
  };
}

function readWorkflowStateSchema(): WorkflowStateSchema {
  const packageJsonPath = require.resolve(
    '@kontourai/flow-agents/package.json',
  );
  return JSON.parse(
    readFileSync(
      path.join(
        path.dirname(packageJsonPath),
        'schemas',
        'workflow-state.schema.json',
      ),
      'utf-8',
    ),
  ) as WorkflowStateSchema;
}

describe('flow-agents vocabulary anti-drift', () => {
  test('mirrored workflow sidecar statuses/phases exactly match the installed package export', () => {
    // `statuses` is a Set in the package; order must still match our array
    // 1:1 since we copy-typed it directly from the source list.
    expect([...statuses]).toEqual(WORKFLOW_TASK_STATUSES);
    expect(phases).toEqual(WORKFLOW_PHASES);
  });

  test('task-status projection directly consumes the installed work-item vocabulary', () => {
    // `triage` is Station's local intake state and `canceled` is its local
    // terminal state. Neither is a Flow Agents work-item lifecycle status.
    const stationNeutralStatuses = new Set(
      TASK_STATUSES.filter(
        (status) => status !== 'triage' && status !== 'canceled',
      ),
    );

    expect(stationNeutralStatuses).toEqual(new Set(workItemStatuses));
  });

  test('installed workflow state exposes the canonical Flow run open-gate projection', () => {
    const flowRun = readWorkflowStateSchema().properties.flow_run;
    expect(flowRun?.required).toContain('open_gate_ids');
    expect(flowRun?.properties.open_gate_ids).toMatchObject({
      type: 'array',
      uniqueItems: true,
    });
  });
});
