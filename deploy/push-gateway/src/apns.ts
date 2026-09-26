// APNs sender for Live Activities over iOS 18 broadcast channels.
//
// Each activity gets its own channel, created here as part of its start: the
// start is a push-to-start sent to one device naming that channel, and every
// update and end is a broadcast to it, so no per-activity token ever leaves
// the phone. Channels are created and deleted on Apple's separate management
// hosts. Channels do not expire and Apple caps how many an app may hold, so a
// channel whose start Apple refused is deleted before answering.

import type { ApnsEnvironment, LiveActivityRequest } from './apns-request.ts';
import { isApnsChannelId, livePriority } from './apns-request.ts';
import { type ApnsCredentials, providerToken } from './apns-token.ts';

const REQUEST_TIMEOUT_MS = 10_000;
/** A stored activity push older than this is worthless: drop it. */
const EXPIRATION_SECONDS = 300;

// Apple's reasons for a token that will never deliver again.
const UNREGISTERED_REASONS = new Set([
  'Unregistered',
  'BadDeviceToken',
  'DeviceTokenNotForTopic',
]);
// A channel that no longer exists. Verified against the sandbox 2026-09-24:
// a broadcast to a deleted channel answers 400 ChannelNotRegistered, to an id
// that never existed 400 BadChannelId. Mapped by reason, whatever the status.
const CHANNEL_GONE_REASONS = new Set(['BadChannelId', 'ChannelNotRegistered']);
// The app id lacks a capability the gateway needs (verified 2026-09-24: a
// channel create for a bundle without broadcast answers 400
// BroadcastFeatureNotEnabled). The gateway's configuration, not the Station's
// request, is wrong: retryable for the caller, logged for the operator.
const GATEWAY_CONFIG_REASONS = new Set(['BroadcastFeatureNotEnabled']);

export type ApnsFailure =
  /** The push-to-start token no longer reaches an install. */
  | { kind: 'unregistered' }
  /** The broadcast channel is gone; the Station must start afresh. */
  | { kind: 'channel-gone' }
  | { kind: 'rejected'; status: number }
  | { kind: 'unavailable'; status: number };

export type ApnsOutcome = { kind: 'sent' } | { kind: 'deleted' } | ApnsFailure;

/** What a start needs from its caller besides Apple. */
export interface StartHooks {
  /** Records a newly created channel; a throw abandons the start. */
  record(channelId: string): Promise<void>;
  /** Forgets a channel the start gave back. */
  forget(channelId: string): Promise<void>;
  /** Runs work past the response (the Worker's ctx.waitUntil). */
  defer(work: Promise<unknown>): void;
}
type Failure = ApnsFailure;

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
  return typeof body?.reason === 'string'
    ? body.reason.slice(0, 64)
    : undefined;
}

export class ApnsSender {
  private readonly credentials: ApnsCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    credentials: ApnsCredentials,
    // Workers throws "Illegal invocation" when fetch is called as a method of
    // another object, so the default must be a wrapper, not the bare global.
    fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    now: () => number = () => Math.floor(Date.now() / 1000),
    timeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Creates the activity's channel, records it in the ledger, then sends the
   * push-to-start naming it. `bodyFor` builds the APNs body for the new
   * channel (null: too large).
   */
  async start(
    request: LiveActivityRequest,
    bodyFor: (channelId: string) => Uint8Array<ArrayBuffer> | null,
    hooks: StartHooks,
  ): Promise<{ kind: 'started'; channelId: string } | Failure> {
    const created = await this.createChannel(
      request.bundleId,
      request.environment,
    );
    if (created.kind !== 'created') return created;
    const { channelId } = created;
    const channel = {
      bundleId: request.bundleId,
      environment: request.environment,
      channelId,
    };

    // An unrecorded channel would be swept from under a live activity, so a
    // start whose channel cannot be recorded does not go ahead.
    try {
      await hooks.record(channelId);
    } catch {
      console.error('apns channel ledger write failed; start abandoned');
      hooks.defer(this.giveBack(channel, hooks));
      return { kind: 'unavailable', status: 503 };
    }

    const body = bodyFor(channelId);
    const outcome = body
      ? await this.push(
          `${pushHost(request.environment)}/3/device/${request.pushToStartToken}`,
          {
            ...this.liveHeaders(request),
            'apns-topic': `${request.bundleId}.push-type.liveactivity`,
          },
          body,
          true,
        )
      : ({ kind: 'rejected', status: 413 } as const);
    if (outcome.kind === 'sent') return { kind: 'started', channelId };

    // Nothing will ever listen on this channel: give the quota back. A start
    // that timed out may have been delivered; the Station starts afresh
    // either way, and the phone ends an older activity for the same
    // registration when it launches. Deferred past the response, so a caller
    // that disconnects cannot cancel it; if it fails anyway, the sweep
    // reclaims the channel once its ledger entry expires.
    hooks.defer(this.giveBack(channel, hooks));
    return outcome;
  }

