import {
  parseWorkspacePaneDescriptor,
  parseWorkspacePaneInstance,
  WORKSPACE_PANE_CONTRACT_VERSION,
  type WorkspacePaneDescriptor,
  type WorkspacePaneInstance,
} from './workspace-pane.js';

/**
 * The Home role (station#3122 stage 3).
 *
 * Holding the role means: the root route mounts this contributed Workspace
 * Pane instead of the built-in Home. The role is modelled after a launcher
 * grant, with the launcher constraints the issue records:
 *
 * - **Granting is a separate explicit act, and the grant record lives where
 *   the granted party cannot write.** A `trusted-plugin-react` renderer runs
 *   as same-origin JavaScript, so any browser-writable store (localStorage
 *   included) is by definition writable by the plugin being granted — a
 *   store there lets `activate()` grant itself Home, which defeats the
 *   constraint outright. The record therefore lives server-side
 *   (`workspace-home-role.json` under the Station home). The write path —
 *   the consent channel — must be served from a DISTINCT origin, because a
 *   same-origin consent page cannot bind an approval to itself: same-origin
 *   code can rewrite the page, or submit the approval inside a click's user
 *   activation without the page ever being seen. That surface is being
 *   scoped separately; on this build the grant constructor has NO
 *   production caller, so the record can only exist if placed by hand or
 *   by that future channel. Installing — or any plugin code running after
 *   installation — never claims the root route.
 * - **The built-in Home is the un-removable floor.** A grant can only ever
 *   ADD a candidate above the built-in; revoking, failing to parse, failing
 *   eligibility, or failing renderer resolution all land on the built-in.
 *   There is deliberately no way to express "no Home".
 * - **A grant does not survive what it did not approve.** The server
 *   re-derives the grant's standing against the LIVE installation on every
 *   read (`WorkspaceHomeRoleStatus`): an uninstall, a version change, or a
 *   same-version byte replacement of the installed code (caught by an
 *   install-content digest recorded at approval) all read as `lapsed`, and
 *   the root route stays on the built-in with the derived reason. The
 *   stored projection field list makes a widened Home projection detectable
 *   the same way (`workspaceHomeRoleGrantCoversProjection`).
 *
 * What the grant does NOT bound: a granted `trusted-plugin-react` renderer
 * executes same-origin with SDK access, like every trusted plugin layout.
 * The boundary this record creates is over the ROLE — which code the root
 * route mounts after a reload, and on whose approval — not over what
 * trusted code can do while it runs. That runtime surface is the trusted
 * tier's own consent gate; the projection field list below is consent
 * description and widening detection, not a data boundary.
 *
 * What this deliberately is NOT: a permission system. station#3534 (typed
 * permission vocabulary) is unbuilt, so the grant names one role and one
 * pane occurrence rather than inventing scopes. When #3534 lands, this
 * record is the shape it absorbs.
 */

export const WORKSPACE_HOME_ROLE_GRANT_VERSION = '1.0' as const;

/** The single placed occurrence identity a granted Home mounts under. */
export const WORKSPACE_HOME_ROLE_INSTANCE_ID = 'workspace-home-role';

export interface WorkspaceHomeRoleGrant {
  version: typeof WORKSPACE_HOME_ROLE_GRANT_VERSION;
  /** The exact descriptor the user approved, parsed fail-closed. */
  descriptor: WorkspacePaneDescriptor;
  /**
   * The granted occurrence, minted at grant time. Its `boundContext.
   * contribution` is the placed installation record the approval was shown
   * for; renderer authorization compares it against the live plugin
   * registration and fails closed on divergence.
   */
  instance: WorkspacePaneInstance;
  /** When the explicit grant act happened (ISO 8601). */
  grantedAt: string;
  /**
   * The Home projection's field names as they were when the user approved.
   * Derived from the projection type by the grant surface, never hand-written
   * prose: this is what makes "a widened projection is a new grant"
   * enforceable rather than aspirational.
   */
  projectionFields: readonly string[];
}

/**
 * Whether a descriptor may hold the Home role.
 *
 * Owner decision on station#3122 (2026-08): only the trusted plugin React
 * tier may hold the Home role in the first cut. The issue's own analysis
 * records this as conservative rather than necessary — under the projection
 * model the sandboxed tiers become far less dangerous — and gates revisiting
 * on the projection boundary having fault-injection evidence.
 *
 * The tier decision is enforced at TWO independent sites, and widening it
 * means changing both: the `renderer.kind` line below (checked at grant
 * creation and re-checked at every parse), and the Home host's offered
 * capability set (`HomeRolePane` enables no sandboxed hosts, so selection
 * cannot land on a sandboxed candidate even if this predicate admitted
 * one). Earlier wording claimed the line below was the only change; that
 * was false, and the second site is deliberate defence in depth, not an
 * accident to consolidate away.
 */
