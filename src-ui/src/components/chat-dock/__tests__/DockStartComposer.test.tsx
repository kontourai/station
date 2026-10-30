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
// The dock's composer reads run locations (#3391); none have arrived here.
vi.mock('../../../contexts/ProjectsContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useScopedProjectRunLocationsQuery: () => ({ data: undefined }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => undefined,
}));

const { DockStartComposer } = await import('../DockStartComposer');

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

function renderDraft(
  override: {
    slug: string;
    name: string;
    composerDraft?: ProjectChatComposerDraft;
  },
  forkMode?: { kind: 'fork'; preferredAgentSlug: string },
) {
  const noop = vi.fn();
  render(
    <DockStartComposer
      projectIconBySlug={new Map()}
      agents={[]}
      projects={[]}
      newChatProjectOverride={override}
      onSelect={noop}
      onClose={noop}
      forkMode={forkMode}
    />,
  );
}

test('a project chat request carrying a composer draft reaches the picker as a verbatim draft item', async () => {
  renderDraft({ slug: 'pulse', name: 'Pulse', composerDraft: draft });
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
  renderDraft({ slug: 'pulse', name: 'Pulse' });
  await screen.findByText('new chat picker');
  expect(newChatProps.at(-1)!.draftContext).toBeUndefined();
  cleanup();
  newChatProps.length = 0;

  renderDraft(
    { slug: 'pulse', name: 'Pulse', composerDraft: draft },
    { kind: 'fork', preferredAgentSlug: 'assistant' },
  );
  await screen.findByText('new chat picker');
  expect(newChatProps.at(-1)!.draftContext).toBeUndefined();
});
