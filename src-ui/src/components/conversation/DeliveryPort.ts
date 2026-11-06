import type { TurnDeliveryOutcome } from '@kontourai/station-contracts/orchestration';

/** Delivery actions never choose a Station or mint a replacement message key. */
export interface DeliveryPort {
  savedOnDevice: boolean;
  /** null means this adapter cannot prove the Station outlives this app. */
  stationOutlivesApp?: boolean | null;
  canRetry?: boolean;
  canDiscardUnconfirmed: boolean;
  check?(): Promise<TurnDeliveryOutcome | undefined>;
  retry?(): Promise<void>;
  release?(): Promise<void>;
  edit?(): Promise<string | null>;
  copy?(): Promise<string>;
  discard?(kind?: 'not-sent' | 'unconfirmed'): Promise<string | null>;
}

/** Recorded facts offer only the actions their owner actually implements. */
export const recordedDeliveryPort: DeliveryPort = {
  savedOnDevice: false,
  stationOutlivesApp: null,
  canDiscardUnconfirmed: false,
};
