/**
 * @vitest-environment jsdom
 *
 *durable half: a dismissed notice that has an `occurrence` stays
 * dismissed across a reload, and one WITHOUT an occurrence does not — because
 * an id-only dismissal, made durable, means the banner never comes back.
 *
 * The store is a module singleton that reads storage once at import, so every
 * "after a reload" case here is a real fresh import (`vi.resetModules`),
 * not a method call that pretends to be one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BANNER_PRIORITY } from '../contexts/banner-store';

const STORAGE_KEY = 'station.banners.dismissed';

async function freshStore() {
  vi.resetModules();
  return (await import('../contexts/banner-store')).bannerStore;
}

function banner(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chrome:test:durable',
    priority: BANNER_PRIORITY.info,
    tone: 'info' as const,
    message: 'Request access to reconnect to Default.',
    dismissible: true,
    occurrence: 'evidence-a',
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('banner dismissal durability', () => {
  it('keeps an occurrence-bearing dismissal across a reload', async () => {
    const store = await freshStore();
    store.present(banner());
    expect(store.getSnapshot()).toHaveLength(1);

    store.dismiss('chrome:test:durable', { reason: 'user' });
    expect(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}'),
    ).toEqual({ 'chrome:test:durable': 'evidence-a' });

    const reloaded = await freshStore();
    reloaded.present(banner());
    expect(reloaded.getSnapshot()).toHaveLength(0);
  });

  it('re-presents the same id at a NEW occurrence, and forgets the record', async () => {
    const store = await freshStore();
    store.present(banner());
    store.dismiss('chrome:test:durable', { reason: 'user' });

    const reloaded = await freshStore();
    reloaded.present(banner({ occurrence: 'evidence-b' }));
    expect(reloaded.getSnapshot()).toHaveLength(1);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('never persists a dismissal with no occurrence', async () => {
    // The trap: keyed by id alone, a durable dismissal means the banner never
    // comes back. Session-scoped suppression still applies within the session.
    const store = await freshStore();
    store.present(banner({ occurrence: undefined }));
    store.dismiss('chrome:test:durable', { reason: 'user' });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    // The dismissed card is still on screen for its 160ms exit; flush it so
    // this asserts suppression rather than the animation.
    store.flushExits();
    store.present(banner({ occurrence: undefined }));
    expect(store.getSnapshot()).toHaveLength(0);

    const reloaded = await freshStore();
    reloaded.present(banner({ occurrence: undefined }));
    expect(reloaded.getSnapshot()).toHaveLength(1);
  });

  it('does not persist a system dismissal — only the user decides', async () => {
    const store = await freshStore();
    store.present(banner());
    store.dismiss('chrome:test:durable');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('clears the record on clear() and reset()', async () => {
    const store = await freshStore();
    store.present(banner());
    store.dismiss('chrome:test:durable', { reason: 'user' });
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    store.clear();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    store.present(banner());
    store.dismiss('chrome:test:durable', { reason: 'user' });
    store.clear('chrome:test:');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('ignores a stored value that is not an occurrence string', async () => {
    // A non-string would re-enter the store as an id-only dismissal, which is
    // the one shape that must never be durable — so it is refused on read and
    // the banner presents.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ 'chrome:test:durable': true }),
    );
    const store = await freshStore();
    store.present(banner());
    expect(store.getSnapshot()).toHaveLength(1);
  });

  it('presents normally when the stored record is unparseable', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'not json');
    const store = await freshStore();
    store.present(banner());
    expect(store.getSnapshot()).toHaveLength(1);
  });
});
