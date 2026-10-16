import { describe, expect, test } from 'vitest';
import {
  deriveMessageDeliveryState,
  type MessageDeliverySignals,
  type MessageDeliveryState,
  outboxTurnDeliveryState,
} from '../messageDeliveryState';

/** Signal → state, with literal expectations (no derivation from the code). */
const TABLE: Array<
  [label: string, MessageDeliverySignals, MessageDeliveryState | undefined]
> = [
  ['no delivery fact at all', {}, undefined],
  ['request out, no answer', { requestInFlight: true }, 'sending'],
  [
    'outbox row invoking with no request of this window out: awaits the lookup',
    { outbox: 'invoking' },
    'awaiting-confirmation',
  ],
  [
    'outbox row invoking while this window replays it',
    { outbox: 'invoking', requestInFlight: true },
    'sending',
  ],
  [
    'request out, lookup has not found it yet',
    { requestInFlight: true, lookup: 'not-received' },
    'sending',
  ],
  [
    'request out, Station says it has it',
    { requestInFlight: true, lookup: 'received' },
    'received',
  ],
  [
    'orphaned row, Station says it has it',
    { outbox: 'invoking', lookup: 'received' },
    'received',
  ],
  [
    'Station answered with the turn id',
    { providerAccepted: true },
    'delivered',
  ],
  ['the turn start was seen', { turnStarted: true }, 'delivered'],
  [
    'lookup says started',
    { outbox: 'invoking', lookup: 'started' },
    'delivered',
  ],
  ['outbox row accepted', { outbox: 'accepted' }, 'delivered'],
  [
    'turn seen outranks a stale indeterminate answer',
    { turnStarted: true, lookup: 'indeterminate' },
    'delivered',
  ],
  ['kept for later, offline', { outbox: 'pending' }, 'waiting-to-send'],
  ['held behind a running turn', { heldBehindTurn: true }, 'held-on-device'],
  ['refused by Station', { refused: true }, 'not-sent'],
  ['outbox row failed', { outbox: 'failed' }, 'not-sent'],
  [
    'lookup found nothing and nothing is out',
    { lookup: 'not-received' },
    'not-sent',
  ],
  ['lookup indeterminate', { lookup: 'indeterminate' }, 'unconfirmed'],
  ['lookup expired', { lookup: 'expired' }, 'unconfirmed'],
  [
    'Station cannot see the conversation (forwarded elsewhere)',
    { requestInFlight: true, lookup: 'unknown' },
    'unconfirmed',
  ],
  ['outbox may have started', { outbox: 'may-have-started' }, 'unconfirmed'],
  [
    'a possible effect is never shown as retryable',
    { outbox: 'failed', lookup: 'indeterminate' },
    'unconfirmed',
  ],
  [
    'a held message is not sending',
    { heldBehindTurn: true, requestInFlight: true },
    'held-on-device',
  ],
];

describe('deriveMessageDeliveryState', () => {
  test.each(TABLE)('%s', (_label, signals, expected) => {
    expect(deriveMessageDeliveryState(signals)).toBe(expected);
  });
});

describe('outboxTurnDeliveryState', () => {
  test('a listed held copy is held on a device, not waiting to send', () => {
    expect(
      outboxTurnDeliveryState({ status: 'pending', heldElsewhere: true }),
    ).toBe('held-on-device');
    expect(outboxTurnDeliveryState({ status: 'pending' })).toBe(
      'waiting-to-send',
    );
  });
});
