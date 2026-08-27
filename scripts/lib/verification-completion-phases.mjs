import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CANONICAL_COMPLETION_LANE } from '../verification-lanes.mjs';
import { writeReceiptSecurely } from './test-reliability.mjs';
import {
  createOwnedRunner,
  runWithinDeadline,
} from './verification-execution-lifecycle.mjs';
import { isLaneHostPressureGated } from './verification-host-pressure.mjs';
import { createVerificationRequest } from './verification-receipt.mjs';

function phaseRecordRelativePath(request, phase) {
  return `.kontourai/verification-phase-records/${request.key}/${phase.id}.json`;
}

function completionPhaseAttachment(context, phase) {
  const relative = phaseRecordRelativePath(context.request, phase);
  return {
    name: `completion-${phase.id}.json`,
    path: join(context.before.worktree, relative),
    contentType: 'application/json',
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function phaseRecordPassed(record) {
  return (
    record?.terminal?.status === 'completed' &&
    record.terminal?.exitCode === 0 &&
    record.terminal?.passed === true &&
    isPlainObject(record.output) &&
    record.output.truncated === false &&
    record.output.invalidUtf8 === false &&
    isPlainObject(record.cleanup) &&
    ['passed', 'not_required'].includes(record.cleanup.status) &&
    Number.isInteger(record.cleanup.survivingOwnedChildren) &&
    record.cleanup.survivingOwnedChildren === 0
  );
}

function completedPhaseCheckpoint(context, phase) {
  try {
    const record = JSON.parse(
      readFileSync(
        join(
          context.before.worktree,
          phaseRecordRelativePath(context.request, phase),
        ),
        'utf8',
      ),
    );
    return (
      record?.kind === 'completion-phase-receipt' &&
      record.parentRequestKey === context.request.key &&
      record.beforeRequestKey === context.request.key &&
      record.afterRequestKey === context.request.key &&
      record.phase?.id === phase.id &&
      record.phase?.command === phase.command &&
      record.phase?.weight === phase.weight &&
      record.phase?.timeoutMs === phase.timeoutMs &&
      phaseRecordPassed(record)
    );
  } catch {
    return false;
  }
}

function phasePassed(raw) {
  const cleanupStatus = raw?.cleanup?.status ?? 'not_required';
  return (
    raw?.status === 0 &&
    !raw?.error &&
    !raw?.signal &&
    raw?.output?.truncated !== true &&
    raw?.output?.invalidUtf8 !== true &&
    ['passed', 'not_required'].includes(cleanupStatus) &&
    (raw?.cleanup?.survivingOwnedChildren ?? 0) === 0
  );
}

function createCompletionOutputCollector() {
  const stdout = [];
  const stderr = [];
  const integrity = { truncated: false, invalidUtf8: false };
  const cleanup = { status: 'not_required', survivingOwnedChildren: 0 };
  return {
    append(phase, raw) {
      stdout.push(
        `\n[completion:${phase.id}]\n${raw?.output?.stdout?.text ?? ''}`,
      );
      stderr.push(
        `\n[completion:${phase.id}]\n${raw?.output?.stderr?.text ?? ''}`,
      );
      integrity.truncated ||= raw?.output?.truncated === true;
      integrity.invalidUtf8 ||= raw?.output?.invalidUtf8 === true;
      if (raw?.cleanup?.status === 'failed') cleanup.status = 'failed';
      else if (cleanup.status !== 'failed' && raw?.cleanup?.status === 'passed')
        cleanup.status = 'passed';
      cleanup.survivingOwnedChildren = Math.max(
        cleanup.survivingOwnedChildren,
        raw?.cleanup?.survivingOwnedChildren ?? 0,
      );
    },
    output: () => ({
      stdout: { text: stdout.join('') },
      stderr: { text: stderr.join('') },
      truncated: integrity.truncated,
      invalidUtf8: integrity.invalidUtf8,
    }),
    cleanup: () => ({ ...cleanup }),
  };
}

function completionPhaseLane(context, phase) {
  return {
    ...context.lane,
    ...phase,
    completion: false,
    diagnostic: true,
    phases: undefined,
  };
}

function writeCompletionPhaseRecord({ context, phase, before, after, raw }) {
  const record = {
    kind: 'completion-phase-receipt',
    parentRequest: context.request,
    parentRequestKey: context.request.key,
    phase: {
      id: phase.id,
      command: phase.command,
      weight: phase.weight,
      timeoutMs: phase.timeoutMs,
      queueStartedAt: raw?.phaseTiming?.queueStartedAt ?? null,
      executionStartedAt: raw?.phaseTiming?.executionStartedAt ?? null,
      executionDeadlineAt: raw?.phaseTiming?.executionDeadlineAt ?? null,
    },
    beforeRequestKey: createVerificationRequest(
      CANONICAL_COMPLETION_LANE,
      before,
    ).key,
    afterRequestKey: createVerificationRequest(CANONICAL_COMPLETION_LANE, after)
      .key,
    terminal: {
      status: raw?.deadlineExpired
        ? 'timed_out'
        : phasePassed(raw)
          ? 'completed'
          : 'failed',
      exitCode: Number.isInteger(raw?.status) ? raw.status : null,
      passed: phasePassed(raw),
    },
    output: {
      truncated: raw?.output?.truncated === true,
      invalidUtf8: raw?.output?.invalidUtf8 === true,
    },
    cleanup: {
      status: raw?.cleanup?.status ?? 'not_required',
      survivingOwnedChildren: raw?.cleanup?.survivingOwnedChildren ?? 0,
    },
  };
  const attachment = completionPhaseAttachment(context, phase);
  writeReceiptSecurely(
    attachment.path.slice(context.before.worktree.length + 1),
    `${JSON.stringify(record, null, 2)}\n`,
    context.before.worktree,
  );
  return attachment;
}

function completionPhaseSequenceIsExact(context) {
  try {
    return context.lane.phases.every((phase) => {
      const record = JSON.parse(
        readFileSync(
          join(
            context.before.worktree,
            phaseRecordRelativePath(context.request, phase),
          ),
          'utf8',
        ),
      );
      return (
        record.parentRequestKey === context.request.key &&
        record.beforeRequestKey === context.request.key &&
        record.afterRequestKey === context.request.key &&
        phaseRecordPassed(record)
      );
    });
  } catch {
    return false;
  }
}

async function runCompletionPhaseSequence(input) {
  const { context, directory, owner, outputLock, getLease, setLease, signal } =
    input;
  const { seams } = input;
  const phaseRoot = join(
    context.before.worktree,
    '.kontourai',
    'verification-phase-records',
    context.request.key,
  );
  seams.ensureDirectory(phaseRoot);
  const output = createCompletionOutputCollector();
  const attachments = [];
  for (const [index, phase] of context.lane.phases.entries()) {
    if (completedPhaseCheckpoint(context, phase)) {
      output.append(phase, { status: 0 });
      attachments.push(completionPhaseAttachment(context, phase));
      continue;
    }
    const lane = completionPhaseLane(context, phase);
    setLease({
      ...getLease(),
      state: 'queued',
      weight: phase.weight,
      phase: {
        id: phase.id,
        index,
        total: context.lane.phases.length,
        queueStartedAt: context.now(),
        queueDeadlineAt: context.absoluteDeadline,
      },
      heartbeatAt: context.now(),
    });
    const admission = await seams.admitAndOwnOutput({
      root: context.root,
      directoryKey: seams.requestDirectoryKey(directory),
      owner,
      lane,
      capacity: context.capacity,
      outputLock,
      staleMs: context.staleMs,
      signal,
      deadline: context.absoluteDeadline,
      heartbeatMs: context.heartbeatMs,
      wait: context.wait,
      now: context.now,
      currentLease: getLease,
      updateLease: setLease,
      hostPressureGated: isLaneHostPressureGated(lane),
      hostCpuSampler: context.hostCpuSampler,
      hostPressureWaitMs: context.hostPressureWaitMs,
    });
    if (!admission.admitted) {
      if (admission.outputOwned) seams.removeOwnedDirectory(outputLock, owner);
      return {
        status: null,
        ...(admission.deadlineExpired ? { deadlineExpired: true } : {}),
        signal:
          admission.canceled && !admission.deadlineExpired
            ? 'SIGTERM'
            : undefined,
        error:
          admission.canceled || admission.deadlineExpired
            ? undefined
            : new Error('completion phase admission failed'),
        output: output.output(),
      };
    }
    const queuedPhase = getLease().phase ?? {};
    const executionStartedAt = context.now();
    const executionDeadlineAt = Math.min(
      context.absoluteDeadline,
      executionStartedAt + phase.timeoutMs,
    );
    setLease({
      ...getLease(),
      state: 'running',
      phase: { ...queuedPhase, executionStartedAt, executionDeadlineAt },
      heartbeatAt: executionStartedAt,
    });
    let retainOutput = false;
    let result;
    try {
      seams.assertExpectedRequest({
        lane: context.lane,
        cwd: context.cwd,
        collectProvenance: context.collectProvenance,
        expectedRequest: context.expectedRequest,
        stage: 'execution',
      });
      const before = context.collectProvenance({ cwd: context.cwd });
      const execute = context.phaseRunner
        ? ({ signal: phaseSignal }) =>
            context.phaseRunner({
              phase,
              signal: phaseSignal,
              request: context.request,
            })
        : createOwnedRunner({
            lane,
            worktree: context.before.worktree,
            outputLock,
            owner,
            outputOwned: admission.outputOwned,
            now: context.now,
            currentLease: getLease,
            updateLease: setLease,
            privateCommand: (phaseLane) =>
              seams.privateCommand(phaseLane, context.toolchain),
            processIdentity: seams.processIdentity,
            writeOwnedLease: seams.writeOwnedLease,
            env: context.env,
          });
      const phaseDeadline =
        getLease().phase?.executionDeadlineAt ?? executionDeadlineAt;
      let raw;
      let timedOut = false;
      try {
        ({ raw, timedOut } = await runWithinDeadline({
          execute,
          lane,
          request: context.request,
          signal,
          canceled: getLease().state === 'canceling',
          deadline: phaseDeadline,
          now: context.now,
          fence: () => {
            retainOutput = true;
            return setLease({
              ...getLease(),
              state: 'fenced',
              heartbeatAt: context.now(),
            });
          },
        }));
      } catch (error) {
        raw = {
          status: null,
          error,
          deadlineExpired: context.now() >= phaseDeadline,
        };
        timedOut = raw.deadlineExpired;
      }
      if (timedOut) raw = { ...raw, deadlineExpired: true };
      raw = {
        ...raw,
        phaseTiming: {
          queueStartedAt: getLease().phase?.queueStartedAt ?? null,
          executionStartedAt,
          executionDeadlineAt: phaseDeadline,
        },
      };
      const after = context.collectProvenance({ cwd: context.cwd });
      result = {
        raw,
        attachment: writeCompletionPhaseRecord({
          context,
          phase,
          before,
          after,
          raw,
        }),
        outputRetained: retainOutput,
      };
    } finally {
      if (admission.outputOwned && !retainOutput)
        seams.removeOwnedDirectory(outputLock, owner);
    }
    output.append(phase, result.raw);
    attachments.push(result.attachment);
    if (!phasePassed(result.raw))
      return {
        ...result.raw,
        output: output.output(),
        cleanup: output.cleanup(),
        ...(result.outputRetained ? { outputRetained: true } : {}),
        attachmentRoot: phaseRoot,
        attachments,
      };
  }
  if (!completionPhaseSequenceIsExact(context))
    return {
      status: null,
      error: new Error('completion phase receipt validation failed'),
      cleanup: output.cleanup(),
    };
  return {
    status: 0,
    output: output.output(),
    cleanup: output.cleanup(),
    attachmentRoot: phaseRoot,
    attachments,
  };
}

export function createCompletionPhaseRunner(input) {
  return async ({ signal } = {}) => {
    try {
      return await runCompletionPhaseSequence({ ...input, signal });
    } catch (error) {
      return {
        status: null,
        error,
        output: {
          stdout: { text: '' },
          stderr: { text: error?.stack ?? String(error) },
        },
      };
    }
  };
}
