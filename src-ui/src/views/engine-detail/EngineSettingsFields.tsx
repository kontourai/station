import type {
  CredentialProfile,
  CredentialProfileApplicationProjection,
} from '@kontourai/station-contracts/connection-recovery';
import {
  useAppHomeProfileQuery,
  useApplyCredentialProfileMutation,
  useClearAppHomeProfileMutation,
  useCredentialRecoveryQuery,
  useDeleteCredentialProfileMutation,
  useImportAppHomeSnapshotMutation,
  useImportCredentialProfileSnapshotMutation,
  useSetCredentialProfileEnrollmentMutation,
  useSetCredentialRecoveryAutomaticPolicyMutation,
  useSkillsQuery,
  useUpsertCredentialProfileMutation,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { Checkbox } from '../../components/Checkbox';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import {
  describeReadFailure,
  ErrorState,
  SkeletonBlock,
} from '../../components/state';
import { formatBytes } from '../../utils/formatBytes';
import { describeStationFailure } from '../../utils/stationFailure';
import { CredentialProfileEnrolment } from '../CredentialProfileEnrolment';

/**
 * Skills materialization opt-in (docs/design/connections-onboarding.md §5):
 * an accessible multiselect of installed Station skills, scoped to the
 * claude connection only. Off by default — nothing is selected
 * until the user checks a box, and the resulting id list is only persisted
 * when the surrounding form's "Save Changes" button is pressed (mirrors how
 * Default Model above is edited, unlike the ACP tool-servers modal's
 * auto-save-per-toggle pattern).
 */
export function ClaudeSkillsMaterializationField({
  selectedSkillIds,
  onChange,
}: {
  selectedSkillIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const { data: skills = [] } = useSkillsQuery() as {
    data?: Array<{ name: string; description?: string }>;
  };

  function toggleSkill(id: string, checked: boolean) {
    onChange(
      checked
        ? [...new Set([...selectedSkillIds, id])]
        : selectedSkillIds.filter((existing) => existing !== id),
    );
  }

  return (
    <div className="editor-field">
      <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
        <legend className="editor-label" style={{ padding: 0 }}>
          Skills materialization
        </legend>
        <p className="editor-help">
          Checked skills are copied into the session's{' '}
          <code>.claude/skills/</code> and removed when it ends.
        </p>
        {skills.length === 0 ? (
          <p className="editor-help">
            No skills installed yet — install one from the Registry.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {skills.map((skill) => (
              <Checkbox
                key={skill.name}
                id={`claude-skill-${skill.name}`}
                checked={selectedSkillIds.includes(skill.name)}
                onChange={(checked) => toggleSkill(skill.name, checked)}
              >
                {skill.name}
                {skill.description ? ` — ${skill.description}` : ''}
              </Checkbox>
            ))}
          </div>
        )}
      </fieldset>
    </div>
  );
}

/**
 * App-home profile opt-in (#896,
 * docs/design/agent-engine-unification.md §6.1's overlay model): a
 * Station-managed config home for the connection's sessions, off by
 * default. Parameterized over `engineLabel` (#896  — claude
 * and codex both render this field). Import is a separate,
 * explicit user action — never triggered by the toggle or a form save —
 * and always renders its copied/skipped report, never silent.
 */
export function AppHomeProfileField({
  connectionId,
  engineLabel,
  useAppHome,
  onToggle,
}: {
  connectionId: string;
  engineLabel: string;
  useAppHome: boolean;
  onToggle: (value: boolean) => void;
}) {
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  // Read-only status peek (docs/design/agent-engine-unification.md §6.1) —
  // fetched regardless of the toggle so a profile left over from a prior
  // opt-in still shows its usage report and clear action after the toggle
  // is turned back off.
  const { data: status } = useAppHomeProfileQuery(connectionId);
  const importMutation = useImportAppHomeSnapshotMutation();
  const clearMutation = useClearAppHomeProfileMutation();

  return (
    <div className="editor-field">
      <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
        <legend className="editor-label" style={{ padding: 0 }}>
          App home
        </legend>
        <Checkbox
          id={`${connectionId}-use-app-home`}
          checked={useAppHome}
          onChange={onToggle}
        >
          Run sessions in a Station-managed app home
        </Checkbox>
        <p className="editor-help">
          Leaves your global {engineLabel} settings untouched. Uses{' '}
          <code>~/.station/app-homes/{connectionId}</code>.
        </p>
        {useAppHome && (
          <div style={{ marginTop: 8 }}>
            {status && (
              <p className="editor-help">
                {status.exists
                  ? `Contents: ${status.seededFrom === 'global-import' ? 'imported snapshot' : 'empty'} · Sign-in: ${status.authState}${status.keychainAuthPossible ? ' · macOS Keychain sign-in also works' : ''}`
                  : 'Created on the first session with this on.'}
              </p>
            )}
            <label
              className="editor-checkbox"
              htmlFor={`${connectionId}-app-home-include-credentials`}
            >
              <input
                id={`${connectionId}-app-home-include-credentials`}
                type="checkbox"
                checked={includeCredentials}
                onChange={(event) =>
                  setIncludeCredentials(event.target.checked)
                }
              />
              <span>Include sign-in credentials</span>
            </label>
            <div className="editor-row">
              <button
                type="button"
                className="editor-btn"
                disabled={importMutation.isPending}
                onClick={() =>
                  importMutation.mutate({
                    id: connectionId,
                    includeCredentials,
                  })
                }
              >
                {importMutation.isPending
                  ? 'Importing…'
                  : `Import a snapshot of your global ${engineLabel} settings`}
              </button>
            </div>
            {importMutation.data && (
              <p className="editor-help">
                Copied:{' '}
                {importMutation.data.copied.length > 0
                  ? importMutation.data.copied.join(', ')
                  : 'nothing'}
                {importMutation.data.skipped.length > 0 && (
                  <>
                    {' '}
                    · Skipped:{' '}
                    {importMutation.data.skipped
                      .map((entry) => `${entry.path} (${entry.reason})`)
                      .join(', ')}
                  </>
                )}
                {!importMutation.data.provenanceUpdated && (
                  <> · Not marked as imported.</>
                )}
              </p>
            )}
            {importMutation.error && (
              <p className="editor-error">
                {describeStationFailure(importMutation.error).body}
              </p>
            )}
          </div>
        )}
        <CredentialRecoveryField
          connectionId={connectionId}
          engineLabel={engineLabel}
        />
        {status?.exists && status.usage && (
          <div style={{ marginTop: 8 }}>
            <p className="editor-help">
              {`Using ${formatBytes(status.usage.sizeBytes)} across ${status.usage.entryCount}${status.usage.truncated ? '+' : ''} items.`}
            </p>
            <div className="editor-row">
              <button
                type="button"
                className="editor-btn"
                disabled={useAppHome || clearMutation.isPending}
                title={
                  useAppHome
                    ? 'Turn the app home off and save before clearing it.'
                    : undefined
                }
                onClick={() => setConfirmClearOpen(true)}
              >
                {clearMutation.isPending ? 'Clearing…' : 'Clear this app home'}
              </button>
            </div>
            {useAppHome && (
              <p className="editor-help">
                Turn the app home off and save before clearing it.
              </p>
            )}
            {clearMutation.error && (
              <p className="editor-error">
                {describeStationFailure(clearMutation.error).body}
              </p>
            )}
          </div>
        )}
      </fieldset>
      <ConfirmModal
        isOpen={confirmClearOpen}
        title="Clear app home"
        message={`Deletes ~/.station/app-homes/${connectionId}, including imported settings. This cannot be undone.`}
        confirmLabel="Clear"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          setConfirmClearOpen(false);
          clearMutation.mutate(connectionId);
        }}
        onCancel={() => setConfirmClearOpen(false)}
      />
    </div>
  );
}

