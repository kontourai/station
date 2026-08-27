import { lookup as dnsLookup } from 'node:dns';
import {
  type ClientRequest,
  request as httpRequest,
  type IncomingMessage,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { isAbsolute, relative, sep } from 'node:path';

export const DEV_SERVER_HOST = '127.0.0.1';
export const MAX_JSON_BODY_BYTES = 1_048_576;
export const MAX_FETCH_RESPONSE_BYTES = 10_485_760;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_FETCH_REDIRECTS = 5;
export const MAX_RELOAD_CLIENTS = 32;
export const DEV_HEADERS_TIMEOUT_MS = 10_000;
export const DEV_REQUEST_TIMEOUT_MS = 15_000;

export class DevHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface DnsAddress {
  address: string;
  family: 4 | 6;
}

export interface DevFetchDependencies {
  lookup: (hostname: string) => Promise<DnsAddress[]>;
  httpRequest: typeof httpRequest;
  httpsRequest: typeof httpsRequest;
}

export function createPinnedLookup(selected: DnsAddress): typeof dnsLookup {
  return ((
    _hostname: string,
    options: unknown,
    callback: (...args: unknown[]) => void,
  ) => {
    const all =
      typeof options === 'object' &&
      options !== null &&
      'all' in options &&
      (options as { all?: boolean }).all === true;
    if (all) {
      callback(null, [{ address: selected.address, family: selected.family }]);
    } else {
      callback(null, selected.address, selected.family);
    }
  }) as typeof dnsLookup;
}

const defaultDependencies: DevFetchDependencies = {
  lookup: (hostname) =>
    new Promise((resolve, reject) => {
      dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) =>
        error ? reject(error) : resolve(addresses as DnsAddress[]),
      );
    }),
  httpRequest,
  httpsRequest,
};

export function validateRequestBoundary(
  req: IncomingMessage,
  port: number,
  privileged = true,
): string | null {
  const liveOrigin = `http://${DEV_SERVER_HOST}:${port}`;
  if (req.headers.host?.toLowerCase() !== `${DEV_SERVER_HOST}:${port}`) {
    return 'invalid_host';
  }
  if (!privileged) return null;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).origin !== liveOrigin || origin !== liveOrigin) {
        return 'invalid_origin';
      }
    } catch {
      return 'invalid_origin';
    }
  }
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'none' && site !== 'same-origin')
    return 'cross_site_request';
  return null;
}

export function isCanonicalPathContained(
  target: string,
  root: string,
): boolean {
  const rel = relative(root, target);
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  );
}

export async function readJsonBody(
  req: IncomingMessage,
  allowEmpty = true,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: DevHttpError) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw && allowEmpty) return resolve({});
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('object required');
          }
          resolve(parsed);
        } catch {
          reject(new DevHttpError(400, 'invalid_json'));
        }
      }
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_JSON_BODY_BYTES) {
        chunks.length = 0;
        finish(new DevHttpError(413, 'body_too_large'));
        req.resume();
      } else chunks.push(buffer);
    };
    const onEnd = () => finish();
    const onError = () => finish(new DevHttpError(400, 'body_read_error'));
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onError);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onError);
  });
}

function ipv4Number(address: string): number {
  return (
    address
      .split('.')
      .reduce((value, octet) => value * 256 + Number(octet), 0) >>> 0
  );
}

