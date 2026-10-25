import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InputRequestResponse } from '@kontourai/station-contracts/input-request';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { inputRequestFromMcpElicitation } from '@kontourai/station-shared/mcp-elicitation';
import { test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import {
  type ReportInputBinding,
  ReportInputLedger,
  reportInputKey,
} from '../report-input-ledger.js';

const makeTempDir = trackTempDirs();
function fixture() {
  const root = makeTempDir('report-input-ledger-');
  const persistence = new StationDelegationPersistence(root);
  const store = persistence.reportInputStore(() => undefined);
  const digest = `sha256:${'a'.repeat(64)}`;
  const binding: ReportInputBinding = {
    groupId: 'group',
    rootId: 'root',
    executionId: 'execution',
    seatId: 'reviewer',
    invocationId: 'invocation',
    authority: { id: 'root', authority_epoch: 0, digest },
    envelope: { id: 'envelope', generation: 0, digest },
    usage: { inputTokens: 4, outputTokens: 4, costMicros: 12 },
    providerToolCallId: 'tool-input',
    providerEvidence: {
      id: 'provider-evidence',
      domain: 'station.provider-evidence',
      digest,
    },
    threadId: 'native-session',
    turnId: 'native-turn',
    question: 'Which scope?',
    recipient: {
      hostId: 'host',
      recipientId: 'actual-recipient',
      generation: 1,
      executionId: 'native-session',
      sessionReceipt: {
        id: 'session-receipt',
        domain: 'station.reserved-session.v1',
        digest,
      },
    },
  };
  const form = inputRequestFromMcpElicitation('station-report-input', {
    message: binding.question,
    requestedSchema: {
      type: 'object',
      properties: { answer: { type: 'string', minLength: 1, maxLength: 512 } },
      required: ['answer'],
    },
  });
  assert.ok(form);
  const question: Extract<CanonicalRuntimeEvent, { method: 'request.opened' }> =
    {
      provider: 'station-agent',
      threadId: binding.threadId,
      turnId: binding.turnId,
      eventId: 'actual-event',
      requestId: 'actual-request',
      requestType: 'approval',
      method: 'request.opened',
      createdAt: '2026-10-24T12:00:00.000Z',
      title: 'Clarification',
      payload: { inputRequest: form },
    };
  const file = join(
    root,
    'station-report-input-v1',
    `${reportInputKey(binding)}.json`,
  );
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  return {
    root,
    persistence,
    store,
    binding,
    question,
    file,
    read,
    ledger: new ReportInputLedger(store),
  };
}

test('durable input enforces one question and two sends, and reopening cannot replay any phase', async () => {
  const f = fixture();
  await f.ledger.begin(f.binding);
  await assert.rejects(
    () => f.ledger.bindQuestion(f.binding, f.question),
    /question_limit/,
  );
  assert.equal(await f.ledger.consumeSend(f.binding), 1);
  await assert.rejects(() => f.ledger.consumeSend(f.binding), /send_limit/);
  await f.ledger.bindQuestion(f.binding, f.question);
  await assert.rejects(
    () =>
      f.ledger.bindQuestion(f.binding, {
        ...f.question,
        eventId: 'another-event',
      }),
    /question_limit/,
  );
  await assert.rejects(() =>
    f.ledger.retainAnswer(f.binding, {
      action: 'accept',
      content: { answer: '' },
    }),
  );
  const answer: InputRequestResponse = {
    action: 'accept',
    content: { answer: 'Only current source' },
  };
  await f.ledger.retainAnswer(f.binding, answer);
  await assert.rejects(
    () => f.ledger.consumeSend(f.binding, { action: 'decline' }),
    /send_limit/,
  );
  assert.equal(await f.ledger.consumeSend(f.binding, answer), 2);
  await assert.rejects(
    () => f.ledger.consumeSend(f.binding, answer),
    /send_limit/,
  );
  await assert.rejects(
    () => f.ledger.finish(f.binding, { action: 'decline' }),
    /result_mismatch/,
  );
  const receipt = await f.ledger.finish(f.binding, answer);
  assert.equal(receipt.domain, 'station.report-input.v1');
  assert.deepEqual(f.read().result, answer);
  const scope = {
    groupId: f.binding.groupId,
    invocationId: f.binding.invocationId,
    seatId: f.binding.seatId,
    threadId: f.binding.threadId,
  };
  assert.deepEqual(
    (
      await f.persistence.readReportInputReceipt(
        receipt,
        scope,
        () => undefined,
      )
    ).response,
    answer,
  );
  await assert.rejects(
    () =>
      f.persistence.readReportInputReceipt(
        receipt,
        { ...scope, seatId: 'foreign-seat' },
        () => undefined,
      ),
    /reference_mismatch/,
  );
  await assert.rejects(
    () =>
      f.persistence.readReportInputReceipt(
        { ...receipt, digest: `sha256:${'b'.repeat(64)}` },
        scope,
        () => undefined,
      ),
    /reference_mismatch/,
  );
  const reopened = new ReportInputLedger(
    new StationDelegationPersistence(f.root).reportInputStore(() => undefined),
  );
  await assert.rejects(() => reopened.begin(f.binding), /already_claimed/);
  await assert.rejects(
    () => reopened.begin({ ...f.binding, seatId: 'another-seat' }),
    /already_claimed/,
  );
  await assert.rejects(() => reopened.consumeSend(f.binding), /no_live_claim/);
  assert.equal(f.read().physicalSends, 2);
});

test('two concurrent claims and sends consume only one first-send allowance', async () => {
  const f = fixture();
  const other = new ReportInputLedger(
    new StationDelegationPersistence(f.root).reportInputStore(() => undefined),
  );
  const claims = await Promise.allSettled([
    f.ledger.begin(f.binding),
    other.begin(f.binding),
  ]);
  assert.equal(
    claims.filter((entry) => entry.status === 'fulfilled').length,
    1,
  );
  const owner = claims[0].status === 'fulfilled' ? f.ledger : other;
  const sends = await Promise.allSettled([
    owner.consumeSend(f.binding),
    owner.consumeSend(f.binding),
  ]);
  assert.equal(sends.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(f.read().physicalSends, 1);
  assert.equal(f.read().question, undefined);
});

test('a live claim refuses a structurally valid on-disk rollback without refunding or reopening', async () => {
  const f = fixture();
  await f.ledger.begin(f.binding);
  const initial = readFileSync(f.file);
  await f.ledger.consumeSend(f.binding);
  writeFileSync(f.file, initial);
  await assert.rejects(
    () => f.ledger.consumeSend(f.binding),
    /binding_changed/,
  );
  await assert.rejects(
    () => new ReportInputLedger(f.store).begin(f.binding),
    /already_claimed/,
  );
});

test('the persistence owner refuses combined phase jumps and post-result changes', async () => {
  const f = fixture();
  await f.ledger.begin(f.binding);
  const answer: InputRequestResponse = { action: 'decline' };
  await f.ledger.consumeSend(f.binding);
  await f.ledger.bindQuestion(f.binding, f.question);
  await assert.rejects(
    () =>
      f.store.transact(reportInputKey(f.binding), (record) => {
        assert.ok(record);
        return {
          record: { ...record, answer, physicalSends: 2 },
          result: undefined,
        };
      }),
    /transition_refused/,
  );
  await f.ledger.retainAnswer(f.binding, answer);
  await f.ledger.consumeSend(f.binding, answer);
  await f.ledger.finish(f.binding, answer);
  await assert.rejects(() =>
    f.store.transact(reportInputKey(f.binding), (record) => {
      assert.ok(record);
      return {
        record: { ...record, result: { action: 'cancel' } },
        result: undefined,
      };
    }),
  );
  assert.deepEqual(f.read().result, answer);
});
