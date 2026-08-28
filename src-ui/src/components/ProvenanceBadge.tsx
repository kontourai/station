/**
 * archive#settings-revamp (docs/design/settings-architecture.md §4
 * "provenance... so the UI can render 'overridden by operator env' badges
 * instead of accepting doomed edits").
 *
 * Reads `GET /config/app`'s per-field provenance map
 * (`SettingProvenanceEntry`, `@kontourai/station-contracts/settings-registry`)
 * and renders the matching chip via Console Kit's own `Badge` primitive
 * (consumed, not reinvented — see `components/trust/TrustPanel.tsx` for the
 * established pattern):
 *
 * - `source: 'env'` -> "Set by operator: {envVar}", tone `neutral`. Either a
 *   runtime-injected field (e.g. `managedChatOrchestration`) or a registered
 *   field with nothing stored whose declared `envFallback` is set — in both
 *   cases the env var is where the effective value comes from.
 * - `source: 'default'` -> a subtle "Default" chip, tone `neutral`.
 * - `source: 'file'` (the common case: a real, editable stored value) -> no badge.
 * - No provenance entry at all -> no badge.
 *
 * **archive#1557 — there is no "Overridden by {var}" chip and no disabled
 * control.** This module used to render one whenever a registered
 * `envOverride` var was set, describing the stored value as inert, and
 * `isProvenanceOverridden` disabled the input on the same signal. No
 * resolver in Station worked that way: the region resolver reads the stored
 * value before the environment, so Station was greying out the value that
 * WAS in effect and labelling it doomed. The badge now states only what the
 * provenance the server computed actually says, and the server computes it
 * from where the value comes from. If a genuinely env-wins setting ever
 * exists, it needs a resolver that behaves that way first — a badge is not
 * the place to introduce the semantics.
 */
import type { SettingProvenanceEntry } from '@kontourai/station-contracts/settings-registry';
import { Badge } from '@kontourai/ui/react';

export interface ProvenanceBadgeProps {
  provenance?: SettingProvenanceEntry;
}

export function ProvenanceBadge({ provenance }: ProvenanceBadgeProps) {
  if (!provenance) return null;

  if (provenance.source === 'env') {
    return (
      <Badge
        value={
          provenance.envVar
            ? `Set by operator: ${provenance.envVar}`
            : 'Set by operator'
        }
        tone="neutral"
        className="provenance-badge"
      />
    );
  }

  if (provenance.source === 'default') {
    return (
      <Badge value="Default" tone="neutral" className="provenance-badge" />
    );
  }

  return null;
}
