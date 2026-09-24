import { getDocument, type PDFDocumentProxy, PDFWorker } from 'pdfjs-dist';
import { BundledPdfBinaryDataFactory } from './pdf-binary-data';

/**
 * pdf.js's worker, bundled by Vite as a same-origin module worker
 * (`worker.format: 'es'`) with a `.js` name: Vite rebuilds any
 * `new Worker(new URL(…, import.meta.url))` it sees. The package's own `.mjs`
 * file would be served by Station's UI server as `application/octet-stream`,
 * which a module worker refuses under `nosniff`; `worker-src 'self'` admits
 * the bundled one in both CSPs. Plain `new URL` (not a `?worker` import) keeps
 * this module loadable by the esbuild harnesses that bundle the previewer.
 */
function startPdfWorker(): Worker {
  return new Worker(
    new URL(
      '../../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ),
    { type: 'module', name: 'station-pdf' },
  );
}

/**
 * How long a new worker may take to announce itself. This bounds startup
 * only — loading the worker script — never parsing, so a slow phone reading a
 * large PDF is not cut off; it is generous because a phone parses 1.2 MB of
 * worker JavaScript before it can answer.
 */
const WORKER_START_DEADLINE_MS = 30_000;

export interface OpenedPdf {
  promise: Promise<PDFDocumentProxy>;
  /** Stops parsing, frees the document, and terminates its worker. */
  destroy: () => void;
}

/**
 * Opens PDF bytes Station already holds. The bytes go to pdf.js as data —
 * never as a URL: `fetch('blob:…')` is refused by the app CSP.
 *
 * Each document gets its own worker so closing the preview frees everything
 * it parsed; pdf.js does not terminate a worker it was handed, so `destroy`
 * does.
 *
 * pdf.js 6 has no `eval` path at all (the `isEvalSupported` option was
 * removed with it), so nothing here depends on `'unsafe-eval'`. PostScript
 * functions compile to WebAssembly under `'wasm-unsafe-eval'`, which both
 * CSPs grant, and otherwise run in pdf.js's interpreter.
 */
export function openPdf(data: Uint8Array): OpenedPdf {
  const port = startPdfWorker();
  // pdf.js waits forever for a worker it was handed that never starts (a
  // refused script, a crash on load) or never answers, which would leave the
  // preview loading with no end. A worker error before the document opens,
  // or no `ready` announcement within the deadline, fails it instead.
  // (PDFWorker's own promise cannot tell: for a handed-in port it resolves
  // at once, before the worker has run a line.)
  let stopWatching: () => void = () => undefined;
  const workerFailed = new Promise<never>((_, reject) => {
    const onError = () => reject(new Error('The PDF worker failed to start'));
    const onMessage = (event: MessageEvent) => {
      if ((event.data as { action?: unknown } | null)?.action !== 'ready')
        return;
      clearTimeout(deadline);
      port.removeEventListener('message', onMessage);
    };
    const deadline = setTimeout(
      () => reject(new Error('The PDF worker did not start in time')),
      WORKER_START_DEADLINE_MS,
    );
    port.addEventListener('error', onError);
    port.addEventListener('message', onMessage);
    stopWatching = () => {
      clearTimeout(deadline);
      port.removeEventListener('error', onError);
      port.removeEventListener('message', onMessage);
    };
  });
  workerFailed.catch(() => undefined);
  const worker = PDFWorker.create({ port });
  const task = getDocument({
    data,
    worker,
    // Side-files come from the bundle through the main thread (see
    // pdf-binary-data.ts), never from a base URL the worker would fetch.
    useWorkerFetch: false,
    BinaryDataFactory: BundledPdfBinaryDataFactory,
    enableXfa: false,
  });
  let destroyed = false;
  return {
    promise: Promise.race([task.promise, workerFailed]),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      stopWatching();
      // The task's own teardown waits on the worker; terminating the worker
      // is what actually releases the memory, so it does not wait for that.
      task.destroy().catch(() => undefined);
      worker.destroy();
      port.terminate();
    },
  };
}
