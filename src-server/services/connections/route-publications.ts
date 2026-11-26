import {
  MAX_STATION_ROUTES,
  type StationRoutesResponse,
} from '@kontourai/station-contracts/station-routes';
import { parseTrustedConsentOrigin } from '../consent/consent-origin.js';
import { createPublicIngressOriginResolver } from '../tailscale/public-ingress-origin.js';
import { resolveTailscaleAuthority } from '../tailscale/tailscale-authority.js';

type Publication = NonNullable<StationRoutesResponse['publication']>;

export class RoutePublications {
  private readonly app: ReturnType<typeof createPublicIngressOriginResolver>;

  constructor(
    private readonly input: {
      appPorts: readonly number[];
      consentPort: number;
      enabled: () => boolean;
      configuredOrigin: () => string | undefined | Promise<string | undefined>;
      legacyOrigin: string | null;
      cli?: Parameters<typeof createPublicIngressOriginResolver>[0]['cli'];
    },
  ) {
    let authority: Awaited<ReturnType<typeof resolveTailscaleAuthority>>;
    const cli =
      input.cli ??
      (async (args: readonly string[]) => {
        if (authority?.kind !== 'trusted')
          authority = await resolveTailscaleAuthority();
        if (authority.kind !== 'trusted') return { stdout: '', exitCode: null };
        return authority.command(args);
      });
    this.app = createPublicIngressOriginResolver({
      localPorts: input.appPorts,
      cli,
    });
  }

  async resolve(): Promise<Publication> {
    if (!this.input.enabled()) {
      return {
        consentOrigin: this.input.legacyOrigin,
        source: this.input.legacyOrigin ? 'configured' : 'unavailable',
        appOrigins: [],
        status: 'disabled',
      };
    }
    const configured = await this.input.configuredOrigin();
    const origin =
      configured === undefined
        ? this.input.legacyOrigin
        : parseTrustedConsentOrigin(configured);
    const [appOrigins, consentOrigins] = await Promise.all([
      this.app.ownedOrigins(),
      this.app.ownedOrigins([this.input.consentPort]),
    ]);
    const publishedAppOrigins = appOrigins.slice(0, MAX_STATION_ROUTES);
    if (origin)
      return {
        consentOrigin: appOrigins.includes(origin) ? null : origin,
        source: 'configured',
        appOrigins: publishedAppOrigins,
        status: appOrigins.includes(origin) ? 'unavailable' : 'ready',
      };
    const candidates = consentOrigins.filter((candidate) =>
      appOrigins.some(
        (app) =>
          new URL(app).hostname === new URL(candidate).hostname &&
          app !== candidate,
      ),
    );
    const consentOrigin = candidates.length === 1 ? candidates[0]! : null;
    return {
      consentOrigin,
      source: consentOrigin ? 'tailscale' : 'unavailable',
      appOrigins: publishedAppOrigins,
      status: consentOrigin
        ? 'ready'
        : candidates.length > 1
          ? 'ambiguous'
          : 'unavailable',
    };
  }
}
