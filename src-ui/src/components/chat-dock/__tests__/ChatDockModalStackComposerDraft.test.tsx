/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { ProjectChatComposerDraft } from '../../../lib/projectChatEvents';

// The picker itself is covered by NewChatModalSelectDispatch; this pins the
// hand-off from the dock's new-chat request to the picker's draft item.
const { newChatProps } = vi.hoisted(() => ({
  newChatProps: [] as Record<string, unknown>[],
}));
vi.mock('../../modals/NewChatModal', () => ({
  NewChatModal: (props: Record<string, unknown>) => {
    newChatProps.push(props);
    return <div>new chat picker</div>;
  },
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => undefined,
}));

const { ChatDockModalStack } = await import('../ChatDockModalStack');

afterEach(() => {
  cleanup();
  newChatProps.length = 0;
});

const draft: ProjectChatComposerDraft = {
  title: 'Plugin authoring',
  description: 'Nothing is sent until you send it.',
  label: 'Opening message',
  detail: 'Continue building Pulse',
  message: 'Read the `plugin-authoring` topic.',
};

function renderStack(
  override: {
    slug: string;
    name: string;
    composerDraft?: ProjectChatComposerDraft;
  },
  forkMode?: { kind: 'fork'; preferredAgentSlug: string },
) {
  const noop = vi.fn();
  render(
    <ChatDockModalStack
      agents={[]}
      projects={[]}
      newChatProjectOverride={override}
      sessions={[]}
      showNewChatModal
      showChatSettings={false}
      showSessionPicker={false}
      chatFontSize={14}
      defaultFontSize={14}
      showReasoning={false}
      showToolDetails={false}
      autoHideEnabled={false}
      onSelectNewChat={noop}
      onCloseNewChat={noop}
      onCloseSettings={noop}
      onCloseSessionPicker={noop}
      onSessionPickerSelect={noop}
      onChatFontSizeChange={noop}
      onShowReasoningChange={noop}
      onShowToolDetailsChange={noop}
      onAutoHideChange={noop}
      forkMode={forkMode}
    />,
  );
}

test('a project chat request carrying a composer draft reaches the picker as a verbatim draft item', async () => {
  renderStack({ slug: 'pulse', name: 'Pulse', composerDraft: draft });
  await screen.findByText('new chat picker');
  const props = newChatProps.at(-1)!;
  expect(props.activeProjectSlug).toBe('pulse');
  expect(props.draftContext).toEqual({
    title: draft.title,
    description: draft.description,
    framing: 'verbatim',
    items: [
      {
        id: 'composer-draft',
        label: draft.label,
        detail: draft.detail,
        messageLine: draft.message,
      },
    ],
  });
});

test('no draft, or a fork, offers no draft item', async () => {
  renderStack({ slug: 'pulse', name: 'Pulse' });
  await screen.findByText('new chat picker');
  expect(newChatProps.at(-1)!.draftContext).toBeUndefined();
  cleanup();
  newChatProps.length = 0;

  renderStack(
    { slug: 'pulse', name: 'Pulse', composerDraft: draft },
    { kind: 'fork', preferredAgentSlug: 'assistant' },
  );
  await screen.findByText('new chat picker');
  expect(newChatProps.at(-1)!.draftContext).toBeUndefined();
});
