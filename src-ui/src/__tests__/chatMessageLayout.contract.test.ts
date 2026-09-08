import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
// Edge-only imports. The assertions below read these files as TEXT, which
// creates no module edge — so `vitest related` could never reach this test
// from the files it guards, and it only ever ran in full regression (#1141).
// Vitest stubs stylesheets, so these cost nothing but put the test in the
// graph.
import '../components/chat/chat.css';
import '../components/chat/ConversationHandoff.css';
import '../components/chat/TaskPicker.css';
import '../index.css';

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
const turnActionsMenu = readFileSync(
  join(uiRoot, 'components', 'chat', 'TurnActionsMenu.tsx'),
  'utf8',
);
const turnProvenanceCard = readFileSync(
  join(uiRoot, 'components', 'chat', 'TurnProvenanceCard.tsx'),
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

function atRules(css: string, prefix: string): string[] {
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(prefix, from);
    if (start < 0) return bodies;
    const open = css.indexOf('{', start);
    let depth = 0;
    for (let index = open; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1;
      if (css[index] === '}') {
        depth -= 1;
        if (depth === 0) {
          bodies.push(css.slice(open + 1, index));
          from = index + 1;
          break;
        }
      }
    }
    if (from <= start) return bodies;
  }
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
    const task = rule(taskPicker, '.task-picker');

    expect(handoff).toContain('width: 100%');
    expect(handoff).toContain('margin: 12px 0');
    expect(handoff).toContain('text-align: left');
    // Scoped to the actions cluster's OWN rule. `.turn-footer__actions` also
    // appears as a descendant in the 480px block and under
    // `.message-details__body`, so the selector is anchored to a line start:
    // an unanchored `indexOf('.turn-footer__actions {')` resolves to the media
    // block first. Whole-file `toContain('flex-wrap: wrap')` /
    // `toContain('justify-content: flex-end')` used to stand here and were
    // satisfied by unrelated rules elsewhere in this 2.4k-line sheet -- this
    // cluster declares neither.
    const actions = /\n\.turn-footer__actions\s*\{([^}]*)\}/.exec(chatCss)?.[1];
    expect(actions, "the .turn-footer__actions rule's own body").toBeDefined();
    expect(actions).toContain('align-self: flex-end');
    expect(actions).toContain('flex: 0 0 auto');
    // ...and the responsive half: at <=480px the footer is a column, so the
    // cluster moves to the reading edge rather than staying at the far one.
    //
    // `.some(...)` over the 480px blocks is order-blind on purpose, and that
    // is safe only because a sibling case pins the COUNT: 'narrow screens keep
    // the footer actions at the reading edge' asserts exactly one 480px block
    // declares `.turn-footer__actions`. Without that pin, a second block
    // declaring the same selector later -- which would win the cascade -- could
    // contradict this one and `.some` would still be satisfied.
    expect(
      atRules(chatCss, '@media (max-width: 480px)').some((body) =>
        /\.turn-footer \.turn-footer__actions\s*\{[^}]*align-self:\s*flex-start;/s.test(
          body,
        ),
      ),
      'the 480px block moves .turn-footer__actions to align-self: flex-start',
    ).toBe(true);
    expect(task).toContain('align-items: flex-start');
    const taskTrigger = rule(taskPicker, '.task-picker__trigger');
    expect(taskTrigger).toContain('min-width: 44px');
    expect(taskTrigger).toContain('min-height: 44px');
    expect(chatCss).toMatch(
      /\.message__rating-btn\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/s,
    );
    const footerActions = messageBubble.indexOf(
      'className="turn-footer__actions"',
    );
    const shareContent = messageBubble.indexOf('shareContent={');
    const shareLoader = messageBubble.indexOf('load={loadShareAnswerButton}');
    expect(footerActions).toBeGreaterThanOrEqual(0);
    expect(shareContent).toBeGreaterThanOrEqual(0);
    expect(shareLoader).toBeGreaterThan(shareContent);
    expect(footerActions).toBeGreaterThan(shareLoader);
    expect(messageBubble.indexOf('load={loadTurnActionsMenu}')).toBeGreaterThan(
      footerActions,
    );
    expect(messageBubble).not.toContain('<ShareAnswerButton');
    expect(turnActionsMenu).not.toContain('ShareAnswerButton');
    expect(turnProvenanceCard).toContain('{shareContent}');
  });

  test('hover-only footer collapse preserves keyboard access and touch targets', () => {
    const hover = atRule(chatCss, '@media (hover: hover)');
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
    expect(
      messageBubble.match(/developerToolsEnabled\s*&&\s*msg\.traceId/g),
    ).toHaveLength(2);
  });

  // The footer switched from a row to a column, which made the narrow-screen
  // `justify-content: flex-start` inert. Untested, it was deleted as dead CSS
  // and phones silently inherited the desktop `align-self: flex-end`.
  test('narrow screens keep the footer actions at the reading edge', () => {
    // chat.css has more than one 480px block, so select the one that carries
    // the rule rather than the first one that matches the query text.
    const narrow = atRules(chatCss, '@media (max-width: 480px)').filter(
      (body) => body.includes('.turn-footer__actions {'),
    );
    expect(
      narrow,
      'no 480px block declares .turn-footer__actions',
    ).toHaveLength(1);
    expect(narrow[0]).toMatch(
      /\.turn-footer \.turn-footer__actions\s*\{[^}]*align-self:\s*flex-start;/s,
    );
    // Anchored at column 0: `rule()` matches by first occurrence, and the
    // nested 480px copy above now precedes the base rule in the file.
    expect(chatCss).toMatch(
      /\n\.turn-footer__actions \{[^}]*align-self: flex-end;/s,
    );
    // Replaces a `getComputedStyle(...).flexWrap` assertion that could not
    // fail: vitest stubs CSS imports, and `nowrap` is the initial value, so it
    // passed with no stylesheet loaded at all.
    expect(chatCss).toMatch(
      /\n\.turn-footer__actions \{[^}]*flex-wrap: nowrap;/s,
    );
    const narrowRuleStart = chatCss.lastIndexOf(
      '.turn-footer .turn-footer__actions {',
    );
    expect(narrowRuleStart).toBeGreaterThanOrEqual(0);
    const narrowRuleEnd = chatCss.indexOf('}', narrowRuleStart);
    expect(narrowRuleEnd).toBeGreaterThan(narrowRuleStart);
    expect(chatCss.slice(narrowRuleEnd + 1)).not.toMatch(
      /\.turn-footer \.turn-footer__actions\s*\{[^}]*align-self:/s,
    );
  });
});