function inV4Range(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

const deniedV4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function parseIpv6(rawAddress: string): bigint | null {
  const address = rawAddress.toLowerCase().split('%')[0];
  if (isIP(address) !== 6) return null;
  let normalized = address;
  const dottedTail = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dottedTail) {
    const value = ipv4Number(dottedTail);
    normalized = `${normalized.slice(0, -dottedTail.length)}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [
    ...left,
    ...Array(halves.length === 2 ? missing : 0).fill('0'),
    ...right,
  ];
  if (groups.length !== 8) return null;
  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(`0x${group || '0'}`),
    0n,
  );
}

function ipv6Prefix(base: string, bits: number): [bigint, number] {
  const value = parseIpv6(base);
  if (value === null) throw new Error(`Invalid internal IPv6 prefix: ${base}`);
  return [value, bits];
}

function inV6Range(value: bigint, [base, bits]: [bigint, number]): boolean {
  const shift = BigInt(128 - bits);
  return value >> shift === base >> shift;
}

const globalV6 = ipv6Prefix('2000::', 3);
const deniedV6 = [
  ipv6Prefix('2001::', 32),
  ipv6Prefix('2001:2::', 48),
  ipv6Prefix('2001:10::', 28),
  ipv6Prefix('2001:20::', 28),
  ipv6Prefix('2001:db8::', 32),
  ipv6Prefix('2002::', 16),
];

export function isPublicIp(rawAddress: string): boolean {
  if (rawAddress.includes('%')) return false;
  const address = rawAddress.toLowerCase().split('%')[0];
  const family = isIP(address);
  if (family === 4)
    return !deniedV4.some(([base, bits]) => inV4Range(address, base, bits));
  const value = parseIpv6(address);
  if (value === null) return false;
  if (value >> 32n === 0xffffn) {
    const mapped = Number(value & 0xffffffffn);
    const ipv4 = `${mapped >>> 24}.${(mapped >>> 16) & 0xff}.${(mapped >>> 8) & 0xff}.${mapped & 0xff}`;
    return isPublicIp(ipv4);
  }
  return (
    inV6Range(value, globalV6) &&
    !deniedV6.some((prefix) => inV6Range(value, prefix))
  );
}

export async function resolvePublicAddress(
  hostname: string,
  dependencies: DevFetchDependencies = defaultDependencies,
): Promise<DnsAddress> {
  const normalizedHostname =
    hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
  const literalFamily = isIP(normalizedHostname);
  const answers = literalFamily
    ? [{ address: normalizedHostname, family: literalFamily as 4 | 6 }]
    : await dependencies.lookup(normalizedHostname);
  if (
    !answers.length ||
    answers.some(
      ({ address, family }) =>
        isIP(address.toLowerCase().split('%')[0]) !== family ||
        !isPublicIp(address),
    )
  ) {
    throw new DevHttpError(403, 'disallowed_target');
  }
  return answers[0];
}

const strippedHeaders = new Set([
  'host',
  'connection',
  'proxy-connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'cookie',
  'authorization',
  'proxy-authenticate',
  'proxy-authorization',
  'content-length',
  'accept-encoding',
]);

export function sanitizeProxyHeaders(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (!strippedHeaders.has(name.toLowerCase()) && typeof value === 'string')
      output[name] = value;
  }
  output['Accept-Encoding'] = 'identity';
  return output;
}

export interface ProxyRequestBody {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export async function proxyPublicHttp(
  input: ProxyRequestBody,
  dependencies: DevFetchDependencies = defaultDependencies,
) {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.url !== 'string' ||
    !input.url
  ) {
    throw new DevHttpError(400, 'invalid_request');
  }
  if (
    input.method !== undefined &&
    (typeof input.method !== 'string' ||
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(input.method))
  ) {
    throw new DevHttpError(400, 'invalid_method');
  }
  if (input.headers !== undefined) {
    if (
      !input.headers ||
      typeof input.headers !== 'object' ||
      Array.isArray(input.headers)
    ) {
      throw new DevHttpError(400, 'invalid_headers');
    }
    for (const [name, value] of Object.entries(input.headers)) {
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        typeof value !== 'string' ||
        [...value].some((character) => {
          const code = character.charCodeAt(0);
          return code <= 31 || code === 127;
        })
      ) {
        throw new DevHttpError(400, 'invalid_headers');
      }
    }
  }
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new DevHttpError(400, 'invalid_url');
  }
  let method = (input.method || 'GET').toUpperCase();
  let body: string | undefined;
  try {
    if (input.body !== undefined) {
      if (
        typeof input.body === 'function' ||
        typeof input.body === 'symbol' ||
        typeof input.body === 'bigint'
      ) {
        throw new Error('unsupported body');
      }
      body =
        typeof input.body === 'string'
          ? input.body
          : JSON.stringify(input.body);
      if (body === undefined) throw new Error('unsupported body');
    }
  } catch {
    throw new DevHttpError(400, 'invalid_body');
  }
  let headers = sanitizeProxyHeaders(input.headers);

  for (let redirects = 0; ; redirects += 1) {
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new DevHttpError(403, 'disallowed_target');
    }
    const deadline = Date.now() + FETCH_TIMEOUT_MS;
    const selected = await withDeadline(
      resolvePublicAddress(url.hostname, dependencies),
      deadline,
    );
    const response = await requestHop(
      url,
      method,
      headers,
      body,
      selected,
      dependencies,
      deadline,
    );
    if (
      [301, 302, 303, 307, 308].includes(response.status) &&
      response.location
    ) {
      if (redirects >= MAX_FETCH_REDIRECTS)
        throw new DevHttpError(502, 'too_many_redirects');
      try {
        url = new URL(response.location, url);
      } catch {
        throw new DevHttpError(502, 'invalid_redirect');
      }
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          method === 'POST')
      ) {
        method = method === 'HEAD' ? 'HEAD' : 'GET';
        body = undefined;
        headers = Object.fromEntries(
          Object.entries(headers).filter(
            ([name]) =>
              !['content-type', 'content-length'].includes(name.toLowerCase()),
          ),
        );
      }
      continue;
    }
    return {
      success: true,
      status: response.status,
      contentType: response.contentType,
      body: response.body,
    };
  }
}

async function withDeadline<T>(
  promise: Promise<T>,
  deadline: number,
): Promise<T> {
  const remaining = Math.max(0, deadline - Date.now());
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new DevHttpError(504, 'upstream_timeout')),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requestHop(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  selected: DnsAddress,
  dependencies: DevFetchDependencies,
  deadline: number,
): Promise<{
  status: number;
  contentType: string;
  body: string;
  location?: string;
}> {
  return new Promise((resolve, reject) => {
    const factory =
      url.protocol === 'https:'
        ? dependencies.httpsRequest
        : dependencies.httpRequest;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let response: import('node:http').IncomingMessage | undefined;
    let req: ClientRequest | undefined;
    let onData: ((chunk: Buffer | string) => void) | undefined;
    let onEnd: (() => void) | undefined;
    let onResponseError: (() => void) | undefined;
    let onAborted: (() => void) | undefined;
    let onClose: (() => void) | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      req?.off('error', onRequestError);
      if (response) {
        if (onData) response.off('data', onData);
        if (onEnd) response.off('end', onEnd);
        if (onResponseError) response.off('error', onResponseError);
        if (onAborted) response.off('aborted', onAborted);
        if (onClose) response.off('close', onClose);
      }
    };
    const fail = (error: DevHttpError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (value: {
      status: number;
      contentType: string;
      body: string;
      location?: string;
    }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onRequestError = () => fail(new DevHttpError(502, 'upstream_error'));
    try {
      const requestOptions = {
        method,
        headers,
        lookup: createPinnedLookup(selected),
        ...(url.protocol === 'https:'
          ? {
              rejectUnauthorized: true,
              ...(isIP(url.hostname.replace(/^\[|\]$/g, '')) === 0
                ? { servername: url.hostname }
                : {}),
            }
          : {}),
      };
      req = factory(url, requestOptions, (res) => {
        response = res;
        const chunks: Buffer[] = [];
        let bytes = 0;
        let ended = false;
        const encoding = String(
          res.headers['content-encoding'] || 'identity',
        ).toLowerCase();
        if (encoding !== 'identity') {
          fail(new DevHttpError(502, 'unsupported_content_encoding'));
          res.once('error', () => {});
          res.destroy();
          return;
        }
        onData = (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > MAX_FETCH_RESPONSE_BYTES) {
            fail(new DevHttpError(502, 'response_too_large'));
            res.once('error', () => {});
            res.destroy();
            req?.destroy();
          } else chunks.push(buffer);
        };
        onEnd = () => {
          ended = true;
          succeed({
            status: res.statusCode || 502,
            contentType: String(res.headers['content-type'] || ''),
            location:
              typeof res.headers.location === 'string'
                ? res.headers.location
                : undefined,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        };
        onResponseError = () => fail(new DevHttpError(502, 'upstream_error'));
        onAborted = () => fail(new DevHttpError(502, 'upstream_error'));
        onClose = () => {
          if (!ended) fail(new DevHttpError(502, 'upstream_error'));
        };
        res.on('data', onData);
        res.on('end', onEnd);
        res.on('error', onResponseError);
        res.on('aborted', onAborted);
        res.on('close', onClose);
      });
    } catch {
      fail(new DevHttpError(502, 'upstream_error'));
      return;
    }
    if (settled) {
      req.destroy();
      return;
    }
    timer = setTimeout(
      () => {
        fail(new DevHttpError(504, 'upstream_timeout'));
        req?.destroy();
      },
      Math.max(0, deadline - Date.now()),
    );
    req.on('error', onRequestError);
    try {
      if (body !== undefined) req.write(body);
      req.end();
    } catch {
      fail(new DevHttpError(502, 'upstream_error'));
      req.destroy();
    }
  });
}
