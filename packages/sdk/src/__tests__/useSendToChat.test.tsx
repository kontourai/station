// @vitest-environment jsdom
/**
 * `useSendToChat` accepts the plugin-qualified form plugin authors write,
 * `'<plugin>:<agent>'`, and derives the Agent's identity itself (#2400,
 * owner decision). Driven through the real SDK context seam: the hook reads
 * the host's `agents` slot and launches through its `activeChats` slot.
 */
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSendToChat } from '../hooks/operations';
import { SDKProvider } from '../providers';
import type { AgentSummary } from '../types';

// Slugs are globally unique: the installer refuses a second Agent with a slug
// that already exists, so the catalog never holds two rows with one slug.
const agents: AgentSummary[] = [
  { slug: 'assistant', name: 'My Plugin Assistant', plugin: 'my-plugin' },
  { slug: 'reviewer', name: 'Other Plugin Reviewer', plugin: 'other-plugin' },
  { slug: 'station', name: 'Station' },
];

function mount(agent: Parameters<typeof useSendToChat>[0]) {
  const launchChat = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SDKProvider
      value={{
        apiBase: '',
        contexts: {
          agents: { useAgents: () => agents },
          activeChats: { useLaunchChat: () => launchChat },
        },
        hooks: {},
      }}
    >
      {children}
    </SDKProvider>
  );
  const { result } = renderHook(() => useSendToChat(agent), { wrapper });
  return { send: result.current, launchChat };
}

afterEach(() => vi.restoreAllMocks());

describe('useSendToChat', () => {
  it('launches the Agent the qualified form names, under its bare identity', () => {
    const { send, launchChat } = mount('my-plugin:assistant');
    send('Summarize this document');
    expect(launchChat).toHaveBeenCalledExactlyOnceWith(
      'assistant',
      'My Plugin Assistant',
      'Summarize this document',
    );
  });

  it('refuses a reference naming a plugin that did not contribute the Agent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, launchChat } = mount('other-plugin:assistant');
    send('Hello');
    expect(launchChat).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[useSendToChat] Agent 'other-plugin:assistant' not found",
    );
  });

  it('refuses a qualified reference to an Agent from no plugin', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, launchChat } = mount('my-plugin:station');
    send('Hello');
    expect(launchChat).not.toHaveBeenCalled();
  });

  it('refuses a qualified reference whose Agent half is not a clean identity', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send, launchChat } = mount('my-plugin:Assistant');
    send('Hello');
    expect(launchChat).not.toHaveBeenCalled();
  });

  it('still launches a clean Agent id by slug', () => {
    const { send, launchChat } = mount(agentId('station'));
    send('Hi');
    expect(launchChat).toHaveBeenCalledExactlyOnceWith(
      'station',
      'Station',
      'Hi',
    );
  });
});