export function isWorkspaceHomeRoleEligibleDescriptor(
  descriptor: WorkspacePaneDescriptor,
): boolean {
  return (
    // The tier decision (one of the two sites named above).
    descriptor.renderer.kind === 'plugin-component' &&
    // Structural requirements, independent of the tier decision: the holder
    // must attribute itself to a plugin (the contract already refuses
    // builtin attribution on a plugin renderer at parse), and must have
    // declared it can occupy a whole route — Home is standalone-only.
    descriptor.provenance.origin === 'plugin' &&
    typeof descriptor.provenance.pluginId === 'string' &&
    descriptor.placement.supportedRegions.includes('standalone')
  );
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value === value.trim()
  );
}

export interface WorkspaceHomeRoleGrantInput {
  descriptor: unknown;
  /** The placed contribution record the approval was presented for. */
  contribution: unknown;
  grantedAt: string;
  projectionFields: readonly string[];
}

/**
 * The one constructor for a Home role grant — the explicit act. Everything is
 * re-derived fail-closed from its inputs; there is no way to smuggle an
 * unparsed descriptor, an ineligible tier, or an unattributed occurrence into
 * a grant record. Returns null rather than a partial grant.
 */
export function createWorkspaceHomeRoleGrant(
  input: WorkspaceHomeRoleGrantInput,
): WorkspaceHomeRoleGrant | null {
  const descriptor = parseWorkspacePaneDescriptor(input.descriptor);
  if (!descriptor) return null;
  if (!isWorkspaceHomeRoleEligibleDescriptor(descriptor)) return null;
  if (!isNonEmptyTrimmedString(input.grantedAt)) return null;
  if (!Number.isFinite(Date.parse(input.grantedAt))) return null;
  if (
    !Array.isArray(input.projectionFields) ||
    input.projectionFields.length === 0 ||
    !input.projectionFields.every(isNonEmptyTrimmedString) ||
    new Set(input.projectionFields).size !== input.projectionFields.length
  ) {
    return null;
  }
  // The instance parser validates the contribution snapshot fail-closed
  // (identity, version, source identity, provenance). The occurrence binds
  // NOTHING else — no projectId in particular, so no Project host can ever
  // pass `isWorkspacePaneInstanceOwnedByProject` for it.
  const instance = parseWorkspacePaneInstance({
    version: WORKSPACE_PANE_CONTRACT_VERSION,
    descriptorId: descriptor.id,
    instanceId: WORKSPACE_HOME_ROLE_INSTANCE_ID,
    stateKey: WORKSPACE_HOME_ROLE_INSTANCE_ID,
    boundContext: { contribution: input.contribution },
  });
  if (!instance?.boundContext?.contribution) return null;
  const contribution = instance.boundContext.contribution;
  // The approval was shown for one plugin's pane; the occurrence must be
  // bound to that same plugin, or the grant would attach one contributor's
  // consent to another contributor's code.
  if (
    contribution.provenance?.origin !== 'plugin' ||
    contribution.provenance.pluginId !== descriptor.provenance.pluginId ||
    contribution.sourceIdentity?.id !== descriptor.provenance.pluginId
  ) {
    return null;
  }
  return {
    version: WORKSPACE_HOME_ROLE_GRANT_VERSION,
    descriptor,
    instance,
    grantedAt: input.grantedAt,
    projectionFields: [...input.projectionFields],
  };
}

/**
 * Reads a persisted grant. Deliberately re-runs the constructor on the stored
 * parts instead of trusting stored structure: a tampered or stale record —
 * including one granted under a WIDER eligibility policy than the current
 * build's — re-derives to null and the root route stays on the built-in Home.
 */
