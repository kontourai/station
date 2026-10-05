// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe('lastChosenModel', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  test('round-trips a model choice through storage', async () => {
    const { getLastChosenModelMap, trackLastChosenModel } = await import(
      '../hooks/lastChosenModel'
    );

    expect(getLastChosenModelMap()).toEqual({});

    trackLastChosenModel('claudedefault', 'claude-sonnet-4-6');

    expect(getLastChosenModelMap()).toEqual({
      claudedefault: 'claude-sonnet-4-6',
    });
  });

  test('overwrites the prior choice for the same binding and keeps others', async () => {
    const { getLastChosenModelMap, trackLastChosenModel } = await import(
      '../hooks/lastChosenModel'
    );

    trackLastChosenModel('claudedefault', 'claude-sonnet-4-6');
    trackLastChosenModel('codexdefault', 'gpt-5-codex');
    trackLastChosenModel('claudedefault', 'claude-opus-4-6');

    expect(getLastChosenModelMap()).toEqual({
      claudedefault: 'claude-opus-4-6',
      codexdefault: 'gpt-5-codex',
    });
  });

  test('ignores empty binding key or model id', async () => {
    const { getLastChosenModelMap, trackLastChosenModel } = await import(
      '../hooks/lastChosenModel'
    );

    trackLastChosenModel('', 'claude-sonnet-4-6');
    trackLastChosenModel('claudedefault', '');

    expect(getLastChosenModelMap()).toEqual({});
  });

  test('tolerates corrupt JSON and non-object payloads in storage', async () => {
    const { getLastChosenModelMap } = await import('../hooks/lastChosenModel');

    localStorage.setItem('station.newChat.lastModelByBinding', '{not json');
    expect(getLastChosenModelMap()).toEqual({});

    localStorage.setItem('station.newChat.lastModelByBinding', '[]');
    expect(getLastChosenModelMap()).toEqual({});

    localStorage.setItem('station.newChat.lastModelByBinding', 'null');
    expect(getLastChosenModelMap()).toEqual({});
  });

  test('drops non-string values from a malformed stored map', async () => {
    const { getLastChosenModelMap } = await import('../hooks/lastChosenModel');

    localStorage.setItem(
      'station.newChat.lastModelByBinding',
      JSON.stringify({
        claudedefault: 'claude-sonnet-4-6',
        'bad-entry': 42,
        'empty-entry': '',
      }),
    );

    expect(getLastChosenModelMap()).toEqual({
      claudedefault: 'claude-sonnet-4-6',
    });
  });

  // #3312 review LOW: Home stays mounted while a docked chat records a new
  // choice; the map it resolves its start identity from must follow.
  test('the live map re-renders when a choice is recorded or forgotten', async () => {
    const { act, renderHook } = await import('@testing-library/react');
    const {
      clearLastChosenModel,
      trackLastChosenModel,
      useLastChosenModelMap,
    } = await import('../hooks/lastChosenModel');
    const { result } = renderHook(() => useLastChosenModelMap());
    expect(result.current).toEqual({});

    act(() => trackLastChosenModel('codexdefault', 'gpt-5.4'));
    expect(result.current).toEqual({ codexdefault: 'gpt-5.4' });

    act(() => clearLastChosenModel('codexdefault'));
    expect(result.current).toEqual({});
  });
});
