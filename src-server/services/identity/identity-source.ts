import {
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_INGRESS_IDENTITY_HEADER,
  readVerifiedIngressIdentity,
} from '../../utils/internal-api-token.js';

/**
 * A provider-agnostic verified identity. This is the seam that lets Station
 * grow additional identity providers (e.g. a Kontour account signed in via
 * GitHub/Google) without the authz/pairing layer knowing which provider
 * produced the identity.
 *
 * Today the only provider is `tailscale-serve` (the tailnet-WhoIs ingress
 * identity). `VerifiedIngressIdentity` in `utils/internal-api-token.ts` remains
 * the wire/boundary shape (it carries `login`); a `VerifiedIdentity` is the
 * abstraction over it, mapping that provider's `login` onto the stable
 * `subject` field.
 */
export interface VerifiedIdentity {
  /** Which identity provider vouched for this subject. */
  provider: 'tailscale-serve' | 'kontour-account' | 'device';
  /** Stable id within the provider (today: the Tailscale Serve login). */
  subject: string;
  displayName?: string;
  /** Reserved for a future kontour-account provider (github/google); unused now. */
  federatedVia?: string;
}

/**
 * The ingress request context an {@link IdentitySource} inspects. It carries
 * the node environment (needed for transport-trust checks such as the loopback
 * attestation the tailnet source performs) plus a raw header accessor so each
 * provider reads only the headers it cares about.
 */
export interface IdentityRequestContext {
  readonly environment: unknown;
  header(name: string): string | undefined;
}

/**
 * A pluggable identity provider. Given an ingress request context, it either
 * returns the verified identity it recognizes, or `null` if the request does
 * not carry a credential this provider can verify.
 */
export interface IdentitySource {
  readonly provider: VerifiedIdentity['provider'];
  identify(context: IdentityRequestContext): VerifiedIdentity | null;
}

/**
 * The first identity provider: the existing tailnet-WhoIs path. It wraps
 * {@link readVerifiedIngressIdentity} verbatim — same header reading, same
 * loopback + internal-token attestation, same validation — and maps the
 * resulting `VerifiedIngressIdentity.login` onto `VerifiedIdentity.subject`.
 * The verification semantics are unchanged from the direct reader call.
 */
export class TailscaleServeIdentitySource implements IdentitySource {
  readonly provider = 'tailscale-serve' as const;

  identify(context: IdentityRequestContext): VerifiedIdentity | null {
    const ingress = readVerifiedIngressIdentity(context.environment, {
      identity: context.header(INTERNAL_INGRESS_IDENTITY_HEADER),
      token: context.header(INTERNAL_API_TOKEN_HEADER),
    });
    if (!ingress) return null;
    return {
      provider: 'tailscale-serve',
      subject: ingress.login,
      ...(ingress.displayName !== undefined
        ? { displayName: ingress.displayName }
        : {}),
    };
  }
}

// Extension point (additive, not yet implemented): a
// `KontourAccountIdentitySource` would validate a Kontour session token from
// the request and return a `VerifiedIdentity` with `provider: 'kontour-account'`
// (and `federatedVia` set to the upstream github/google issuer). It is
// registered by adding it to the ordered source list at the ingress boundary
// (see `runtime-routes.ts`); no change to the pairing/authz layer is required,
// because that layer consumes the provider-agnostic `VerifiedIdentity`. This
// waits on the external Kontour token contract — do not implement it here.