/**
 * Credential profiles are an explicit layer over an app home: refs are opaque
 * handles for Station's managed profile directories, while labels are only a
 * management convenience. This view deliberately never receives or renders
 * credential values, account identities, or filesystem paths.
 */
function CredentialRecoveryField({
  connectionId,
  engineLabel,
}: {
  connectionId: string;
  engineLabel: string;
}) {
  return (
    <CredentialRecoveryLayout
      connectionId={connectionId}
      engineLabel={engineLabel}
      state={useCredentialRecoveryState(connectionId)}
    />
  );
}

function useCredentialRecoveryState(connectionId: string) {
  const [profileToApply, setProfileToApply] = useState<string | null>(null);
  const {
    data: recovery,
    isLoading,
    isError,
    error,
    refetch,
  } = useCredentialRecoveryQuery(connectionId);
  const upsertMutation = useUpsertCredentialProfileMutation();
  const deleteMutation = useDeleteCredentialProfileMutation();
  const enrollmentMutation = useSetCredentialProfileEnrollmentMutation();
  const policyMutation = useSetCredentialRecoveryAutomaticPolicyMutation();
  const importMutation = useImportCredentialProfileSnapshotMutation();
  const applyMutation = useApplyCredentialProfileMutation();
  const hasCompleteRecoveryState =
    recovery != null &&
    !Array.isArray(recovery) &&
    recovery.group != null &&
    recovery.policy != null &&
    recovery.application != null;

  return {
    recovery,
    isLoading,
    isError,
    error,
    refetch,
    profiles: recovery?.profiles ?? [],
    enrolledProfileRefs: recovery?.group?.enrolledProfileRefs ?? [],
    automatic: recovery?.policy?.automatic === true,
    unsupported:
      !hasCompleteRecoveryState ||
      recovery?.application?.capability !== 'restart_resume',
    pendingRef: recovery?.application?.pendingProfileRef,
    applyingRef: applyMutation.isPending ? profileToApply : null,
    outcome: applyMutation.data?.outcome ?? recovery?.application?.outcome,
    errors: [
      upsertMutation.error,
      deleteMutation.error,
      enrollmentMutation.error,
      policyMutation.error,
      importMutation.error,
      applyMutation.error,
    ],
    profileToApply,
    importResult: importMutation.data,
    importPending: importMutation.isPending,
    policyPending: policyMutation.isPending,
    profileMutating: {
      upsert: upsertMutation.isPending,
      remove: deleteMutation.isPending,
      enrollment: enrollmentMutation.isPending,
    },
    upsert: (ref: string, label: string | undefined, onSuccess?: () => void) =>
      upsertMutation.mutate({ id: connectionId, ref, label }, { onSuccess }),
    remove: (ref: string) => deleteMutation.mutate({ id: connectionId, ref }),
    setEnrollment: (ref: string, enrolled: boolean) =>
      enrollmentMutation.mutate({ id: connectionId, ref, enrolled }),
    setAutomatic: (automatic: boolean) =>
      policyMutation.mutate({ id: connectionId, automatic }),
    importProfile: (ref: string, includeCredentials: boolean) =>
      importMutation.mutate({ id: connectionId, ref, includeCredentials }),
    requestApply: setProfileToApply,
    cancelApply: () => setProfileToApply(null),
    confirmApply: () => {
      if (profileToApply) {
        applyMutation.mutate({
          id: connectionId,
          ref: profileToApply,
          confirmed: true,
        });
      }
      setProfileToApply(null);
    },
  };
}

