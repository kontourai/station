/**
 * Session -> Builder run join (station#189 S4).
 *
 * Every test here is about the same question: what is Station entitled to
 * claim? The join has exactly two admissible paths, and the interesting cases
 * are all the ones that LOOK joinable and are not — a runtime-session value
 * that belongs to a different runtime, two runs claiming the same session, a
 * joined task with no run projected yet. Each of those must reach a surface as
 * an explicit gap, never as a run.
 */

import type {
  WorkflowRunCorrelation,
  WorkflowRunIdentity,
  WorkflowState,
  WorkflowTaskSummary,
} from '@kontourai/station-contracts/workflow';
import { describe, expect, test } from 'vitest';
import {
  readBoundTaskState,
  resolveSessionBuilderRun,
} from '../session-builder-run-join.js';

const STATION_THREAD_ID = 'thread-6377ca0c787f951bb744ed6b';

function sessionBinding(taskSlug: string, cwd = '/repo') {
  return { taskSlug, cwd, ownership: 'read-only-join' as const };
}

function correlation(
  runtimeSession: WorkflowRunIdentity,
): WorkflowRunCorrelation {
  return {
    schema_version: '1.0',
    correlation_id: 'run-9aac6bd3-ac12-4490-90b4-80ff724417c8',
    identities: {
      runtime_session: runtimeSession,
      flow_run: { status: 'present', value: 'kontourai-station-1388' },
    },
  };
}

function task(
  overrides: Partial<WorkflowTaskSummary> & { taskSlug: string },
): WorkflowTaskSummary {
  return {
    status: 'in_progress',
    phase: 'execution',
    updatedAt: '2026-08-01T00:00:00.000Z',
    nextAction: { status: 'continue', summary: 'Keep going' },
    hasHandoff: false,
    path: `.kontourai/flow-agents/${overrides.taskSlug}`,
    ...overrides,
  };
}

function state(
  taskSlug: string,
  overrides: Partial<WorkflowState> = {},
): WorkflowState {
  return {
    schema_version: '1.0',
    task_slug: taskSlug,
    status: 'in_progress',
    phase: 'execution',
    updated_at: '2026-08-01T00:00:00.000Z',
    next_action: { status: 'continue', summary: 'Keep going' },
    ...overrides,
  };
}

function builderFlowRun(taskSlug: string) {
  return {
    run_id: taskSlug,
    definition_id: 'builder.build',
    definition_version: '1.3',
    status: 'active',
    current_step: 'verify',
    run_ref: `.kontourai/flow/runs/${taskSlug}`,
    open_gate_ids: ['verify-gate'],
  };
}

