import { createContext, useContext } from 'react';

/**
 * Heading-ownership context for the `SplitPaneLayout` skeleton (archive#2931).
 *
 * `docs/design/shell-skeletons.md` §2.1 states the rule: in a `SplitPaneLayout`
 * screen the shell owns the COLLECTION title and the detail pane owns the ITEM
 * title. Those are two different levels of one hierarchy, not two peers — but
 * before this context both rendered `<h2>`, so the document outline could not
 * tell the collection from the item, and a view that added its own page-level
 * heading inside the detail slot produced a third `<h2>` that read as a sibling
 * of the collection title.
 *
 * `SplitPaneLayout` provides this around its detail slot; `DetailHeader` reads
 * it and drops to the item level. The rule is then expressed by the components
 * rather than remembered by each view: a `DetailHeader` cannot render at page
 * level inside a detail pane, whatever the view does.
 *
 * Visual output is unchanged — `.detail-header__title` sets its own font-size,
 * weight and colour, so only the element name (and therefore the accessibility
 * tree) differs.
 */
export interface DetailPaneContextValue {
  /** True when the consuming subtree is inside a `SplitPaneLayout` detail slot. */
  inDetailPane: boolean;
}

export const DetailPaneContext = createContext<DetailPaneContextValue>({
  inDetailPane: false,
});

/**
 * The heading level a shared header component should render at for its own
 * subject title: `'item'` inside a `SplitPaneLayout` detail slot (the shell
 * already owns the collection title), `'page'` anywhere else (the header IS the
 * page's subject, e.g. the page-layout skeleton's single-subject views).
 */
export function useSubjectHeadingLevel(): 'page' | 'item' {
  return useContext(DetailPaneContext).inDetailPane ? 'item' : 'page';
}