function CredentialRecoveryLayout({
  connectionId,
  engineLabel,
  state,
}: {
  connectionId: string;
  engineLabel: string;
  state: ReturnType<typeof useCredentialRecoveryState>;
}) {
  // An engine that cannot apply an entry gets the fact, not a form of live
  // controls under a "Not supported" label.
  const unsupported =
    !state.isLoading &&
    !(state.isError && !state.recovery) &&
    state.unsupported;
  return (
    <section
      className="credential-recovery"
      aria-labelledby={`${connectionId}-credential-profiles-heading`}
    >
      <div>
        <h3
          id={`${connectionId}-credential-profiles-heading`}
          className="editor-label"
        >
          Credential entries
        </h3>
        <p className="editor-help">
          {unsupported
            ? 'Not supported by this engine.'
            : "References only; Station doesn't store or show credentials here."}
        </p>
      </div>
      {!unsupported && (
        <>
          <CredentialRecoveryStatus application={state.recovery?.application} />
          <CredentialRecoveryManagement
            connectionId={connectionId}
            engineLabel={engineLabel}
            state={state}
          />
          <CredentialRecoveryFeedback
            outcome={state.outcome}
            errors={state.errors}
          />
          <CredentialProfileApplyConfirmation state={state} />
        </>
      )}
    </section>
  );
}

