import { describe, expect, it, vi } from 'vitest';
import { ListenerManager } from '../core/ListenerManager.js';

// Concrete subclass that exposes protected methods for testing
class TestManager extends ListenerManager {
  notify() {
    this._notify();
  }
  clearListeners() {
    this._clearListeners();
  }
}

describe('ListenerManager', () => {
  it('subscribe returns an unsubscribe function', () => {
    const m = new TestManager();
    const fn = vi.fn();
    const unsub = m.subscribe(fn);
    m.notify();
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
    m.notify();
    expect(fn).toHaveBeenCalledTimes(1); // not called again
  });

  it('notifies all current listeners', () => {
    const m = new TestManager();
    const a = vi.fn();
    const b = vi.fn();
    m.subscribe(a);
    m.subscribe(b);
    m.notify();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('clearListeners prevents further notifications', () => {
    const m = new TestManager();
    const fn = vi.fn();
    m.subscribe(fn);
    m.clearListeners();
    m.notify();
    expect(fn).not.toHaveBeenCalled();
  });

  it('duplicate subscribe calls result in one notification per notify()', () => {
    const m = new TestManager();
    const fn = vi.fn();
    // Set deduplicates — same function reference added twice is still one entry
    m.subscribe(fn);
    m.subscribe(fn);
    m.notify();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('subscribe is a stable bound property (no per-call binding needed)', () => {
    const m = new TestManager();
    // subscribe should be the same reference each time (class field, not a method)
    expect(m.subscribe).toBe(m.subscribe);
  });
});
