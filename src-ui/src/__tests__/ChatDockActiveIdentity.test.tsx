/**
 * @vitest-environment jsdom
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ChatDockActiveIdentity } from '../components/chat-dock/ChatDockActiveIdentity';
import type { AgentData } from '../contexts/AgentsContext';
import type { ChatSession } from '../types';
import { identiconHue } from '../utils/identicon';
import {
  clipboardAbsent,
  clipboardRefuses,
  clipboardWrites,
} from './clipboard-stubs';

vi.mock('../hooks/useKeyboardShortcut', () => ({
  useShortcutDisplay: () => '⌘W',
}));

const { triggerHapticMock } = vi.hoisted(() => ({
  triggerHapticMock: vi.fn(),
}));
vi.mock('../platform/native/haptics', () => ({
  triggerHaptic: triggerHapticMock,
}));

afterEach(() => {
  cleanup();
  triggerHapticMock.mockReset();
  clipboardAbsent();
});

const routedSession = {
  id: 'local-tab-key',
  conversationId: 'station-thread-from-route',
  title: 'Routed session',
  agentSlug: 'codex',
} as ChatSession;

function copyButton() {
  return screen.getByRole('button', { name: 'Copy thread ID' });
}

/**
 * archive#3309: the header reads agent-first. These pin WHAT the row names and
 * in WHICH order — the owner's report was that the dock never showed the agent
 * answering in it, only the conversation's own title.
 */
describe('ChatDockActiveIdentity agent identity (#3309)', () => {
  const session = {
    id: 'chat-1',
    title: 'Polish the Station dock',
    agentSlug: 'codex',
    agentName: 'Codex',
  } as ChatSession;

  const codex = {
    slug: 'codex',
    name: 'Codex',
    engineId: 'claude-code',
    engineDisplayName: 'Claude Code',
  } as unknown as AgentData;

  function identityText() {
    return document.querySelector('.chat-dock__active-identity-text')
      ?.textContent;
  }

  test('leads with the agent, then engine and model, with the title last', () => {
    render(
      <ChatDockActiveIdentity
        session={session}
        agent={codex}
        modelLabel="Opus 5 (1M context)"
        onClose={vi.fn()}
      />,
    );

    // Order is the claim, not just presence: agent → engine → model → title.
    expect(identityText()).toBe(
      'CodexClaude CodeOpus 5 (1M context)Polish the Station dock',
    );
    expect(
      document.querySelector('.chat-dock__active-identity-avatar'),
    ).not.toBeNull();
  });

  test('an unreported model names none rather than a placeholder', () => {
    render(
      <ChatDockActiveIdentity
        session={session}
        agent={codex}
        modelLabel={null}
        onClose={vi.fn()}
      />,
    );

    expect(
      document.querySelector('.chat-dock__active-identity-model'),
    ).toBeNull();
    expect(identityText()).not.toContain('not reported');
  });

  test('an engine chip that would repeat the agent name is suppressed', () => {
    const station = {
      slug: 'station',
      name: 'Station',
      engineId: 'station',
      engineDisplayName: 'Station',
    } as unknown as AgentData;

    render(
      <ChatDockActiveIdentity
        session={
          {
            ...session,
            agentSlug: 'station',
            agentName: 'Station',
          } as ChatSession
        }
        agent={station}
        onClose={vi.fn()}
      />,
    );

    // One "Station", not two: the agent's own name now carries that identity.
    expect(identityText()).toBe('StationPolish the Station dock');
    expect(document.querySelector('.engine-chip')).toBeNull();
  });

  /**
   * The discriminating fixture for this row's headline claim: the avatar is
   * seeded from the SESSION's committed `agentSlug`, so it survives a catalog
   * miss. Every other fixture here is brand-named ("Codex", "Station"), and
   * `resolveBrandKey` matches on the NAME as well as the id — so those render
   * vendor artwork whether or not the slug reaches `AgentIcon`, and cannot see
   * the slug being lost. This agent's name matches no brand, which forces the
   * identicon path, whose hue is derived from the slug and nothing else.
   */
  test('a non-brand agent the catalog never resolved still gets its slug-seeded identicon', () => {
    const { container } = render(
      <ChatDockActiveIdentity
        session={
          {
            ...session,
            agentSlug: 'release-bot',
            agentName: 'Release Bot',
          } as ChatSession
        }
        onClose={vi.fn()}
      />,
    );

    const swatch = container.querySelector('.brand-icon--identicon');
    expect(swatch).toBeTruthy();
    expect(
      (swatch as HTMLElement).style.getPropertyValue('--identicon-hue'),
    ).toBe(String(identiconHue('release-bot')));
    expect(identityText()).toBe('Release BotPolish the Station dock');
  });

  test('an unresolved agent still attributes from the session, and claims no engine', () => {
    render(<ChatDockActiveIdentity session={session} onClose={vi.fn()} />);

    // `agentName`/`agentSlug` are the session's own committed facts, so the
    // avatar and name survive a catalog miss; the engine is not derivable
    // without the catalog row, so nothing is asserted about it.
    expect(identityText()).toBe('CodexPolish the Station dock');
    expect(
      document.querySelector('.chat-dock__active-identity-avatar'),
    ).not.toBeNull();
    expect(document.querySelector('.engine-chip')).toBeNull();
  });
});

