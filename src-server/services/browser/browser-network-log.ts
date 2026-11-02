import type { CdpTransport } from './browser-host.js';

/** Network metadata is ephemeral, generation-scoped, and never includes bodies or headers. */
export interface BrowserNetworkEntry {
  seq: number;
  method: string;
  url: string;
  type: string;
  status?: number;
  bytes?: number;
  durationMs?: number;
  failed?: boolean;
}

const LIMIT = 500;
const URL_LIMIT = 2048;

interface NetworkEvent {
  requestId?: string;
  request?: { url?: string; method?: string };
  response?: { status?: number };
  type?: string;
  timestamp?: number;
  encodedDataLength?: number;
}

/** Do not retain credentials, fragments, or query values from untrusted pages. */
export function redactNetworkUrl(value: string): string {
  if (value.length > URL_LIMIT * 4) return '[URL too long]';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return '[non-http URL]';
    url.username = '';
    url.password = '';
    url.hash = '';
    if (url.search) url.search = '?[redacted]';
    return url.href.slice(0, URL_LIMIT);
  } catch {
    return '[invalid URL]';
  }
}

/** Retains only bounded metadata from one CDP target session. */
export class BrowserNetworkLog {
  private readonly entries: BrowserNetworkEntry[] = [];
  private readonly pending = new Map<
    string,
    { entry: BrowserNetworkEntry; started?: number }
  >();
  private readonly off: Array<() => void>;
  private seq = 0;
  private dropped = 0;
  private disposed = false;
  private enabled = false;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly cdp: CdpTransport,
    private readonly sessionId: string,
    private readonly previewEnabled: () => boolean = () => true,
  ) {
    const mine =
      (handle: (p: NetworkEvent) => void) =>
      (params: unknown, session?: string) => {
        if (
          this.disposed ||
          session !== sessionId ||
          !params ||
          typeof params !== 'object'
        )
          return;
        if (!this.previewEnabled()) {
          this.suspend();
          return;
        }
        handle(params as NetworkEvent);
      };
    this.off = [
      cdp.on(
        'Network.requestWillBeSent',
        mine((p) => {
          if (
            typeof p.requestId !== 'string' ||
            p.requestId.length > 256 ||
            typeof p.request?.url !== 'string'
          )
            return;
          const entry: BrowserNetworkEntry = {
            seq: ++this.seq,
            method:
              typeof p.request.method === 'string'
                ? p.request.method.slice(0, 20)
                : '',
            url: redactNetworkUrl(p.request.url),
            type: typeof p.type === 'string' ? p.type.slice(0, 40) : 'Other',
          };
          this.entries.push(entry);
          this.pending.set(p.requestId, {
            entry,
            started: typeof p.timestamp === 'number' ? p.timestamp : undefined,
          });
          while (this.entries.length > LIMIT) {
            const removed = this.entries.shift();
            this.dropped++;
            for (const [id, active] of this.pending)
              if (active.entry === removed) this.pending.delete(id);
          }
        }),
      ),
      cdp.on(
        'Network.responseReceived',
        mine((p) => {
          if (typeof p.requestId !== 'string') return;
          const active = this.pending.get(p.requestId);
          if (!active) return;
          if (
            typeof p.response?.status === 'number' &&
            Number.isFinite(p.response.status)
          )
            active.entry.status = p.response.status;
          if (typeof p.type === 'string')
            active.entry.type = p.type.slice(0, 40);
        }),
      ),
      cdp.on(
        'Network.loadingFinished',
        mine((p) => this.finish(p, false)),
      ),
      cdp.on(
        'Network.loadingFailed',
        mine((p) => this.finish(p, true)),
      ),
    ];
  }

  async enable(): Promise<void> {
    await this.stopping;
    if (this.enabled || this.disposed || !this.previewEnabled()) return;
    this.starting ??= this.cdp
      .send(
        'Network.enable',
        { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 },
        this.sessionId,
      )
      .then(async () => {
        if (this.disposed || !this.previewEnabled()) {
          await this.cdp
            .send('Network.disable', {}, this.sessionId)
            .catch(() => {});
          return;
        }
        this.enabled = true;
        this.timer = setInterval(() => {
          if (!this.previewEnabled()) this.suspend();
        }, 1000);
        this.timer.unref?.();
      })
      .finally(() => {
        this.starting = undefined;
      });
    await this.starting;
  }

  read(after = 0, limit = 100) {
    const entries = this.entries
      .filter((entry) => entry.seq > after)
      .slice(0, Math.max(1, Math.min(100, limit)));
    return {
      entries: entries.map((entry) => ({ ...entry })),
      dropped: this.dropped,
      latestSeq: this.seq,
    };
  }

  get capturing(): boolean {
    return this.enabled && !this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    this.suspend();
    for (const off of this.off) off();
  }

  private suspend(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.enabled) {
      const stop = this.cdp.send('Network.disable', {}, this.sessionId).then(
        () => {},
        () => {},
      );
      this.stopping = stop;
      void stop.finally(() => {
        if (this.stopping === stop) this.stopping = undefined;
      });
    }
    this.enabled = false;
    this.entries.length = 0;
    this.pending.clear();
  }

  private finish(p: NetworkEvent, failed: boolean): void {
    if (typeof p.requestId !== 'string') return;
    const active = this.pending.get(p.requestId);
    if (!active) return;
    if (failed) active.entry.failed = true;
    if (
      typeof p.encodedDataLength === 'number' &&
      Number.isFinite(p.encodedDataLength) &&
      p.encodedDataLength >= 0
    )
      active.entry.bytes = p.encodedDataLength;
    if (
      active.started !== undefined &&
      typeof p.timestamp === 'number' &&
      Number.isFinite(p.timestamp)
    )
      active.entry.durationMs = Math.max(
        0,
        (p.timestamp - active.started) * 1000,
      );
    this.pending.delete(p.requestId);
  }
}
