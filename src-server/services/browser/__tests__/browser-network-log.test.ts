import { describe, expect, it, vi } from 'vitest';
import type { CdpTransport } from '../browser-host.js';
import { BrowserNetworkLog, redactNetworkUrl } from '../browser-network-log.js';

function transport() {
  const listeners = new Map<
    string,
    (params: unknown, session?: string) => void
  >();
  const cdp = {
    send: vi.fn(async () => undefined),
    on: (
      name: string,
      listener: (params: unknown, session?: string) => void,
    ) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
  } as unknown as CdpTransport;
  return {
    cdp,
    emit: (name: string, params: unknown, session = 'target') =>
      listeners.get(name)?.(params, session),
  };
}

describe('browser network capture', () => {
  it('does not start or retain capture when the preview is disabled', async () => {
    const t = transport();
    let enabled = false;
    const log = new BrowserNetworkLog(t.cdp, 'target', () => enabled);
    await log.enable();
    expect(t.cdp.send).not.toHaveBeenCalled();
    enabled = true;
    await log.enable();
    t.emit('Network.requestWillBeSent', {
      requestId: '1',
      request: { url: 'https://example.test/' },
    });
    expect(log.read().entries).toHaveLength(1);
    enabled = false;
    t.emit('Network.requestWillBeSent', {
      requestId: '2',
      request: { url: 'https://example.test/private' },
    });
    expect(log.read().entries).toHaveLength(0);
    log.dispose();
    expect(log.read().entries).toHaveLength(0);
  });
  it('redacts credentials, fragments and query values', () => {
    const value = redactNetworkUrl(
      'https://user:pass@example.test/a?token=secret&x=private#fragment',
    );
    expect(value).not.toMatch(/user|pass|secret|private|fragment/);
    expect(value).toContain('example.test/a');
    expect(redactNetworkUrl('not a URL')).toBe('[invalid URL]');
    expect(redactNetworkUrl('data:text/plain,secret')).toBe('[non-http URL]');
  });

  it('captures only its target metadata and bounds retained records', async () => {
    const t = transport();
    const log = new BrowserNetworkLog(t.cdp, 'target');
    await log.enable();
    expect(t.cdp.send).toHaveBeenCalledWith(
      'Network.enable',
      { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 },
      'target',
    );
    t.emit(
      'Network.requestWillBeSent',
      { requestId: 'ignored', request: { url: 'https://other.test/' } },
      'other',
    );
    for (let i = 0; i < 501; i++) {
      t.emit('Network.requestWillBeSent', {
        requestId: String(i),
        request: {
          url: `https://example.test/?token=${i}`,
          method: 'GET',
          postData: 'never retain',
        },
        type: 'XHR',
        timestamp: 1,
      });
    }
    t.emit('Network.responseReceived', {
      requestId: '500',
      response: { status: 503, headers: { cookie: 'never retain' } },
      type: 'XHR',
    });
    t.emit('Network.loadingFinished', {
      requestId: '500',
      timestamp: 1.25,
      encodedDataLength: 42,
    });
    const result = log.read(500);
    expect(result.dropped).toBe(1);
    expect(result.entries).toEqual([
      expect.objectContaining({
        seq: 501,
        status: 503,
        bytes: 42,
        durationMs: 250,
      }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(/never retain|token=500/);
    expect(log.read(0, 1000).entries).toHaveLength(100);
    log.dispose();
    expect(log.capturing).toBe(false);
    expect(log.read().entries).toEqual([]);
  });
});
