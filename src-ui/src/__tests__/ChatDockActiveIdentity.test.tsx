/**
 * @vitest-environment jsdom
 */

import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
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
  /**
   * One line: title, agent, engine. The model and the route are the
   * composer's (its model picker names them), so the bar carries them only in
   * the context's tooltip.
   */
  test('keeps the model and route out of the line and in the tooltip', () => {
    render(
      <ChatDockActiveIdentity
        session={session}
        agent={codex}
        modelLabel="GPT-6.1 Sol"
        routeLabel="home-media"
        onClose={vi.fn()}
      />,
    );
    expect(
      document.querySelector('.chat-dock__active-identity-engine')?.textContent,
    ).toBe('Claude Code');
    expect(
      document
        .querySelector('.chat-dock__active-identity-context')
        ?.getAttribute('title'),
    ).toBe('Codex · Claude Code · GPT-6.1 Sol · via home-media');
  });

  test('leads with the conversation title, then the agent and engine', () => {
    render(
      <ChatDockActiveIdentity
        session={session}
        agent={codex}
        modelLabel="Opus 5 (1M context)"
        onClose={vi.fn()}
      />,
    );

    // Order is the claim, not just presence: title → agent → engine.
    expect(identityText()).toBe('Polish the Station dockCodexClaude Code');
    expect(
      document.querySelector('.chat-dock__active-identity-avatar'),
    ).not.toBeNull();
  });

  test('shows only a server-issued driven-from origin', () => {
    const { rerender } = render(
      <ChatDockActiveIdentity session={session} onClose={vi.fn()} />,
    );
    expect(screen.queryByText('Driven from delegation')).toBeNull();
    rerender(
      <ChatDockActiveIdentity
        session={session}
        inputOrigin={{
          kind: 'delegation',
          taskId: 'task:review',
          title: 'Review Station',
        }}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Driven from delegation').getAttribute('title'),
    ).toBe('Driven from delegated task: Review Station');
    // It is the first to give way on a narrow bar, so the title's tooltip
    // keeps it.
    expect(
      document
        .querySelector('.chat-dock__active-identity-title')
        ?.getAttribute('title')
        ?.split('\n')
        .at(-1),
    ).toBe('Driven from delegated task: Review Station');
    // With no task title, it says so plainly rather than show the raw id.
    rerender(
      <ChatDockActiveIdentity
        session={session}
        inputOrigin={{ kind: 'delegation', taskId: 'task:01da7f' }}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Driven from delegation').getAttribute('title'),
    ).toBe('Driven from a delegated task');
  });

  test('the title and the context each carry their full text as a tooltip; the title names the context too, which may have stepped aside', () => {
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
    ).toBe(
      'Polish the Station dock\nCodex · Claude Code · Opus 5 (1M context)',
    );
    expect(
      document
        .querySelector('.chat-dock__active-identity-context')
        ?.getAttribute('title'),
    ).toBe('Codex · Claude Code · Opus 5 (1M context)');
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
    expect(identityText()).toBe('Polish the Station dockStation');
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
    expect(identityText()).toBe('Polish the Station dockRelease Bot');
  });

  test('an unresolved agent still attributes from the session, and claims no engine', () => {
    render(<ChatDockActiveIdentity session={session} onClose={vi.fn()} />);

    // `agentName`/`agentSlug` are the session's own committed facts, so the
    // avatar and name survive a catalog miss; the engine is not derivable
    // without the catalog row, so nothing is asserted about it.
    expect(identityText()).toBe('Polish the Station dockCodex');
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

/**
 * #3355: a LOCAL chat passes no `originProvider` (only an imported session
 * records one), so the header's engine mark has to come from the catalog's
 * `engineId` for the agent. Before this, a Codex-bound agent with a non-brand
 * slug drew "CO"-style initials in the header even with the catalog healthy.
 * The slug is deliberately not an engine id, so `AgentIcon`'s slug parse
 * cannot supply the mark on its own.
 */
describe('ChatDockActiveIdentity engine mark for a local chat (#3355)', () => {
  const session = {
    id: 'chat-local',
    title: 'Review the release notes',
    agentSlug: 'release-reviewer',
    agentName: 'Release Reviewer',
  } as ChatSession;

  function avatar() {
    return document.querySelector('.chat-dock__active-identity-avatar');
  }

  test('draws the catalog engine mark when the agent resolves to codex', () => {
    const agent = {
      slug: 'release-reviewer',
      name: 'Release Reviewer',
      engineId: 'codex',
      engineDisplayName: 'Codex',
      execution: { agentConnectionId: 'codex' },
    } as unknown as AgentData;

    render(
      <ChatDockActiveIdentity
        session={session}
        agent={agent}
        onClose={vi.fn()}
      />,
    );

    expect(avatar()?.getAttribute('data-brand-key')).toBe('codex');
    expect(avatar()?.querySelector('.brand-icon__initials')).toBeNull();
  });

  test('a catalog agent with no engine keeps its identicon rather than a guessed mark', () => {
    const agent = {
      slug: 'release-reviewer',
      name: 'Release Reviewer',
    } as unknown as AgentData;

    render(
      <ChatDockActiveIdentity
        session={session}
        agent={agent}
        onClose={vi.fn()}
      />,
    );

    expect(avatar()?.getAttribute('data-brand-key')).toBeNull();
    expect(avatar()?.classList.contains('brand-icon--identicon')).toBe(true);
  });

  test("an imported session's recorded provider still wins over the catalog", () => {
    const agent = {
      slug: 'release-reviewer',
      name: 'Release Reviewer',
      engineId: 'codex',
    } as unknown as AgentData;

    render(
      <ChatDockActiveIdentity
        session={session}
        agent={agent}
        originProvider="opencode"
        onClose={vi.fn()}
      />,
    );

    expect(avatar()?.getAttribute('data-brand-key')).toBe('opencode');
  });
  test('an ACP-bound agent draws no brand mark (#3355)', () => {
    const agent = {
      slug: 'release-reviewer',
      name: 'Release Reviewer',
      engineId: 'acp',
      engineConnectionType: 'acp',
      execution: { agentConnectionId: 'kiro' },
    } as unknown as AgentData;

    render(
      <ChatDockActiveIdentity
        session={session}
        agent={agent}
        onClose={vi.fn()}
      />,
    );

    expect(avatar()?.getAttribute('data-brand-key')).toBeNull();
    // `acp` is not a product, so the avatar is the agent's own fallback.
    const fallback =
      avatar()?.querySelector('.brand-icon__initials') ??
      (avatar()?.classList.contains('brand-icon--identicon') ? avatar() : null);
    expect(fallback).not.toBeNull();
  });
});

/**
 * The header names the engine the chat's Session runs on, by the same rule as
 * the composer's engine chip (`chatEngineIdentity`). Repointing the Agent does
 * not move an open Session, so the Agent's configured connection must not
 * relabel it; the two surfaces sit on one screen and must agree.
 */
describe('ChatDockActiveIdentity session engine', () => {
  const agentOn = (connection: string, name: string, slug = 'station') =>
    ({
      slug,
      name: slug === 'station' ? 'Station' : slug,
      engineId: connection,
      engineDisplayName: name,
      execution: { agentConnectionId: connection },
    }) as unknown as AgentData;

  const engineText = () =>
    document.querySelector('.chat-dock__active-identity-engine')?.textContent ??
    null;

  /** A chat whose connection was observed for its current Session. */
  function observed(provider: string, connection: string) {
    return {
      orchestrationProvider: provider,
      agentConnectionId: engineConnectionId(connection),
      currentSessionId: 'session-1',
      agentConnectionObservedFor: 'session-1',
    } as Partial<ChatSession>;
  }

  function renderHeader(
    session: Partial<ChatSession>,
    agent: AgentData,
    executionAgent?: AgentData,
  ) {
    render(
      <ChatDockActiveIdentity
        session={
          {
            id: 'chat-engine',
            title: 'Continue',
            agentSlug: 'station',
            agentName: 'Station',
            ...session,
          } as ChatSession
        }
        agent={agent}
        executionAgent={executionAgent}
        acpConnections={[{ id: 'opencode', name: 'OpenCode' }]}
        onClose={vi.fn()}
      />,
    );
  }

  test('a Codex Session reads Codex after its Agent is repointed to OpenCode', () => {
    renderHeader(observed('codex', 'codex'), agentOn('opencode', 'OpenCode'));
    expect(engineText()).toBe('Codex');
  });

  test('an ACP Session is named by its own connection', () => {
    renderHeader(observed('acp', 'opencode'), agentOn('codex', 'Codex'));
    expect(engineText()).toBe('OpenCode');
  });

  test('an Agent still bound to the Session keeps its own connection name', () => {
    renderHeader(
      observed('codex', 'codex-work'),
      agentOn('codex-work', 'Codex (work)'),
    );
    expect(engineText()).toBe('Codex (work)');
  });

  test('before any Session exists the header names the configured engine', () => {
    renderHeader({}, agentOn('opencode', 'OpenCode'));
    expect(engineText()).toBe('OpenCode');
  });

  test('a connection observed for an earlier Session claims no engine name (#4162)', () => {
    // A successor started on the Agent's new ACP connection, but the chat's
    // connection is still the one observed for its predecessor.
    renderHeader(
      {
        orchestrationProvider: 'acp',
        agentConnectionId: engineConnectionId('codex'),
        currentSessionId: 'session-2',
        agentConnectionObservedFor: 'session-1',
      } as Partial<ChatSession>,
      agentOn('opencode-work', 'OpenCode (work)'),
    );
    expect(engineText()).toBeNull();
  });

  test('a conversation override is judged against its execution Agent', () => {
    // The profile Agent is on OpenCode; the override runs this chat on the
    // Codex (work) connection, which is the Session's. The chip compares
    // against the same execution Agent and names "Codex (work)".
    renderHeader(
      observed('codex', 'codex-work'),
      agentOn('opencode', 'OpenCode'),
      agentOn('codex-work', 'Codex (work)', 'codex-work-default'),
    );
    expect(engineText()).toBe('Codex (work)');
  });
});
