import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import { useId, useState } from 'react';
import { Button } from '../Button';
import {
  type PullRequestReferenceScope,
  parsePullRequestReference,
} from './pull-request-reference';
import './LinkPullRequestField.css';

/**
 * Link a pull request to the chat: one field and one action. Accepts a URL,
 * `owner/repo#n`, or `#n` against `scope` (the checkout's repository); the
 * action stays disabled until the text reads as one of those.
 */
export function LinkPullRequestField({
  scope,
  pending,
  onLink,
  autoFocus = false,
}: {
  scope: PullRequestReferenceScope;
  pending: boolean;
  onLink: (identity: PullRequestLinkIdentity) => void;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const id = useId();
  const identity = parsePullRequestReference(text, scope);
  const placeholder = scope.repository?.name
    ? `#number or URL`
    : 'Pull request URL';
  const submit = () => {
    if (identity && !pending) onLink(identity);
  };
  return (
    <form
      className="link-pull-request"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor={id} className="sr-only">
        Pull request
      </label>
      <input
        id={id}
        className="editor-input link-pull-request__input"
        value={text}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        // The field opens on request, so focus follows the request.
        // biome-ignore lint/a11y/noAutofocus: opened by the "+" that asked for it.
        autoFocus={autoFocus}
        onChange={(event) => setText(event.target.value)}
      />
      <Button
        type="submit"
        size="sm"
        disabled={!identity}
        pending={pending}
        pendingLabel="Linking"
      >
        Link
      </Button>
    </form>
  );
}
