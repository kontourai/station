/**
 * #4769: the egress broker's policy and its CONNECT handling, against real
 * loopback sockets. The upstream it dials is a local stand-in (`dial`), and
 * name resolution is injected (`lookup`), so nothing reaches the network.
 */
import { connect, createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import {
  addressesAdmitted,
  decideEgress,
  type EgressBroker,
  type EgressBrokerOptions,
  isPublicAddress,
  MAX_EGRESS_DECISIONS,
  normalizeEgressHost,
  parseConnectAuthority,
  parseEgressHostRule,
  startEgressBroker,
} from '../egress-broker.js';

describe('egress host policy', () => {
  test('an allowed-host entry parses to an exact host on 443 unless it names a port', () => {
    expect(parseEgressHostRule('registry.npmjs.org')).toEqual({
      kind: 'exact',
      host: 'registry.npmjs.org',
      port: 443,
    });
    expect(parseEgressHostRule('Example.COM.:8443')).toEqual({
      kind: 'exact',
      host: 'example.com',
      port: 8443,
    });
    expect(parseEgressHostRule('*.github.com')).toEqual({
      kind: 'subdomains',
      suffix: 'github.com',
      port: 443,
    });
    expect(parseEgressHostRule('[2001:db8::1]:8080')).toEqual({
      kind: 'exact',
      host: '2001:db8::1',
      port: 8080,
    });
    expect(parseEgressHostRule('203.0.113.7')).toEqual({
      kind: 'exact',
      host: '203.0.113.7',
      port: 443,
    });
  });

  test('a malformed allowed-host entry is refused, never narrowed', () => {
    for (const bad of [
      '',
      'https://example.com',
      'example.com/path',
      'exa mple.com',
      'example.com:0',
      'example.com:65536',
      'example.com:+443',
      '*.com',
      '*.203.0.113.7',
      '*',
      'ex*ample.com',
      '-bad.example.com',
      'bücher.example',
      `${'a'.repeat(64)}.example.com`,
      `${'a.'.repeat(130)}example.com`,
      '[::1',
      '[example.com]:443',
      'fe80::1%en0',
    ])
      expect(parseEgressHostRule(bad), bad).toBeUndefined();
  });

  test('a host is compared in lowercase with one trailing dot removed', () => {
    expect(normalizeEgressHost('API.Anthropic.com.')).toBe('api.anthropic.com');
    expect(normalizeEgressHost('api.anthropic.com..')).toBeUndefined();
    expect(normalizeEgressHost('[::FFFF:7F00:1]')).toBe('::ffff:7f00:1');
  });

  test('a CONNECT target needs a host and a port, and reads IPv6 literals', () => {
    expect(parseConnectAuthority('Api.Example.com.:443')).toEqual({
      host: 'api.example.com',
      port: 443,
    });
    expect(parseConnectAuthority('[2001:db8::5]:443')).toEqual({
      host: '2001:db8::5',
      port: 443,
    });
    for (const bad of [
      'api.example.com',
      '2001:db8::5',
      '[2001:db8::5]',
      'api.example.com:http',
      ':443',
      `${'a'.repeat(254)}:443`,
      '[2001:db8::5]x:443',
    ])
      expect(parseConnectAuthority(bad), bad).toBeUndefined();
  });

  test('the model endpoint, then any allowed entry, admits a target; anything else is denied', () => {
    const allowedHosts = [
      parseEgressHostRule('registry.npmjs.org')!,
      parseEgressHostRule('*.github.com')!,
    ];
    const modelEndpoint = { host: 'api.anthropic.com', port: 443 };
    const decide = (host: string, port = 443) =>
      decideEgress({ host, port }, { allowedHosts, modelEndpoint }).reason;
    expect(decide('api.anthropic.com')).toBe('model-endpoint');
    expect(decide('api.anthropic.com', 80)).toBe('not-allowed');
    expect(decide('registry.npmjs.org')).toBe('allowed-host');
    expect(decide('registry.npmjs.org', 8443)).toBe('not-allowed');
    expect(decide('api.github.com')).toBe('allowed-host');
    // A subdomain entry does not admit its apex or a lookalike.
    expect(decide('github.com')).toBe('not-allowed');
    expect(decide('evilgithub.com')).toBe('not-allowed');
    expect(decide('attacker.example')).toBe('not-allowed');
    expect(
      decideEgress({ host: 'x', port: 443 }, { allowedHosts: [] }).verdict,
    ).toBe('denied');
  });

  test('public addresses are told apart from loopback, private and link-local ones', () => {
    for (const address of ['93.184.216.34', '2606:4700::6810:84e5', '8.8.8.8'])
      expect(isPublicAddress(address), address).toBe(true);
    for (const address of [
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '169.254.169.254',
      '224.0.0.1',
      '::1',
      '::',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      'not an address',
    ])
      expect(isPublicAddress(address), address).toBe(false);
  });

  test('a listed name that resolves to loopback or a private address is refused; the model endpoint is not', () => {
    const named = decideEgress(
      { host: 'rebound.example', port: 443 },
      { allowedHosts: [parseEgressHostRule('rebound.example')!] },
    );
    expect(addressesAdmitted(named, ['127.0.0.1'])).toBe(false);
    expect(addressesAdmitted(named, ['93.184.216.34', '10.0.0.1'])).toBe(false);
    expect(addressesAdmitted(named, ['93.184.216.34'])).toBe(true);
    expect(addressesAdmitted(named, [])).toBe(false);
    const literal = decideEgress(
      { host: '10.0.0.5', port: 8080 },
      { allowedHosts: [parseEgressHostRule('10.0.0.5:8080')!] },
    );
    expect(addressesAdmitted(literal, ['10.0.0.5'])).toBe(true);
    const loopbackLiteral = decideEgress(
      { host: '127.0.0.1', port: 3141 },
      { allowedHosts: [parseEgressHostRule('127.0.0.1:3141')!] },
    );
    expect(addressesAdmitted(loopbackLiteral, ['127.0.0.1'])).toBe(false);
    const model = decideEgress(
      { host: 'localhost', port: 4000 },
      {
        allowedHosts: [],
        modelEndpoint: { host: 'localhost', port: 4000 },
      },
    );
    expect(addressesAdmitted(model, ['127.0.0.1'])).toBe(true);
  });
});

/** A local upstream that answers `upstream:<first bytes>` and closes. */
async function standIn(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    socket.once('data', (chunk) => socket.end(`upstream:${chunk}`));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { server, port: address.port };
}

/** Sends `request` to the broker and reads until it closes. */
function exchange(
  port: number,
  request: string | Buffer,
  then?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ host: '127.0.0.1', port });
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1');
      if (then && text.includes('200 Connection Established\r\n\r\n')) {
        socket.write(then);
        then = undefined;
      }
    });
    socket.on('close', () => resolve(text));
    socket.on('error', reject);
    socket.write(request);
  });
}

