import { createHash } from 'node:crypto';
import type {
  CredentialProfile,
  CredentialProfileApplicationCapability,
  CredentialProfileApplicationOutcome,
  CredentialProfileRegistryState,
  CredentialRecoveryGroup,
  CredentialRecoveryGroupProjection,
} from '@kontourai/station-contracts/connection-recovery';
import {
  DEFAULT_CREDENTIAL_RECOVERY_POLICY,
  isAutomaticCredentialRecoveryEnabled,
} from '@kontourai/station-contracts/connection-recovery';
import {
  appHomeProfileDir,
  type EnsureAppHomeProfileOptions,
  ensureAppHomeProfile,
} from './app-home-profiles.js';

const MAX_PROFILES = 64;
const MAX_REF_LENGTH = 256;
const MAX_LABEL_LENGTH = 256;
const MAX_ATTEMPT_ID_LENGTH = 128;
/** Never evict an unacknowledged receipt: refusing a new stage is safer. */
export const MAX_APPLICATION_RECEIPTS = 64;

type RegistryState = Required<
  Pick<CredentialProfileRegistryState, 'profiles' | 'group' | 'policy'>
> &
  Omit<CredentialProfileRegistryState, 'profiles' | 'group' | 'policy'>;

/** Legacy file parser only; durable application authority lives in SQLite. */
interface LegacyPendingApplication {
  previousProfileRef?: string;
  candidateProfileRef: string;
  attemptId: string;
}
interface LegacyApplicationReceipt {
  attemptId: string;
  candidateProfileRef: string;
  outcome: 'staged' | 'adopted' | 'rolled_back' | 'superseded';
  recordedAt: string;
}
export type LegacyCredentialProfileRegistryState = RegistryState & {
  pendingApplication?: LegacyPendingApplication;
  applicationReceipts?: LegacyApplicationReceipt[];
};

export type CredentialProfileRegistryTransition =
  | 'staged'
  | 'adopted'
  | 'rolled_back'
  | 'acknowledged'
  | 'rejected'
  | 'ignored';

export interface CredentialProfileRegistryTransitionResult {
  state: LegacyCredentialProfileRegistryState;
  transition: CredentialProfileRegistryTransition;
}

function normalizeRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ref = value.trim();
  if (
    ref.length === 0 ||
    ref.length > MAX_REF_LENGTH ||
    ref === '.' ||
    ref === '..' ||
    /[\\/]/.test(ref) ||
    hasControlCharacters(ref)
  ) {
    return undefined;
  }
  return ref;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function normalizeLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const label = value.trim();
  return label.length > 0 &&
    label.length <= MAX_LABEL_LENGTH &&
    !hasControlCharacters(label)
    ? label
    : undefined;
}

function normalizeAttemptId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id.length > 0 &&
    id.length <= MAX_ATTEMPT_ID_LENGTH &&
    !hasControlCharacters(id)
    ? id
    : undefined;
}

function normalizeProfiles(value: unknown): CredentialProfile[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const profiles: CredentialProfile[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const raw = candidate as Record<string, unknown>;
    const ref = normalizeRef(raw.ref);
    if (!ref || seen.has(ref) || profiles.length >= MAX_PROFILES) continue;
    seen.add(ref);
    const label = normalizeLabel(raw.label);
    profiles.push(label ? { ref, label } : { ref });
  }
  return profiles;
}

function normalizeRefs(value: unknown, knownRefs: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const valueRef of value) {
    const ref = normalizeRef(valueRef);
    if (!ref || !knownRefs.has(ref) || seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}

function normalizeGroup(
  value: unknown,
  knownRefs: Set<string>,
): CredentialRecoveryGroup {
  const raw =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  const profileRefs = normalizeRefs(raw.profileRefs, knownRefs);
  const members = new Set(profileRefs);
  return {
    profileRefs,
    enrolledProfileRefs: normalizeRefs(raw.enrolledProfileRefs, members),
  };
}

function normalizePending(
  value: unknown,
  knownRefs: Set<string>,
): LegacyPendingApplication | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const candidateProfileRef = normalizeRef(raw.candidateProfileRef);
  const attemptId = normalizeAttemptId(raw.attemptId);
  const previousProfileRef = normalizeRef(raw.previousProfileRef);
  if (
    !candidateProfileRef ||
    !attemptId ||
    !knownRefs.has(candidateProfileRef)
  ) {
    return undefined;
  }
  return {
    candidateProfileRef,
    attemptId,
    ...(previousProfileRef && knownRefs.has(previousProfileRef)
      ? { previousProfileRef }
      : {}),
  };
}

