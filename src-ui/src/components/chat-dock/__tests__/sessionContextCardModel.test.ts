import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { TRANSCRIPT_MIN_WIDTH } from '../../chat/transcriptMeasure';
import {
  SESSION_CONTEXT_CARD_WIDTH,
  SESSION_CONTEXT_EXIT_MS,
  sessionContextCardFits,
} from '../sessionContextCardModel';

/**
 * The fit judges the ROOM the card and the transcript share. While the card
 * is hidden that room is the transcript column; while it shows the column
 * is already a card column narrower, so the room is the column plus the
 * card. Literals are pinned beside the constants so a change to
 * either is a visible decision, not a silent shift.
 */
describe('sessionContextCardFits', () => {
  test('the constants it is derived from', () => {
    expect(TRANSCRIPT_MIN_WIDTH).toBe(640);
    expect(SESSION_CONTEXT_CARD_WIDTH).toBe(280);
  });

  test('a hidden card shows from 920px of transcript column, not before', () => {
    expect(sessionContextCardFits(919, false)).toBe(false);
    expect(sessionContextCardFits(920, false)).toBe(true);
  });

  test('a shown card stays while the transcript beside it keeps 640px', () => {
    // 640px of transcript column beside a shown card is 920px of room.
    expect(sessionContextCardFits(640, true)).toBe(true);
    expect(sessionContextCardFits(639, true)).toBe(false);
  });

  test('showing the card cannot flip the answer back', () => {
    // At every room size, the decision made with the card hidden is the
    // decision re-made once it shows and the transcript column narrows by
    // the card's.
    for (let room = 600; room <= 1400; room += 1) {
      const shown = sessionContextCardFits(room, false);
      if (shown)
        expect(
          sessionContextCardFits(room - SESSION_CONTEXT_CARD_WIDTH, true),
        ).toBe(true);
    }
  });
});

describe('SESSION_CONTEXT_EXIT_MS', () => {
  test('matches --motion-base, the token the card and chip exits animate on', () => {
    // The CSS owns the exit's duration and this constant owns when the element
    // leaves the tree; if they drift apart the surface is deleted mid-exit.
    const read = (relative: string) =>
      readFileSync(path.resolve(import.meta.dirname, relative), 'utf8');
    const declared = read('../../../tokens.css').match(
      /--motion-base:\s*([0-9.]+)(m?s);/,
    );
    expect(declared, 'expected --motion-base in tokens.css').not.toBeNull();
    const ms = Number(declared?.[1]) * (declared?.[2] === 'ms' ? 1 : 1000);
    expect(SESSION_CONTEXT_EXIT_MS).toBe(ms);
    expect(read('../SessionContextCard.css')).toMatch(
      /\.session-context-card--exiting[^{]*\{[^}]*animation:\s*session-context-card-exit\s+var\(--motion-base\)/,
    );
    // Opacity and transform only: the card's column is what the fit above
    // measures, so animating its width would feed the observer mid-flight.
    for (const name of [
      'session-context-card-enter',
      'session-context-card-exit',
    ]) {
      const frames = read('../SessionContextCard.css').match(
        new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`),
      );
      expect(frames, `missing @keyframes ${name}`).not.toBeNull();
      expect(frames?.[1]).not.toMatch(/\b(width|min-width|max-width|flex)\s*:/);
    }
    expect(read('../SessionContextChip.css')).toMatch(
      /\.session-context-chip--exiting\s*\{[^}]*animation:\s*session-context-chip-exit\s+var\(--motion-base\)/,
    );
  });
});
