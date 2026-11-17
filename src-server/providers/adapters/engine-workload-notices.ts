/**
 * Workload notices for a running engine (#5113): what an adapter tells its
 * engine when the engine's own workload scope nears its memory limit, leaves
 * it, or loses a process to the kernel OOM killer.
 *
 * WorkloadResources announces each transition once to the engine process's
 * subscribers (`watchChildWorkloadNotices`); it knows nothing about
 * adapters. An adapter keeps one {@link EngineWorkloadNotices} per session,
 * hands it each notice, and drains it into the engine's context through its
 * own mechanism. This module only words, coalesces and counts.
 */
import {
  WORKLOAD_COMMAND_OOM_KILLED_CODE,
  WORKLOAD_MEMORY_PRESSURE_CLEARED_CODE,
  WORKLOAD_MEMORY_PRESSURE_CODE,
} from '@kontourai/station-contracts/provider';
import type {
  ChildWorkloadNotice,
  ChildWorkloadProcess,
} from '@kontourai/station-shared/child-workload';
import { engineWorkloadNotices } from '../../telemetry/metrics.js';

export type EngineWorkloadNoticeFamily = 'claude' | 'codex';
type Delivery = 'mid-turn' | 'turn-start';

/** An undelivered notice older than this no longer describes the scope. */
const NOTICE_TTL_MS = 10 * 60 * 1000;
/** Each notice's text is at most this many characters. */
const NOTICE_MAX_LENGTH = 360;
const PROCESS_COUNT = 3;
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

function size(bytes: number): string {
  return bytes >= GIB
    ? `${(bytes / GIB).toFixed(1)} GiB`
    : `${Math.max(1, Math.round(bytes / MIB))} MiB`;
}

/**
 * The kernel's command name, already at most 15 characters there; anything
 * but plain name characters is replaced, so a process cannot name itself
 * into the engine's instructions.
 */
function processName(name: string): string {
  return name.slice(0, 15).replace(/[^\w.+-]/g, '?') || '?';
}

function largest(processes: readonly ChildWorkloadProcess[] | undefined) {
  if (!processes?.length) return '';
  return processes
    .slice(0, PROCESS_COUNT)
    .map((row) => `${processName(row.name)} ${size(row.rssBytes)}`)
    .join(', ');
}

function bounded(text: string): string {
  return text.length <= NOTICE_MAX_LENGTH
    ? text
    : `${text.slice(0, NOTICE_MAX_LENGTH - 1)}…`;
}

/** One notice as one short sentence pair, with no paths, argv or secrets. */
function workloadNoticeText(notice: ChildWorkloadNotice): string {
  if (notice.kind === 'pressure-enter') {
    const share = Math.round(
      (notice.workingSetBytes / notice.memoryMaxBytes) * 100,
    );
    const top = largest(notice.largestProcesses);
    return bounded(
      `This session's memory is at ${share}% of its ${size(notice.memoryMaxBytes)} limit${top ? `; largest: ${top}` : ''}. Stop or serialize memory-heavy commands before the kernel kills one.`,
    );
  }
  if (notice.kind === 'pressure-exit')
    return bounded(
      `This session's memory is back below ${notice.thresholdPercent - 5}% of its ${size(notice.memoryMaxBytes)} limit.`,
    );
  const kills = notice.kill.newKills;
  const limit = notice.kill.memoryMaxBytes
    ? ` ${size(notice.kill.memoryMaxBytes)}`
    : '';
  const top = largest(notice.largestProcesses);
  return bounded(
    `The kernel killed ${kills} ${kills === 1 ? 'process' : 'processes'} in this session for exceeding its${limit} memory limit${top ? `; largest now: ${top}` : ''}. A command that just failed may have been killed; run memory-heavy commands one at a time.`,
  );
}

/**
 * The `runtime.warning` fields the transcript shows for one notice: the same
 * sentence the engine is told, and only counts and sizes as details.
 */
