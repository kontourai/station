/**
 * Which main-frame document a page request belonged to, so a failed request
 * can say whether it failed inside the live page (`current`) or was torn
 * down by a navigation that replaced its document (`previous`). The Gallery
 * capture's per-screen failed-request log and its asset diagnostics share one
 * tracker.
 *
 * Two orderings make the obvious rules wrong, both observed in a local
 * capture: Chromium aborts the old document's requests as the navigation
 * commits, and those `requestfailed` events can arrive before
 * `framenavigated`; and the old document keeps issuing requests after the
 * navigation request has started (a viewport change re-renders it). So a
 * document is counted when its navigation commits, and any other request
 * that fails while a navigation is still pending belongs to the document
 * being replaced: the new one cannot issue requests before it commits.
 * Same-document (history API) navigations issue no navigation request and
 * are not counted. A document restored without a request (back/forward
 * cache) is not counted either; nothing in the Gallery relies on one.
 */
export function createDocumentTracker() {
  let commits = 0;
  let pending: object | null = null;
  const tags = new WeakMap<object, { document: number; opens: boolean }>();
  return {
    /** Every page request, as it is issued. */
    issued(request: object, opensDocument: boolean) {
      if (opensDocument) pending = request;
      tags.set(request, {
        document: opensDocument ? commits + 1 : commits,
        opens: opensDocument,
      });
    },
    /** A main-frame `framenavigated` event. */
    committed() {
      if (pending === null) return;
      commits++;
      pending = null;
    },
    /** Classify a request; call before `settled` for the same request. */
    classify(request: object): 'current' | 'previous' | null {
      const tag = tags.get(request);
      if (!tag) return null;
      // A navigation that failed before committing is the attempted document.
      if (tag.opens) return 'current';
      return tag.document === commits && pending === null
        ? 'current'
        : 'previous';
    },
    /** A request finished or failed; a failed navigation is no longer pending. */
    settled(request: object, failed: boolean) {
      if (failed && request === pending) pending = null;
    },
  };
}
export type DocumentTracker = ReturnType<typeof createDocumentTracker>;