function normalizeOutcome(
  value: unknown,
): CredentialProfileApplicationOutcome | undefined {
  return value === 'staged' ||
    value === 'adopted' ||
    value === 'failed' ||
    value === 'rolled_back' ||
    value === 'rejected' ||
    value === 'unsupported'
    ? value
    : undefined;
}

function normalizeReceipt(
  value: unknown,
): LegacyApplicationReceipt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const attemptId = normalizeAttemptId(raw.attemptId);
  const candidateProfileRef = normalizeRef(raw.candidateProfileRef);
  const outcome = raw.outcome;
  const recordedAt =
    typeof raw.recordedAt === 'string' ? raw.recordedAt : undefined;
  if (
    !attemptId ||
    !candidateProfileRef ||
    (outcome !== 'staged' &&
      outcome !== 'adopted' &&
      outcome !== 'rolled_back' &&
      outcome !== 'superseded') ||
    !recordedAt
  ) {
    return undefined;
  }
  return { attemptId, candidateProfileRef, outcome, recordedAt };
}

function normalizeReceipts(value: unknown): LegacyApplicationReceipt[] {
  if (!Array.isArray(value)) return [];
  const receipts: LegacyApplicationReceipt[] = [];
  const attempts = new Set<string>();
  for (const valueReceipt of value) {
    const receipt = normalizeReceipt(valueReceipt);
    if (!receipt || attempts.has(receipt.attemptId)) continue;
    attempts.add(receipt.attemptId);
    receipts.push(receipt);
    if (receipts.length === MAX_APPLICATION_RECEIPTS) break;
  }
  return receipts;
}

/** Drops malformed and unsafe untrusted input; absence remains default-off. */
export function normalizeCredentialProfileRegistry(
  value: unknown,
): LegacyCredentialProfileRegistryState {
  const raw =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  const profiles = normalizeProfiles(raw.profiles);
  const knownRefs = new Set(profiles.map((profile) => profile.ref));
  const activeProfileRef = normalizeRef(raw.activeProfileRef);
  const pendingApplication = normalizePending(
    raw.pendingApplication,
    knownRefs,
  );
  const outcome = normalizeOutcome(raw.outcome);
  // Terminal receipts remain valid evidence even if the associated profile
  // was later deleted. Recovery acknowledgement, not profile membership,
  // owns their retention.
  const applicationReceipts = normalizeReceipts(raw.applicationReceipts);
  return {
    profiles,
    group: normalizeGroup(raw.group, knownRefs),
    policy: {
      automatic:
        raw.policy !== null &&
        typeof raw.policy === 'object' &&
        (raw.policy as Record<string, unknown>).automatic === true,
    },
    ...(activeProfileRef && knownRefs.has(activeProfileRef)
      ? { activeProfileRef }
      : {}),
    ...(pendingApplication ? { pendingApplication } : {}),
    ...(applicationReceipts.length > 0 ? { applicationReceipts } : {}),
    ...(outcome ? { outcome } : {}),
  };
}

function stateOf(value: unknown): LegacyCredentialProfileRegistryState {
  return normalizeCredentialProfileRegistry(value);
}

function withState(
  state: LegacyCredentialProfileRegistryState,
): LegacyCredentialProfileRegistryState {
  return state;
}

function rejected(
  state: LegacyCredentialProfileRegistryState,
): CredentialProfileRegistryTransitionResult {
  return {
    state: withState({ ...state, outcome: 'rejected' }),
    transition: 'rejected',
  };
}

/** Upserts management metadata and explicitly adds a new profile to the group. */
export function upsertCredentialProfile(
  value: unknown,
  profile: CredentialProfile,
): CredentialProfileRegistryTransitionResult {
  const state = stateOf(value);
  const ref = normalizeRef(profile.ref);
  if (!ref) return rejected(state);
  const label = normalizeLabel(profile.label);
  const existing = state.profiles.find((candidate) => candidate.ref === ref);
  if (!existing && state.profiles.length >= MAX_PROFILES)
    return rejected(state);
  const profiles = existing
    ? state.profiles.map((candidate) =>
        candidate.ref === ref ? (label ? { ref, label } : { ref }) : candidate,
      )
    : [...state.profiles, label ? { ref, label } : { ref }];
  const profileRefs = state.group.profileRefs.includes(ref)
    ? state.group.profileRefs
    : [...state.group.profileRefs, ref];
  return {
    state: withState({
      ...state,
      profiles,
      group: { ...state.group, profileRefs },
    }),
    transition: 'ignored',
  };
}

