import { randomUUID } from 'node:crypto';
import type { AtomicCommand, AtomicResult } from '@kontourai/monument/testing';
import { entryData, partSchema, prefixDigest, readTape } from './codecs.js';
import {
  canonical,
  digestBytes,
  encode,
  hash,
  RuntimeError,
} from './encoding.js';
import type { ModelPolicy } from './policy.js';
import { validateReceiptCommand } from './receipts.js';
import {
  type AttemptRecord,
  type ModelState,
  type RunRecord,
  resultSchema,
} from './records.js';
import type {
  Attempt,
  BodyRef,
  CurrentAdmission,
  ModelContext,
  ModelProtocol,
  Projection,
  Refused,
  RunKey,
  Snapshot,
} from './types.js';
export type ModelCommand = AtomicCommand<ModelProtocol>;
export type ModelResult<C extends ModelCommand> = AtomicResult<
  ModelProtocol,
  C
>;
export const keyOf = (key: RunKey): string =>
  JSON.stringify([key.scopeId, key.conversationId, key.invocationId]);
// Keys reach decisions only after command/record validation.
function sameRunKey(a: RunKey, b: RunKey): boolean {
  return (
    a.scopeId === b.scopeId &&
    a.conversationId === b.conversationId &&
    a.invocationId === b.invocationId
  );
}
export const same = (a: unknown, b: unknown): boolean =>
  canonical(a) === canonical(b);
export function commandDigest(command: Omit<ModelCommand, 'digest'> | object) {
  const { digest: _digest, ...fields } = command as { digest?: string };
  return hash(fields);
}
export const isRead = (c: ModelCommand): boolean =>
  c.type === 'read' || c.type === 'listOutbox';
