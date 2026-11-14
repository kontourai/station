import type {
  InputRequestUrl,
  InputRequestUrlResponse,
} from '@kontourai/station-contracts/input-request';
import { readInputRequestLink } from '@kontourai/station-shared/input-request';
import { useState } from 'react';
import { userFacingErrorMessage } from '../../utils/errorText';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';
import './InputRequestCard.css';

const PURPOSE_TITLE: Record<InputRequestUrl['body']['purpose'], string> = {
  'mcp-sign-in': 'wants you to sign in',
  elicitation: 'wants you to open a link',
  'engine-link': 'wants you to open a link',
};

/**
 * A `station.input-request/v1` URL request: a link the source wants the
 * person to open (an MCP server's sign-in page, a URL-mode elicitation, an
 * engine's link). Station never opens it: the person does, and the answer
 * says only that they did (`accept`, recorded as opened) or that they
 * cancelled. The link's host
 * is shown beside the button, so the person sees where it goes.
 */
export function InputRequestUrlCard({
  request,
  onRespond,
}: {
  request: InputRequestUrl;
  onRespond: (action: InputRequestUrlResponse['action']) => Promise<void>;
}) {
  const [pending, setPending] = useState<InputRequestUrlResponse['action']>();
  const [done, setDone] = useState<InputRequestUrlResponse['action']>();
  const [error, setError] = useState<string>();
  // The contract's reader already refused anything else; check again rather
  // than render an href nobody validated.
  const link = readInputRequestLink(request.body.url);
  const host = link ? new URL(link).host : undefined;

  const respond = async (action: InputRequestUrlResponse['action']) => {
    setPending(action);
    setError(undefined);
    try {
      await onRespond(action);
      setDone(action);
    } catch (failure) {
      setError(userFacingErrorMessage(failure));
    } finally {
      setPending(undefined);
    }
  };

  if (done)
    return (
      <p className="input-request-card__provenance" role="status">
        {done === 'accept'
          ? `Opened ${request.requester}’s link`
          : `Cancelled ${request.requester}’s request`}
      </p>
    );

  return (
    <section
      className="input-request-card"
      aria-label={`${request.requester} ${PURPOSE_TITLE[request.body.purpose]}`}
    >
      <div className="input-request-card__heading">
        <strong>
          {request.requester} {PURPOSE_TITLE[request.body.purpose]}
        </strong>
        {host ? <span>{host}</span> : null}
      </div>
      {request.message ? (
        <p className="input-request-card__message">{request.message}</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="input-request-card__footer">
        <ActionRow
          className="input-request-card__actions"
          overflowLabel="More link options"
          secondary={
            <Button
              variant="secondary"
              disabled={!!pending}
              pending={pending === 'cancel'}
              pendingLabel="Cancelling…"
              onClick={() => void respond('cancel')}
            >
              Cancel
            </Button>
          }
          primary={
            link ? (
              <a
                className="button button--primary"
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                aria-disabled={!!pending}
                onClick={(event) => {
                  if (pending) {
                    event.preventDefault();
                    return;
                  }
                  void respond('accept');
                }}
              >
                {request.body.purpose === 'mcp-sign-in'
                  ? 'Sign in'
                  : 'Open link'}
              </a>
            ) : (
              <span role="status">This link can’t be opened from Station.</span>
            )
          }
        />
      </div>
    </section>
  );
}
