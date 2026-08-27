// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { MessageAttribution } from '../components/chat/message-bubble/MessageAttribution';

describe('MessageAttribution (station#1424)', () => {
  test('renders nothing at all when there is no agent, engine, owner, or posture to show', () => {
    const { container } = render(
      <MessageAttribution agent={null} engine={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  test('renders the agent identity, engine chip, owner chip, and permission-posture badge together, human-visibly', () => {
    render(
      <MessageAttribution
        agent={{ name: 'Release Reviewer' }}
        engine={{ name: 'Claude Code' }}
        owner={{ id: 'brian', label: 'Brian Anderson' }}
        permissionPosture="read-only-attached"
      />,
    );
    expect(screen.getByText('Release Reviewer')).toBeTruthy();
    expect(screen.getByText('Claude Code')).toBeTruthy();
    expect(screen.getByText(/via Brian Anderson/)).toBeTruthy();
    expect(screen.getByText('Read only')).toBeTruthy();
  });

  test('omits the engine chip when the engine cannot be resolved (LOW-1 honesty) but still shows the agent identity — asserting real absence, not just presence of something else (station#1424 review fix M2b)', () => {
    const { container } = render(
      <MessageAttribution agent={{ name: 'Unresolved Agent' }} engine={null} />,
    );
    expect(screen.getByText('Unresolved Agent')).toBeTruthy();
    // No engine chip rendered at all: neither a resolved name nor any
    // stray pill markup leaks through when `engine` is null. Scoped to this
    // render's own container (station#1424 review round 3, NEW-5) — a
    // `document`-wide query would still pass today but silently stop
    // meaning anything the moment a sibling test leaves markup mounted.
    expect(container.querySelector('.engine-chip')).toBeNull();
  });

  test('never fabricates an agent identity — agent: null omits the name entirely rather than showing a placeholder like "AI" (station#1424 review fix N4)', () => {
    const { container } = render(
      <MessageAttribution agent={null} engine={{ name: 'Station' }} />,
    );
    expect(screen.getByText('Station')).toBeTruthy();
    expect(screen.queryByText('AI')).toBeNull();
    expect(
      container.querySelector('.message-attribution__agent-name'),
    ).toBeNull();
  });

  test('renders no icon of its own — the row already has one avatar (station#1424 review fix S2)', () => {
    const { container } = render(
      <MessageAttribution
        agent={{ name: 'Icon-free Agent' }}
        engine={{ name: 'Station' }}
      />,
    );
    expect(container.querySelector('.brand-icon')).toBeNull();
  });

  test('omits the owner chip and posture badge when neither is supplied', () => {
    render(
      <MessageAttribution
        agent={{ name: 'Quiet Agent' }}
        engine={{ name: 'Station' }}
      />,
    );
    expect(screen.queryByText(/^via /)).toBeNull();
    expect(screen.queryByText('Read only')).toBeNull();
  });

  test.each([
    ['Codex', 'codex'],
    ['  Claude   Code  ', 'claude code'],
    ['Ｃｏｄｅｘ', 'Codex'],
  ])(
    'states equivalent Agent %j and engine %j labels only once',
    (agentName, engineName) => {
      const { container } = render(
        <MessageAttribution
          agent={{ name: agentName }}
          engine={{ name: engineName }}
        />,
      );
      expect(
        container.querySelector('.message-attribution__agent-name'),
      ).toBeNull();
      expect(container.querySelector('.engine-chip')).not.toBeNull();
      expect(container.querySelector('.engine-chip')?.textContent).toBe(
        engineName,
      );
    },
  );

  test('keeps distinct Agent and engine provenance labels', () => {
    render(
      <MessageAttribution
        agent={{ name: 'Release Reviewer' }}
        engine={{ name: 'Codex' }}
      />,
    );
    expect(screen.getByText('Release Reviewer')).toBeTruthy();
    expect(screen.getByText('Codex')).toBeTruthy();
  });
});
