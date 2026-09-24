// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The pdf.js module boundary: jsdom has no canvas or workers, so the library
// is faked and everything above it (the viewer, its worker ownership, the
// options it passes) is real.
const pdfjs = vi.hoisted(() => ({
  getDocument: vi.fn(),
  createWorker: vi.fn(),
  workerPorts: [] as {
    terminate: ReturnType<typeof vi.fn>;
    fail: () => void;
  }[],
}));

vi.mock('pdfjs-dist', () => ({
  getDocument: pdfjs.getDocument,
  PDFWorker: { create: pdfjs.createWorker },
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?worker', () => ({
  default: class {
    terminate = vi.fn();
    private errorListeners: (() => void)[] = [];
    constructor() {
      pdfjs.workerPorts.push(this);
    }
    addEventListener(type: string, listener: () => void) {
      if (type === 'error') this.errorListeners.push(listener);
    }
    /** What a Worker does when its script is refused or throws on load. */
    fail() {
      for (const listener of this.errorListeners) listener();
    }
  },
}));

import PdfCanvasViewer from '../components/PdfCanvasViewer';

interface FakePage {
  getViewport: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
}

function fakePage(width = 600, height = 800): FakePage {
  return {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({
      width: width * scale,
      height: height * scale,
      scale,
    })),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    cleanup: vi.fn(),
  };
}

function fakeDocument(numPages: number) {
  const pages = new Map<number, FakePage>();
  const pageFor = (n: number) => {
    if (!pages.has(n)) pages.set(n, fakePage());
    return pages.get(n)!;
  };
  return {
    doc: { numPages, getPage: vi.fn(async (n: number) => pageFor(n)) },
    pageFor,
  };
}

/** A loading task as getDocument returns it. */
function fakeTask(promise: Promise<unknown>) {
  promise.catch(() => undefined);
  return { promise, destroy: vi.fn(() => Promise.resolve()) };
}

const workerDestroy = vi.fn();
const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const pdfBlob = () => new Blob([bytes], { type: 'application/pdf' });

