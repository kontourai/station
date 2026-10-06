import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { isAbsolute } from 'node:path';
import type { RelayIceServerV1 } from '@kontourai/station-contracts/relay-ice';
import {
  type BrokerIcePolicy,
  BrokerIceService,
  type BrokerTurnProvider,
} from './broker-ice-service.js';

const MAX_RESPONSE_BYTES = 16 * 1024;

/** The long-lived issuer is host-owned. Only end-user credentials leave this adapter. */
export class CloudflareTurnProvider implements BrokerTurnProvider {
  readonly #url: string;
  readonly #apiToken: string;
  constructor(
    keyId: string,
    apiToken: string,
    private readonly request: typeof fetch = fetch,
  ) {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/u.test(keyId) ||
      !/^[\x21-\x7e]{16,8192}$/u.test(apiToken)
    )
      throw new Error('ice_provider_config_invalid');
    this.#apiToken = apiToken;
    this.#url = `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`;
  }
  async issue(input: {
    ttlSeconds: number;
    usageKey: string;
    signal: AbortSignal;
  }): Promise<readonly RelayIceServerV1[]> {
    if (
      !Number.isInteger(input.ttlSeconds) ||
      input.ttlSeconds < 120 ||
      input.ttlSeconds > 600 ||
      !/^[a-f0-9]{64}$/u.test(input.usageKey)
    )
      throw new Error('ice_provider_request_invalid');
    input.signal.throwIfAborted();
    const response = await this.request(this.#url, {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: input.signal,
      headers: {
        Authorization: `Bearer ${this.#apiToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Station-Relay/0.1',
      },
      body: JSON.stringify({
        ttl: input.ttlSeconds,
        customIdentifier: input.usageKey,
      }),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error('ice_provider_unavailable');
    }
    const reader = response.body.getReader();
    const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
    let length = 0;
    let chunks = 0;
    const aborted = () => {
      void reader.cancel().catch(() => {});
    };
    input.signal.addEventListener('abort', aborted, { once: true });
    try {
      for (;;) {
        input.signal.throwIfAborted();
        const part = await reader.read();
        input.signal.throwIfAborted();
        if (part.done) break;
        if (
          ++chunks > 1024 ||
          length + part.value.byteLength > bytes.byteLength
        )
          throw new Error('ice_provider_response_invalid');
        bytes.set(part.value, length);
        length += part.value.byteLength;
      }
    } finally {
      input.signal.removeEventListener('abort', aborted);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const raw: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(0, length),
      ),
    );
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).join(',') !== 'iceServers'
    )
      throw new Error('ice_provider_response_invalid');
    const servers = (raw as { iceServers: unknown }).iceServers;
    if (!Array.isArray(servers) || servers.length > 8)
      throw new Error('ice_provider_response_invalid');
    const result: RelayIceServerV1[] = [];
    for (const server of servers) {
      if (!server || typeof server !== 'object' || Array.isArray(server))
        throw new Error('ice_provider_response_invalid');
      const urls =
        typeof server.urls === 'string' ? [server.urls] : server.urls;
      if (
        !Array.isArray(urls) ||
        urls.length < 1 ||
        urls.length > 8 ||
        !urls.every((url) => typeof url === 'string')
      )
        throw new Error('ice_provider_response_invalid');
      const relayUrls = urls.filter((url: string) => !url.startsWith('stun:'));
      if (relayUrls.length === 0) continue;
      if (
        Object.keys(server).sort().join(',') !== 'credential,urls,username' ||
        typeof server.username !== 'string' ||
        typeof server.credential !== 'string'
      )
        throw new Error('ice_provider_response_invalid');
      result.push({
        urls: relayUrls,
        username: server.username,
        credential: server.credential,
      });
    }
    return result;
  }
}

/** Private operator config is never an API request or renderer setting. */
export function loadCloudflareBrokerIce(file: string): BrokerIceService {
  if (!isAbsolute(file) || process.getuid === undefined)
    throw new Error('ice_provider_config_invalid');
  const link = lstatSync(file);
  let fd: number | undefined;
  let raw: unknown;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      link.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 ||
      info.dev !== link.dev ||
      info.ino !== link.ino ||
      info.size > 16 * 1024
    )
      throw new Error('ice_provider_config_invalid');
    const buffer = Buffer.alloc(16 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > 16 * 1024) throw new Error('ice_provider_config_invalid');
    raw = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, length),
      ),
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !==
      'apiToken,keyId,ledgerPath,policy,version'
  )
    throw new Error('ice_provider_config_invalid');
  const config = raw as Record<string, unknown>;
  if (
    config.version !== 'station-broker-cloudflare-turn/v1' ||
    typeof config.keyId !== 'string' ||
    typeof config.apiToken !== 'string' ||
    typeof config.ledgerPath !== 'string' ||
    !config.policy ||
    typeof config.policy !== 'object' ||
    Array.isArray(config.policy) ||
    Object.keys(config.policy).sort().join(',') !==
      'maxAttemptsPerDay,maxAttemptsPerSubject,maxConcurrent,ttlSeconds'
  )
    throw new Error('ice_provider_config_invalid');
  return new BrokerIceService(
    config.ledgerPath,
    new CloudflareTurnProvider(config.keyId, config.apiToken),
    config.policy as BrokerIcePolicy,
  );
}