function CredentialRecoveryManagement({
  connectionId,
  engineLabel,
  state,
}: {
  connectionId: string;
  engineLabel: string;
  state: ReturnType<typeof useCredentialRecoveryState>;
}) {
  if (state.isLoading) {
    return <SkeletonBlock count={2} label="Loading credential entries" />;
  }
  // archive#771: this used to fall straight through to the (empty) management
  // UI on a settled error, reading as "no credential entries" instead of "the
  // read failed". A retry that never had cached data has nothing to preserve.
  if (state.isError && !state.recovery) {
    return (
      <ErrorState
        title="Couldn't load credential entries"
        description={describeReadFailure(state.error)}
        action={
          <button type="button" onClick={() => state.refetch()}>
            Retry
          </button>
        }
      />
    );
  }
  return (
    <>
      <CredentialProfileEditor connectionId={connectionId} state={state} />
      <CredentialProfileProvisioning
        connectionId={connectionId}
        engineLabel={engineLabel}
        profiles={state.profiles}
        pending={state.importPending}
        result={state.importResult}
        onImport={state.importProfile}
      />
      <CredentialRecoveryPolicy
        connectionId={connectionId}
        automatic={state.automatic}
        pending={state.policyPending}
        onChange={state.setAutomatic}
      />
    </>
  );
}

function CredentialRecoveryFeedback({
  outcome,
  errors,
}: {
  outcome?: string;
  errors: unknown[];
}) {
  const isFailure =
    outcome === 'failed' ||
    outcome === 'rolled_back' ||
    outcome === 'rejected' ||
    outcome === 'unsupported';
  return (
    <>
      {outcome && (
        <p
          className={`credential-recovery__outcome${isFailure ? ' credential-recovery__outcome--failure' : ''}`}
          role={isFailure ? 'alert' : 'status'}
        >
          {isFailure
            ? `Credential application ${outcome === 'rolled_back' ? 'was rolled back' : 'did not complete'}; the active credential was not changed.`
            : `Credential application: ${outcome.replaceAll('_', ' ')}.`}
        </p>
      )}
      <CredentialRecoveryErrors errors={errors} />
    </>
  );
}

function CredentialProfileApplyConfirmation({
  state,
}: {
  state: ReturnType<typeof useCredentialRecoveryState>;
}) {
  return (
    <ConfirmModal
      isOpen={state.profileToApply !== null}
      title="Apply credential entry"
      message="Verifying uses one potentially billable engine turn. If it fails, the current credential stays active."
      confirmLabel="Apply and verify"
      cancelLabel="Cancel"
      variant="warning"
      onConfirm={state.confirmApply}
      onCancel={state.cancelApply}
    />
  );
}

function CredentialRecoveryStatus({
  application,
}: {
  application?: CredentialProfileApplicationProjection;
}) {
  const capability = application?.capability ?? 'unsupported';
  return (
    <div className="credential-recovery__status" aria-live="polite">
      <span className="plugins__cap plugins__cap--ref">
        {capability === 'restart_resume'
          ? 'Restart and resume'
          : capability === 'hot_apply'
            ? 'Apply without restart'
            : 'Not supported'}
      </span>
      {application?.activeProfileRef && (
        <span className="credential-recovery__status-value">
          Active: {application.activeProfileRef}
        </span>
      )}
      {application?.pendingProfileRef && (
        <span className="credential-recovery__status-value">
          Pending verification: {application.pendingProfileRef}
        </span>
      )}
    </div>
  );
}

function CredentialProfileEditor({
  connectionId,
  state,
}: {
  connectionId: string;
  state: ReturnType<typeof useCredentialRecoveryState>;
}) {
  return (
    <>
      <CredentialProfileList connectionId={connectionId} state={state} />
      <CredentialProfileCreateForm
        pending={state.profileMutating.upsert}
        onUpsert={state.upsert}
      />
    </>
  );
}