export function parseWorkspaceHomeRoleGrant(
  value: unknown,
): WorkspaceHomeRoleGrant | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const record = value as Record<string, unknown>;
  if (record.version !== WORKSPACE_HOME_ROLE_GRANT_VERSION) return null;
  const instance =
    typeof record.instance === 'object' &&
    record.instance !== null &&
    !Array.isArray(record.instance)
      ? (record.instance as Record<string, unknown>)
      : undefined;
  const boundContext =
    instance &&
    typeof instance.boundContext === 'object' &&
    instance.boundContext !== null &&
    !Array.isArray(instance.boundContext)
      ? (instance.boundContext as Record<string, unknown>)
      : undefined;
  if (!boundContext) return null;
  const grant = createWorkspaceHomeRoleGrant({
    descriptor: record.descriptor,
    contribution: boundContext.contribution,
    grantedAt: record.grantedAt as string,
    projectionFields: record.projectionFields as readonly string[],
  });
  if (!grant) return null;
  // The minted occurrence identity is a constant; a stored record claiming a
  // different one is not this contract's record.
  if (
    instance?.instanceId !== grant.instance.instanceId ||
    instance.stateKey !== grant.instance.stateKey ||
    instance.descriptorId !== grant.instance.descriptorId
  ) {
    return null;
  }
  return grant;
}

/**
 * Whether a grant still covers the current Home projection. False as soon as
 * the projection carries a field the user never saw at approval — a widened
 * projection is a NEW grant, or the whole model reduces to install-time
 * consent for an unbounded future. A NARROWED projection stays covered.
 */
export function workspaceHomeRoleGrantCoversProjection(
  grant: WorkspaceHomeRoleGrant,
  currentProjectionFields: readonly string[],
): boolean {
  return currentProjectionFields.every((field) =>
    grant.projectionFields.includes(field),
  );
}

/**
 * What the BUILT-IN Home displays, named field by field — that is, what the
 * user stops seeing curated at the root route if they replace it.
 *
 * WHAT THIS RECORD IS NOT — and what no consent surface may present it as:
 * a bound on the granted code. A granted `trusted-plugin-react` layout
 * mounts with no props and unrestricted same-origin SDK/API access; none of
 * these fields are delivered to it, and its actual reach is not limited to
 * them. Independent review caught a consent page framing this list as
 * "what this pane would render" — a user-facing label no execution seam
 * derives, on the worst possible surface for one. Any future consent page
 * (the distinct-origin surface being scoped separately) must render this
 * list as "what the built-in Home shows today — what you are replacing",
 * alongside a plain statement that the granted code runs as trusted,
 * unbounded plugin code.
 *
 * Within that honest framing the record is still load-bearing: "allow
 * access to all your data" is not consent, because nobody can evaluate it,
 * so the replacement decision names what the built-in actually carries.
 * The sorted field-name list below is what a grant stamps and
 * `workspaceHomeRoleGrantCoversProjection` compares — so widening the
 * projection invalidates existing grants exactly when this record gains the
 * new field.
 *
 * Contracts cannot see the UI's `HomeWorkItem` view-model type, so the
 * derivation coupling lives where both types are visible:
 * `src-ui/src/views/home/home-role-projection.ts` holds compile-time
 * assertions in BOTH directions (every `HomeWorkItem` field is named here;
 * this record names no field `HomeWorkItem` lacks). Adding a field to
 * `HomeWorkItem` fails typecheck there until this record describes it.
 */
export const WORKSPACE_HOME_PROJECTION_FIELD_DESCRIPTIONS = {
  id: 'Work item identifiers',
  kind: 'Whether each item is a task, chat, session, or remote session',
  kindLabel: 'The displayed kind of each item',
  title: 'Session, chat, and task titles',
  projectLabel: 'Project names',
  agentLabel: 'Agent names',
  modelLabel: 'Model names',
  model: 'The reported model id behind each item',
  conversationId: 'Durable conversation identifiers',
  conversationUpdatedAt: 'When each conversation last changed',
  acknowledgedAt: 'When you last opened each conversation',
  cwdLabel: 'Working-directory hints for sessions',
  turnProgress:
    'Last-progress times and quiet-turn observations for active sessions',
  updatedAt: 'When each item last changed',
  lifecycleLabel: 'Each item’s current state',
  unanswerableNotice: 'Why an item is waiting on something it cannot answer',
  failureNotice:
    'Why an item failed or was stopped, when a reason was recorded',
  chatSessionId: 'Chat session identifiers',
  orchestrationThreadId: 'Session thread identifiers',
  orchestrationThreadIds:
    'Linked execution Session thread identifiers for a conversation',
  taskSessionId: 'Task session identifiers',
  agentSlug: 'Which Agent each item is bound to',
  projectSlug: 'Which Project each item belongs to',
  controlMode: 'Whether a session is owned here or followed read-only',
  environmentId: 'Remote environment identifiers',
  environmentLabel: 'Remote environment names',
} as const satisfies Record<string, string>;