  private async giveBack(
    channel: {
      bundleId: string;
      environment: ApnsEnvironment;
      channelId: string;
    },
    hooks: StartHooks,
  ): Promise<void> {
    const deleted = await this.deleteChannel(
      channel.bundleId,
      channel.environment,
      channel.channelId,
    );
    if (deleted.kind === 'deleted')
      await hooks.forget(channel.channelId).catch(() => {
        console.error('apns channel ledger forget failed');
      });
    else
      console.error(
        `apns channel left behind after a refused start (${deleted.kind})`,
      );
  }

  /**
   * The ids of every channel Apple holds for this app and environment, or
   * null when they cannot be read. Response shape verified 2026-09-24 as
   * {"channels":[...]}; the element shape and any paging are not.
   */
  async listChannels(
    bundleId: string,
    environment: ApnsEnvironment,
  ): Promise<string[] | null> {
    const response = await this.call(
      `${manageHost(environment)}/1/apps/${bundleId}/all-channels`,
      'GET',
      {},
    );
    if (!response?.ok) {
      const reason = response ? await reasonOf(response) : 'unreachable';
      console.error(
        `apns channel list failed for ${environment}:${bundleId}: ${response?.status ?? ''} ${reason ?? ''}`.trim(),
      );
      return null;
    }
    const body = (await response.json().catch(() => null)) as {
      channels?: unknown;
    } | null;
    if (!Array.isArray(body?.channels)) return null;
    // Paging is unverified. Extra keys (a cursor?) or a suspiciously round
    // length suggest a partial list; say so, since channels past a page are
    // never swept.
    const extra = Object.keys(body).filter((key) => key !== 'channels');
    const count = body.channels.length;
    if (extra.length > 0 || (count >= 1000 && count % 100 === 0))
      console.error(
        `apns channel list for ${environment}:${bundleId} may be paged: ${count} channels, extra keys [${extra.join(',').slice(0, 128)}]`,
      );
    const ids: string[] = [];
    for (const entry of body.channels) {
      const id =
        typeof entry === 'string'
          ? entry
          : entry && typeof entry === 'object'
            ? ((entry as Record<string, unknown>)['apns-channel-id'] ??
              (entry as Record<string, unknown>).channelId ??
              (entry as Record<string, unknown>)['channel-id'])
            : undefined;
      // An entry this code cannot read is left alone, never deleted.
      if (isApnsChannelId(id)) ids.push(id);
    }
    return ids;
  }

  /** Update or end: a broadcast to the activity's channel. */
  async broadcast(
    request: LiveActivityRequest,
    body: Uint8Array<ArrayBuffer>,
  ): Promise<{ kind: 'sent' } | Failure> {
    return this.push(
      `${pushHost(request.environment)}/4/broadcasts/apps/${request.bundleId}`,
      // Broadcasts are addressed by channel and need no apns-topic; Apple
      // refuses one without apns-expiration (400 BadExpirationDate), which
      // liveHeaders always sets. Both verified 2026-09-24.
      {
        ...this.liveHeaders(request),
        'apns-channel-id': request.channelId ?? '',
      },
      body,
      false,
    );
  }

