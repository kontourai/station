import { useRef, useState } from 'react';
import {
  type NewChatIntent,
  OPEN_NEW_CHAT_EVENT,
} from '../../lib/newChatIntent';
import { Button } from '../Button';

export function HomeChatStartForm({ identity }: { identity?: string }) {
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  return (
    <form
      className="home-view__goal"
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
        rows={3}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      {identity ? (
        <p className="home-view__goal-identity">Using {identity}</p>
      ) : null}
      <div className="home-view__goal-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={!prompt.trim()}
          pending={pending}
          pendingLabel="Preparing…"
        >
          Start a chat
        </Button>
        <Button
          type="button"
          variant="link"
          disabled={pending}
          onClick={() => window.dispatchEvent(new Event(OPEN_NEW_CHAT_EVENT))}
        >
          Chat options
        </Button>
      </div>
    </form>
  );
}
