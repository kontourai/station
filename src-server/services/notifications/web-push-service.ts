/**
 * WebPushService — thin wrapper around the `web-push` package: signs and
 * sends a single Web Push message with Station's VAPID keypair.
 *
 * Deliberately dumb: it knows nothing about notifications, categories, or
 * paired devices. `web-push-delivery.ts` owns the fan-out/self-heal policy;
 * this class only classifies one send's outcome (sent/gone/error) so the
 * caller never has to inspect a `WebPushError` directly.
 */
import type { WebPushSubscription } from '@kontourai/station-contracts';
import webpush from 'web-push';
import type { VapidKeyPair } from './vapid-key-service.js';

export type WebPushSendResult = 'sent' | 'gone' | 'error';

export interface WebPushPayload {
  title: string;
  body?: string;
  category: string;
  notificationId: string;
  /** Deep link the service worker focuses-or-opens on tap. */
  url: string;
  apiBase?: string;
}

export class WebPushService {
  private readonly keys: VapidKeyPair;

  constructor(keys: VapidKeyPair, subject: string) {
    this.keys = keys;
    webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  }

  getPublicKey(): string {
    return this.keys.publicKey;
  }

  /**
   * Sends one push message. Never throws — a delivery failure (including a
   * 404/410 "this subscription is gone") is reported back as a result, never
   * an exception, so a single bad subscription can't take down a fan-out.
   *
   * `ttlSeconds` sets the Web Push protocol TTL header (RFC 8030) — how long
   * the push service should hold the message for an offline device before
   * giving up — sized per notification outcome (archive#1100 AC2,
   * `push-payload-composer.ts`). Omitted entirely when not provided so the
   * `web-push` library's own default applies.
   */
  async send(
    subscription: WebPushSubscription,
    payload: WebPushPayload,
    ttlSeconds?: number,
  ): Promise<WebPushSendResult> {
    try {
      await webpush.sendNotification(
        subscription,
        JSON.stringify(payload),
        ttlSeconds === undefined ? undefined : { TTL: ttlSeconds },
      );
      return 'sent';
    } catch (error) {
      const statusCode =
        error instanceof webpush.WebPushError ? error.statusCode : undefined;
      if (statusCode === 404 || statusCode === 410) return 'gone';
      return 'error';
    }
  }
}
