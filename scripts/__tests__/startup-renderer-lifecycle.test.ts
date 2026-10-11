import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
import { expect, test } from 'vitest';

const source = stripTypeScriptTypes(
  readFileSync(
    new URL('../../src-ui/src/lib/startup-animation.ts', import.meta.url),
    'utf8',
  ),
).replaceAll('export function ', 'function ');

function renderer({ reduced = false, channel = 'stable' } = {}) {
  let paints = 0;
  let nextFrame = 0;
  const frames = new Map<number, (time: number) => void>();
  const listeners = new Map<string, () => void>();
  const observers: { callback: () => void; disconnected: boolean }[] = [];
  const images: ImageFixture[] = [];
  const context = new Proxy(
    {
      clearRect() {
        paints++;
      },
      measureText() {
        return { width: 100 };
      },
      getImageData() {
        return { data: new Uint8ClampedArray(187 * 187 * 4) };
      },
      createLinearGradient() {
        return { addColorStop() {} };
      },
    },
    {
      get(target, key) {
        return Reflect.get(target, key) ?? (() => {});
      },
    },
  );
  const motion = {
    matches: reduced,
    addEventListener(_name: string, callback: () => void) {
      listeners.set('motion', callback);
    },
    removeEventListener() {
      listeners.delete('motion');
    },
  };
  const canvas = {
    parentElement: { append() {}, style: { setProperty() {} } },
    clientWidth: 400,
    clientHeight: 800,
    isConnected: true,
    dataset: {},
    getContext() {
      return context;
    },
  };
  class Observer {
    disconnected = false;
    constructor(public callback: () => void) {
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  }
  class ImageFixture {
    src = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      images.push(this);
    }
  }
  const document = {
    hidden: false,
    documentElement: {
      dataset: { appChannel: channel },
      classList: {
        contains() {
          return channel === 'dev';
        },
      },
    },
    querySelector() {
      return canvas;
    },
    fonts: {
      load() {
        return new Promise(() => {});
      },
    },
    createElementNS() {
      return {
        setAttribute() {},
        getTotalLength() {
          return 100;
        },
        getPointAtLength() {
          return { x: 1, y: 1 };
        },
      };
    },
    createElement(tag: string) {
      return tag === 'canvas'
        ? {
            getContext() {
              return context;
            },
          }
        : { style: {}, remove() {} };
    },
    addEventListener(name: string, callback: () => void) {
      listeners.set(name, callback);
    },
    removeEventListener(name: string) {
      listeners.delete(name);
    },
  };
  const sandbox = vm.createContext({
    document,
    window: {
      matchMedia() {
        return motion;
      },
      devicePixelRatio: 1,
    },
    getComputedStyle() {
      return {
        color: 'rgb(1,2,3)',
        getPropertyValue() {
          return 'Fraunces';
        },
      };
    },
    Image: ImageFixture,
    MutationObserver: Observer,
    ResizeObserver: Observer,
    requestAnimationFrame(callback: (time: number) => void) {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) {
      frames.delete(id);
    },
  });
  vm.runInContext(source, sandbox);
  images.at(-1)?.onload?.();
  return {
    motion,
    document,
    listeners,
    observers,
    images,
    frames,
    paints: () => paints,
    tick(time: number) {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(time);
    },
    release() {
      vm.runInContext('releaseInitialStartupAnimation()', sandbox);
    },
  };
}

test('rapid reduced-motion and theme invalidations repaint instead of dropping the only frame', () => {
  const scene = renderer();
  scene.tick(1000);
  expect(scene.paints()).toBe(1);
  scene.motion.matches = true;
  scene.listeners.get('motion')?.();
  scene.tick(1001);
  expect(scene.paints()).toBe(2);
  expect(scene.frames.size).toBe(0);
  scene.observers[0].callback();
  scene.tick(1002);
  expect(scene.paints()).toBe(3);
  expect(scene.frames.size).toBe(0);
});

test.each([false, true])(
  'ready-app handoff disposes the initial renderer, reduced motion=%s',
  (reduced) => {
    const scene = renderer({ reduced });
    scene.tick(1000);
    scene.release();
    scene.release();
    expect(scene.frames.size).toBe(0);
    expect(scene.observers.every((observer) => observer.disconnected)).toBe(
      true,
    );
    expect(scene.listeners.size).toBe(0);
    const count = scene.paints();
    scene.tick(2000);
    expect(scene.paints()).toBe(count);
  },
);

test.each(['stable', 'dev', 'beta', 'nightly'])(
  'canvas keeps the %s channel artwork',
  (channel) => {
    const scene = renderer({ channel });
    expect(scene.images.at(-1)?.src).toBe(
      channel === 'stable' ? '/favicon.png' : `/favicon-${channel}.png`,
    );
    scene.release();
  },
);
