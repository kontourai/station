import {
  type ApprovedStationConnectionTrust,
  STATION_CONNECTION_PROOF_LIFETIME_SECONDS,
  type StationConnectionProofBinding,
} from '@kontourai/station-contracts/connection-proof';
import {
  ConnectionProofError,
  copyConnectionProofBinding,
  signStationConnectionProof,
} from '@kontourai/station-shared/connection-proof';

/** Transport-only issuer. No application grant or person authority is minted. */
export function createStationConnectionProofIssuer(input: {
  trust: ApprovedStationConnectionTrust;
  signingKey: Parameters<typeof signStationConnectionProof>[0]['signingKey'];
  /** Trusted Station-owned admission predicate, rechecked after signing. */
  authorize: (binding: StationConnectionProofBinding) => boolean;
  now?: () => number;
}) {
  const trust = { ...input.trust, signingKey: { ...input.trust.signingKey } };
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  const signingKey = input.signingKey;
  const authorize = input.authorize;
  return Object.freeze({
    async issue(value: StationConnectionProofBinding): Promise<string> {
      const binding = copyConnectionProofBinding(value);
      const issuedAt = now();
      if (authorize(binding) !== true) throw new ConnectionProofError();
      const proof = await signStationConnectionProof({
        trust,
        binding,
        signingKey,
        now: issuedAt,
      });
      const current = now();
      if (
        authorize(binding) !== true ||
        !Number.isSafeInteger(current) ||
        current < issuedAt ||
        current >= issuedAt + STATION_CONNECTION_PROOF_LIFETIME_SECONDS
      )
        throw new ConnectionProofError();
      return proof;
    },
  });
}
