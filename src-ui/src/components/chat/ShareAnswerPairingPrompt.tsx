import { requestCurrentStationAccess } from '@kontourai/station-connect';
import { useState } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { errorText } from '../../utils/errorText';

/**
 * The pairing path offered when minting a share is refused for want of a
 * credential (archive#1423).
 *
 * **It performs the REQUEST and never the confirm, and that is the whole
 * design.** The same-origin browser-continuity flow ends in a credential
 * carrying `DEFAULT_GRANT_PAIRING_SCOPE` — read, operate, terminal, AND
 * `access:manage`: full authority over this Station, not "permission to
 * share". The host-side confirm step follows a public access request; it does
 * not create protected-route authority from a loopback position. Auto-
 * confirming here — under a per-answer button, to get past a 401 — would
 * functionally reopen, the hole this slice exists to close. The operator
 * approves it themselves, on
 * the pairing surface, having seen what they are approving.
 *
 * Lazily loaded by `ShareAnswerButton` so neither this component nor the
 * connect package's pairing core sits in the entry chunk every operator
 * downloads on first paint.
 */

type PromptState =
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'requested' }
  | { phase: 'failed'; message: string };

export function ShareAnswerPairingPrompt() {
  const { apiBase } = useApiBase();
  const { navigate } = useNavigation();
  const [state, setState] = useState<PromptState>({ phase: 'idle' });

  const requestAccess = async () => {
    setState({ phase: 'requesting' });
    try {
// The browser sets `Origin` itself and forbids scripts from overriding
// it, so no explicit origin is passed here — see
// `requestCurrentStationAccess`'s own note on the CLI's different case.
      await requestCurrentStationAccess({
        endpoint: apiBase,
        deviceName: 'This browser',
      });
      setState({ phase: 'requested' });
    } catch (error) {
      setState({ phase: 'failed', message: errorText(error) });
    }
  };

  return (
    <span className="share-answer__pairing">
      <span className="share-answer__status">
        Pairing this browser grants it{' '}
        <strong>full access to this Station</strong> — reading and controlling
        sessions, opening terminals, and managing devices — not just sharing.
        Station asks for it here because a share link keeps working after you
        close this tab.
      </span>

      {state.phase === 'idle' && (
        <button
          type="button"
          className="share-answer__button"
          onClick={requestAccess}
        >
          Request pairing for this browser
        </button>
      )}

      {state.phase === 'requesting' && (
        <span className="share-answer__status" role="status">
          Sending the request…
        </span>
      )}

      {state.phase === 'requested' && (
        <>
          <span className="share-answer__status" role="status">
            Request sent. Station will not grant anything until you approve it
            yourself — open Connections, approve this browser, then use Share
            answer again.
          </span>
          <button
            type="button"
            className="share-answer__button"
            onClick={() => navigate('/connections')}
          >
            Open Connections to approve
          </button>
        </>
      )}

      {state.phase === 'failed' && (
        <span className="share-answer__status" role="alert">
          {state.message}
        </span>
      )}
    </span>
  );
}
