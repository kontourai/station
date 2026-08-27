/**
 * Focused test for roadmap #753 review polish item 3: the
 * `WorkflowProcessProjectionEntry` this service builds must carry
 * `has_unresolved_critique` in `extensions['flow-agents']` when the signal is
 * defined — `@kontourai/console-server`'s own `WorkflowProcessProjectionEntry`
 * type declares this field (verified against the pinned package's
 * `workflow-process-bridge.d.ts`), and upstream flow-agents populates it.
 *
 * Kept in its own file, separate from `operating-state-service.test.ts`
 * (whose header documents "no mocks on
 * `translateWorkflowProcessProjectionEnvelope`" as a deliberate real-pipeline
 * proof) — `WorkflowProcessProjectionEntry.extensions` does not survive
 * `translateWorkflowProcessProjectionEnvelope`'s translation into
 * `ConsoleEventRecord`s (verified against the pinned package's
 * `workflow-process-bridge.js`: `translateProcessEntry` only reads
 * `extensions['flow-agents'].phase`/`.updated_at`, never forwards the whole
 * extensions object into the emitted event's payload), so the final
 * `OperatingState` this service returns has nowhere to carry the field
 * through. This test therefore spies on the real
 * `translateWorkflowProcessProjectionEnvelope` (delegating to the actual
 * implementation via `importOriginal`, not replacing its behavior) purely to
 * capture the ENVELOPE this service constructs before handing it off —
 * proving the entry-construction half of the pipeline, not re-asserting the
 * translation behavior the sibling file already proves unmocked.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowState } from '@kontourai/station-contracts/workflow';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  workflowSidecarTransitions: { add: vi.fn() },
}));

const translateSpy = vi.fn();
vi.mock('@kontourai/console-server', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/console-server')>();
  return {
    ...actual,
    translateWorkflowProcessProjectionEnvelope: (
      ...args: Parameters<
        typeof actual.translateWorkflowProcessProjectionEnvelope
      >
    ) => {
      translateSpy(...args);
      return actual.translateWorkflowProcessProjectionEnvelope(...args);
    },
  };
});

const { WorkflowSidecarService } = await import(
  '../../evidence/workflow-sidecar-service.js'
);
const { OperatingStateService } = await import('../operating-state-service.js');

const logger = { debug: vi.fn(), warn: vi.fn() };

function writeState(
  cwd: string,
  taskSlug: string,
  state: Partial<WorkflowState> = {},
): void {
  const dir = join(cwd, '.kontourai', 'flow-agents', taskSlug);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  const full: WorkflowState = {
    schema_version: '1.0',
    task_slug: taskSlug,
    status: 'in_progress',
    phase: 'execution',
    created_at: now,
    updated_at: now,
    next_action: { status: 'continue', summary: 'Keep going' },
    ...state,
  };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(full, null, 2));
}

function writeTrustBundle(
  cwd: string,
  taskSlug: string,
  claims: Record<string, unknown>[],
): void {
  const dir = join(cwd, '.kontourai', 'flow-agents', taskSlug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'trust.bundle'), JSON.stringify({ claims }, null, 2));
}

describe('OperatingStateService — WorkflowProcessProjectionEntry.extensions.has_unresolved_critique (roadmap #753)', () => {
  let cwd: string;
  let service: InstanceType<typeof OperatingStateService>;

  beforeEach(() => {
    translateSpy.mockClear();
    cwd = mkdtempSync(join(tmpdir(), 'operating-state-extension-'));
    service = new OperatingStateService(
      { workflowSidecarService: new WorkflowSidecarService({ logger }) },
      { logger, now: () => Date.parse('2026-07-23T12:00:00.000Z') },
    );
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test('is included (true) when the task has an unresolved live critique', () => {
    writeState(cwd, 'demo-task', { status: 'in_progress' });
    writeTrustBundle(cwd, 'demo-task', [
      {
        id: 'critique-1',
        value: 'not_verified',
        metadata: {
          origin: 'critique',
          workflow_subject_ref: 'flow-agents://session/demo-task',
        },
      },
    ]);

    service.deriveOperatingState(cwd, 'demo');

    expect(translateSpy).toHaveBeenCalledTimes(1);
    const envelope = translateSpy.mock.calls[0]?.[0];
    const entry = envelope.processes[0];
    expect(entry.extensions['flow-agents'].has_unresolved_critique).toBe(true);
  });

  test('is included (false) when a trust.bundle was read but has no unresolved critiques', () => {
    writeState(cwd, 'demo-task', { status: 'in_progress' });
    writeTrustBundle(cwd, 'demo-task', []);

    service.deriveOperatingState(cwd, 'demo');

    const envelope = translateSpy.mock.calls[0]?.[0];
    const entry = envelope.processes[0];
    expect(entry.extensions['flow-agents'].has_unresolved_critique).toBe(false);
  });

  test('is omitted entirely when no trust.bundle exists (no signal available, never a fabricated false)', () => {
    writeState(cwd, 'demo-task', { status: 'in_progress' });

    service.deriveOperatingState(cwd, 'demo');

    const envelope = translateSpy.mock.calls[0]?.[0];
    const entry = envelope.processes[0];
    expect(
      Object.hasOwn(entry.extensions['flow-agents'], 'has_unresolved_critique'),
    ).toBe(false);
  });
});
