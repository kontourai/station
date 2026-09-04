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

/** Comments out, so a rule quoted in prose (e.g. a moved-rule pointer
 * comment) is not read as a declaration. */
function withoutComments(css: string): string {
  return css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
}

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
    expect(chatCss).not.toMatch(
      /@media \(max-width:\s*420px\)[\s\S]*?\.chat-input__agent-name\s*\{[^}]*display:\s*none/s,
    );
  });

  /**
   * station#541: the readonly approval chip's label span
   * (`.chat-input__approval-chip-label`, the "Set by engine" half) used to
   * be plain, unbounded text: a flex item's default `min-width: auto`
   * refuses to shrink below its content size, which silently disables
   * `text-overflow: ellipsis` — the chip would just grow the row instead
   * of truncating.
   *
   * The tool-policy half (`-policy`, e.g. "Station approvals do not
   * apply") is NOT covered here (review round 3, M5): it is a
   * security-relevant negation that must never render a partial ("Station
   * approvals do…" reads as the OPPOSITE), so it is `display: none`
   * wherever it could otherwise shrink — see the dedicated test below —
   * and genuinely live nowhere the chip is unconstrained either (its
   * container is `flex: 0 0 auto` there). An ellipsis rule on that span
   * would be dead CSS with no state that exercises it; round 2 shipped
   * exactly that dead rule and this test's own loop narrated it as live.
   */
  test('the approval chip label span ellipsizes, not just hard-clips', () => {
    const rule = chatCss.match(
      /\.chat-input__approval-chip-label\s*\{([^}]*)\}/,
    )?.[1];
    expect(
      rule,
      '.chat-input__approval-chip-label rule not found',
    ).toBeDefined();
    expect(rule).toMatch(/min-width:\s*0/);
    expect(rule).toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule).toMatch(/white-space:\s*nowrap/);

    // And the policy span carries NONE of that ellipsis machinery — it
    // would be dead CSS (M5): confirms the round-2 rule was actually
    // deleted, not merely renamed/moved. Comments stripped first: a
    // pointer comment elsewhere quotes this exact selector in prose, which
    // a naive scan of the raw text would misread as a second declaration.
    const policyRules = [
      ...withoutComments(chatCss).matchAll(
        /\.chat-input__approval-chip-policy\s*\{([^}]*)\}/g,
      ),
    ];
    expect(
      policyRules.length,
      'exactly one .chat-input__approval-chip-policy declaration should remain',
    ).toBe(1);
    expect(policyRules[0][1]).toMatch(/display:\s*none/);
    expect(policyRules[0][1]).not.toMatch(/text-overflow/);
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
