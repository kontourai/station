import { createHash, randomBytes } from 'node:crypto';
import {
  TERMINAL_TICKET_PATTERN,
  TERMINAL_TICKET_TTL_MS,
  type TerminalTicket,
} from '@kontourai/station-contracts/terminal-transport';

type Entry<Principal> = {
  principal: Principal;
  identity: string;
  expiresAt: number;
};

/**
 * Single-use socket tickets minted by an authenticated HTTP request. The
 * ticket carries that request's admission into the upgrade, so the socket is
 * authenticated before any WebSocket resource is allocated. Only a digest is
 * retained; a ticket is consumed by its first redemption, valid or expired.
 */
export class TerminalTickets<Principal> {
  private entries = new Map<string, Entry<Principal>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxOutstanding: number;
  private readonly maxPerIdentity: number;

  constructor(
    options: {
      now?: () => number;
      ttlMs?: number;
      maxOutstanding?: number;
      maxPerIdentity?: number;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? TERMINAL_TICKET_TTL_MS;
    this.maxOutstanding = options.maxOutstanding ?? 256;
    this.maxPerIdentity = options.maxPerIdentity ?? 8;
  }

  /** `undefined` when the caller already holds its outstanding-ticket budget. */
  mint(principal: Principal, identity: string): TerminalTicket | undefined {
    this.sweep();
    let held = 0;
    for (const entry of this.entries.values())
      if (entry.identity === identity) ++held;
    if (held >= this.maxPerIdentity || this.entries.size >= this.maxOutstanding)
      return undefined;
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.entries.set(digest(ticket), { principal, identity, expiresAt });
    return { ticket, expiresAt };
  }

  redeem(
    ticket: string,
  ): { principal: Principal; identity: string } | undefined {
    if (!TERMINAL_TICKET_PATTERN.test(ticket)) return undefined;
    const key = digest(ticket);
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (!entry || entry.expiresAt <= this.now()) return undefined;
    return { principal: entry.principal, identity: entry.identity };
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries)
      if (entry.expiresAt <= now) this.entries.delete(key);
  }
}

function digest(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex');
}
