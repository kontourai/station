// APNs sender for Live Activities over iOS 18 broadcast channels.
//
// A start is a push-to-start sent to one device and names the channel the new
// activity listens on; every update and end is a broadcast to that channel,
// so no per-activity token ever leaves the phone. Channels are created and
// deleted on Apple's separate management hosts.

import type {
  ApnsEnvironment,
  ChannelRequest,
  LiveActivityRequest,
} from './apns-request.ts';
import { livePriority } from './apns-request.ts';
import { type ApnsCredentials, providerToken } from './apns-token.ts';

const REQUEST_TIMEOUT_MS = 10_000;
/** A stored activity push older than this is worthless: drop it. */
const EXPIRATION_SECONDS = 300;
const CHANNEL_ID = /^[A-Za-z0-9+/]{4,128}={0,2}$/;

// Apple's reasons for a token that will never deliver again.
const UNREGISTERED_REASONS = new Set([
  'Unregistered',
  'BadDeviceToken',
  'DeviceTokenNotForTopic',
]);
// A channel that no longer exists (UNVERIFIED: names from Apple's broadcast
// documentation, not yet observed live).
const CHANNEL_GONE_REASONS = new Set(['BadChannelId', 'ChannelNotRegistered']);

export type ApnsOutcome =
  | { kind: 'sent' }
  | { kind: 'created'; channelId: string }
  | { kind: 'deleted' }
  /** The push-to-start token no longer reaches an install. */
  | { kind: 'unregistered' }
  /** The broadcast channel is gone; the Station must create another. */
  | { kind: 'channel-gone' }
  | { kind: 'rejected'; status: number }
  | { kind: 'unavailable'; status: number };

const pushHost = (environment: ApnsEnvironment) =>
  environment === 'production'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com';

const manageHost = (environment: ApnsEnvironment) =>
  environment === 'production'
    ? 'https://api-manage-broadcast.push.apple.com:2196'
    : 'https://api-manage-broadcast.sandbox.push.apple.com:2195';

async function reasonOf(response: Response): Promise<string | undefined> {
  const body = (await response.json().catch(() => null)) as {
    reason?: unknown;
  } | null;
  return typeof body?.reason === 'string' ? body.reason : undefined;
}

export class ApnsSender {
  private readonly credentials: ApnsCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    credentials: ApnsCredentials,
    // Workers throws "Illegal invocation" when fetch is called as a method of
    // another object, so the default must be a wrapper, not the bare global.
    fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async sendLiveActivity(
    request: LiveActivityRequest,
    body: Uint8Array<ArrayBuffer>,
  ): Promise<ApnsOutcome> {
    const headers: Record<string, string> = {
      'apns-push-type': 'liveactivity',
      'apns-priority': String(livePriority(request)),
      'apns-expiration': String(this.now() + EXPIRATION_SECONDS),
      'content-type': 'application/json',
    };
    let url: string;
    if (request.event === 'start') {
      url = `${pushHost(request.environment)}/3/device/${request.pushToStartToken}`;
      headers['apns-topic'] = `${request.bundleId}.push-type.liveactivity`;
    } else {
      // Broadcasts are addressed by channel; no apns-topic (UNVERIFIED).
      url = `${pushHost(request.environment)}/4/broadcasts/apps/${request.bundleId}`;
      headers['apns-channel-id'] = request.channelId;
    }
    const response = await this.call(url, 'POST', headers, body);
    if (!response) return { kind: 'unavailable', status: 504 };
    if (response.ok) return { kind: 'sent' };
    return this.failure(response, request.event === 'start');
  }

  async manageChannel(request: ChannelRequest): Promise<ApnsOutcome> {
    const url = `${manageHost(request.environment)}/1/apps/${request.bundleId}/channels`;
    if (request.op === 'create') {
      const response = await this.call(
        url,
        'POST',
        { 'content-type': 'application/json' },
        new TextEncoder().encode(
          JSON.stringify({
            'message-storage-policy': 1,
            'push-type': 'LiveActivity',
          }),
        ),
      );
      if (!response) return { kind: 'unavailable', status: 504 };
      if (!response.ok) return this.failure(response, false);
      const channelId = response.headers.get('apns-channel-id');
      if (!channelId || !CHANNEL_ID.test(channelId)) {
        console.error('apns channel create returned no usable channel id');
        return { kind: 'unavailable', status: 502 };
      }
      return { kind: 'created', channelId };
    }
    const response = await this.call(url, 'DELETE', {
      'apns-channel-id': request.channelId,
    });
    if (!response) return { kind: 'unavailable', status: 504 };
    // Deleting a channel Apple no longer has is the outcome the caller wanted.
    if (response.ok || response.status === 404) return { kind: 'deleted' };
    const outcome = await this.failure(response, false);
    return outcome.kind === 'channel-gone' ? { kind: 'deleted' } : outcome;
  }

  private async call(
    url: string,
    method: 'POST' | 'DELETE',
    headers: Record<string, string>,
    body?: Uint8Array<ArrayBuffer>,
  ): Promise<Response | null> {
    let token: string;
    try {
      token = await providerToken(this.credentials, this.now());
    } catch (error) {
      console.error(
        'apns provider token unavailable (configuration fault):',
        error instanceof Error ? error.message : 'unknown error',
      );
      // Classified like an APNs outage: retryable for the caller.
      return new Response(null, { status: 503 });
    }
    return this.fetchImpl(url, {
      method,
      headers: { authorization: `bearer ${token}`, ...headers },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => null);
  }

  private async failure(
    response: Response,
    deviceAddressed: boolean,
  ): Promise<ApnsOutcome> {
    const reason = await reasonOf(response);
    if (reason && CHANNEL_GONE_REASONS.has(reason))
      return { kind: 'channel-gone' };
    if (deviceAddressed) {
      if (
        response.status === 410 ||
        (reason && UNREGISTERED_REASONS.has(reason))
      )
        return { kind: 'unregistered' };
    } else if (response.status === 404 || response.status === 410) {
      return { kind: 'channel-gone' };
    }
    if (response.status === 403) {
      // A provider-token or key problem is ours, not the Station's: retryable
      // for the caller, and the reason stays in the gateway's log.
      console.error(
        `apns refused the provider token (configuration fault): ${reason ?? 'no reason'}`,
      );
      return { kind: 'unavailable', status: 503 };
    }
    if (response.status === 429 || response.status >= 500)
      return { kind: 'unavailable', status: response.status };
    return { kind: 'rejected', status: response.status };
  }
}
