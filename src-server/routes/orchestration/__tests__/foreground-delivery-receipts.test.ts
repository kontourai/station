import { describe, expect, test } from 'vitest';
import {
  ForegroundDeliveryReceiptCapacityError,
  ForegroundDeliveryReceipts,
} from '../foreground-delivery-receipts.js';

const receipt = (clientTurnId: string, callerKey = 'caller-a') => ({
  callerKey,
  conversationId: 'conversation',
  clientTurnId,
});

describe('ForegroundDeliveryReceipts', () => {
  test('records a send until its release, per caller', () => {
    const receipts = new ForegroundDeliveryReceipts();
    const release = receipts.begin(receipt('k'));
    expect(receipts.has(receipt('k'))).toBe(true);
    expect(receipts.has(receipt('k', 'caller-b'))).toBe(false);
    release();
    expect(receipts.has(receipt('k'))).toBe(false);
  });

  test('an overlapping retry of the same key keeps it recorded until both answer', () => {
    const receipts = new ForegroundDeliveryReceipts();
    const first = receipts.begin(receipt('k'));
    const second = receipts.begin(receipt('k'));
    first();
    first(); // a release runs once
    expect(receipts.has(receipt('k'))).toBe(true);
    second();
    expect(receipts.has(receipt('k'))).toBe(false);
  });

  test('refuses a new send past its bound instead of handling it unrecorded', () => {
    const receipts = new ForegroundDeliveryReceipts(2);
    receipts.begin(receipt('a'));
    receipts.begin(receipt('b'));
    expect(() => receipts.begin(receipt('c'))).toThrow(
      ForegroundDeliveryReceiptCapacityError,
    );
    expect(receipts.has(receipt('c'))).toBe(false);
    // A retry of a key already recorded is not a new entry.
    expect(() => receipts.begin(receipt('a'))).not.toThrow();
  });

  test('remembers conversations it forwarded, per caller', () => {
    const receipts = new ForegroundDeliveryReceipts();
    receipts.begin({ ...receipt('k'), forwarded: true })();
    expect(
      receipts.forwarded({
        callerKey: 'caller-a',
        conversationId: 'conversation',
      }),
    ).toBe(true);
    expect(
      receipts.forwarded({
        callerKey: 'caller-b',
        conversationId: 'conversation',
      }),
    ).toBe(false);
  });
});
