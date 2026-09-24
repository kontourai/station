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
  // refused script, a crash on load), which would leave the preview loading
  // with no end. A worker error before the document opens fails it instead.
  const workerFailed = new Promise<never>((_, reject) => {
    port.addEventListener(
      'error',
      () => reject(new Error('The PDF worker failed to start')),
      { once: true },
    );
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
      // The task's own teardown waits on the worker; terminating the worker
      // is what actually releases the memory, so it does not wait for that.
      task.destroy().catch(() => undefined);
      worker.destroy();
      port.terminate();
    },
  };
}
