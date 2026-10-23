import { randomUUID } from 'node:crypto';
import type { Server } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import {
  type CiaoService,
  getResponder,
  type Responder,
} from '@homebridge/ciao';
import type {
  AppConfig,
  LanDiscoveryStatus,
} from '@kontourai/station-contracts/config';

const controllers = new WeakMap<object, LanDiscovery>();

/** One owner shared by the API listener and its authorized configuration route. */
export function lanDiscoveryFor(owner: object): LanDiscovery {
  let controller = controllers.get(owner);
  if (!controller) {
    controller = new LanDiscovery();
    controllers.set(owner, controller);
  }
  return controller;
}

export class LanDiscovery {
  private enabled = false;
  private generation = 0;
  private listener?: Server;
  private queue: Promise<void> = Promise.resolve();
  private publication?: { responder: Responder; service?: CiaoService };
  private timer?: ReturnType<typeof setTimeout>;
  private networkTimer?: ReturnType<typeof setInterval>;
  private networkKey = '';
  private status: LanDiscoveryStatus = {
    state: 'disabled',
    message: 'Nearby discovery is off.',
  };
  private readonly name = `Station ${hostname()
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .slice(0, 24)} ${randomUUID().slice(0, 8)}`;

  snapshot(): LanDiscoveryStatus {
    return { ...this.status };
  }

  configure(config: Pick<AppConfig, 'lanDiscoveryEnabled'>): Promise<void> {
    const enabled = config.lanDiscoveryEnabled === true;
    if (enabled === this.enabled) return this.queue;
    this.enabled = enabled;
    return this.reconcile();
  }

  bound(listener: Server): Promise<void> {
    this.listener = listener;
    listener.once('close', () => {
      if (this.listener === listener) void this.stop();
    });
    clearInterval(this.networkTimer);
    this.networkTimer = setInterval(() => {
      if (
        this.enabled &&
        JSON.stringify(this.lanInterfaces()) !== this.networkKey
      )
        void this.reconcile();
    }, 5000);
    this.networkTimer.unref();
    return this.reconcile();
  }

  stop(): Promise<void> {
    this.listener = undefined;
    clearInterval(this.networkTimer);
    return this.reconcile();
  }

  private lanInterfaces(): Array<{ name: string; address: string }> {
    const bound = this.listener?.address();
    if (!bound || typeof bound === 'string') return [];
    return Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
      (entries ?? [])
        .filter(
          (entry) =>
            !entry.internal &&
            entry.family === 'IPv4' &&
            (entry.address.startsWith('10.') ||
              entry.address.startsWith('192.168.') ||
              /^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)) &&
            (bound.address === '0.0.0.0' || bound.address === entry.address),
        )
        .map((entry) => ({ name, address: entry.address })),
    );
  }

  private reconcile(): Promise<void> {
    const generation = ++this.generation;
    this.status = {
      state: 'starting',
      message: this.enabled
        ? 'Updating nearby discovery…'
        : 'Stopping nearby discovery…',
    };
    this.queue = this.queue
      .then(async () => {
        await this.cleanup();
        if (generation !== this.generation) return;
        if (!this.enabled) {
          this.status = {
            state: 'disabled',
            message: 'Nearby discovery is off.',
          };
          return;
        }
        this.networkKey = JSON.stringify(this.lanInterfaces());
        const bound = this.listener?.address();
        if (!bound || typeof bound === 'string') {
          this.status = {
            state: 'unavailable',
            message:
              'The Station listener is not running. Start Station to advertise it.',
          };
          return;
        }
        if (bound.address === '::1' || bound.address.startsWith('127.')) {
          this.status = {
            state: 'loopback-only',
            message:
              'Station listens only on this computer. Configure a LAN listener before enabling nearby discovery.',
          };
          return;
        }
        const interfaces = this.lanInterfaces();
        this.networkKey = JSON.stringify(interfaces);
        if (!interfaces.length) {
          this.status = {
            state: 'unavailable',
            message:
              'No reachable private IPv4 interface matches the Station listener. Check the LAN connection and listener address.',
          };
          return;
        }
        const addresses = interfaces.map((entry) => entry.address);
        // Names scope the responder's sockets; exact addresses scope its service
        // records. Neither assumes that an IPv6 wildcard accepts IPv4 traffic.
        const responder = getResponder({
          interface: [...new Set(interfaces.map((entry) => entry.name))],
          advertiseIpv6: false,
          disableIpv6: true,
          excludeIpv6Only: true,
        });
        const publication: NonNullable<typeof this.publication> = { responder };
        this.publication = publication;
        const service = responder.createService({
          name: this.name,
          type: 'station',
          port: bound.port,
          restrictedAddresses: addresses,
          disabledIpv6: true,
          txt: { v: '1', transport: 'http' },
        });
        publication.service = service;
        let failedPublication = false;
        const failed = () => {
          if (generation !== this.generation || failedPublication) return;
          failedPublication = true;
          this.status = {
            state: 'unavailable',
            message:
              'Local multicast publication failed. Check network permissions and toggle discovery to retry.',
          };
          this.queue = this.queue.then(() => this.cleanup());
        };
        this.status = {
          state: 'starting',
          message: 'Publishing nearby discovery…',
        };
        this.timer = setTimeout(failed, 8000);
        this.timer.unref();
        // The pinned patch makes this promise witness completed announcement
        // sends, rather than merely entering Ciao's ANNOUNCING state.
        void service.advertise().then(() => {
          if (
            generation !== this.generation ||
            failedPublication ||
            this.publication !== publication
          )
            return;
          if (JSON.stringify(this.lanInterfaces()) !== this.networkKey) {
            void this.reconcile();
            return;
          }
          clearTimeout(this.timer);
          this.status = {
            state: 'published',
            message: 'Advertising on this local network.',
            serviceName: service.getFQDN().split('._station.')[0],
            port: bound.port,
            addresses,
          };
        }, failed);
      })
      .catch(() => {
        if (generation !== this.generation) return;
        this.status = {
          state: 'unavailable',
          message:
            'Nearby discovery could not start. Toggle it off and on to retry.',
        };
        return this.cleanup();
      });
    return this.queue;
  }

  private async cleanup(): Promise<void> {
    clearTimeout(this.timer);
    const publication = this.publication;
    this.publication = undefined;
    if (!publication) return;
    // Withdraw this owner's service before releasing a potentially shared
    // responder. Ciao bounds each goodbye send at 200ms; the patched shutdown
    // closes sockets even if sending the goodbye fails.
    const stopping = (async () => {
      try {
        await publication.service?.destroy();
      } finally {
        await publication.responder.shutdown();
      }
    })().catch(() => {});
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      stopping,
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, 1500);
      }),
    ]);
    clearTimeout(deadline);
  }
}