  async deleteChannel(
    bundleId: string,
    environment: ApnsEnvironment,
    channelId: string,
  ): Promise<{ kind: 'deleted' } | Failure> {
    const response = await this.call(
      `${manageHost(environment)}/1/apps/${bundleId}/channels`,
      'DELETE',
      { 'apns-channel-id': channelId },
    );
    if (!response) return { kind: 'unavailable', status: 504 };
    if (response.ok) return { kind: 'deleted' };
    const outcome = await this.failure(response, 'delete');
    // Deleting a channel Apple says it does not have is what the caller wanted.
    return outcome.kind === 'channel-gone' ? { kind: 'deleted' } : outcome;
  }

  private async createChannel(
    bundleId: string,
    environment: ApnsEnvironment,
  ): Promise<{ kind: 'created'; channelId: string } | Failure> {
    const response = await this.call(
      `${manageHost(environment)}/1/apps/${bundleId}/channels`,
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
    if (!response.ok) return this.failure(response, 'channel');
    const channelId = response.headers.get('apns-channel-id');
    if (!channelId || !isApnsChannelId(channelId)) {
      console.error('apns channel create returned no usable channel id');
      return { kind: 'unavailable', status: 502 };
    }
    return { kind: 'created', channelId };
  }

  private liveHeaders(request: LiveActivityRequest): Record<string, string> {
    return {
      'apns-push-type': 'liveactivity',
      'apns-priority': String(livePriority(request)),
      'apns-expiration': String(this.now() + EXPIRATION_SECONDS),
      'content-type': 'application/json',
    };
  }

  private async push(
    url: string,
    headers: Record<string, string>,
    body: Uint8Array<ArrayBuffer>,
    deviceAddressed: boolean,
  ): Promise<{ kind: 'sent' } | Failure> {
    const response = await this.call(url, 'POST', headers, body);
    if (!response) return { kind: 'unavailable', status: 504 };
    if (response.ok) return { kind: 'sent' };
    return this.failure(response, deviceAddressed ? 'device' : 'channel');
  }

  private async call(
    url: string,
    method: 'GET' | 'POST' | 'DELETE',
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
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch(() => null);
  }

  /**
   * Mapped by Apple's reason; a bare status only decides retryability.
   * `target` is what the request addressed: a device (push-to-start), a
   * channel (create or broadcast), or a channel being deleted.
   */
  private async failure(
    response: Response,
    target: 'device' | 'channel' | 'delete',
  ): Promise<Failure> {
    const reason = await reasonOf(response);
    const { status } = response;
    if (reason && CHANNEL_GONE_REASONS.has(reason))
      return { kind: 'channel-gone' };
    // Verified 2026-09-24: deleting an unknown or already-deleted channel
    // answers 404 BadPath, not BadChannelId. The path is a constant this code
    // builds, and a genuinely wrong one would already fail every create and
    // start, so on a delete it means the channel is gone.
    if (target === 'delete' && status === 404 && reason === 'BadPath')
      return { kind: 'channel-gone' };
    if (target === 'device' && reason && UNREGISTERED_REASONS.has(reason))
      return { kind: 'unregistered' };
    if (reason && GATEWAY_CONFIG_REASONS.has(reason)) {
      console.error(`apns ${status} (gateway configuration fault): ${reason}`);
      return { kind: 'unavailable', status: 503 };
    }
    if (status === 403 || status === 429) {
      // A provider-token, key or throttling problem is the gateway's own, not
      // the Station's: retryable for the caller, the reason stays in the log.
      console.error(`apns ${status} (gateway fault): ${reason ?? 'no reason'}`);
      return { kind: 'unavailable', status: 503 };
    }
    if (status >= 500) return { kind: 'unavailable', status };
    if (status === 404)
      // Not evidence the channel is gone: a wrong path or host answers 404 too.
      console.error(`apns 404 with unrecognised reason: ${reason ?? 'none'}`);
    return { kind: 'rejected', status };
  }
}
