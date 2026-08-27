import { describe, expect, test, vi } from 'vitest';
import { SSEBroadcaster } from '../sse-broadcaster.js';

describe('SSEBroadcaster', () => {
  test('broadcast sends to all subscribers', () => {
    const b = new SSEBroadcaster();
    const a = vi.fn();
    const c = vi.fn();
    b.subscribe(a);
    b.subscribe(c);
    b.broadcast({ type: 'test' });
    const expected = JSON.stringify({ type: 'test' });
    expect(a).toHaveBeenCalledWith(expected);
    expect(c).toHaveBeenCalledWith(expected);
  });

  test('unsubscribe stops delivery', () => {
    const b = new SSEBroadcaster();
    const fn = vi.fn();
    const unsub = b.subscribe(fn);
    unsub();
    b.broadcast({ type: 'test' });
    expect(fn).not.toHaveBeenCalled();
  });

  test('throwing client is removed', () => {
    const b = new SSEBroadcaster();
    const bad = vi.fn(() => {
      throw new Error('dead');
    });
    const good = vi.fn();
    b.subscribe(bad);
    b.subscribe(good);
    b.broadcast({ type: 'test' });
    expect(good).toHaveBeenCalledTimes(1);
    b.broadcast({ type: 'test2' });
    expect(bad).toHaveBeenCalledTimes(1); // removed after first failure
    expect(good).toHaveBeenCalledTimes(2);
  });
});
