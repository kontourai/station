import { contrastRatio } from '@kontourai/ui/contrast';
import { describe, expect, test } from 'vitest';
import {
  AGENT_ACCENTS,
  agentAccentFor,
  agentAccentStyle,
} from '../agentSenderAccent';

/** `color-mix(in srgb, <accent> <percent>%, <base>)` for opaque hex colours. */
function mix(accent: string, base: string, percent: number): string {
  const channel = (hex: string, index: number) =>
    Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  return `#${[0, 1, 2]
    .map((index) =>
      Math.round(
        channel(accent, index) * (percent / 100) +
          channel(base, index) * (1 - percent / 100),
      )
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

// The shipped @kontourai/ui token values the bubble sits on
// (`tokens.css`: --k-bg, --k-panel-raised; chat uses --bg-tertiary for the
// latter). Pinned here as literals so a retint of either surface is a
// visible change to this test.
const SURFACES = {
  light: { page: '#f5f4ef', raised: '#fbfaf7' },
  dark: { page: '#0a0e13', raised: '#16202d' },
} as const;

describe('agent sender accent', () => {
  test('is stable: the same agent always gets the same accent', () => {
    const first = agentAccentFor({ agent: 'Reviewer', sessionId: 's1' });
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect(agentAccentFor({ agent: 'Reviewer', sessionId: 'other' })).toBe(
        first,
      );
    // Case and padding are not a different agent.
    expect(agentAccentFor({ agent: '  reviewer ', sessionId: 'x' })).toBe(
      first,
    );
    // Pinned: a changed hash would recolour every transcript at once.
    expect(agentAccentFor({ agent: 'Reviewer', sessionId: 's1' }).id).toBe(
      'amber',
    );
    expect(agentAccentFor({ agent: 'Planner', sessionId: 's2' }).id).toBe(
      'rose',
    );
  });

  test('distinct agents get distinct accents', () => {
    expect(agentAccentFor({ agent: 'Reviewer', sessionId: 's1' })).not.toBe(
      agentAccentFor({ agent: 'Planner', sessionId: 's2' }),
    );
    expect(agentAccentFor({ engine: 'claude', sessionId: 's' })).not.toBe(
      agentAccentFor({ engine: 'codex', sessionId: 's' }),
    );
  });

  test('keys on the agent, else the engine, else the Session id', () => {
    expect(agentAccentFor({ sessionId: 'abc' })).toBe(
      agentAccentFor({ sessionId: 'abc' }),
    );
    const bySession = new Set(
      Array.from(
        { length: 40 },
        (_, index) => agentAccentFor({ sessionId: `session-${index}` }).id,
      ),
    );
    // Session ids spread over the palette; the agent beats them when named.
    expect(bySession.size).toBeGreaterThan(3);
    expect(agentAccentFor({ agent: 'Writer', sessionId: 'a' })).toBe(
      agentAccentFor({ agent: 'Writer', sessionId: 'b' }),
    );
  });

  test('hands the stylesheet both themes’ values', () => {
    const accent = agentAccentFor({ agent: 'Reviewer', sessionId: 's' });
    expect(agentAccentStyle({ agent: 'Reviewer', sessionId: 's' })).toEqual({
      '--agent-accent-light': accent.light,
      '--agent-accent-dark': accent.dark,
    });
  });

  test('the palette is fixed: eight different, valid colours per theme', () => {
    expect(AGENT_ACCENTS).toHaveLength(8);
    for (const theme of ['light', 'dark'] as const) {
      const colours = AGENT_ACCENTS.map((accent) => accent[theme]);
      expect(new Set(colours).size).toBe(colours.length);
      for (const colour of colours) expect(colour).toMatch(/^#[0-9a-f]{6}$/u);
    }
  });

  describe.each(['light', 'dark'] as const)(
    'contrast in the %s theme',
    (theme) => {
      const { page, raised } = SURFACES[theme];
      test.each(AGENT_ACCENTS.map((accent) => [accent.id, accent[theme]]))(
        '%s: header text is 4.5:1 on the tinted bubble and the rail is 3:1 on the page',
        (_id, colour) => {
          // The bubble is the accent at 12% over the raised panel (chat.css).
          const tint = mix(colour as string, raised, 12);
          expect(contrastRatio(colour as string, tint)).toBeGreaterThanOrEqual(
            4.5,
          );
          expect(contrastRatio(colour as string, page)).toBeGreaterThanOrEqual(
            3,
          );
        },
      );
    },
  );
});
