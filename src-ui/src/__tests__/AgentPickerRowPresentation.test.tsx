// @vitest-environment jsdom

import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AgentPickerGroups } from '../components/chat-start/AgentPickerRow';
import type { AgentData } from '../contexts/AgentsContext';

vi.mock('../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => ({ hostName: 'home-server' }),
}));

// The engine-default row for a connection its owner named after the engine
// plus where it runs, as the phone picker showed it.
const PROXIED_CLAUDE: AgentData = {
  slug: agentId('claude-code'),
  name: 'Claude Code',
  source: 'local',
  engineDefault: true,
  engineDisplayName: 'Claude Code (home-server proxy)',
  execution: { agentConnectionId: engineConnectionId('claude-proxy') },
};
// A custom Agent on that same engine: its name is not the engine's, so the
// whole engine name is what tells the user where it runs.
const REVIEWER_ON_PROXY: AgentData = {
  slug: agentId('reviewer'),
  name: 'Reviewer',
  source: 'local',
  engineDisplayName: 'Claude Code (home-server proxy)',
  execution: { agentConnectionId: engineConnectionId('claude-proxy') },
};
const KIRO: AgentData = {
  slug: agentId('kiro'),
  name: 'Kiro CLI',
  source: 'acp',
  engineConnectionType: 'acp',
  connectionName: 'Kiro CLI',
};

function renderRows(
  agents: AgentData[],
  model: (agent: AgentData) => { label: string; unavailable: boolean },
) {
  return render(
    <AgentPickerGroups
      groups={[{ label: 'Coding apps', glyph: 'engine', agents }]}
      flatList={agents}
      selectedIndex={0}
      onChoose={() => {}}
      onHover={() => {}}
      modelLabelFor={(agent) => model(agent).label}
      modelUnavailableFor={(agent) => model(agent).unavailable}
      onOpenModel={() => {}}
      fixDisabledFor={() => undefined}
      onFix={() => {}}
    />,
  );
}

function row(slug: string): HTMLElement {
  const button = document.querySelector(`[data-agent-slug="${slug}"]`);
  const element = button?.closest('.new-chat-modal__agent-row');
  if (!(element instanceof HTMLElement)) throw new Error(`no row ${slug}`);
  return element;
}

afterEach(cleanup);

