import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const uiRoot = join(__dirname, '..');
const indexCss = readFileSync(join(uiRoot, 'index.css'), 'utf8');
const chatCss = readFileSync(
  join(uiRoot, 'components', 'chat', 'chat.css'),
  'utf8',
);
const handoffCss = readFileSync(
  join(uiRoot, 'components', 'chat', 'ConversationHandoff.css'),
  'utf8',
);
const messageBubble = readFileSync(
  join(uiRoot, 'components', 'chat', 'MessageBubble.tsx'),
  'utf8',
);
const turnActionsCss = readFileSync(
  join(uiRoot, 'components', 'chat', 'TurnActionsMenu.css'),
  'utf8',
);
const taskPicker = readFileSync(
  join(uiRoot, 'components', 'chat', 'TaskPicker.css'),
  'utf8',
);

function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing ${selector} rule`).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('}', start);
  return css.slice(start, end + 1);
}

function atRule(css: string, prefix: string): string {
  const start = css.indexOf(prefix);
  expect(start, `missing ${prefix}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  throw new Error(`unterminated ${prefix}`);
}

describe('chat message responsive layout contract (station#4241/#4244)', () => {
  test('wide and narrow docks share one bounded, wrapping user/assistant content surface', () => {
    const messages = rule(indexCss, '.chat-messages');
    const message = rule(indexCss, '.message');
    const row = rule(chatCss, '.message-row');

    expect(messages).toContain('--chat-message-gutter: clamp(12px, 4vw, 20px)');
    expect(messages).toContain('padding: var(--chat-message-gutter)');
    expect(message).toContain('box-sizing: border-box');
    expect(message).toContain('min-width: 0');
    expect(message).toContain('overflow-wrap: anywhere');
    expect(row).toContain('width: 100%');
    expect(row).toContain('min-width: 0');
  });

  test('handoff cards and completed-answer controls use the same responsive flow instead of a centered long action', () => {
    const handoff = rule(handoffCss, '.conversation-handoff-boundary');
    const actions = chatCss;
    const task = rule(taskPicker, '.task-picker');

    expect(handoff).toContain('width: 100%');
    expect(handoff).toContain('margin: 12px 0');
    expect(handoff).toContain('text-align: left');
    expect(actions).toContain('flex-wrap: wrap');
    expect(actions).toContain('justify-content: flex-end');
    expect(chatCss).toContain('@media (max-width: 480px)');
    expect(task).toContain('align-items: flex-start');
    const taskTrigger = rule(taskPicker, '.task-picker__trigger');
    expect(taskTrigger).toContain('min-width: 44px');
    expect(taskTrigger).toContain('min-height: 44px');
    expect(chatCss).toMatch(
      /\.message__rating-btn\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/s,
    );
  });

  test('hover-only footer collapse preserves keyboard access and touch targets', () => {
    const hover = atRule(turnActionsCss, '@media (hover: hover)');
    const resting = rule(hover, '.turn-footer__actions');
    const restored = rule(
      hover,
      '.message:is(:hover, :focus-within) .turn-footer__actions',
    );
    const touchRating = rule(chatCss, '.turn-footer__actions .message__rating');
    const hoverRating = rule(hover, '.turn-footer__actions .message__rating');

    expect(resting).toContain('height: 0');
    expect(resting).toContain('overflow: hidden');
    expect(resting).toContain('pointer-events: none');
    expect(restored).toContain('height: auto');
    expect(restored).toContain('overflow: visible');
    expect(restored).toContain('pointer-events: auto');
    expect(hoverRating).toContain('min-height: 0');
    expect(touchRating).toContain('min-height: 44px');
    expect(messageBubble).toMatch(/developerToolsEnabled\s*&&\s*msg\.traceId/);
  });
});
