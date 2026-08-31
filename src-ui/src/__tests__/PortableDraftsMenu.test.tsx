/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { isPortableDraftShortcut } from '../components/chat/ChatInputArea';
import { PortableDraftsMenu } from '../components/chat/PortableDraftsMenu';
import { chatDraftsStore } from '../contexts/chat-drafts-store';

describe('PortableDraftsMenu', () => {
  beforeEach(() => chatDraftsStore.clearPortable());

  test('states dropped and unreadable image outcomes separately and restores', async () => {
    await chatDraftsStore.stash('Outcomes', 'portable text', []);
    const draft = chatDraftsStore.getPortableSnapshot()[0];
    draft.droppedImageNames.push('too-large.png');
    draft.unreadableImageNames.push('broken.png');
    const onRestore = vi.fn();
    render(
      <PortableDraftsMenu
        input=""
        attachments={[]}
        open={true}
        onOpenChange={() => {}}
        onRestore={onRestore}
      />,
    );
    expect(screen.getByText('Dropped: too-large.png')).toBeTruthy();
    expect(screen.getByText('Unreadable: broken.png')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Outcomes/ }));
    expect(onRestore).toHaveBeenCalledWith(draft);
  });

  test('uses mod+S without intercepting the Up-key history path', () => {
    expect(
      isPortableDraftShortcut({ key: 's', metaKey: true, ctrlKey: false }),
    ).toBe(true);
    expect(
      isPortableDraftShortcut({
        key: 'ArrowUp',
        metaKey: false,
        ctrlKey: false,
      }),
    ).toBe(false);
  });
});