describe('egress broker', () => {
  const opened: Array<{ close: () => unknown }> = [];
  afterEach(async () => {
    for (const item of opened.splice(0)) await item.close();
  });

  async function broker(
    options: Partial<EgressBrokerOptions> & { upstreamPort?: number } = {},
  ): Promise<EgressBroker> {
    const { upstreamPort, ...rest } = options;
    const started = await startEgressBroker({
      allowedHosts: [parseEgressHostRule('allowed.example')!],
      lookup: async () => ['93.184.216.34'],
      ...(upstreamPort
        ? { dial: (_address, _port) => connect(upstreamPort, '127.0.0.1') }
        : {}),
      now: () => new Date('2026-11-11T00:00:00.000Z'),
      ...rest,
    });
    opened.push(started);
    return started;
  }

  test('an allowed host is tunnelled and recorded with host, port, verdict and time only', async () => {
    const upstream = await standIn();
    opened.push({ close: () => upstream.server.close() });
    const dialled: Array<[string, number]> = [];
    const started = await broker({
      dial: (address, port) => {
        dialled.push([address, port]);
        return connect(upstream.port, '127.0.0.1');
      },
    });
    const reply = await exchange(
      started.port,
      'CONNECT Allowed.Example.:443 HTTP/1.1\r\nHost: allowed.example:443\r\nProxy-Authorization: secret\r\n\r\n',
      'hello',
    );
    expect(reply).toContain('HTTP/1.1 200 Connection Established');
    expect(reply).toContain('upstream:hello');
    // The checked address is dialled, not the name again.
    expect(dialled).toEqual([['93.184.216.34', 443]]);
    expect(started.decisions()).toEqual([
      {
        at: '2026-11-11T00:00:00.000Z',
        verdict: 'allowed',
        reason: 'allowed-host',
        host: 'allowed.example',
        port: 443,
      },
    ]);
    expect(JSON.stringify(started.decisions())).not.toMatch(/secret|hello/);
  });

  test('the model endpoint set from the engine environment is tunnelled', async () => {
    const upstream = await standIn();
    opened.push({ close: () => upstream.server.close() });
    const started = await broker({
      upstreamPort: upstream.port,
      lookup: async () => ['127.0.0.1'],
    });
    started.setModelEndpoint({ host: 'localhost', port: 4000 });
    const reply = await exchange(
      started.port,
      'CONNECT localhost:4000 HTTP/1.1\r\n\r\n',
      'ping',
    );
    expect(reply).toContain('upstream:ping');
    expect(started.decisions().map((record) => record.reason)).toEqual([
      'model-endpoint',
    ]);
  });

  test('a host that is not allowed gets 403 and a denied record; nothing is dialled', async () => {
    let dialled = 0;
    const started = await broker({
      dial: () => {
        dialled += 1;
        return connect(1, '127.0.0.1');
      },
    });
    const reply = await exchange(
      started.port,
      'CONNECT attacker.example:443 HTTP/1.1\r\n\r\n',
    );
    expect(reply).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
    expect(reply).toContain('attacker.example:443');
    expect(dialled).toBe(0);
    expect(started.decisions()).toEqual([
      {
        at: '2026-11-11T00:00:00.000Z',
        verdict: 'denied',
        reason: 'not-allowed',
        host: 'attacker.example',
        port: 443,
      },
    ]);
  });

  test('an allowed name that resolves to loopback is refused, so Station’s own port stays out of reach', async () => {
    const started = await broker({ lookup: async () => ['127.0.0.1'] });
    const reply = await exchange(
      started.port,
      'CONNECT allowed.example:443 HTTP/1.1\r\n\r\n',
    );
    expect(reply).toMatch(/^HTTP\/1\.1 403/);
    expect(started.decisions()[0]).toMatchObject({
      verdict: 'denied',
      reason: 'non-public-address',
    });
  });

  test('an IPv6 literal target is read and denied unless listed', async () => {
    const started = await broker();
    const reply = await exchange(
      started.port,
      'CONNECT [::1]:443 HTTP/1.1\r\n\r\n',
    );
    expect(reply).toMatch(/^HTTP\/1\.1 403/);
    expect(started.decisions()[0]).toMatchObject({
      host: '::1',
      port: 443,
      reason: 'not-allowed',
    });
  });

  test('a request that is not CONNECT gets 405 and its URL path is never recorded', async () => {
    const started = await broker();
    const reply = await exchange(
      started.port,
      'GET http://allowed.example/private/path?token=abc HTTP/1.1\r\nHost: allowed.example\r\n\r\n',
    );
    expect(reply).toMatch(/^HTTP\/1\.1 405 Method Not Allowed\r\n/);
    expect(reply).toContain('Allow: CONNECT');
    expect(started.decisions()).toEqual([
      {
        at: '2026-11-11T00:00:00.000Z',
        verdict: 'denied',
        reason: 'method-not-allowed',
        host: 'allowed.example',
        port: 80,
      },
    ]);
    expect(JSON.stringify(started.decisions())).not.toMatch(/private|token/);
  });

  test('a malformed CONNECT gets 400 and a record with no host', async () => {
    const started = await broker();
    for (const request of [
      'CONNECT allowed.example HTTP/1.1\r\n\r\n',
      'CONNECT  HTTP/1.1\r\n\r\n',
      'CONNECT allowed.example:443 HTTP/2\r\n\r\n',
      `CONNECT ${'a'.repeat(300)}.example:443 HTTP/1.1\r\n\r\n`,
    ])
      expect(await exchange(started.port, request)).toMatch(
        /^HTTP\/1\.1 400 Bad Request/,
      );
    expect(started.decisions()).toHaveLength(4);
    for (const record of started.decisions()) {
      expect(record).toMatchObject({
        verdict: 'denied',
        reason: 'malformed-request',
      });
      expect(record).not.toHaveProperty('host');
    }
  });

  test('a request header past the byte limit is refused before it ends', async () => {
    const started = await broker({ maxHeaderBytes: 64 });
    const reply = await exchange(
      started.port,
      `CONNECT allowed.example:443 HTTP/1.1\r\nX-Pad: ${'p'.repeat(200)}`,
    );
    expect(reply).toMatch(/^HTTP\/1\.1 431/);
    expect(started.decisions()[0]?.reason).toBe('malformed-request');
  });

  test('a client that never finishes its header is closed at the deadline (slowloris)', async () => {
    const started = await broker({ headerDeadlineMs: 150 });
    const begun = Date.now();
    const reply = await exchange(started.port, 'CONNECT allowed.exa');
    expect(Date.now() - begun).toBeLessThan(5_000);
    expect(reply).toMatch(/^HTTP\/1\.1 408/);
    expect(started.decisions()).toEqual([
      {
        at: '2026-11-11T00:00:00.000Z',
        verdict: 'denied',
        reason: 'header-deadline',
      },
    ]);
  });

  test('the decision records are bounded, oldest dropped first', async () => {
    const started = await broker({ maxDecisions: 3 });
    for (const host of ['a', 'b', 'c', 'd', 'e'])
      await exchange(
        started.port,
        `CONNECT ${host}.example:443 HTTP/1.1\r\n\r\n`,
      );
    expect(started.decisions().map((record) => record.host)).toEqual([
      'c.example',
      'd.example',
      'e.example',
    ]);
    expect(MAX_EGRESS_DECISIONS).toBe(256);
  });

  test('every decision reaches the observer as it is made', async () => {
    const seen: string[] = [];
    const started = await broker({
      onDecision: (record) => seen.push(`${record.verdict}:${record.host}`),
    });
    await exchange(started.port, 'CONNECT nope.example:443 HTTP/1.1\r\n\r\n');
    expect(seen).toEqual(['denied:nope.example']);
  });

  test('an unresolvable allowed name is denied, and an unreachable one gets 502', async () => {
    const unresolved = await broker({
      lookup: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(
      await exchange(
        unresolved.port,
        'CONNECT allowed.example:443 HTTP/1.1\r\n\r\n',
      ),
    ).toMatch(/^HTTP\/1\.1 403/);
    expect(unresolved.decisions()[0]?.reason).toBe('unresolved');
    const closedPort = await standIn();
    await new Promise((resolve) => closedPort.server.close(resolve));
    const unreachable = await broker({ upstreamPort: closedPort.port });
    expect(
      await exchange(
        unreachable.port,
        'CONNECT allowed.example:443 HTTP/1.1\r\n\r\n',
      ),
    ).toMatch(/^HTTP\/1\.1 502/);
  });

  test('a closed broker refuses new connections', async () => {
    const started = await broker();
    await started.close();
    await expect(exchange(started.port, 'x')).rejects.toThrow();
  });
});