function CredentialProfileList({
  connectionId,
  state,
}: {
  connectionId: string;
  state: ReturnType<typeof useCredentialRecoveryState>;
}) {
  const { profiles } = state;
  return (
    <>
      <div className="credential-recovery__profile-list">
        {profiles.map((profile) => (
          <CredentialProfileRow
            connectionId={connectionId}
            key={profile.ref}
            profile={profile}
            state={state}
          />
        ))}
      </div>
      {profiles.length === 0 && (
        <p className="credential-recovery__notice">
          No credential entries added yet.
        </p>
      )}
    </>
  );
}

function CredentialProfileRow({
  connectionId,
  profile,
  state,
}: {
  connectionId: string;
  profile: CredentialProfile;
  state: ReturnType<typeof useCredentialRecoveryState>;
}) {
  const enrolled = state.enrolledProfileRefs.includes(profile.ref);
  return (
    <div className="credential-recovery__profile">
      <div className="credential-recovery__profile-copy">
        <CredentialProfileMetadata profile={profile} state={state} />
        <CredentialProfileEnrolment
          connectionId={connectionId}
          profileRef={profile.ref}
        />
        <Checkbox
          id={`${connectionId}-credential-profile-${profile.ref}-enrolled`}
          checked={enrolled}
          onChange={(enabled) => state.setEnrollment(profile.ref, enabled)}
          disabled={state.profileMutating.enrollment}
        >
          Allow automatic recovery selection
        </Checkbox>
      </div>
      <CredentialProfileActions profile={profile} state={state} />
    </div>
  );
}

function CredentialProfileMetadata({
  profile,
  state,
}: {
  profile: CredentialProfile;
  state: ReturnType<typeof useCredentialRecoveryState>;
}) {
  const [label, setLabel] = useState(profile.label ?? '');
  return (
    <>
      <div className="credential-recovery__profile-name">
        {profile.label || profile.ref}
      </div>
      {profile.label && (
        <p className="credential-recovery__profile-ref">Ref: {profile.ref}</p>
      )}
      <CredentialProfileLabelEditor
        label={label}
        pending={state.profileMutating.upsert}
        profileRef={profile.ref}
        onChange={setLabel}
        onSave={() => state.upsert(profile.ref, label.trim() || undefined)}
      />
    </>
  );
}

function CredentialProfileLabelEditor({
  label,
  pending,
  profileRef,
  onChange,
  onSave,
}: {
  label: string;
  pending: boolean;
  profileRef: string;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="credential-recovery__profile-actions">
      <input
        className="editor-input"
        aria-label={`Label for ${profileRef}`}
        value={label}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Management label"
      />
      <button
        type="button"
        className="editor-btn editor-btn--ghost"
        disabled={pending}
        onClick={onSave}
      >
        Save label
      </button>
    </div>
  );
}

function CredentialProfileActions({
  profile,
  state,
}: {
  profile: CredentialProfile;
  state: ReturnType<typeof useCredentialRecoveryState>;
}) {
  const applyDisabled =
    state.unsupported ||
    state.applyingRef !== null ||
    Boolean(state.pendingRef);
  return (
    <div className="credential-recovery__profile-actions">
      <button
        type="button"
        className="editor-btn"
        disabled={applyDisabled}
        onClick={() => state.requestApply(profile.ref)}
      >
        {state.applyingRef === profile.ref ? 'Applying…' : 'Apply manually'}
      </button>
      <button
        type="button"
        className="editor-btn editor-btn--ghost"
        disabled={state.profileMutating.remove || Boolean(state.pendingRef)}
        onClick={() => state.remove(profile.ref)}
      >
        Remove
      </button>
    </div>
  );
}

