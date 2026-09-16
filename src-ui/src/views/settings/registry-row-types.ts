/**
 * archive#settings-revamp: shared prop shape for both the generic
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
  /**
   * #1582 D9: a default this HOST reports, for a field whose default cannot be
   * written down in the registry because it is host-dependent (`terminalShell`
   * is `SHELL`, or a platform fallback, or neither). The registry's static
   * `placeholder`/`defaultValue` remain the answer for every other field; this
   * is supplied by a section that holds the runtime config, and only where the
   * server actually reports one — absent stays absent rather than becoming a
   * guess.
   */
  runtimeDefault?: string;
  /**
   * #2144 slice 3 — the project override context, supplied only by a caller
   * that holds a project override draft (`SettingsView`'s project selector).
   * All four are absent on a Station-only page, which is what makes its rows
   * render exactly as they did before this slice.
   */
  projectName?: string;
  /** The project's override value for this key, when it has one. */
  projectValue?: unknown;
  /**
   * This Station's stored value, when `value` above is the project's. The
   * control edits `value`; the inheritance list explains both, and cannot
   * recover the Station's own value from a draft that has replaced it.
   */
  stationValue?: unknown;
  /** Drops this key's project override; see `SettingRowStatus`. */
  onResetToInherited?: () => void;
}
