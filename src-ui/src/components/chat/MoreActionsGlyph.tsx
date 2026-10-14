/**
 * The one "more actions" mark for a message's actions: the row's phone ⋯
 * trigger and the answer and user overflow menus, on every screen size.
 * Vertically centred (U+22EF), unlike a baseline ellipsis, and hidden from
 * assistive technology because each trigger carries its own label.
 */
export function MoreActionsGlyph() {
  return <span aria-hidden="true">⋯</span>;
}
