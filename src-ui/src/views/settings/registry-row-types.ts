/**
 * station#settings-revamp slice 3: shared prop shape for both the generic
 * per-kind row renderer (`registry-row.tsx`) and every custom/composite row
 * component it delegates to (`ApprovalGuardianEditor`, `DistributionProfileField`,
 * `BuiltinEngineRow`). Loosely typed (`unknown` value) deliberately — each
 * custom component narrows its own `value`/`onChange` to its concrete
 * registry field type; `SettingDefinition` itself is a discriminated union
 * over many different `AppConfig` keys, so a single generic parameter here
 * would not buy real type safety back.
 */
import type {
  SettingDefinition,
  SettingProvenanceEntry,
} from '@kontourai/station-contracts/settings-registry';

export interface RegistryRowComponentProps {
  definition: SettingDefinition;
  value: unknown;
  provenance?: SettingProvenanceEntry;
  onChange: (value: unknown) => void;
}
