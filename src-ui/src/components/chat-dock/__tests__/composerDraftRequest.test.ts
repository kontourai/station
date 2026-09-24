/** @vitest-environment jsdom */
import { afterEach, expect, test } from 'vitest';
import {
  OPEN_PROJECT_CHATS_EVENT,
  type ProjectChatComposerDraft,
  requestProjectChat,
} from '../../../lib/projectChatEvents';
import { claimComposerDraftRequest } from '../composerDraftRequest';

// Review M2: every mounted chat pane listens for the same event. These are
// real listeners on the real window event, each with its pane's scope, in
// the order the panes registered.
const draft: ProjectChatComposerDraft = {
  title: 'Plugin authoring',
  description: 'Nothing is sent until you send it.',
  label: 'Opening message',
  detail: 'Continue building Pulse',
  message: 'Read the `plugin-authoring` topic.',
};

const listeners: ((event: Event) => void)[] = [];
afterEach(() => {
  for (const listener of listeners.splice(0))
    window.removeEventListener(OPEN_PROJECT_CHATS_EVENT, listener);
});

function mountPane(
  label: string,
  pane: { hasImmutableProjectScope: boolean; projectSlug?: string },
  opened: string[],
) {
  const listener = (event: Event) => {
    const claimed = claimComposerDraftRequest(event, pane);
    if (claimed) opened.push(`${label}:${claimed.projectSlug}`);
  };
  window.addEventListener(OPEN_PROJECT_CHATS_EVENT, listener);
  listeners.push(listener);
}

test('a fullscreen pane bound to another Project never takes the draft; the ambient dock does', () => {
  const opened: string[] = [];
  mountPane(
    'fullscreen-x',
    { hasImmutableProjectScope: true, projectSlug: 'x' },
    opened,
  );
  mountPane('ambient', { hasImmutableProjectScope: false }, opened);

  expect(requestProjectChat({ projectSlug: 'y', composerDraft: draft })).toBe(
    true,
  );
  expect(opened).toEqual(['ambient:y']);
});

test('exactly one pane opens a picker, even with several eligible', () => {
  const opened: string[] = [];
  mountPane(
    'fullscreen-y',
    { hasImmutableProjectScope: true, projectSlug: 'y' },
    opened,
  );
  mountPane('ambient', { hasImmutableProjectScope: false }, opened);
  mountPane('ambient-2', { hasImmutableProjectScope: false }, opened);

  requestProjectChat({ projectSlug: 'y', composerDraft: draft });
  expect(opened).toEqual(['fullscreen-y:y']);
});

test('with only a pane bound elsewhere mounted, nobody claims and the caller is told', () => {
  const opened: string[] = [];
  mountPane(
    'fullscreen-x',
    { hasImmutableProjectScope: true, projectSlug: 'x' },
    opened,
  );
  expect(requestProjectChat({ projectSlug: 'y', composerDraft: draft })).toBe(
    false,
  );
  expect(opened).toEqual([]);
});

test('a plain project-chat request is not claimed here', () => {
  const opened: string[] = [];
  mountPane('ambient', { hasImmutableProjectScope: false }, opened);
  expect(requestProjectChat({ projectSlug: 'y' })).toBe(false);
  expect(opened).toEqual([]);
});
