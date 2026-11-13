import type { SemanticTone } from '@kontourai/ui/react';

/**
 * How a listed resource's status is SHOWN: a short label, its tone, why (when
 * it is not obvious) and at most one fix. Presentation only — each feature
 * owns its own status words and the decision behind them (for Connections,
 * `deriveConnectionHealth`), and hands the kit the result.
 */
export interface ResourceStatus {
  label: string;
  tone: SemanticTone;
  reason?: string;
  action?: { label: string; id: string };
}
