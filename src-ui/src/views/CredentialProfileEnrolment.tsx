import {
  type EnrolmentAuthState,
  useEnrolmentQuery,
} from '@kontourai/station-sdk';
import { SkeletonBlock } from '../components/state';

const authStateLabels: Record<EnrolmentAuthState, string> = {
  authenticated: 'Signed in',
  unauthenticated: 'Signed out',
  unknown: 'Sign-in status unknown',
};

export function CredentialProfileEnrolment({
  connectionId,
  profileRef,
}: {
  connectionId: string;
  profileRef: string;
}) {
  const { data, error, isLoading, isFetching, refetch } = useEnrolmentQuery(
    connectionId,
    profileRef,
  );

  if (isLoading) {
    // a twelfth loading sentence. The vocabulary is SkeletonList /
    // SkeletonBlock, and a wait names itself in the skeleton's `label` — not
    // in a new string that disagrees with its neighbours on casing, ellipsis
    // and noun. Region-shaped wait, so SkeletonBlock.
    return (
      <SkeletonBlock
        count={1}
        className="credential-enrolment__checking"
        label="Checking sign-in state"
      />
    );
  }

  if (error || !data) {
    return (
      <div className="credential-enrolment">
        <p className="credential-enrolment__checking" aria-live="polite">
          Could not check sign-in state.
        </p>
        <button
          type="button"
          className="editor-btn editor-btn--ghost"
          disabled={isFetching}
          onClick={() => void refetch()}
        >
          Re-check sign-in state for {profileRef}
        </button>
      </div>
    );
  }

  return (
    <div className="credential-enrolment">
      <p
        className={`credential-enrolment__state credential-enrolment__state--${data.authState}`}
        aria-live="polite"
      >
        {authStateLabels[data.authState]}
      </p>
      {data.detail && (
        <p className="credential-enrolment__detail">{data.detail}</p>
      )}
      <details className="credential-enrolment__command">
        <summary>Show sign-in command</summary>
        <dl>
          <dt>Command</dt>
          <dd>
            <code>{data.command.command}</code>
          </dd>
          <dt>Arguments</dt>
          <dd>
            <code>{data.command.args.join(' ') || '(none)'}</code>
          </dd>
          <dt>Environment</dt>
          <dd>
            {Object.entries(data.command.env).map(([key, value]) => (
              <code key={key}>{`${key}=${value}`}</code>
            ))}
          </dd>
          <dt>Description</dt>
          <dd>{data.command.description}</dd>
        </dl>
      </details>
      <button
        type="button"
        className="editor-btn editor-btn--ghost"
        disabled={isFetching}
        onClick={() => void refetch()}
      >
        {isFetching ? 'Checking sign-in state…' : "I've run it — check again"}
      </button>
    </div>
  );
}