beforeEach(() => {
  pdfjs.getDocument.mockReset();
  pdfjs.createWorker.mockReset();
  pdfjs.workerPorts.length = 0;
  workerDestroy.mockReset();
  pdfjs.createWorker.mockImplementation(({ port }: { port: unknown }) => ({
    port,
    destroy: workerDestroy,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PdfCanvasViewer', () => {
  test('hands pdf.js the exact bytes, on a worker it owns, with bundled side-files', async () => {
    const { doc } = fakeDocument(3);
    pdfjs.getDocument.mockReturnValue(fakeTask(Promise.resolve(doc)));

    render(<PdfCanvasViewer blob={pdfBlob()} />);

    expect(await screen.findByText('3 pages')).toBeTruthy();
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
    const options = pdfjs.getDocument.mock.calls[0][0];
    expect(options.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(options.data)).toEqual(Array.from(bytes));
    expect(options.url).toBeUndefined();
    // The worker is this document's own, built from the bundled module.
    expect(pdfjs.workerPorts).toHaveLength(1);
    expect(pdfjs.createWorker).toHaveBeenCalledWith({
      port: pdfjs.workerPorts[0],
    });
    expect(options.worker.port).toBe(pdfjs.workerPorts[0]);
    // Side-files come through the bundle, never a worker-side URL fetch.
    expect(options.useWorkerFetch).toBe(false);
    expect(typeof options.BinaryDataFactory).toBe('function');
    expect(options.cMapUrl).toBeUndefined();
  });

  test('shows every page and draws them onto canvases', async () => {
    const { doc, pageFor } = fakeDocument(2);
    pdfjs.getDocument.mockReturnValue(fakeTask(Promise.resolve(doc)));

    render(<PdfCanvasViewer blob={pdfBlob()} />);

    const first = await screen.findByRole('img', { name: 'Page 1 of 2' });
    expect(first.tagName).toBe('CANVAS');
    expect(screen.getByRole('img', { name: 'Page 2 of 2' })).toBeTruthy();
    await waitFor(() => expect(pageFor(2).render).toHaveBeenCalled());
    const call = pageFor(1).render.mock.calls[0][0];
    expect(call.canvas).toBe(first);
    expect(screen.getByText('2 pages')).toBeTruthy();
  });

  test('draws only the pages near the viewport, not the whole document', async () => {
    const observed: {
      element: Element;
      callback: IntersectionObserverCallback;
    }[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private callback: IntersectionObserverCallback) {}
        observe(element: Element) {
          observed.push({ element, callback: this.callback });
        }
        disconnect() {}
      },
    );
    const { doc, pageFor } = fakeDocument(300);
    pdfjs.getDocument.mockReturnValue(fakeTask(Promise.resolve(doc)));

    render(<PdfCanvasViewer blob={pdfBlob()} />);
    await screen.findByText('300 pages');
    await waitFor(() => expect(observed).toHaveLength(300));

    // The observer reports the first two pages in range.
    act(() => {
      for (const { element, callback } of observed.slice(0, 2))
        callback(
          [{ isIntersecting: true, target: element } as never],
          {} as never,
        );
    });

    await waitFor(() => expect(pageFor(2).render).toHaveBeenCalled());
    expect(pageFor(1).render).toHaveBeenCalled();
    const drawn = doc.getPage.mock.calls.map(([n]) => n);
    expect(new Set(drawn)).toEqual(new Set([1, 2]));
    expect(screen.getAllByRole('img')).toHaveLength(300);
  });

  test('zooming redraws the pages at the new scale', async () => {
    const { doc, pageFor } = fakeDocument(1);
    pdfjs.getDocument.mockReturnValue(fakeTask(Promise.resolve(doc)));

    render(<PdfCanvasViewer blob={pdfBlob()} />);
    await waitFor(() => expect(pageFor(1).render).toHaveBeenCalledTimes(1));
    const before = pageFor(1).render.mock.calls[0][0].viewport.scale;
    expect(screen.getByLabelText('PDF zoom level').textContent).toBe('100%');

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));

    expect(screen.getByLabelText('PDF zoom level').textContent).toBe('125%');
    await waitFor(() => expect(pageFor(1).render).toHaveBeenCalledTimes(2));
    const after = pageFor(1).render.mock.calls[1][0].viewport.scale;
    expect(after).toBeCloseTo(before * 1.25);

    fireEvent.click(screen.getByRole('button', { name: 'Fit width' }));
    expect(screen.getByLabelText('PDF zoom level').textContent).toBe('100%');

    // The page region zooms from the keyboard too.
    fireEvent.keyDown(screen.getByRole('region', { name: 'PDF pages' }), {
      key: '-',
    });
    expect(screen.getByLabelText('PDF zoom level').textContent).toBe('80%');
  });

  test('says honestly when the file is not a PDF it can read', async () => {
    pdfjs.getDocument.mockReturnValue(
      fakeTask(
        Promise.reject(
          Object.assign(new Error('Invalid PDF structure.'), {
            name: 'InvalidPDFException',
          }),
        ),
      ),
    );

    render(<PdfCanvasViewer blob={pdfBlob()} />);

    expect(await screen.findByText('Preview unavailable')).toBeTruthy();
    expect(
      screen.getByText(
        'Station could not read this PDF. Download it to open it.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  test('says so when the PDF worker never starts, instead of loading forever', async () => {
    // pdf.js itself never settles when the worker it was handed is dead.
    pdfjs.getDocument.mockReturnValue(fakeTask(new Promise(() => undefined)));

    render(<PdfCanvasViewer blob={pdfBlob()} />);
    await waitFor(() => expect(pdfjs.workerPorts).toHaveLength(1));
    expect(screen.getByLabelText('Loading PDF preview')).toBeTruthy();

    act(() => pdfjs.workerPorts[0].fail());

    expect(await screen.findByText('Preview unavailable')).toBeTruthy();
  });

  test('names a password-protected PDF as such rather than as broken', async () => {
    pdfjs.getDocument.mockReturnValue(
      fakeTask(
        Promise.reject(
          Object.assign(new Error('No password given'), {
            name: 'PasswordException',
          }),
        ),
      ),
    );

    render(<PdfCanvasViewer blob={pdfBlob()} />);

    expect(
      await screen.findByText('This PDF is password-protected'),
    ).toBeTruthy();
    expect(screen.queryByText('Preview unavailable')).toBeNull();
  });

  test('destroys the document and terminates its worker on unmount', async () => {
    const { doc } = fakeDocument(1);
    const task = fakeTask(Promise.resolve(doc));
    pdfjs.getDocument.mockReturnValue(task);

    const { unmount } = render(<PdfCanvasViewer blob={pdfBlob()} />);
    await screen.findByText('1 page');
    expect(task.destroy).not.toHaveBeenCalled();

    unmount();

    expect(task.destroy).toHaveBeenCalledTimes(1);
    expect(workerDestroy).toHaveBeenCalledTimes(1);
    expect(pdfjs.workerPorts[0].terminate).toHaveBeenCalledTimes(1);
  });

  test('a different file replaces the open document instead of leaking it', async () => {
    const first = fakeDocument(1);
    const second = fakeDocument(4);
    const firstTask = fakeTask(Promise.resolve(first.doc));
    const secondTask = fakeTask(Promise.resolve(second.doc));
    pdfjs.getDocument
      .mockReturnValueOnce(firstTask)
      .mockReturnValueOnce(secondTask);

    const { rerender } = render(<PdfCanvasViewer blob={pdfBlob()} />);
    await screen.findByText('1 page');

    rerender(<PdfCanvasViewer blob={pdfBlob()} />);

    expect(await screen.findByText('4 pages')).toBeTruthy();
    expect(firstTask.destroy).toHaveBeenCalledTimes(1);
    expect(pdfjs.workerPorts[0].terminate).toHaveBeenCalledTimes(1);
    expect(secondTask.destroy).not.toHaveBeenCalled();
  });
});