function CredentialProfileCreateForm({
  pending,
  onUpsert,
}: {
  pending: boolean;
  onUpsert: (
    ref: string,
    label: string | undefined,
    onSuccess?: () => void,
  ) => void;
}) {
  const [profileRef, setProfileRef] = useState('');
  const [profileLabel, setProfileLabel] = useState('');
  const addProfile = () => {
    const ref = profileRef.trim();
    if (!ref) return;
    onUpsert(ref, profileLabel.trim() || undefined, () => {
      setProfileRef('');
      setProfileLabel('');
    });
  };

  return (
    <div className="credential-recovery__add-row">
      <input
        className="editor-input"
        aria-label="Credential entry reference"
        value={profileRef}
        onChange={(event) => setProfileRef(event.target.value)}
        placeholder="Credential reference"
      />
      <input
        className="editor-input"
        aria-label="Credential entry label"
        value={profileLabel}
        onChange={(event) => setProfileLabel(event.target.value)}
        placeholder="Management label (optional)"
      />
      <button
        type="button"
        className="editor-btn"
        disabled={pending || profileRef.trim().length === 0}
        onClick={addProfile}
      >
        {pending ? 'Adding…' : 'Add credential entry'}
      </button>
    </div>
  );
}

function CredentialProfileProvisioning({
  connectionId,
  engineLabel,
  profiles,
  pending,
  result,
  onImport,
}: {
  connectionId: string;
  engineLabel: string;
  profiles: CredentialProfile[];
  pending: boolean;
  result?: {
    copied: string[];
    skipped: Array<unknown>;
    provenanceUpdated: boolean;
  };
  onImport: (ref: string, includeCredentials: boolean) => void;
}) {
  const [includeCredentials, setIncludeCredentials] = useState(false);
  return (
    <fieldset>
      <legend className="editor-label">Provisioning import</legend>
      <p className="editor-help">
        Imports the entry’s global {engineLabel} snapshot. Credentials are
        excluded unless checked below.
      </p>
      <Checkbox
        id={`${connectionId}-credential-profile-include-credentials`}
        checked={includeCredentials}
        onChange={setIncludeCredentials}
      >
        Include selected credential entry sign-in credentials
      </Checkbox>
      <div className="credential-recovery__profile-actions">
        {profiles.map((profile) => (
          <button
            key={profile.ref}
            type="button"
            className="editor-btn editor-btn--ghost"
            disabled={pending}
            onClick={() => onImport(profile.ref, includeCredentials)}
          >
            {pending
              ? 'Importing…'
              : `Import into ${profile.label || profile.ref}`}
          </button>
        ))}
      </div>
      {result && <CredentialProfileImportResult result={result} />}
    </fieldset>
  );
}

function CredentialProfileImportResult({
  result,
}: {
  result: {
    copied: string[];
    skipped: Array<unknown>;
    provenanceUpdated: boolean;
  };
}) {
  return (
    <p
      className="credential-recovery__outcome"
      role="status"
      aria-label="Credential entry provisioning import result"
    >
      Provisioning import completed: {result.copied.length}{' '}
      {result.copied.length === 1 ? 'item' : 'items'} copied;{' '}
      {result.skipped.length} {result.skipped.length === 1 ? 'item' : 'items'}{' '}
      skipped.{' '}
      {result.provenanceUpdated
        ? 'This credential entry is marked as imported.'
        : 'This credential entry was not marked as imported because nothing was copied.'}
    </p>
  );
}

function CredentialRecoveryPolicy({
  connectionId,
  automatic,
  pending,
  onChange,
}: {
  connectionId: string;
  automatic: boolean;
  pending: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <fieldset>
      <legend className="editor-label">Automatic recovery</legend>
      <Checkbox
        id={`${connectionId}-credential-recovery-automatic`}
        checked={automatic}
        onChange={onChange}
        disabled={pending}
      >
        Automatically try an enrolled credential entry after an account-scoped
        capacity or rate-limit failure
      </Checkbox>
      <p className="editor-help">Only enrolled entries are tried.</p>
    </fieldset>
  );
}

function CredentialRecoveryErrors({ errors }: { errors: unknown[] }) {
  const messages = [
    ...new Set(errors.map(mutationErrorMessage).filter(Boolean)),
  ];
  return messages.length > 0 ? (
    <div className="credential-recovery__errors" aria-live="assertive">
      {messages.map((message) => (
        <p className="editor-error" role="alert" key={message}>
          {message}
        </p>
      ))}
    </div>
  ) : null;
}

function mutationErrorMessage(error: unknown): string | null {
  if (!error) return null;
  return describeStationFailure(error).body;
}