export function workloadNoticeWarning(notice: ChildWorkloadNotice): {
  severity: 'warning';
  code: string;
  message: string;
  details: Record<string, number>;
} {
  const message = workloadNoticeText(notice);
  if (notice.kind === 'oom-kill')
    return {
      severity: 'warning',
      code: WORKLOAD_COMMAND_OOM_KILLED_CODE,
      message,
      details: {
        newKills: notice.kill.newKills,
        oomKills: notice.kill.oomKills,
        ...(notice.kill.memoryMaxBytes
          ? { memoryMaxBytes: notice.kill.memoryMaxBytes }
          : {}),
      },
    };
  return {
    severity: 'warning',
    code:
      notice.kind === 'pressure-enter'
        ? WORKLOAD_MEMORY_PRESSURE_CODE
        : WORKLOAD_MEMORY_PRESSURE_CLEARED_CODE,
    message,
    details: {
      workingSetBytes: notice.workingSetBytes,
      memoryMaxBytes: notice.memoryMaxBytes,
      thresholdPercent: notice.thresholdPercent,
    },
  };
}

interface Pending {
  notice: ChildWorkloadNotice;
  at: number;
}

/** A drained set of notices, as one block of engine context. */
export interface EngineWorkloadNoticeBatch {
  readonly text: string;
  readonly notices: readonly Pending[];
}

/**
 * One session's undelivered workload notices. Notices arrive only on
 * transitions; this keeps at most one pressure notice and one kill notice
 * pending, so an engine that sees them late sees the current state once:
 * entering and leaving pressure before delivery cancel out, and kills
 * accumulate into one.
 */
export class EngineWorkloadNotices {
  private pending: Pending[] = [];
  private ended = false;

  constructor(
    private readonly family: EngineWorkloadNoticeFamily,
    private readonly now: () => number = Date.now,
  ) {}

  private count(notice: ChildWorkloadNotice, outcome: string): void {
    engineWorkloadNotices.add(1, {
      provider_family: this.family,
      kind: notice.kind,
      outcome,
    });
  }

  /** Queues one transition for the engine. Ignored once the session ended. */
  receive(notice: ChildWorkloadNotice, at = this.now()): void {
    if (this.ended) return;
    if (notice.kind === 'oom-kill') {
      const index = this.pending.findIndex(
        (entry) => entry.notice.kind === 'oom-kill',
      );
      const earlier = this.pending[index]?.notice;
      if (earlier?.kind === 'oom-kill') {
        this.count(earlier, 'superseded');
        this.pending.splice(index, 1);
        notice = {
          ...notice,
          kill: {
            ...notice.kill,
            newKills: earlier.kill.newKills + notice.kill.newKills,
          },
        };
      }
      this.pending.push({ notice, at });
      return;
    }
    const index = this.pending.findIndex(
      (entry) => entry.notice.kind !== 'oom-kill',
    );
    const earlier = this.pending[index]?.notice;
    if (earlier) {
      this.count(earlier, 'superseded');
      this.pending.splice(index, 1);
      // Entered and left before the engine heard of either: nothing to say.
      if (
        earlier.kind === 'pressure-enter' &&
        notice.kind === 'pressure-exit'
      ) {
        this.count(notice, 'superseded');
        return;
      }
    }
    this.pending.push({ notice, at });
  }

  /** Removes and returns what the engine has not been told, or undefined. */
  take(): EngineWorkloadNoticeBatch | undefined {
    const now = this.now();
    const live: Pending[] = [];
    for (const entry of this.pending) {
      if (now - entry.at > NOTICE_TTL_MS) this.count(entry.notice, 'expired');
      else live.push(entry);
    }
    this.pending = [];
    if (!live.length) return undefined;
    return {
      text: live
        .map(
          ({ notice }) =>
            `Station workload notice: ${workloadNoticeText(notice)}`,
        )
        .join('\n'),
      notices: live,
    };
  }

  /** The engine received this batch. */
  delivered(batch: EngineWorkloadNoticeBatch, delivery: Delivery): void {
    for (const { notice } of batch.notices)
      this.count(notice, `delivered-${delivery}`);
  }

  /**
   * A taken batch did not reach the engine: it is pending again, ahead of
   * (and coalesced with) anything that arrived meanwhile.
   */
  restore(batch: EngineWorkloadNoticeBatch): void {
    if (this.ended) {
      for (const { notice } of batch.notices) this.count(notice, 'discarded');
      return;
    }
    const later = this.pending;
    this.pending = [];
    for (const entry of [...batch.notices, ...later])
      this.receive(entry.notice, entry.at);
  }

  /** The session ended: whatever is pending is never delivered. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const { notice } of this.pending) this.count(notice, 'discarded');
    this.pending = [];
  }
}
