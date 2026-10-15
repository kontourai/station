import { createHash } from 'node:crypto';
import { planTurnBoundaryReconcile } from '@kontourai/monument';
import { openSqliteKernelStorage } from '@kontourai/monument/sqlite';

// Parked #3574 experiment. This is not ContinuationStateStore compatibility.
export function openProbeStorage(path, options = {}) {
  return openSqliteKernelStorage({ path, ...options });
}

export class ContinuationProbe {
  constructor(storage, context, owner, processProbe) {
    this.storage = storage;
    this.context = context;
    this.owner = owner;
    this.processProbe = processProbe;
  }

  async command(command) {
    return this.storage.execute(command, this.context);
  }

  async prepare(runId, iteration, now) {
    const boundaryId = `${runId}:${iteration}`;
    const result = await this.command({
      type: 'turnBoundary.create',
      boundaryId,
      threadId: runId,
      state: 'prepared',
      purpose: 'turn',
      owner: this.owner,
      now,
    });
    if (result.kind !== 'applied') throw new Error(`prepare: ${result.kind}`);
    return boundaryId;
  }

  async invoke(boundaryId, now, execute) {
    const result = await this.command({
      type: 'turnBoundary.transition',
      boundaryId,
      ownerId: this.owner.id,
      from: ['prepared'],
      to: 'invoking',
      now,
    });
    if (result.kind !== 'applied') throw new Error(`invoke: ${result.kind}`);
    return execute();
  }

  async capture(capture, now) {
    const bytes = JSON.stringify(capture);
    const id = {
      callerSessionId: capture.request.run_id,
      tool: 'accepted-turn',
      key: capture.turn_id,
    };
    const claimed = await this.command({
      type: 'requestKeys.claim',
      id,
      digest: createHash('sha256').update(bytes).digest('hex'),
      now: Date.parse(now),
    });
    if (claimed.kind === 'replay') return JSON.parse(claimed.result);
    // An unresolved write is deliberately not overwritten: no durable capture
    // read/CAS command exists to establish equality after an interrupted write.
    if (claimed.kind !== 'claimed') throw new Error(`capture: ${claimed.kind}`);
    const saved = await this.command({
      type: 'requestKeys.complete',
      id,
      result: bytes,
    });
    if (saved.kind !== 'applied')
      throw new Error(`capture save: ${saved.kind}`);
    const accepted = await this.command({
      type: 'turnBoundary.transition',
      boundaryId: capture.turn_id,
      ownerId: this.owner.id,
      from: ['invoking'],
      to: 'accepted',
      providerTurnId: capture.turn_id,
      now,
    });
    if (accepted.kind !== 'applied')
      throw new Error(`accept: ${accepted.kind}`);
    return capture;
  }

  async recover(now) {
    const listed = await this.command({ type: 'turnBoundary.list' });
    if (listed.kind !== 'records') throw new Error(`list: ${listed.kind}`);
    return this.command(
      planTurnBoundaryReconcile(
        listed.records,
        { probe: this.processProbe },
        now,
      ),
    );
  }
}