const refuse = (reason: Refused['reason']): Refused => ({
  kind: 'refused',
  reason,
});
const snapshotOf = (run: RunRecord): Snapshot => ({
  spec: run.spec,
  fence: run.fence,
  state: run.state,
  nextOrdinal: run.pins.length,
});
export function projectionId(p: Omit<Projection, 'id' | 'body'>): string {
  return [
    p.key.scopeId,
    p.key.conversationId,
    p.key.invocationId,
    p.requestId,
    String(p.attempt),
    p.kind,
    String(p.sequence),
  ]
    .map((x) => `${Buffer.byteLength(x)}:${x}`)
    .join('');
}
function emit(
  state: ModelState,
  run: RunRecord,
  item: Omit<Projection, 'id' | 'key'>,
) {
  const p = { ...item, key: run.spec.key };
  const projection = { ...p, id: projectionId(p) };
  const existing = state.outbox.get(projection.id);
  if (existing) {
    if (!same(existing.projection, projection))
      throw new RuntimeError('DURABLE_CONFLICT');
    return;
  }
  const position = [...state.outbox.values()].filter((v) =>
    sameRunKey(v.projection.key, run.spec.key),
  ).length;
  state.outbox.set(projection.id, {
    projection,
    position,
    acknowledged: false,
  });
}
function abort(state: ModelState, run: RunRecord, attempt: AttemptRecord) {
  if (attempt.state !== 'running') return;
  attempt.state = 'aborted';
  emit(state, run, {
    kind: 'aborted',
    requestId: attempt.attempt.requestId,
    attempt: attempt.attempt.number,
    sequence: 0,
    body: null,
  });
}
export interface DecisionInput {
  readonly state: ModelState;
  readonly context: ModelContext;
  readonly policy: ModelPolicy;
  readonly admission: CurrentAdmission;
  readonly now: number;
  readonly globalOpen?: {
    readonly activeCount: number;
    readonly conversationBusy: boolean;
  };
  readonly readBody: (ref: BodyRef) => Uint8Array;
}
export function decideModel<C extends ModelCommand>(
  command: C,
  input: DecisionInput,
): ModelResult<C>;
export function decideModel(
  command: ModelCommand,
  input: DecisionInput,
): ModelResult<ModelCommand> {
  const { state, context, policy, admission, readBody, now } = input;
  const key = command.type === 'open' ? command.spec.key : command.key;
  const id = keyOf(key);
  const run = state.runs.get(id);
  if (
    run &&
    (!same(admission.binding, run.spec.binding) ||
      admission.writerGeneration !== run.writerGeneration)
  )
    return refuse('unsupported');
  const retired = state.retired.get(id);
  if (
    retired &&
    (!same(admission.binding, retired.binding) ||
      admission.writerGeneration !== retired.writerGeneration)
  )
    return refuse('unsupported');
  if (command.type === 'read' && retired) return refuse('expired');
  if (
    command.type === 'read' &&
    run?.settledAt !== null &&
    run?.settledAt !== undefined &&
    now >= run.settledAt + policy.settledRetentionMs
  )
    return refuse('expired');
  if (command.type === 'read')
    return run
      ? {
          kind: 'found',
          snapshot: snapshotOf(run),
          pins: run.pins.map((p) => p.pin),
        }
      : { kind: 'absent' };
  if (command.type === 'listOutbox') {
    if (
      !Number.isSafeInteger(command.limit) ||
      command.limit < 1 ||
      command.limit > 1024
    )
      return refuse('unsupported');
    const rows = [...state.outbox.values()].filter((row) =>
      sameRunKey(row.projection.key, key),
    );
    const maximum = rows.reduce((n, row) => Math.max(n, row.position), -1);
    const throughPosition = command.throughPosition ?? maximum;
    if (
      !Number.isSafeInteger(throughPosition) ||
      throughPosition < -1 ||
      throughPosition > maximum
    )
      return refuse('unsupported');
    return {
      kind: 'listed',
      throughPosition,
      entries: rows
        .filter((row) => !row.acknowledged && row.position <= throughPosition)
        .sort((a, b) => a.position - b.position)
        .slice(0, command.limit)
        .map((row) => row.projection),
    };
  }
  if (!same(command.digest, commandDigest(command))) return refuse('conflict');
  if (retired) {
    const receipt = state.receipts.get(canonical([id, command.operationId]));
    if (
      receipt &&
      (receipt.digest !== command.digest ||
        receipt.commandType !== command.type)
    )
      return refuse('conflict');
    if (command.type === 'open' && hash(command.spec) !== retired.specDigest)
      return refuse('conflict');
    return refuse('expired');
  }
  const receiptId = canonical([id, command.operationId]);
  const receipt = state.receipts.get(receiptId);
  if (receipt) {
    if (
      receipt.digest !== command.digest ||
      receipt.commandType !== command.type
    )
      return refuse('conflict');
    if (
      command.type !== 'acknowledge' &&
      run?.settledAt !== null &&
      run?.settledAt !== undefined &&
      now >= run.settledAt + policy.settledRetentionMs
    )
      return refuse('expired');
    if (!run) return refuse('unavailable');
    validateReceiptCommand(state, run, receipt, command);
    const answer = receipt.answer;
    if (command.type === 'begin' && answer.kind === 'execute')
      return {
        kind: 'acknowledged',
        fence: answer.fence,
        originalGrantId: answer.attempt.grantId,
      };
    if (answer.kind === 'applied' || answer.kind === 'already-applied') {
      if (answer.fence) return { kind: 'already-applied', fence: answer.fence };
      return { kind: 'already-applied' };
    }
    // All receipts are parsed and command-specific before persistence. Reads
    // and first open/takeOver never mint a provider execution permit.
    if (
      answer.kind === 'opened' ||
      answer.kind === 'existing' ||
      answer.kind === 'restored' ||
      answer.kind === 'replay' ||
      answer.kind === 'already-begun' ||
      answer.kind === 'acknowledged' ||
      answer.kind === 'refused'
    )
      return answer;
    return refuse('unavailable');
  }
  if (command.type === 'open' && run && !same(command.spec, run.spec))
    return refuse('conflict');
  if (
    command.type !== 'acknowledge' &&
    run?.settledAt !== null &&
    run?.settledAt !== undefined &&
    now >= run.settledAt + policy.settledRetentionMs
  )
    return refuse('expired');
  const remember = (answer: ModelResult<ModelCommand>) => {
    if (answer.kind !== 'refused')
      state.receipts.set(receiptId, {
        operationId: command.operationId,
        digest: command.digest,
        commandType: command.type,
        answer: resultSchema.parse(answer),
      });
    return answer;
  };
  if (command.type === 'open') {
    if (!same(admission.binding, command.spec.binding))
      return refuse('unsupported');
    if (run) {
      if (!same(run.spec, command.spec)) return refuse('conflict');
      if (
        run.settledAt !== null &&
        now - run.settledAt >= policy.settledRetentionMs
      )
        return refuse('expired');
      return remember({ kind: 'existing', snapshot: snapshotOf(run) });
    }
    const active = [...state.runs.values()].filter(
      (r) => r.state === 'open' || r.state === 'running',
    );
    if (
      input.globalOpen?.conversationBusy ??
      active.some(
        (r) =>
          r.spec.key.scopeId === key.scopeId &&
          r.spec.key.conversationId === key.conversationId,
      )
    )
      return refuse('busy');
    if ((input.globalOpen?.activeCount ?? active.length) >= policy.maxOpenRuns)
      return refuse('capacity');
    const entry = entryData(
      command.spec.entry.body.codec,
      readBody(command.spec.entry.body),
    );
    if (
      !same(entry.binding, command.spec.binding) ||
      entry.sourceCutoff !== command.spec.entry.sourceCutoff ||
      entry.authoredDigest !== command.spec.entry.originalAuthoredDigest ||
      prefixDigest(entry) !== command.spec.entry.effectivePrefixDigest
    )
      return refuse('conflict');
    const created: RunRecord = {
      spec: command.spec,
      fence: { owner: command.owner, revision: '0' },
      state: 'open',
      pins: [],
      writerGeneration: admission.writerGeneration,
      createdAt: now,
      settledAt: null,
    };
    state.runs.set(id, created);
    return remember({ kind: 'opened', snapshot: snapshotOf(created) });
  }
  if (!run) return refuse('unavailable');
  if (command.type === 'acknowledge') {
    const row = state.outbox.get(command.projectionId);
    if (
      !row ||
      !sameRunKey(row.projection.key, key) ||
      hash(row.projection) !== command.projectionDigest
    )
      return refuse('conflict');
    row.acknowledged = true;
    return remember({ kind: 'applied' });
  }
  if (!same(run.fence, command.expected)) return refuse('stale');
  if (run.state === 'cancelled') return refuse('cancelled');
  if (run.state === 'completed' || run.state === 'blocked')
    return refuse('expired');
  const bump = () => {
    run.fence = {
      ...run.fence,
      revision: String(BigInt(run.fence.revision) + 1n),
    };
  };
  const ack = () => {
    bump();
    return remember({ kind: 'applied', fence: run.fence });
  };
  if (command.type === 'takeOver') {
    if (command.owner.id === run.fence.owner.id) return refuse('conflict');
    const verdict = context.liveness(structuredClone(run.fence.owner));
    if (verdict !== 'dead')
      return refuse(verdict === 'live' ? 'busy' : 'unknown-owner');
    for (const p of run.pins) for (const a of p.attempts) abort(state, run, a);
    run.fence = { owner: command.owner, revision: run.fence.revision };
    bump();
    return remember({
      kind: 'restored',
      snapshot: snapshotOf(run),
      entry: run.spec.entry,
      pendingRequest:
        run.pins.find((p) => !p.attempts.some((a) => a.state === 'completed'))
          ?.pin ?? null,
    });
  }
  if (context.liveness(structuredClone(run.fence.owner)) !== 'live')
    return refuse('unknown-owner');
  if (command.type === 'pin') {
    const existing = run.pins.find(
      (p) => p.pin.ordinal === command.pin.ordinal,
    );
    if (existing)
      return same(existing.pin, command.pin)
        ? remember({ kind: 'applied', fence: run.fence })
        : refuse('conflict');
    const previous =
      run.pins.at(-1)?.attempts.find((a) => a.state === 'completed')?.tape
        ?.digest ?? null;
    if (
      command.pin.ordinal !== run.pins.length ||
      command.pin.entryDigest !== run.spec.entry.body.digest ||
      command.pin.previousResponseDigest !== previous ||
      (run.pins.length > 0 && previous === null) ||
      run.pins.some((p) => p.pin.requestId === command.pin.requestId)
    )
      return refuse('conflict');
    if (
      run.pins.length >= policy.maxCallsPerRun ||
      command.pin.request.byteLength > policy.maxRequestBytes
    )
      return refuse('capacity');
    if (command.pin.request.codec !== 'runtime-ai-sdk-v3-request/1')
      return refuse('unsupported');
    readBody(command.pin.request);
    run.pins.push({ pin: command.pin, attempts: [] });
    return ack();
  }
  if (command.type === 'cancel') {
    for (const p of run.pins) for (const a of p.attempts) abort(state, run, a);
    run.state = 'cancelled';
    run.settledAt = now;
    return ack();
  }
  if (command.type === 'finish') {
    if (run.pins.some((p) => !p.attempts.some((a) => a.state === 'completed')))
      return refuse('busy');
    run.state = command.status;
    run.settledAt = now;
    return ack();
  }
  if (command.type === 'begin') {
    const p = run.pins.find((p) => p.pin.requestId === command.requestId);
    if (!p) return refuse('conflict');
    readBody(run.spec.entry.body);
    readBody(p.pin.request);
    const completed = p.attempts.find((a) => a.state === 'completed');
    if (completed?.tape) {
      readBody(completed.tape);
      return remember({
        kind: 'replay',
        fence: run.fence,
        tape: completed.tape,
        attempt: completed.attempt,
      });
    }
    // Abandonment does not let a live owner issue a second attempt.
    if (p.attempts.some((a) => a.attempt.owner.id === run.fence.owner.id))
      return remember({ kind: 'already-begun', fence: run.fence });
    const attempt: Attempt = {
      requestId: p.pin.requestId,
      number: p.attempts.length + 1,
      owner: run.fence.owner,
      grantId: randomUUID(),
    };
    p.attempts.push({ attempt, state: 'running', partials: [], tape: null });
    run.state = 'running';
    bump();
    return remember({ kind: 'execute', fence: run.fence, attempt });
  }
  const p = run.pins.find((p) => p.pin.requestId === command.attempt.requestId);
  const a = p?.attempts.find((a) => same(a.attempt, command.attempt));
  if (
    !p ||
    !a ||
    a.state !== 'running' ||
    !same(a.attempt.owner, run.fence.owner)
  )
    return refuse('stale');
  if (command.type === 'partial') {
    if (command.sequence !== a.partials.length) return refuse('conflict');
    if (command.body.codec !== 'runtime-ai-sdk-v3-part/1')
      return refuse('unsupported');
    const part = partSchema.parse(
      JSON.parse(new TextDecoder().decode(readBody(command.body))),
    );
    if (part.type.startsWith('tool-') || part.type === 'finish')
      return refuse('unsupported');
    if (
      a.partials.reduce((n, b) => n + b.byteLength, 0) +
        command.body.byteLength >
      policy.maxPartialBytesPerAttempt
    )
      return refuse('capacity');
    a.partials.push(command.body);
    emit(state, run, {
      kind: 'partial',
      requestId: a.attempt.requestId,
      attempt: a.attempt.number,
      sequence: command.sequence,
      body: command.body,
    });
    return ack();
  }
  if (command.type === 'complete') {
    if (command.tape.codec !== 'runtime-ai-sdk-v3-tape/1')
      return refuse('unsupported');
    if (command.tape.byteLength > policy.maxResponseBytes)
      return refuse('capacity');
    const tape = readTape(readBody(command.tape));
    if (
      tape.requestId !== a.attempt.requestId ||
      tape.attempt !== a.attempt.number ||
      command.lastPartialSequence !== a.partials.length - 1
    )
      return refuse('conflict');
    if (
      a.partials.some(
        (b, i) =>
          !tape.parts[i] || digestBytes(encode(tape.parts[i])) !== b.digest,
      )
    )
      return refuse('conflict');
    a.state = 'completed';
    a.tape = command.tape;
    emit(state, run, {
      kind: 'completed',
      requestId: a.attempt.requestId,
      attempt: a.attempt.number,
      sequence: 0,
      body: command.tape,
    });
    return ack();
  }
  abort(state, run, a);
  if (command.reason === 'consumer-cancel') {
    run.state = 'cancelled';
    run.settledAt = now;
  }
  return ack();
}
