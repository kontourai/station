/**
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  chatState: {
    agentSlug: 'station',
    provider: 'station',
    input: '',
  } as Record<string, unknown>,
  agents: [{ slug: 'station', name: 'Station', skills: [] as string[] }],
  updateChat: vi.fn(),
  addEphemeralMessage: vi.fn(),
  runSkill: vi.fn().mockResolvedValue(undefined),
  readSkillDetail: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useRunSkill: () => ({ mutateAsync: mocks.runSkill }),
  useSkillDetailReader: () => mocks.readSkillDetail,
}));
vi.mock('../contexts/ActiveChatsContext', () => ({
  activeChatsStore: {
    getSnapshot: () => ({ 'session-1': mocks.chatState }),
  },
  useActiveChatActions: () => ({
    updateChat: mocks.updateChat,
    addEphemeralMessage: mocks.addEphemeralMessage,
  }),
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => mocks.agents,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost' }),
}));

import { useSlashCommandHandler } from '../hooks/useSlashCommandHandler';

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const autocomplete = {
  openModel: vi.fn(),
  openNewChat: vi.fn(),
  closeCommand: vi.fn(),
  closeAll: vi.fn(),
};

function run(command: string) {
  const { result } = renderHook(() => useSlashCommandHandler(), { wrapper });
  return result.current('session-1', command, { autocomplete });
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mocks.agents = [{ slug: 'station', name: 'Station', skills: [] }];
  mocks.updateChat.mockClear();
  mocks.addEphemeralMessage.mockClear();
  mocks.runSkill.mockClear();
  mocks.readSkillDetail.mockReset();
});

// Plan §4. A typed `/command` resolves against the SKILLS cache, its body is read on demand (the listing carries no bodies), and
// its variables substitute exactly as a custom agent command's params do.
describe('typing a command skill', () => {
  function seedSkills(skills: unknown[]) {
    queryClient.setQueryData(['skills', 'local'], skills);
  }

  test('expands a global command skill and counts the run', async () => {
    seedSkills([
      { name: 'release-check', command: { enabled: true, global: true } },
    ]);
    mocks.readSkillDetail.mockResolvedValue({
      name: 'release-check',
      body: 'Ship it',
      variables: [],
    });

    await expect(run('/release-check')).resolves.toBe('Ship it');
    expect(mocks.runSkill).toHaveBeenCalledWith('release-check');
    expect(mocks.updateChat).toHaveBeenCalledWith('session-1', { input: '' });
  });

  test('substitutes positional arguments into the body', async () => {
    seedSkills([
      { name: 'release-check', command: { enabled: true, global: true } },
    ]);
    mocks.readSkillDetail.mockResolvedValue({
      name: 'release-check',
      body: 'Ship {{ticket}} to {{env}}',
      variables: [{ name: 'ticket' }, { name: 'env', default: 'staging' }],
    });

    await expect(run('/release-check ABC-1')).resolves.toBe(
      'Ship ABC-1 to staging',
    );
  });
  // a variable with neither a typed value nor a declared default
  // is REJECTED — named in an error the user reads — never silently
  // substituted with an empty string. Nothing is sent and the run is not
  // counted, because the skill did not run.
  test('refuses to send when a required variable has no value or default', async () => {
    seedSkills([
      { name: 'release-check', command: { enabled: true, global: true } },
    ]);
    mocks.readSkillDetail.mockResolvedValue({
      name: 'release-check',
      body: 'Ship {{ticket}} to {{env}}',
      variables: [{ name: 'ticket' }, { name: 'env', default: 'staging' }],
    });

    await expect(run('/release-check')).resolves.toBe(true);
    expect(mocks.addEphemeralMessage).toHaveBeenCalledWith('session-1', {
      role: 'system',
      content: '/release-check needs a value for {{ticket}} — nothing was sent',
    });
    expect(mocks.runSkill).not.toHaveBeenCalled();
    expect(mocks.updateChat).toHaveBeenCalledWith('session-1', { input: '' });
  });

  // args parse shell-style — quotes group into one value.
  test('a quoted argument is one value, not split on its spaces', async () => {
    seedSkills([
      { name: 'release-check', command: { enabled: true, global: true } },
    ]);
    mocks.readSkillDetail.mockResolvedValue({
      name: 'release-check',
      body: 'Notes {{notes}} env {{env}}',
      variables: [{ name: 'notes' }, { name: 'env' }],
    });

    await expect(run('/release-check "release notes" prod')).resolves.toBe(
      'Notes release notes env prod',
    );
  });

  // `name=value` assigns by name, so an earlier defaulted
  // variable keeps its default while a later required one is supplied.
  test('a named argument supplies a later variable while the earlier keeps its default', async () => {
    seedSkills([
      { name: 'release-check', command: { enabled: true, global: true } },
    ]);
    mocks.readSkillDetail.mockResolvedValue({
      name: 'release-check',
      body: 'Notes {{notes}} env {{env}}',
      variables: [{ name: 'notes', default: 'none' }, { name: 'env' }],
    });

    await expect(run('/release-check env=prod')).resolves.toBe(
      'Notes none env prod',
    );
  });

  test('mixed named and positional arguments fill the right variables', async () => {
    seedSkills([
      { name: 'release-check', command: { enabled: true, global: true } },
    ]);
    mocks.readSkillDetail.mockResolvedValue({
      name: 'release-check',
      body: 'Notes {{notes}} env {{env}}',
      variables: [{ name: 'notes', default: 'none' }, { name: 'env' }],
    });

    await expect(run('/release-check "some notes" env=prod')).resolves.toBe(
      'Notes some notes env prod',
    );
  });

  // a line the parser cannot read is never dispatched — not
  // to a skill, a builtin, or the model.
  test('an unterminated quote reports the parse error and sends nothing', async () => {
    seedSkills([
      { name: 'release-check', command: { enabled: true, global: true } },
    ]);

    await expect(run('/release-check "unclosed')).resolves.toBe(true);
    expect(mocks.readSkillDetail).not.toHaveBeenCalled();
    expect(mocks.addEphemeralMessage).toHaveBeenCalledWith('session-1', {
      role: 'system',
      content:
        'Could not read /release-check "unclosed: unterminated double quote (") — it never closes',
    });
  });

  test('a surplus positional is an error naming it, not a dropped value', async () => {
    seedSkills([
      { name: 'release-check', command: { enabled: true, global: true } },
    ]);
    mocks.readSkillDetail.mockResolvedValue({
      name: 'release-check',
      body: 'Notes {{notes}}',
      variables: [{ name: 'notes' }],
    });

    await expect(run('/release-check a b')).resolves.toBe(true);
    expect(mocks.addEphemeralMessage).toHaveBeenCalledWith('session-1', {
      role: 'system',
      content:
        "/release-check: no variable left for 'b' — this command takes 1 value — nothing was sent",
    });
    expect(mocks.runSkill).not.toHaveBeenCalled();
  });

  // The command word can differ from the skill name.
  test('matches the declared command word', async () => {
    seedSkills([
      {
        name: 'release-check',
        command: { enabled: true, global: true, name: 'ship' },
      },
    ]);
    mocks.readSkillDetail.mockResolvedValue({
      name: 'release-check',
      body: 'Ship it',
      variables: [],
    });

    await expect(run('/ship')).resolves.toBe('Ship it');
    expect(mocks.readSkillDetail).toHaveBeenCalledWith('release-check');
  });

  // CAT-: attaching is what makes a non-global command available, and the
  // binding is `agent.skills` — the record the agent editor writes.
  test('a non-global command skill is only typable where it is attached', async () => {
    seedSkills([
      { name: 'deploy-notes', command: { enabled: true, global: false } },
    ]);
    mocks.readSkillDetail.mockResolvedValue({
      name: 'deploy-notes',
      body: 'Notes',
      variables: [],
    });

    // Not attached: falls through to the unknown-command path.
    await run('/deploy-notes');
    expect(mocks.readSkillDetail).not.toHaveBeenCalled();

    mocks.agents = [
      { slug: 'station', name: 'Station', skills: ['deploy-notes'] },
    ];
    await expect(run('/deploy-notes')).resolves.toBe('Notes');
  });

  // A failed body read must not send the raw `/command` to the model as if the
  // user had typed it as a message.
  test('reports a failed body read instead of sending the command text', async () => {
    seedSkills([
      { name: 'release-check', command: { enabled: true, global: true } },
    ]);
    mocks.readSkillDetail.mockRejectedValue(new Error('skill read failed'));

    await expect(run('/release-check')).resolves.toBe(true);
    expect(mocks.addEphemeralMessage).toHaveBeenCalledWith('session-1', {
      role: 'system',
      content: 'Could not read /release-check: skill read failed',
    });
    expect(mocks.runSkill).not.toHaveBeenCalled();
  });

  test('a skill nobody enabled is not a command', async () => {
    seedSkills([{ name: 'plain-skill' }]);
    mocks.agents = [
      { slug: 'station', name: 'Station', skills: ['plain-skill'] },
    ];

    await run('/plain-skill');
    expect(mocks.readSkillDetail).not.toHaveBeenCalled();
  });
});
