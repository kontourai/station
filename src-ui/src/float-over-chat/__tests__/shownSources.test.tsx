// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { browserShownSourceKey } from '../floatSource';
import {
  useFloatSourceVisibility,
  useInlineSourceVisibility,
  usePaneSourceVisibility,
} from '../shownSources';

function Viewer({
  kind,
  scope,
  name,
}: {
  kind: 'pane' | 'inline' | 'float';
  scope: string;
  name: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const key = browserShownSourceKey('session', 'http://station.test', scope);
  const pane = usePaneSourceVisibility(kind === 'pane' ? key : null, ref);
  const inline = useInlineSourceVisibility(kind === 'inline' ? key : null, ref);
  const float = useFloatSourceVisibility(kind === 'float' ? key : null);
  const visible =
    kind === 'pane' ? pane : kind === 'inline' ? inline.visible : float;
  return (
    <div ref={ref} data-testid={name}>
      {visible ? 'streaming' : 'waiting'}
    </div>
  );
}
afterEach(cleanup);

test('pane, inline and float election is exclusive, releases and separates authority', () => {
  const view = render(
    <>
      <Viewer kind="float" scope="a" name="float" />
      <Viewer kind="inline" scope="a" name="inline" />
      <Viewer kind="pane" scope="a" name="pane" />
      <Viewer kind="pane" scope="b" name="other" />
    </>,
  );
  expect(screen.getByTestId('pane').textContent).toBe('streaming');
  expect(screen.getByTestId('inline').textContent).toBe('waiting');
  expect(screen.getByTestId('float').textContent).toBe('waiting');
  expect(screen.getByTestId('other').textContent).toBe('streaming');
  act(() =>
    view.rerender(
      <>
        <Viewer kind="float" scope="a" name="float" />
        <Viewer kind="inline" scope="a" name="inline" />
        <Viewer kind="pane" scope="b" name="other" />
      </>,
    ),
  );
  expect(screen.getByTestId('inline').textContent).toBe('streaming');
  expect(screen.getByTestId('float').textContent).toBe('waiting');
  act(() => view.rerender(<Viewer kind="float" scope="a" name="float" />));
  expect(screen.getByTestId('float').textContent).toBe('streaming');
});

test('an offscreen pane releases the viewer to an on-screen inline view', () => {
  const observers: Array<{
    target?: Element;
    callback: IntersectionObserverCallback;
  }> = [];
  class Observer {
    entry: (typeof observers)[number];
    constructor(callback: IntersectionObserverCallback) {
      this.entry = { callback };
      observers.push(this.entry);
    }
    observe(target: Element) {
      this.entry.target = target;
    }
    disconnect() {}
    unobserve() {}
    takeRecords() {
      return [];
    }
    root = null;
    rootMargin = '';
    thresholds = [];
  }
  vi.stubGlobal('IntersectionObserver', Observer);
  try {
    render(
      <>
        <Viewer kind="pane" scope="a" name="pane" />
        <Viewer kind="inline" scope="a" name="inline" />
      </>,
    );
    const show = (name: string, visible: boolean) => {
      const observer = observers.find(
        (entry) => entry.target === screen.getByTestId(name),
      );
      if (!observer) throw new Error(`missing observer for ${name}`);
      act(() =>
        observer.callback(
          [{ isIntersecting: visible } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        ),
      );
    };
    show('pane', true);
    show('inline', true);
    expect(screen.getByTestId('pane').textContent).toBe('streaming');
    expect(screen.getByTestId('inline').textContent).toBe('waiting');
    show('pane', false);
    expect(screen.getByTestId('pane').textContent).toBe('waiting');
    expect(screen.getByTestId('inline').textContent).toBe('streaming');
  } finally {
    vi.unstubAllGlobals();
  }
});
