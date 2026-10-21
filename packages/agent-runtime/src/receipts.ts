import { z } from 'zod';
import { type ModelCommand, same } from './decisions.js';
import { hash, RuntimeError, text } from './encoding.js';
import type { ModelState, Receipt, RunRecord } from './records.js';
import type { Fence } from './types.js';

function damaged(): never {
  throw new RuntimeError('DURABLE_RECORD_DAMAGED');
}
const receiptId = z.tuple([z.string(), text]);
function validFence(run: RunRecord, fence: Fence) {
  if (BigInt(fence.revision) > BigInt(run.fence.revision)) damaged();
}
function validAnswer(run: RunRecord, receipt: Receipt) {
  const answer = receipt.answer;
  switch (receipt.commandType) {
    case 'open':
      if (answer.kind !== 'opened' && answer.kind !== 'existing') damaged();
      break;
    case 'takeOver':
      if (answer.kind !== 'restored') damaged();
      break;
    case 'begin':
      if (
        answer.kind !== 'execute' &&
        answer.kind !== 'replay' &&
        answer.kind !== 'already-begun'
      )
        damaged();
      break;
    case 'acknowledge':
      if (answer.kind !== 'applied' || answer.fence !== undefined) damaged();
      break;
    case 'pin':
    case 'partial':
    case 'complete':
    case 'abandon':
    case 'finish':
    case 'cancel':
      if (answer.kind !== 'applied' || !answer.fence) damaged();
      break;
    default:
      damaged();
  }
  if ('fence' in answer && answer.fence) validFence(run, answer.fence);
  if ('snapshot' in answer) {
    if (
      !same(answer.snapshot.spec, run.spec) ||
      answer.snapshot.nextOrdinal > run.pins.length
    )
      damaged();
    validFence(run, answer.snapshot.fence);
    if (
      answer.kind === 'restored' &&
      (!same(answer.entry, run.spec.entry) ||
        (answer.pendingRequest !== null &&
          !run.pins.some((p) => same(p.pin, answer.pendingRequest))))
    )
      damaged();
  }
  if (answer.kind === 'execute' || answer.kind === 'replay') {
    const pin = run.pins.find(
      (p) => p.pin.requestId === answer.attempt.requestId,
    );
    const attempt = pin?.attempts.find((a) => same(a.attempt, answer.attempt));
    if (!attempt) damaged();
    if (
      answer.kind === 'execute' &&
      !same(answer.fence.owner, answer.attempt.owner)
    )
      damaged();
    if (
      answer.kind === 'replay' &&
      (attempt.state !== 'completed' || !same(answer.tape, attempt.tape))
    )
      damaged();
  }
}
export function validateReceipts(state: ModelState): void {
  for (const [id, receipt] of state.receipts) {
    const tuple = receiptId.parse(JSON.parse(id));
    // Owning map keys were strictly validated from current records in this
    // uninterrupted loadState pass. Only decoded strings reach native JSON.
    const generationId = tuple[0];
    if (
      tuple[1] !== receipt.operationId ||
      id !== JSON.stringify([generationId, receipt.operationId])
    )
      damaged();
    const run = state.runs.get(generationId);
    if (!run) {
      if (
        !state.retired.has(generationId) ||
        receipt.answer.kind !== 'refused' ||
        receipt.answer.reason !== 'expired' ||
        ![
          'open',
          'takeOver',
          'begin',
          'pin',
          'partial',
          'complete',
          'abandon',
          'finish',
          'cancel',
          'acknowledge',
        ].includes(receipt.commandType)
      )
        damaged();
    } else validAnswer(run, receipt);
  }
}
/** Correlate historical answers with the exact command being retried. */
export function validateReceiptCommand(
  state: ModelState,
  run: RunRecord,
  receipt: Receipt,
  command: ModelCommand,
): void {
  validAnswer(run, receipt);
  const answer = receipt.answer;
  if (command.type === 'read' || command.type === 'listOutbox') damaged();
  if (command.type === 'open') {
    if (
      (answer.kind !== 'opened' && answer.kind !== 'existing') ||
      !same(command.spec, answer.snapshot.spec)
    )
      damaged();
    if (
      answer.kind === 'opened' &&
      (answer.snapshot.fence.revision !== '0' ||
        !same(command.owner, answer.snapshot.fence.owner))
    )
      damaged();
    return;
  }
  if (command.type === 'acknowledge') {
    const row = state.outbox.get(command.projectionId);
    if (
      !row ||
      !same(row.projection.key, command.key) ||
      hash(row.projection) !== command.projectionDigest
    )
      damaged();
    return;
  }
  if (command.type === 'takeOver') {
    if (
      answer.kind !== 'restored' ||
      !same(answer.snapshot.fence.owner, command.owner) ||
      BigInt(answer.snapshot.fence.revision) !==
        BigInt(command.expected.revision) + 1n
    )
      damaged();
    return;
  }
  if (
    !('fence' in answer) ||
    !answer.fence ||
    !same(answer.fence.owner, command.expected.owner)
  )
    damaged();
  const step =
    BigInt(answer.fence.revision) - BigInt(command.expected.revision);
  if (command.type === 'begin') {
    if (
      (answer.kind === 'execute' || answer.kind === 'replay') &&
      answer.attempt.requestId !== command.requestId
    )
      damaged();
    if (
      !run.pins.some((p) => p.pin.requestId === command.requestId) ||
      step !== (answer.kind === 'execute' ? 1n : 0n)
    )
      damaged();
    return;
  }
  if (command.type === 'pin') {
    if (
      !run.pins.some((p) => same(p.pin, command.pin)) ||
      (step !== 0n && step !== 1n)
    )
      damaged();
  } else if (step !== 1n) damaged();
  if ('attempt' in command) {
    const pin = run.pins.find(
      (p) => p.pin.requestId === command.attempt.requestId,
    );
    const attempt = pin?.attempts.find((a) => same(a.attempt, command.attempt));
    if (!attempt) damaged();
    if (
      command.type === 'partial' &&
      !same(attempt.partials[command.sequence], command.body)
    )
      damaged();
    if (
      command.type === 'complete' &&
      (!same(attempt.tape, command.tape) ||
        command.lastPartialSequence !== attempt.partials.length - 1)
    )
      damaged();
  }
}
