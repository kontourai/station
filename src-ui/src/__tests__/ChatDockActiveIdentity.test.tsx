/**
 * @vitest-environment jsdom
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ChatDockActiveIdentity } from '../components/chat-dock/ChatDockActiveIdentity';
import type { AgentData } from '../contexts/AgentsContext';
import type { ChatSession } from '../types';
import { identiconHue } from '../utils/identicon';

vi.mock('../hooks/useKeyboardShortcut', () => ({
  useShortcutDisplay: () => '⌘W',
}));

afterEach(cleanup);

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

  /**
   * #1536 F reordered the tail: the conversation TITLE is the row's flexible
   * element and the engine/model token follows it as ONE muted string. The
   * agent still leads (that is #3309's finding, and it is short); what changed
   * is that the label distinguishing this chat from the last one is no longer
   * the first thing to vanish.
   */
  test('leads with the agent, then the title, with engine and model as one token behind it', () => {
    render(
      <ChatDockActiveIdentity
        session={session}
        agent={codex}
        modelLabel="Opus 5 (1M context)"
        onClose={vi.fn()}
      />,
    );

    // Order is the claim, not just presence: agent → title → engine · model.
    expect(identityText()).toBe(
      'CodexPolish the Station dockClaude Code · Opus 5 (1M context)',
    );
    expect(
      document.querySelector('.chat-dock__active-identity-engine')?.textContent,
    ).toBe('Claude Code · Opus 5 (1M context)');
    expect(
      document.querySelector('.chat-dock__active-identity-avatar'),
    ).not.toBeNull();
  });

  test('the title and the token each carry their full text as a tooltip, because each ellipsizes', () => {
    render(
      <ChatDockActiveIdentity
        session={session}
        agent={codex}
        modelLabel="Opus 5 (1M context)"
        onClose={vi.fn()}
      />,
    );

    expect(
      screen.getByText('Polish the Station dock').getAttribute('title'),
    ).toBe('Polish the Station dock');
    expect(
      screen
        .getByText('Claude Code · Opus 5 (1M context)')
        .getAttribute('title'),
    ).toBe('Claude Code · Opus 5 (1M context)');
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

    // The token is the engine alone — not "Claude Code · " with a dangling
    // separator, and not a placeholder word.
    expect(
      document.querySelector('.chat-dock__active-identity-engine')?.textContent,
    ).toBe('Claude Code');
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
    expect(
      document.querySelector('.chat-dock__active-identity-engine'),
    ).toBeNull();
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
    expect(
      document.querySelector('.chat-dock__active-identity-engine'),
    ).toBeNull();
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

  /**
   * #1536 F: "Copy ID" was a 44px labelled button in this row, competing with
   * the conversation title for the same pixels. It is a row of the dock
   * header's More menu now — see `useDockCopyActions.test.tsx`, which carries
   * archive#3341's contracts (copies the ROUTED conversation id, never the
   * local tab key; never claims or buzzes for a refused write).
   */
  test('no longer carries its own copy affordance', () => {
    render(
      <ChatDockActiveIdentity
        session={
          {
            id: 'local-tab-key',
            conversationId: 'station-thread-from-route',
            title: 'Routed session',
            agentSlug: 'codex',
          } as ChatSession
        }
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Copy thread ID' })).toBeNull();
    // The close control is still here, so an unmounted row cannot pass this.
    expect(screen.getByRole('button', { name: 'Close chat' })).toBeTruthy();
  });
});
