import { describe, expect, test } from 'vitest';
import { TRANSCRIPT_MIN_WIDTH } from '../../chat/transcriptMeasure';
import {
  SESSION_CONTEXT_CARD_WIDTH,
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