export type WorkspaceHomeProjectionField =
  keyof typeof WORKSPACE_HOME_PROJECTION_FIELD_DESCRIPTIONS;

/**
 * The Home projection's field names, sorted for stable storage on a grant
 * record. This is the value stamped onto every grant and compared by
 * `workspaceHomeRoleGrantCoversProjection`.
 */
export const WORKSPACE_HOME_PROJECTION_FIELDS: readonly string[] =
  Object.freeze(
    Object.keys(WORKSPACE_HOME_PROJECTION_FIELD_DESCRIPTIONS).sort(),
  );

/** The per-field claims a grant surface shows, in field order. */
export function describeWorkspaceHomeProjection(): readonly string[] {
  return WORKSPACE_HOME_PROJECTION_FIELDS.map((field) =>
    describeWorkspaceHomeProjectionField(field),
  );
}

/**
 * The user-readable claim behind one projection field, or the field name
 * itself for a field this build does not know — which happens exactly when a
 * NEWER build widened the projection: the honest fallback is the raw name,
 * never silence.
 */
export function describeWorkspaceHomeProjectionField(field: string): string {
  return (
    (
      WORKSPACE_HOME_PROJECTION_FIELD_DESCRIPTIONS as Record<
        string,
        string | undefined
      >
    )[field] ?? field
  );
}

/**
 * Why a stored grant no longer authorizes mounting anything, each derived by
 * the server from a concrete comparison against the live installation —
 * never a stored label:
 *
 * - `plugin-missing`: no installed plugin carries the granted `pluginId`.
 * - `pane-missing`: the plugin is installed but no longer declares the
 *   granted pane.
 * - `pane-disabled`: the pane's contribution is disabled by distribution
 *   policy or a lifecycle override.
 * - `version-changed`: the installed version differs from the one approved.
 * - `code-changed`: the installed content digest differs from the one
 *   recorded at approval — a same-version byte replacement mints no
 *   authority.
 */
export type WorkspaceHomeRoleLapseReason =
  | 'plugin-missing'
  | 'pane-missing'
  | 'pane-disabled'
  | 'version-changed'
  | 'code-changed';

const WORKSPACE_HOME_ROLE_LAPSE_REASONS: readonly WorkspaceHomeRoleLapseReason[] =
  [
    'plugin-missing',
    'pane-missing',
    'pane-disabled',
    'version-changed',
    'code-changed',
  ];

/**
 * The server's derived answer to "what holds the Home role right now".
 * `granted` means the stored grant re-derived fail-closed AND the live
 * installation still matches what was approved (identity, version, content
 * digest). `lapsed` carries the concrete divergence plus enough identity to
 * explain it truthfully; the grant it names authorizes nothing.
 */
export type WorkspaceHomeRoleStatus =
  | { state: 'none' }
  | { state: 'granted'; grant: WorkspaceHomeRoleGrant }
  | {
      state: 'lapsed';
      reason: WorkspaceHomeRoleLapseReason;
      paneName: string;
      pluginId: string;
    };

/**
 * Fail-closed reparse of a serialized {@link WorkspaceHomeRoleStatus} — the
 * client runs this over the server payload so a malformed or tampered
 * response re-derives to the floor (`none`) rather than being trusted
 * because a server said it. A `granted` status re-runs the full grant
 * constructor via {@link parseWorkspaceHomeRoleGrant}, so a client whose
 * eligibility policy is NARROWER than the server's still refuses.
 */
export function parseWorkspaceHomeRoleStatus(
  value: unknown,
): WorkspaceHomeRoleStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { state: 'none' };
  }
  const record = value as Record<string, unknown>;
  if (record.state === 'granted') {
    const grant = parseWorkspaceHomeRoleGrant(record.grant);
    return grant ? { state: 'granted', grant } : { state: 'none' };
  }
  if (
    record.state === 'lapsed' &&
    WORKSPACE_HOME_ROLE_LAPSE_REASONS.includes(
      record.reason as WorkspaceHomeRoleLapseReason,
    ) &&
    isNonEmptyTrimmedString(record.paneName) &&
    isNonEmptyTrimmedString(record.pluginId)
  ) {
    return {
      state: 'lapsed',
      reason: record.reason as WorkspaceHomeRoleLapseReason,
      paneName: record.paneName,
      pluginId: record.pluginId,
    };
  }
  return { state: 'none' };
}
