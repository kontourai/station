import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const indexCss = readFileSync(
  join(process.cwd(), 'src-ui/src/index.css'),
  'utf8',
);
const chatCss = readFileSync(
  join(process.cwd(), 'src-ui/src/components/chat/chat.css'),
  'utf8',
);

describe('composer Agent/Model controls layout', () => {
  test('model capability filters retain padded non-shrinking hit areas', () => {
    const pickerCss = readFileSync(
      join(
        process.cwd(),
        'src-ui/src/components/session/SessionModelPicker.css',
      ),
      'utf8',
    );
    const rule = pickerCss.match(
      /\.session-model-picker__filters button\s*\{([^}]*)\}/,
    )?.[1];
    expect(rule).toMatch(/padding:\s*0 var\(--space-2\)/);
    expect(rule).toMatch(/flex:\s*none/);
    expect(rule).toMatch(/min-height:\s*32px/);
  });
  test('uses the capsule gutter for the control rail', () => {
    expect(indexCss).toMatch(
      /\.chat-input__meta\s*\{[^}]*padding-inline:\s*var\(--space-2\)/s,
    );
  });

  test('wraps Agent, Model, and approval controls within the narrow-width rail', () => {
    expect(chatCss).toMatch(
      /\.chat-input__meta\s*\{\s*flex-wrap:\s*wrap;\s*overflow-x:\s*visible;/s,
    );
    expect(chatCss).toMatch(
      /\.chat-input__meta\s+\.chat-input__agent-btn,[\s\S]*?\.chat-input__approval-chip\s*\{\s*flex:\s*1\s+1\s+12rem;/s,
    );
    expect(chatCss).toMatch(
      /\.chat-input__meta\s+\.chat-input__agent-btn\s*\{\s*min-width:\s*44px;\s*min-height:\s*44px;/s,
    );
  });

  /**
   * station#541: the readonly approval chip's tool-policy half
   * (`.chat-input__approval-chip-policy`, e.g. "Station approvals do not
   * apply") used to be plain, unbounded text. `text-overflow: ellipsis` has
   * no effect on a flex CONTAINER's overflowing children (only a single
   * text node) — so when the chip shrank at the narrow-width rail above
   * (`flex: 1 1 12rem`), the sentence hard-clipped mid-word with no "…"
   * marker, rendering as a dangling fragment rather than a legible
   * truncation. Both spans need `min-width: 0` too: a flex item's default
   * `min-width: auto` refuses to shrink below its content size, which
   * silently disables ellipsis the same way.
   */
  test('the approval chip label AND its policy half both ellipsize, not just hard-clip', () => {
    for (const selector of [
      '.chat-input__approval-chip-label',
      '.chat-input__approval-chip-policy',
    ]) {
      const rule = chatCss.match(
        new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`),
      )?.[1];
      expect(rule, `${selector} rule not found`).toBeDefined();
      expect(rule).toMatch(/min-width:\s*0/);
      expect(rule).toMatch(/overflow:\s*hidden/);
      expect(rule).toMatch(/text-overflow:\s*ellipsis/);
      expect(rule).toMatch(/white-space:\s*nowrap/);
    }
  });

  /**
   * review round 2 (M2/L5): `.chat-input__approval-chip-policy` is a
   * security-relevant NEGATION ("Station approvals do not apply"), and the
   * ellipsis fix above means it can now truncate to "Station approvals
   * do…" — read as the OPPOSITE — anywhere its `flex: 1 1 12rem` basis
   * (chat-composer-controls-layout's own "wraps ... within the narrow-width
   * rail" test above) can be squeezed below that. That basis lives in the
   * WIDE mobile block (`@media (max-width: 768px), (max-height: 540px) and
   * (pointer: coarse)`), not only the narrower 480px arm station#3151
   * originally scoped the hide to — so the hide moved to cover the whole
   * wide block, visible only genuinely outside it (desktop, never
   * width-constrained).
   */
  test('the policy half drops out for the WHOLE width-constrained block, not just <=480px (station#3151 + review round 2)', () => {
    // Brace-aware, not a loose regex spanning `[\s\S]*?`: a text match that
    // does not respect nesting can span past the block's own closing brace
    // and "confirm" a rule that actually lives somewhere else entirely —
    // exactly the anchoring gap review round 2 (L2) flagged. This extracts
    // the wide block's OWN body first, so moving the declaration out of it
    // (even into a plausible-looking neighbour) fails here.
    const opener =
      '@media (max-width: 768px), (max-height: 540px) and (pointer: coarse) {';
    const start = chatCss.indexOf(opener);
    expect(start, 'wide mobile block not found in chat.css').toBeGreaterThan(
      -1,
    );
    const bodyStart = start + opener.length;
    let depth = 1;
    let i = bodyStart;
    for (; i < chatCss.length && depth > 0; i += 1) {
      if (chatCss[i] === '{') depth += 1;
      else if (chatCss[i] === '}') depth -= 1;
    }
    expect(depth, 'wide mobile block never closes').toBe(0);
    const wideBlockBody = chatCss.slice(bodyStart, i - 1);

    expect(wideBlockBody).toMatch(
      /\.chat-input__approval-chip-policy\s*\{\s*display:\s*none;/,
    );

    // And the narrower 480px block no longer carries its own copy — see
    // that block's own comment for why a second declaration there would be
    // dead by construction (480 is a subset of the wide block's condition).
    const narrowMatch = /@media \(max-width: 480px\) \{([\s\S]*?)\n\}/.exec(
      chatCss,
    );
    expect(narrowMatch, '480px block not found in chat.css').not.toBeNull();
    expect(narrowMatch?.[1]).not.toMatch(
      /\.chat-input__approval-chip-policy\s*\{/,
    );
  });
});
