/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { AgentEditorCredentialProfile } from '../views/agent-editor/AgentEditorCredentialProfile';
import type { AgentFormData } from '../views/agent-editor/types';

let recovery: unknown = null;
let isLoading = false;
let isError = false;

vi.mock('@kontourai/station-sdk', () => ({
  useCredentialRecoveryQuery: () => ({ data: recovery, isLoading, isError }),
}));

function createForm(
  execution: Partial<AgentFormData['execution']> = {},
): AgentFormData {
  return {
    slug: 'agent-one',
    name: 'Agent One',
    description: '',
    prompt: '',
    modelId: '',
    region: '',
    guardrails: null,
    maxSteps: '',
    tools: { mcpServers: [], available: [], autoApprove: [] },
    execution: {
      agentConnectionId: 'claude',
      modelConnectionId: '',
      runtimeOptions: {},
      ...execution,
    },
    icon: '',
    skills: [],
    project: '',
  };
}

const withProfiles = (
  profiles: Array<{ ref: string; label?: string }>,
  activeProfileRef?: string,
) => ({
  profiles,
  group: { profileRefs: [], enrolledProfileRefs: [] },
  policy: { automatic: false },
  application: { capability: 'restart_resume', activeProfileRef },
});

describe('AgentEditorCredentialProfile (station#3551)', () => {
  beforeEach(() => {
    recovery = null;
    isLoading = false;
    isError = false;
  });

// proved the loading/error branch could be DELETED
// with this suite staying green, because nothing here ever set those flags.
// Loading and a failed request must never read as "this engine has no
// accounts" — for a pinned agent OR an unpinned one.
  test('loading is its own state, not an absent capability', () => {
    isLoading = true;
    const { container } = render(
      <AgentEditorCredentialProfile
        form={createForm()}
        setForm={vi.fn()}
        locked={false}
      />,
    );
    expect(container.innerHTML).not.toBe('');
    expect(screen.getByText(/Checking which accounts/i)).toBeTruthy();
  });

  test('a failed request says so rather than implying the engine has none', () => {
    isError = true;
    render(
      <AgentEditorCredentialProfile
        form={createForm()}
        setForm={vi.fn()}
        locked={false}
      />,
    );
    expect(screen.getByText(/could not read this engine/i)).toBeTruthy();
    expect(
      screen.getByText(/not the same as the engine having none/i),
    ).toBeTruthy();
  });

  test('a pinned agent keeps its pin visible while loading', () => {
    isLoading = true;
    render(
      <AgentEditorCredentialProfile
        form={createForm({ credentialProfileRef: 'work-account' })}
        setForm={vi.fn()}
        locked={false}
      />,
    );
    expect(screen.getByText(/pins work-account/i)).toBeTruthy();
  });

// An engine with no app-home channel has no accounts to choose between.
// A dropdown there could only ever mislead.
  test('renders nothing for an engine with no credential-profile concept', () => {
    recovery = null;
    const { container } = render(
      <AgentEditorCredentialProfile
        form={createForm()}
        setForm={vi.fn()}
        locked={false}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

 // agent-engine-unification.md §5: a capability the engine cannot deliver is
// an authoring-time validation state, never a silent drop.
  test('surfaces a pin authored against an engine that cannot deliver it', () => {
    recovery = null;
    render(
      <AgentEditorCredentialProfile
        form={createForm({ credentialProfileRef: 'work-account' })}
        setForm={vi.fn()}
        locked={false}
      />,
    );
    expect(screen.getByText(/has no separate accounts/i)).toBeTruthy();
    expect(screen.getByDisplayValue('work-account')).toBeTruthy();
  });

  test('lists enrolled accounts and names the connection fallback', () => {
    recovery = withProfiles(
      [{ ref: 'work-account', label: 'Work' }, { ref: 'personal-account' }],
      'work-account',
    );
    render(
      <AgentEditorCredentialProfile
        form={createForm()}
        setForm={vi.fn()}
        locked={false}
      />,
    );
// The unpinned option states the resolved outcome, not a blank.
    expect(
      screen.getByText("Uses the connection's account (work-account)."),
    ).toBeTruthy();
    expect(screen.getByText('Work (work-account)')).toBeTruthy();
    expect(screen.getByText('personal-account')).toBeTruthy();
  });

// "No pin" must be one representable state, not an empty string that later
// reads as a profile named "".
  test('clearing the selection unsets the ref rather than storing an empty string', () => {
    recovery = withProfiles([{ ref: 'work-account' }], 'work-account');
    let next: AgentFormData | undefined;
    const setForm = vi.fn(
      (updater: (current: AgentFormData) => AgentFormData) => {
        next = updater(createForm({ credentialProfileRef: 'work-account' }));
      },
    );
    render(
      <AgentEditorCredentialProfile
        form={createForm({ credentialProfileRef: 'work-account' })}
        setForm={setForm as never}
        locked={false}
      />,
    );
    fireEvent.change(screen.getByLabelText('Account'), {
      target: { value: '' },
    });
    expect(next?.execution.credentialProfileRef).toBeUndefined();
  });

  test('selecting an account pins it', () => {
    recovery = withProfiles([{ ref: 'personal-account' }], 'work-account');
    let next: AgentFormData | undefined;
    const setForm = vi.fn(
      (updater: (current: AgentFormData) => AgentFormData) => {
        next = updater(createForm());
      },
    );
    render(
      <AgentEditorCredentialProfile
        form={createForm()}
        setForm={setForm as never}
        locked={false}
      />,
    );
    fireEvent.change(screen.getByLabelText('Account'), {
      target: { value: 'personal-account' },
    });
    expect(next?.execution.credentialProfileRef).toBe('personal-account');
  });

// A pin whose profile was deleted must stay selectable — saving an unrelated
// edit cannot silently discard it — and must say it will not resolve. The
// session fails closed rather than running on another account.
  test('keeps an unenrolled pin selectable and says it will not resolve', () => {
    recovery = withProfiles([{ ref: 'personal-account' }], 'personal-account');
    render(
      <AgentEditorCredentialProfile
        form={createForm({ credentialProfileRef: 'deleted-account' })}
        setForm={vi.fn()}
        locked={false}
      />,
    );
    expect(screen.getByText('deleted-account — not enrolled')).toBeTruthy();
    expect(
      screen.getByText(/will fail rather than run on a different/i),
    ).toBeTruthy();
  });

  test('says so when the engine supports accounts but none are enrolled', () => {
    recovery = withProfiles([]);
    render(
      <AgentEditorCredentialProfile
        form={createForm()}
        setForm={vi.fn()}
        locked={false}
      />,
    );
    expect(screen.getByText(/No separate accounts are enrolled/i)).toBeTruthy();
  });
});
