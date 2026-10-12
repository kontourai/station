import { glyph } from '../icons/Glyph';

// The Diff toolbar's own glyphs, kept in the Diff pane's chunk: the shared
// `Glyph` module is in the entry bundle, and these are drawn only here.

/** Two chevrons closing on a line: fold every file of a diff. */
export const CollapseAllGlyph = /* @__PURE__ */ glyph(
  'm4.5 5.5 3.5-3 3.5 3M4.5 10.5l3.5 3 3.5-3M3 8h10',
);
/** Two chevrons opening from a line: unfold every file of a diff. */
export const ExpandAllGlyph = /* @__PURE__ */ glyph(
  'm4.5 3 3.5 3 3.5-3M4.5 13l3.5-3 3.5 3M3 8h10',
);
/** Two columns: a side-by-side diff. */
export const ColumnsGlyph = /* @__PURE__ */ glyph(
  'M2.5 3h11v10h-11V3Zm5.5 0v10',
);
/** A line turning back under itself: soft-wrapped lines. */
export const WrapGlyph = /* @__PURE__ */ glyph(
  'M2.5 4h11M2.5 8h8.5a2 2 0 0 1 0 4H8.5m0 0 1.5-1.5M8.5 12l1.5 1.5M2.5 12h3',
);