describe('Agent picker row presentation', () => {
  test('an engine named after the Agent shows only its qualifier', () => {
    renderRows([PROXIED_CLAUDE, REVIEWER_ON_PROXY], () => ({
      label: 'Opus',
      unavailable: false,
    }));
    const proxied = within(row(PROXIED_CLAUDE.slug));
    expect(proxied.getByText('home-server proxy')).toBeTruthy();
    expect(proxied.queryByText('Claude Code (home-server proxy)')).toBeNull();
    // An Agent with its own name keeps the whole engine name.
    expect(
      within(row(REVIEWER_ON_PROXY.slug)).getByText(
        'Claude Code (home-server proxy)',
      ),
    ).toBeTruthy();
  });

  test('only a single trailing qualifier is split off the engine name', () => {
    const twoGroups: AgentData = {
      ...PROXIED_CLAUDE,
      slug: agentId('claude-two'),
      engineDisplayName: 'Claude Code (a) (b)',
    };
    renderRows([twoGroups], () => ({ label: 'Opus', unavailable: false }));
    expect(
      within(row(twoGroups.slug)).getByText('Claude Code (a) (b)'),
    ).toBeTruthy();
  });

  test('a row with no resolvable engine draws no empty engine label', () => {
    // A custom Agent bound to a connection the catalog cannot name has no
    // engine descriptor; its meta line used to render empty and add height.
    const unresolved: AgentData = {
      slug: agentId('unresolved'),
      name: 'Unresolved',
      source: 'local',
      execution: { agentConnectionId: engineConnectionId('elsewhere') },
    };
    renderRows([unresolved], () => ({ label: 'Opus', unavailable: false }));
    expect(
      row(unresolved.slug).querySelector('.new-chat-modal__agent-engine'),
    ).toBeNull();
  });

  test('a state badge appears only on a blocked row with no fix of its own', () => {
    const fixable: AgentData = {
      ...KIRO,
      slug: agentId('kiro-fixable'),
      available: false,
      unavailableReason: 'Kiro CLI connection is broken.',
      unavailableFix: { kind: 'connection-broken' },
    };
    const policy: AgentData = {
      ...KIRO,
      slug: agentId('kiro-policy'),
      available: false,
      unavailableReason: 'An external policy currently prevents launch.',
      unavailableFix: { kind: 'policy' },
    };
    renderRows([PROXIED_CLAUDE, fixable, policy], () => ({
      label: 'Opus',
      unavailable: false,
    }));
    const badge = (slug: string) =>
      row(slug).querySelector('.agent-readiness__status');
    // Ready: choosable says it; no "Ready" badge.
    expect(badge(PROXIED_CLAUDE.slug)).toBeNull();
    expect(within(row(PROXIED_CLAUDE.slug)).queryByText('Ready')).toBeNull();
    // Blocked with a fix: disabled, with its one button, and no badge.
    const fixableSelect = row(fixable.slug).querySelector(
      'button[data-agent-slug]',
    ) as HTMLButtonElement;
    expect(fixableSelect.disabled).toBe(true);
    expect(
      within(row(fixable.slug)).getByRole('button', { name: /Set up/ }),
    ).toBeTruthy();
    expect(badge(fixable.slug)).toBeNull();
    // A row that cannot start still offers its Model: a choice made before
    // the repair survives it (NewChatModalSetupReturn).
    expect(
      within(row(fixable.slug)).getByRole('button', { name: 'Model: Opus' }),
    ).toBeTruthy();
    // Blocked with no fix: the badge is the row's only stated reason.
    expect(badge(policy.slug)?.textContent).toBe('Not set up');
    // The engine pill follows the name on its line.
    expect(
      row(PROXIED_CLAUDE.slug).querySelector(
        '.new-chat-modal__agent-header .new-chat-modal__agent-engine .engine-chip__pill',
      )?.textContent,
    ).toBe('home-server proxy');
  });

  test('rows do not repeat the Station every row runs on', () => {
    renderRows([PROXIED_CLAUDE, KIRO], () => ({
      label: 'Opus',
      unavailable: false,
    }));
    expect(screen.queryByText(/^on home-server$/)).toBeNull();
  });

  test('an unreported model is not printed as a model', () => {
    renderRows([PROXIED_CLAUDE, KIRO], (agent) =>
      agent.slug === KIRO.slug
        ? { label: 'Model not reported', unavailable: true }
        : { label: 'Opus', unavailable: true },
    );
    expect(
      within(row(KIRO.slug)).queryByRole('button', { name: /^Model: / }),
    ).toBeNull();
    expect(screen.queryByText('Model not reported')).toBeNull();
    // A named model with no catalog keeps its disabled trigger.
    const named = within(row(PROXIED_CLAUDE.slug)).getByRole('button', {
      name: 'Model: Opus',
    });
    expect((named as HTMLButtonElement).disabled).toBe(true);
  });

  test('an unreported model with a catalog asks for a choice', () => {
    const opened: HTMLElement[] = [];
    render(
      <AgentPickerGroups
        groups={[{ label: 'Coding apps', glyph: 'code', agents: [KIRO] }]}
        flatList={[KIRO]}
        selectedIndex={0}
        onChoose={() => {}}
        onHover={() => {}}
        modelLabelFor={() => 'Model not reported'}
        modelUnavailableFor={() => false}
        onOpenModel={(_agent, trigger) => opened.push(trigger)}
        fixDisabledFor={() => undefined}
        onFix={() => {}}
      />,
    );
    const trigger = within(row(KIRO.slug)).getByRole('button', {
      name: 'Model: Choose model',
    });
    expect(trigger.textContent).toBe('Choose model');
    expect(screen.queryByText('Model not reported')).toBeNull();
    trigger.click();
    expect(opened).toEqual([trigger]);
  });
});