export function setCredentialProfileEnrollment(
  value: unknown,
  refInput: string,
  enrolled: boolean,
): CredentialProfileRegistryTransitionResult {
  const state = stateOf(value);
  const ref = normalizeRef(refInput);
  if (!ref || !state.group.profileRefs.includes(ref)) return rejected(state);
  const enrolledProfileRefs = enrolled
    ? state.group.enrolledProfileRefs.includes(ref)
      ? state.group.enrolledProfileRefs
      : [...state.group.enrolledProfileRefs, ref]
    : state.group.enrolledProfileRefs.filter((candidate) => candidate !== ref);
  return {
    state: withState({
      ...state,
      group: { ...state.group, enrolledProfileRefs },
    }),
    transition: 'ignored',
  };
}

export function setCredentialRecoveryAutomaticPolicy(
  value: unknown,
  automatic: boolean,
): CredentialProfileRegistryTransitionResult {
  const state = stateOf(value);
  if (typeof automatic !== 'boolean') return rejected(state);
  return {
    state: withState({ ...state, policy: { automatic } }),
    transition: 'ignored',
  };
}

export function deleteCredentialProfile(
  value: unknown,
  refInput: string,
): CredentialProfileRegistryTransitionResult {
  const state = stateOf(value);
  const ref = normalizeRef(refInput);
  if (
    !ref ||
    state.activeProfileRef === ref ||
    state.pendingApplication?.candidateProfileRef === ref ||
    state.pendingApplication?.previousProfileRef === ref ||
    state.group.enrolledProfileRefs.includes(ref)
  ) {
    return rejected(state);
  }
  if (!state.profiles.some((profile) => profile.ref === ref))
    return rejected(state);
  return {
    state: withState({
      ...state,
      profiles: state.profiles.filter((profile) => profile.ref !== ref),
      group: {
        profileRefs: state.group.profileRefs.filter(
          (candidate) => candidate !== ref,
        ),
        enrolledProfileRefs: state.group.enrolledProfileRefs.filter(
          (candidate) => candidate !== ref,
        ),
      },
    }),
    transition: 'ignored',
  };
}

/** Public projection intentionally does not include pending attempt identity. */
export function projectCredentialProfileRegistry(
  value: unknown,
  capability: CredentialProfileApplicationCapability,
): CredentialRecoveryGroupProjection {
  const state = stateOf(value);
  return {
    profiles: state.profiles.map((profile) => ({ ...profile })),
    group: {
      profileRefs: [...state.group.profileRefs],
      enrolledProfileRefs: [...state.group.enrolledProfileRefs],
    },
    policy: {
      automatic: isAutomaticCredentialRecoveryEnabled(state.policy),
    },
    application: {
      capability,
      ...(state.activeProfileRef
        ? { activeProfileRef: state.activeProfileRef }
        : {}),
      ...(state.pendingApplication
        ? { pendingProfileRef: state.pendingApplication.candidateProfileRef }
        : {}),
      ...(state.outcome ? { outcome: state.outcome } : {}),
    },
  };
}

/** A deterministic filesystem-safe id; opaque refs are never path components. */
export function credentialProfileStorageId(
  engineId: string,
  ref: string,
): string {
  const normalizedRef = normalizeRef(ref);
  if (!normalizedRef) throw new Error('Credential profile ref is not safe.');
  const digest = createHash('sha256')
    .update(`${engineId}\u0000${normalizedRef}`)
    .digest('hex');
  return `credential-profile-${digest}`;
}

export function credentialProfileAppHomeDir(
  engineId: string,
  ref: string,
  homeDir?: string,
): string {
  return appHomeProfileDir(credentialProfileStorageId(engineId, ref), homeDir);
}

/** Lazily creates only the Station-owned profile directory, never a global home. */
export async function ensureCredentialProfileAppHome(
  engineId: string,
  ref: string,
  options: EnsureAppHomeProfileOptions = {},
) {
  return ensureAppHomeProfile(
    credentialProfileStorageId(engineId, ref),
    options,
  );
}

export const DEFAULT_NORMALIZED_CREDENTIAL_RECOVERY_POLICY =
  DEFAULT_CREDENTIAL_RECOVERY_POLICY;
