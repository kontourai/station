import { getDocument, type PDFDocumentProxy, PDFWorker } from 'pdfjs-dist';
// Bundled by Vite as a same-origin module worker (`worker.format: 'es'`) with
// a `.js` name. The package's own `.mjs` file would be served by Station's UI
// server as `application/octet-stream`, which a module worker refuses under
// `nosniff`; `worker-src 'self'` admits the bundled one in both CSPs.
import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import { BundledPdfBinaryDataFactory } from './pdf-binary-data';

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
  const port = new PdfjsWorker({ name: 'station-pdf' });
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
    promise: task.promise,
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
