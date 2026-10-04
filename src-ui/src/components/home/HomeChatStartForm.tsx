import { useId, useRef, useState } from 'react';
import {
  type NewChatIntent,
  OPEN_NEW_CHAT_EVENT,
} from '../../lib/newChatIntent';
import { Button } from '../Button';
import { NewChatAction } from '../NewChatAction';

export function HomeChatStartForm({
  identity,
  compact = false,
}: {
  /**
   * The Agent and Model "Start a chat" will run on: Home's `startIdentity`,
   * read from the same `useNewChatSelectionModel` default selection that the
   * start path's `startWorkingDefaults` opens on. Absent when no Agent is
   * ready, so nothing is advertised that Start would not use.
   */
  identity?: string;
  /**
   * One line, the form above a page of work. The identity moves beside the
   * Start button as a muted note instead of a caption under the field.
   */
  compact?: boolean;
}) {
  const identityId = useId();
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  return (
    <form
      className={`home-view__goal${compact ? ' home-view__goal--compact' : ''}`}
      aria-label="Start work"
      onSubmit={(event) => {
        event.preventDefault();
        if (!prompt.trim() || inFlight.current) return;
        inFlight.current = true;
        setPending(true);
        window.dispatchEvent(
          new CustomEvent<NewChatIntent>(OPEN_NEW_CHAT_EVENT, {
            detail: {
              startWithDefault: true,
              initialPrompt: prompt,
              onClosed: () => {
                inFlight.current = false;
                setPending(false);
              },
            },
          }),
        );
      }}
    >
      <textarea
        className="editor-textarea"
        aria-label="What would you like done?"
        placeholder="Tell Station what you want done…"
        rows={compact ? 1 : 3}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      {identity && !compact ? (
        <p className="home-view__goal-identity">Using {identity}</p>
      ) : null}
      <div className="home-view__goal-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={!prompt.trim()}
          pending={pending}
          pendingLabel="Preparing…"
          aria-describedby={identity && compact ? identityId : undefined}
        >
          Start a chat
        </Button>
        {identity && compact ? (
          <span id={identityId} className="home-view__goal-identity">
            {identity}
          </span>
        ) : null}
        <NewChatAction
          variant="link"
          disabled={pending}
          onClick={() => window.dispatchEvent(new Event(OPEN_NEW_CHAT_EVENT))}
        />
      </div>
    </form>
  );
}
