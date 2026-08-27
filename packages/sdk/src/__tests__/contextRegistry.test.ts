import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextRegistry } from '../context/registry.js';
import type { MessageContextProvider } from '../context/types.js';

function makeProvider(
  id: string,
  context: string | null = null,
  enabled = false,
): MessageContextProvider {
  return {
    id,
    name: `Provider ${id}`,
    enabled,
    getContext: vi.fn(() => context),
    subscribe: vi.fn(() => () => {}),
  };
}

describe('contextRegistry', () => {
  afterEach(() => {
    for (const p of contextRegistry.getAll()) contextRegistry.unregister(p.id);
  });

  describe('registration', () => {
    it('registers and retrieves a provider', () => {
      const p = makeProvider('tz');
      contextRegistry.register(p);
      expect(contextRegistry.get('tz')).toBe(p);
    });

    it('getAll returns all registered providers', () => {
      contextRegistry.register(makeProvider('a'));
      contextRegistry.register(makeProvider('b'));
      const ids = contextRegistry.getAll().map((p) => p.id);
      expect(ids).toContain('a');
      expect(ids).toContain('b');
    });

    it('unregisters a provider', () => {
      contextRegistry.register(makeProvider('rm'));
      contextRegistry.unregister('rm');
      expect(contextRegistry.get('rm')).toBeUndefined();
    });
  });

  describe('getComposedContext', () => {
    it('returns null when no providers are registered', () => {
      expect(contextRegistry.getComposedContext()).toBeNull();
    });

    it('returns null when all providers are disabled', () => {
      contextRegistry.register(makeProvider('off', '[loc]', false));
      expect(contextRegistry.getComposedContext()).toBeNull();
    });

    it('returns context from a single enabled provider', () => {
      contextRegistry.register(makeProvider('tz', '[Timezone: UTC]', true));
      expect(contextRegistry.getComposedContext()).toBe('[Timezone: UTC]');
    });

    it('composes multiple enabled providers separated by newline', () => {
      contextRegistry.register(makeProvider('a', '[A]', true));
      contextRegistry.register(makeProvider('b', '[B]', true));
      const result = contextRegistry.getComposedContext();
      expect(result).toContain('[A]');
      expect(result).toContain('[B]');
      expect(result).toContain('\n');
    });

    it('skips providers whose getContext() returns null even when enabled', () => {
      contextRegistry.register(makeProvider('no-loc', null, true));
      contextRegistry.register(makeProvider('tz', '[Timezone: UTC]', true));
      expect(contextRegistry.getComposedContext()).toBe('[Timezone: UTC]');
    });
  });

  describe('subscribe notifications', () => {
    it('notifies on registration', () => {
      const listener = vi.fn();
      const unsub = contextRegistry.subscribe(listener);
      contextRegistry.register(makeProvider('notify'));
      expect(listener).toHaveBeenCalledTimes(1);
      unsub();
    });

    it('notifies on unregistration', () => {
      contextRegistry.register(makeProvider('rm-notify'));
      const listener = vi.fn();
      const unsub = contextRegistry.subscribe(listener);
      contextRegistry.unregister('rm-notify');
      expect(listener).toHaveBeenCalledTimes(1);
      unsub();
    });

    it('does NOT notify when unregistering non-existent id', () => {
      const listener = vi.fn();
      const unsub = contextRegistry.subscribe(listener);
      contextRegistry.unregister('ghost');
      expect(listener).not.toHaveBeenCalled();
      unsub();
    });
  });
});