describe('resolveSessionBuilderRun', () => {
  test('joins on Station’s own binding when Station started the session', () => {
    const view = resolveSessionBuilderRun({
      threadId: STATION_THREAD_ID,
      binding: sessionBinding('kontourai-station-1388'),
      boundTaskState: state('kontourai-station-1388', {
        flow_run: builderFlowRun('kontourai-station-1388'),
        run_correlation: correlation({
          status: 'present',
          value: STATION_THREAD_ID,
        }),
      }),
      tasks: [],
    });

    expect(view).toMatchObject({
      matchKind: 'started-by-station',
      identityStatus: 'present',
      taskSlug: 'kontourai-station-1388',
      runRef: '.kontourai/flow/runs/kontourai-station-1388',
    });
    expect(view?.flowRun).toEqual(builderFlowRun('kontourai-station-1388'));
    expect(view?.reason).toBeUndefined();
  });

  test('a Station-started join reports the run’s identity gap without downgrading the join', () => {
    // The producer could not stamp a runtime session. That says nothing about
    // whether Station started this session against this task — it did, and
    // that binding is Station's own record. The two fields must disagree here.
    const view = resolveSessionBuilderRun({
      threadId: STATION_THREAD_ID,
      binding: sessionBinding('headless-run'),
      boundTaskState: state('headless-run', {
        flow_run: builderFlowRun('headless-run'),
        run_correlation: correlation({
          status: 'unsupported',
          reason: 'the runtime does not expose a session identity',
        }),
      }),
      tasks: [],
    });

    expect(view).toMatchObject({
      matchKind: 'started-by-station',
      identityStatus: 'unsupported',
      reason: 'the runtime does not expose a session identity',
      taskSlug: 'headless-run',
    });
  });

  test('joins on an exact run_correlation match for a session Station did not start', () => {
    const view = resolveSessionBuilderRun({
      threadId: STATION_THREAD_ID,
      binding: null,
      boundTaskState: null,
      tasks: [
        task({
          taskSlug: 'other-run',
          flowRun: builderFlowRun('other-run'),
          runCorrelation: correlation({
            status: 'present',
            value: 'thread-4534a2d088649e3c537ec1d4',
          }),
        }),
        task({
          taskSlug: 'kontourai-station-1388',
          flowRun: builderFlowRun('kontourai-station-1388'),
          runCorrelation: correlation({
            status: 'present',
            value: STATION_THREAD_ID,
          }),
        }),
      ],
    });

    expect(view).toMatchObject({
      matchKind: 'correlation-matched',
      identityStatus: 'present',
      taskSlug: 'kontourai-station-1388',
    });
  });

  test('a runtime_session value that is not this session renders unavailable, never the nearest run', () => {
    // The live shape of this failure: `runtime_session.value` is whatever the
    // producing runtime had to hand — here a bare Codex CLI thread id — and it
    // simply is not a Station-issued id. There is exactly one Builder run in
    // the workspace and it is NOT this session's.
    const view = resolveSessionBuilderRun({
      threadId: 'thread-station-issued-0001',
      binding: null,
      boundTaskState: null,
      tasks: [
        task({
          taskSlug: 'codex-driven-run',
          flowRun: builderFlowRun('codex-driven-run'),
          runCorrelation: correlation({
            status: 'present',
            value: '01998f2c-4a1e-7a2b-9f00-6f2f0b1c2d3e',
          }),
        }),
      ],
    });

    expect(view).toMatchObject({
      matchKind: 'none',
      identityStatus: 'unavailable',
    });
    expect(view?.taskSlug).toBeUndefined();
    expect(view?.flowRun).toBeUndefined();
    expect(view?.reason).toContain('runtime identity');
  });

  test('no substring, prefix, or case-insensitive near-match is ever accepted', () => {
    const near = [
      `${STATION_THREAD_ID}-2`,
      STATION_THREAD_ID.slice(0, -1),
      STATION_THREAD_ID.toUpperCase(),
      ` ${STATION_THREAD_ID} `,
    ];
    for (const value of near) {
      const view = resolveSessionBuilderRun({
        threadId: STATION_THREAD_ID,
        binding: null,
        boundTaskState: null,
        tasks: [
          task({
            taskSlug: 'near-miss',
            flowRun: builderFlowRun('near-miss'),
            runCorrelation: correlation({ status: 'present', value }),
          }),
        ],
      });
      expect(view, `must not join on ${JSON.stringify(value)}`).toMatchObject({
        matchKind: 'none',
        identityStatus: 'unavailable',
      });
    }
  });

  test('two sidecars claiming the same session render unavailable and name both', () => {
    // Not hypothetical: one runtime session drives several Builder runs in
    // sequence, so the same thread id genuinely appears in several sidecars
    // (live: thread-6377ca0c… in three of station's own). Picking the newest
    // would be a coin flip presented as a fact.
    const view = resolveSessionBuilderRun({
      threadId: STATION_THREAD_ID,
      binding: null,
      boundTaskState: null,
      tasks: [
        task({
          taskSlug: 'kontourai-station-1361',
          flowRun: builderFlowRun('kontourai-station-1361'),
          runCorrelation: correlation({
            status: 'present',
            value: STATION_THREAD_ID,
          }),
        }),
        task({
          taskSlug: 'kontourai-station-1388',
          flowRun: builderFlowRun('kontourai-station-1388'),
          runCorrelation: correlation({
            status: 'present',
            value: STATION_THREAD_ID,
          }),
        }),
      ],
    });

    expect(view).toMatchObject({
      matchKind: 'none',
      identityStatus: 'unavailable',
    });
    expect(view?.flowRun).toBeUndefined();
    expect(view?.reason).toContain('kontourai-station-1361');
    expect(view?.reason).toContain('kontourai-station-1388');
  });

  test('a workspace with nothing joinable renders no row at all', () => {
    expect(
      resolveSessionBuilderRun({
        threadId: STATION_THREAD_ID,
        binding: null,
        boundTaskState: null,
        tasks: [],
      }),
    ).toBeNull();

    // Sidecars exist, but none carries a runtime-session identity: there is
    // no join to disclose the absence of, so no row.
    expect(
      resolveSessionBuilderRun({
        threadId: STATION_THREAD_ID,
        binding: null,
        boundTaskState: null,
        tasks: [
          task({ taskSlug: 'plain-task' }),
          task({
            taskSlug: 'incomplete-envelope',
            runCorrelation: {
              status: 'incomplete',
              reason: 'the producer could not assemble an envelope',
            },
          }),
          task({
            taskSlug: 'unsupported-identity',
            runCorrelation: correlation({
              status: 'unsupported',
              reason: 'the runtime does not expose a session identity',
            }),
          }),
        ],
      }),
    ).toBeNull();
  });

  test('a joined task with no flow_run reports the join and no progress', () => {
    const view = resolveSessionBuilderRun({
      threadId: STATION_THREAD_ID,
      binding: sessionBinding('just-picked-up'),
      boundTaskState: state('just-picked-up'),
      tasks: [],
    });

    expect(view).toMatchObject({
      matchKind: 'started-by-station',
      identityStatus: 'unavailable',
      taskSlug: 'just-picked-up',
    });
    // The whole point: no fabricated step/status/run_ref for a run that has
    // published no projection.
    expect(view?.flowRun).toBeUndefined();
    expect(view?.runRef).toBeUndefined();
  });

  test('a Station binding whose sidecar has vanished says so instead of falling back to correlation', () => {
    // Falling through to the correlation scan here would let an unrelated run
    // that happens to name this thread take the place of the task Station
    // actually bound — a silent substitution.
    const view = resolveSessionBuilderRun({
      threadId: STATION_THREAD_ID,
      binding: sessionBinding('deleted-task'),
      boundTaskState: null,
      tasks: [
        task({
          taskSlug: 'unrelated-run',
          flowRun: builderFlowRun('unrelated-run'),
          runCorrelation: correlation({
            status: 'present',
            value: STATION_THREAD_ID,
          }),
        }),
      ],
    });

    expect(view).toMatchObject({
      matchKind: 'started-by-station',
      identityStatus: 'unavailable',
      taskSlug: 'deleted-task',
    });
    expect(view?.flowRun).toBeUndefined();
  });

  test('a broken binding is flagged as unreadable, so no surface can call it a run that has not published', () => {
    // The two states a surface must never merge: this one (the sidecar could
    // not be opened at all) and "read fine, has published no run yet". Both
    // arrive with a taskSlug and no flowRun, so the flag is the ONLY thing
    // separating them.
    const broken = resolveSessionBuilderRun({
      threadId: STATION_THREAD_ID,
      binding: sessionBinding('deleted-task'),
      boundTaskState: null,
      tasks: [],
    });
    expect(broken).toMatchObject({
      matchKind: 'started-by-station',
      taskSidecarUnreadable: true,
    });
    expect(broken?.reason).toBeTruthy();
    expect(broken?.flowRun).toBeUndefined();

    const unpublished = resolveSessionBuilderRun({
      threadId: STATION_THREAD_ID,
      binding: sessionBinding('just-picked-up'),
      boundTaskState: state('just-picked-up'),
      tasks: [],
    });
    expect(unpublished?.taskSlug).toBe('just-picked-up');
    expect(unpublished?.flowRun).toBeUndefined();
    expect(unpublished?.taskSidecarUnreadable).toBeUndefined();
  });

  test('the bound task is read by exact path, so a decoy directory cannot shadow it', () => {
    // `listTasks` dedupes by DIRECTORY but reports `state.task_slug`, so a
    // second directory declaring the same slug with a newer `updated_at` would
    // win a scan. The bound path never consults the scan, so a decoy in
    // `tasks` must have no effect whatsoever.
    const view = resolveSessionBuilderRun({
      threadId: STATION_THREAD_ID,
      binding: sessionBinding('kontourai-station-1388'),
      boundTaskState: state('kontourai-station-1388', {
        flow_run: builderFlowRun('kontourai-station-1388'),
      }),
      tasks: [
        task({
          taskSlug: 'kontourai-station-1388',
          updatedAt: '2099-01-01T00:00:00.000Z',
          flowRun: {
            ...builderFlowRun('decoy'),
            current_step: 'learn',
            status: 'completed',
          },
        }),
      ],
    });

    expect(view).toMatchObject({
      matchKind: 'started-by-station',
      taskSlug: 'kontourai-station-1388',
    });
    expect(view?.flowRun).toEqual(builderFlowRun('kontourai-station-1388'));
    expect(view?.runRef).toBe('.kontourai/flow/runs/kontourai-station-1388');
  });

  test('carries the sidecar write time on both join paths, and never invents one', () => {
    const started = resolveSessionBuilderRun({
      threadId: STATION_THREAD_ID,
      binding: sessionBinding('timed'),
      boundTaskState: state('timed', {
        updated_at: '2026-08-01T11:22:33.000Z',
        flow_run: builderFlowRun('timed'),
      }),
      tasks: [],
    });
    expect(started?.sidecarUpdatedAt).toBe('2026-08-01T11:22:33.000Z');

    const matched = resolveSessionBuilderRun({
      threadId: STATION_THREAD_ID,
      binding: null,
      boundTaskState: null,
      tasks: [
        task({
          taskSlug: 'timed',
          updatedAt: '2026-08-01T09:00:00.000Z',
          flowRun: builderFlowRun('timed'),
          runCorrelation: correlation({
            status: 'present',
            value: STATION_THREAD_ID,
          }),
        }),
      ],
    });
    expect(matched?.sidecarUpdatedAt).toBe('2026-08-01T09:00:00.000Z');

    // A broken binding read nothing, so it has no write time to quote.
    expect(
      resolveSessionBuilderRun({
        threadId: STATION_THREAD_ID,
        binding: sessionBinding('gone'),
        boundTaskState: null,
        tasks: [],
      })?.sidecarUpdatedAt,
    ).toBeUndefined();
  });

  test('an unreadable bound sidecar reads as absent, and the error is reported not swallowed', () => {
    // `readState` returns null for a MISSING file but throws for a malformed
    // or schema-invalid one. Both must reach the resolver as `null` so the
    // broken-binding row renders; letting the throw escape produces no row at
    // all, which reads as "no Builder run here".
    const binding = sessionBinding('corrupt-run');
    const failure = new Error('Invalid JSON in state.json');
    const reported: unknown[] = [];

    expect(
      readBoundTaskState(
        {
          readState: () => {
            throw failure;
          },
        },
        binding,
        (error) => reported.push(error),
      ),
    ).toBeNull();
    // The disclosure is the row; the diagnostic still has to reach a log.
    expect(reported).toEqual([failure]);

    // A readable sidecar is passed through untouched, and reports nothing.
    const readable = state('corrupt-run');
    const quiet: unknown[] = [];
    expect(
      readBoundTaskState({ readState: () => readable }, binding, (error) =>
        quiet.push(error),
      ),
    ).toBe(readable);
    expect(quiet).toEqual([]);

    // ...and the null it produces is exactly the broken-binding row.
    expect(
      resolveSessionBuilderRun({
        threadId: STATION_THREAD_ID,
        binding,
        boundTaskState: null,
        tasks: [],
      }),
    ).toMatchObject({
      matchKind: 'started-by-station',
      taskSidecarUnreadable: true,
    });
  });

  test('an empty runtime_session value is not an identity', () => {
    const view = resolveSessionBuilderRun({
      threadId: '',
      binding: null,
      boundTaskState: null,
      tasks: [
        task({
          taskSlug: 'blank-identity',
          flowRun: builderFlowRun('blank-identity'),
          runCorrelation: correlation({ status: 'present', value: '' }),
        }),
      ],
    });

    // Both sides blank must NOT match — that would join every identity-less
    // run to every identity-less session.
    expect(view).toBeNull();
  });
});
