import type { TurnDeliveryOutcome } from '@kontourai/station-contracts/orchestration';

/** Delivery actions never choose a Station or mint a replacement message key. */
export interface DeliveryPort {
  savedOnDevice: boolean;
  canRetry?: boolean;
  canDiscardUnconfirmed: boolean;
  check(): Promise<TurnDeliveryOutcome | undefined>;
  retry(): Promise<void>;
  edit(): Promise<string | null>;
  discard(kind?: 'not-sent' | 'unconfirmed'): Promise<string | null>;
}
