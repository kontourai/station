import { TERMINAL_TICKET_PATTERN } from '@kontourai/station-contracts/terminal-transport';
import { expect, test } from 'vitest';
import { TerminalTickets } from '../terminal-tickets.js';

test('a ticket is redeemed once, for the principal that minted it', () => {
  const tickets = new TerminalTickets<string>();
  const minted = tickets.mint('phone-request', 'device:phone')!;
  expect(minted.ticket).toMatch(TERMINAL_TICKET_PATTERN);
  expect(tickets.redeem(minted.ticket)).toEqual({
    principal: 'phone-request',
    identity: 'device:phone',
  });
  expect(tickets.redeem(minted.ticket)).toBeUndefined();
});

test('an expired ticket is refused and consumed', () => {
  let now = 0;
  const tickets = new TerminalTickets<string>({ now: () => now, ttlMs: 10 });
  const minted = tickets.mint('p', 'device:p')!;
  expect(minted.expiresAt).toBe(10);
  now = 10;
  expect(tickets.redeem(minted.ticket)).toBeUndefined();
  now = 0;
  expect(tickets.redeem(minted.ticket)).toBeUndefined();
});

test('outstanding tickets are bounded per identity and in total; expiry frees them', () => {
  let now = 0;
  const tickets = new TerminalTickets<string>({
    now: () => now,
    ttlMs: 10,
    maxPerIdentity: 2,
    maxOutstanding: 3,
  });
  expect(tickets.mint('a', 'device:a')).toBeDefined();
  expect(tickets.mint('a', 'device:a')).toBeDefined();
  expect(tickets.mint('a', 'device:a')).toBeUndefined();
  expect(tickets.mint('b', 'device:b')).toBeDefined();
  expect(tickets.mint('c', 'device:c')).toBeUndefined();
  now = 10;
  expect(tickets.mint('c', 'device:c')).toBeDefined();
});

test('malformed and unknown tickets redeem nothing', () => {
  const tickets = new TerminalTickets<string>();
  tickets.mint('p', 'device:p');
  expect(tickets.redeem('')).toBeUndefined();
  expect(tickets.redeem('x'.repeat(43))).toBeUndefined();
  expect(tickets.redeem('not a ticket, with spaces')).toBeUndefined();
});