describe('ChatDockActiveIdentity', () => {
  test('renders the active title and closes that exact conversation', () => {
    const onClose = vi.fn();
    const session = {
      id: 'chat-1',
      title: 'Polish the Station dock',
      agentSlug: 'codex',
    } as ChatSession;

    render(<ChatDockActiveIdentity session={session} onClose={onClose} />);

    expect(screen.getByText('Polish the Station dock')).toBeTruthy();
    const close = screen.getByRole('button', { name: 'Close chat' });
    expect(close.getAttribute('title')).toBe('Close (⌘W)');
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledWith('chat-1');
  });

  // #765 A7: the idle chip used to read a bare "ID", which looked like a
  // debug artifact next to the chat title. The visible label must name the
  // action the aria-label already promises.
  test('the copy control idles as "Copy ID", not a bare "ID" chip', () => {
    render(
      <ChatDockActiveIdentity session={routedSession} onClose={vi.fn()} />,
    );
    expect(copyButton().textContent).toBe('Copy ID');
    expect(copyButton().classList).toContain('chat-dock__active-identity-copy');
    expect(copyButton().style.minWidth).toBe('44px');
    expect(copyButton().style.minHeight).toBe('44px');
    expect(copyButton().style.fontSize).toBe('var(--text-xs)');
  });

  test('copies the routed conversation id, never the local tab key', async () => {
    const writeText = clipboardWrites();

    render(
      <ChatDockActiveIdentity session={routedSession} onClose={vi.fn()} />,
    );
    fireEvent.click(copyButton());

    expect(writeText).toHaveBeenCalledWith('station-thread-from-route');
    expect(writeText).not.toHaveBeenCalledWith('local-tab-key');
    await waitFor(() => expect(copyButton().textContent).toBe('Copied'));
    expect(triggerHapticMock).toHaveBeenCalledWith('light');
    expect(screen.getByRole('status').textContent).toBe('Thread ID copied.');
  });

  // archive#3341: the two arms that used to render "Copied" for a write that
  // never happened.
  test('a refused write never claims a copy and never buzzes', async () => {
    clipboardRefuses();

    render(
      <ChatDockActiveIdentity session={routedSession} onClose={vi.fn()} />,
    );
    fireEvent.click(copyButton());

    await waitFor(() => expect(copyButton().textContent).toBe("Can't copy"));
    expect(copyButton().textContent).not.toContain('Copied');
    expect(triggerHapticMock).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain(
      'refused clipboard access',
    );
  });

  test('an insecure origin with no clipboard API never claims a copy', async () => {
    clipboardAbsent();

    render(
      <ChatDockActiveIdentity session={routedSession} onClose={vi.fn()} />,
    );
    fireEvent.click(copyButton());

    await waitFor(() => expect(copyButton().textContent).toBe("Can't copy"));
    expect(triggerHapticMock).not.toHaveBeenCalled();
  });

  test('the copy reset timer is cleared on unmount', async () => {
    clipboardWrites();
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    const { unmount } = render(
      <ChatDockActiveIdentity session={routedSession} onClose={vi.fn()} />,
    );

    fireEvent.click(copyButton());
    await waitFor(() => expect(copyButton().textContent).toBe('Copied'));
    clearTimeoutSpy.mockClear();
    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
