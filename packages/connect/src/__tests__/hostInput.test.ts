import { describe, expect, it } from 'vitest';
import { isCleartextNonLoopback, normalizeHostInput } from '../core/hostInput';

describe('normalizeHostInput', () => {
  it('prepends https to a bare hostname', () => {
    expect(normalizeHostInput('station.foo.ts.net')).toBe(
      'https://station.foo.ts.net',
    );
  });

  it('prepends https to a bare host:port', () => {
    expect(normalizeHostInput('myhost:3151')).toBe('https://myhost:3151');
  });

  it('prepends https to a bare IP:port', () => {
    expect(normalizeHostInput('192.168.1.5:3141')).toBe(
      'https://192.168.1.5:3141',
    );
  });

  it('keeps an explicit http:// address as typed', () => {
    expect(normalizeHostInput('http://192.168.1.5:3141')).toBe(
      'http://192.168.1.5:3141',
    );
  });

  it('keeps an explicit https:// address as typed', () => {
    expect(normalizeHostInput('https://station.foo.ts.net')).toBe(
      'https://station.foo.ts.net',
    );
  });

  it('trims surrounding whitespace before normalizing', () => {
    expect(normalizeHostInput('  station.foo.ts.net  ')).toBe(
      'https://station.foo.ts.net',
    );
    expect(normalizeHostInput('\thttp://10.0.0.4:3141\n')).toBe(
      'http://10.0.0.4:3141',
    );
  });

  it('returns an empty string unchanged (no scheme forced onto nothing)', () => {
    expect(normalizeHostInput('')).toBe('');
    expect(normalizeHostInput('   ')).toBe('');
  });

  it('does not double-prefix a non-http scheme', () => {
    expect(normalizeHostInput('tauri://localhost')).toBe('tauri://localhost');
  });
});

describe('isCleartextNonLoopback', () => {
  it('is true for http to a raw IP', () => {
    expect(isCleartextNonLoopback('http://192.168.1.5:3141')).toBe(true);
  });

  it('is true for http to a remote hostname', () => {
    expect(isCleartextNonLoopback('http://station.foo.ts.net')).toBe(true);
  });

  it('is false for any https address', () => {
    expect(isCleartextNonLoopback('https://station.foo.ts.net')).toBe(false);
    expect(isCleartextNonLoopback('https://192.168.1.5:3141')).toBe(false);
  });

  it('is false for http to loopback hosts', () => {
    expect(isCleartextNonLoopback('http://localhost:3141')).toBe(false);
    expect(isCleartextNonLoopback('http://127.0.0.1:3141')).toBe(false);
    expect(isCleartextNonLoopback('http://[::1]:3141')).toBe(false);
  });

  it('is false for unparseable input', () => {
    expect(isCleartextNonLoopback('not a url')).toBe(false);
    expect(isCleartextNonLoopback('')).toBe(false);
  });
});
