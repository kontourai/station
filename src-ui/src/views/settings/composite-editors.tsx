/**
 * archive#settings-revamp (docs/design/settings-architecture.md §4
 * "composite editors like the guardian config opt out with a custom
 * component"). Composite-kind registry fields NEVER get the generic
 * per-kind row renderer (`registry-row.tsx`) — each is either registered
 * here with a custom component, or explicitly deferred.
 *
 * Completeness is enforced by `registry-row.test.tsx`: every composite-kind
 * `APP_SETTINGS_REGISTRY` entry must be a key of `COMPOSITE_EDITORS` or a
 * member of `DEFERRED_COMPOSITE_KEYS` — a CI failure on drift, not a
 * runtime throw (an unclassified composite silently renders nothing).
 *
 * `ApprovalGuardianEditor` (low-traffic — most Stations never touch
 * approval guardian settings) is lazy-loaded via `React.lazy`;
 * `BuiltinEngineRow` internally lazy-loads its own `EnginePicker` modal
 * on demand instead.
 */
import { type ComponentType, lazy } from 'react';
import { BuiltinEngineRow } from './BuiltinEngineRow';
import { DistributionProfileField } from './DistributionProfileField';
import type { RegistryRowComponentProps } from './registry-row-types';

const LazyApprovalGuardianEditor = lazy(() =>
  import('./ApprovalGuardianEditor').then((m) => ({
    default: m.ApprovalGuardianEditor,
  })),
);

/**
 * Composite-kind `APP_SETTINGS_REGISTRY` keys with a custom editor. Every
 * composite key must appear here or in `DEFERRED_COMPOSITE_KEYS`.
 */
export const COMPOSITE_EDITORS: Readonly<
  Record<string, ComponentType<RegistryRowComponentProps>>
> = {
  approvalGuardian: LazyApprovalGuardianEditor,
  distributionProfile: DistributionProfileField,
};

/**
 * Composite-kind `APP_SETTINGS_REGISTRY` keys deliberately left with no
 * Settings UI this slice:
 * - `agentConnections`: per-agent connection override dictionary — belongs
 *   with the entity it configures (docs/design/settings-architecture.md's
 * "Entity" scope rule), not the global Station scope section.
 * - `templateVariables`: already has a working bespoke editor in
 *   `AgentDefaultsSection.tsx` (not routed through the generic registry-row
 *   path at all) — deferred here only for this completeness classification,
 *   not because it lacks UI.
 * - `firstRun`: progress state the first-run chapter writes about itself
 *   (`FirstRunHomeChapter.tsx`), not a preference. A JSON editor here would
 *   let an operator declare the run completed without it having run, which is
 *   a label nothing derived; re-offering the run has its own control (Home's
 *   "Set up Station" card).
 * - `userProfile`: already has its purpose-built first-run editor in
 *   `AboutYouStep.tsx`; exposing a generic composite editor here would bypass
 *   its role/comfort vocabulary and reach disclosure.
 * - `fleetContribution` (archive#1398): the opt-in ships ahead of
 *   any surface that can present it honestly. Its per-connection toggle
 *   belongs next to the model connections it names — global Station scope
 *   is the wrong home for a per-entity allowlist (same rule as
 *   `agentConnections`) — and the degraded states it produces are rendered
 * by, which owns "the §4.5 diagnostic codes rendered wherever
 *   fleet models appear". A generic composite JSON editor here would let an
 *   operator name a connection with no feedback about whether it is
 *   actually being offered.
 * - `contribution` (archive#1500.5): the scoped contribution contract
 * ships with NO consumer at all — owns the authenticated projection
 * route, and.5's acceptance criteria exclude a UI on purpose. A
 *   generic composite JSON editor here would be worse than nothing twice over:
 *   it would let an operator offer a repo, an agent, or a billable model
 *   connection to a project with no feedback about whether anything is being
 *   offered (`fleetContribution`'s reason, one axis wider), and it would do so
 * for a per-space allowlist whose home is the space — §4.6 is explicit that
 *   the contribution question is asked "at the moment you first join or create
 *   a shared space", never as a global settings row. This entry DECLARES the
 *   absence rather than leaving the key unclassified, which is what this gate
 *   exists to prevent.
 */
export const DEFERRED_COMPOSITE_KEYS: readonly string[] = [
  'agentConnections',
  'contribution',
  'firstRun',
  'fleetContribution',
  'templateVariables',
  'userProfile',
];

/**
 * The full custom-row lookup `registry-row.tsx`'s renderer consults first,
 * regardless of `descriptor.kind` — a superset of `COMPOSITE_EDITORS` plus
 * non-composite fields that still need bespoke UI
 * (`builtinAgentEngineConnectionId`, a `kind: 'string'` field rendered as a
 * read-only row with a "Change…" action instead of a text input).
 */
export const CUSTOM_ROW_RENDERERS: Readonly<
  Record<string, ComponentType<RegistryRowComponentProps>>
> = {
  ...COMPOSITE_EDITORS,
  builtinAgentEngineConnectionId: BuiltinEngineRow,
};
