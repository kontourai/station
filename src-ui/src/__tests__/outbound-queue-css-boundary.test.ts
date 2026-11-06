/**
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUiModuleGraph } from '../../../scripts/lib/ui-module-graph.mjs';

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
    const conversationBody = source(
      'components/conversation/ConversationBody.tsx',
    );

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
    expect(conversationBody).toContain(
      "import('../chat/OutboundQueuedMessages')",
    );
    // The local queue loads inside the one pending-message surface's chunk.
    expect(conversationBody).toContain(
      "import('../chat/ConversationInboxMessages')",
    );
    expect(source('components/chat/ConversationInboxMessages.tsx')).toContain(
      "from './QueuedMessages'",
    );
  });

  it('keeps recovery, route negotiation and history surfaces out of eager owners', () => {
    const graph = createUiModuleGraph(join(uiRoot, '../..'));
    for (const [owner, lazyModule] of [
      ['contexts/active-chats-store.ts', 'lib/outboundQueue.ts'],
      ['lib/peer-chat.ts', 'lib/outboundQueue.ts'],
      [
        'connections/StationConnectionsContext.tsx',
        'connections/resolve-station-connection.ts',
      ],
    ]) {
      const edges = graph.edges(`src-ui/src/${owner}`);
      expect(edges.static).not.toContain(`src-ui/src/${lazyModule}`);
      expect(edges.dynamic).toContain(`src-ui/src/${lazyModule}`);
    }
    expect(
      graph.edges('src-ui/src/contexts/ProjectsContext.tsx').static,
    ).not.toContain(
      'src-ui/src/components/conversation/SharedTaskHistoryList.tsx',
    );
    expect(
      graph.edges('src-ui/src/components/conversation/ConversationComposer.tsx')
        .static,
    ).not.toContain('src-ui/src/components/chat/ChatInputArea.tsx');
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
