import type { Frame, Page, Request, Response } from '@playwright/test';

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
 *
 * A commit is a main-frame `framenavigated` after the pending navigation
 * request has its (non-redirect) response. `framenavigated` also fires for a
 * same-document navigation (`pushState`, `replaceState`, a hash change),
 * including one the outgoing document makes while the next navigation is
 * pending, and that is not a new document. In Chromium (checked with
 * Playwright against a page that changes its history while `page.goto`
 * waits: a plain navigation, a service-worker-served one, a redirect, and a
 * response whose body arrives later), the outgoing document's history changes
 * arrive before the navigation's response, and the new document's
 * `framenavigated` after it. A history change in the instant between the
 * response and the commit would still be counted. A document restored without
 * a request (back/forward cache) is not counted; nothing in the Gallery relies
 * on one.
 */
export function createDocumentTracker() {
  let commits = 0;
  let pending: object | null = null;
  let pendingResponded = false;
  const tags = new WeakMap<object, { document: number; opens: boolean }>();
  return {
    /** Every page request, as it is issued. */
    issued(request: object, opensDocument: boolean) {
      if (opensDocument) {
        pending = request;
        pendingResponded = false;
      }
      tags.set(request, {
        document: opensDocument ? commits + 1 : commits,
        opens: opensDocument,
      });
    },
    /** Every page response, with its HTTP status. */
    responded(request: object, status: number) {
      // A redirect's response is followed by a new navigation request.
      if (request === pending && !(status >= 300 && status < 400))
        pendingResponded = true;
    },
    /** A main-frame `framenavigated` event. */
    committed() {
      if (pending === null || !pendingResponded) return;
      commits++;
      pending = null;
      pendingResponded = false;
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
      if (failed && request === pending) {
        pending = null;
        pendingResponded = false;
      }
    },
  };
}
export type DocumentTracker = ReturnType<typeof createDocumentTracker>;

/**
 * The page listeners the Gallery capture attaches, in the order each event's
 * consumers need: the tracker sees a request and its response before anything
 * classifies it, and a failure is classified before the tracker settles it.
 * Returns the function that detaches them.
 */
export function observeGalleryRequests(
  page: Pick<Page, 'on' | 'off' | 'mainFrame'>,
  sinks: {
    documents: DocumentTracker;
    failedRequests: { failed(request: Request): void };
    assets?: {
      request(request: Request): void;
      response(response: Response): void;
      finished(request: Request): void;
      failed(request: Request): void;
    };
  },
): () => void {
  const { documents, failedRequests, assets } = sinks;
  const onRequest = (request: Request) => {
    let opensDocument = false;
    try {
      opensDocument =
        request.isNavigationRequest() && request.frame() === page.mainFrame();
    } catch {
      /* a request without a frame opens no document */
    }
    documents.issued(request, opensDocument);
    assets?.request(request);
  };
  const onResponse = (response: Response) => {
    documents.responded(response.request(), response.status());
    assets?.response(response);
  };
  const onFinished = (request: Request) => {
    assets?.finished(request);
    documents.settled(request, false);
  };
  const onFailed = (request: Request) => {
    failedRequests.failed(request);
    assets?.failed(request);
    documents.settled(request, true);
  };
  const onNavigated = (frame: Frame) => {
    if (frame === page.mainFrame()) documents.committed();
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  page.on('framenavigated', onNavigated);
  return () => {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfinished', onFinished);
    page.off('requestfailed', onFailed);
    page.off('framenavigated', onNavigated);
  };
}
