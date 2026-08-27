/**
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const uiRoot = join(__dirname, '..');

function source(path: string): string {
  return readFileSync(join(uiRoot, path), 'utf8');
}

describe('outbound queue lazy stylesheet boundary (station#2751)', () => {
  it('keeps outbound-only styles with the dynamically loaded component', () => {
    const entryCss = source('index.css');
    const queueCss = source('components/chat/QueuedMessages.css');
    const localQueue = source('components/chat/QueuedMessages.tsx');
    const component = source('components/chat/OutboundQueuedMessages.tsx');
    const chatDock = source('components/chat-dock/ChatDockBody.tsx');

    for (const selector of [
      '.queued-message__advanced-context',
      '.queued-message__merge-preview',
      '.queued-message__edit-input',
    ]) {
      expect(entryCss).not.toContain(selector);
      expect(queueCss).toContain(selector);
    }
    expect(component).toContain("import './QueuedMessages.css'");
    expect(localQueue).toContain("import './QueuedMessages.css'");
    expect(chatDock).toContain("import('../chat/OutboundQueuedMessages')");
    expect(chatDock).toContain("import('../chat/QueuedMessages')");
  });

  it('keeps the shared queue style authority out of the eager sheet', () => {
    const entryCss = source('index.css');
    const queueCss = source('components/chat/QueuedMessages.css');
    for (const selector of [
      '.queued-messages',
      '.queued-message',
      '.queued-message__text',
      '.queued-message__btn',
    ]) {
      expect(entryCss).not.toContain(selector);
      expect(queueCss).toContain(selector);
    }
  });
});
