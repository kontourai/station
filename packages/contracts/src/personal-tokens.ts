/**
 * #3557: personal access tokens. A token is a credential a person makes for
 * a script or an integration. It acts as that person, carries only what they
 * chose for it, and is always capped by their Station group, so it never
 * exceeds the person's own access.
 *
 * v1 tokens read and operate only: running commands and full access need a
 * paired device or the operator in person, and a token is neither.
 */
import {
  PAIRING_SCOPE_ORCHESTRATION_OPERATE,
  PAIRING_SCOPE_ORCHESTRATION_READ,
  type PairingScope,
  parsePairingScope,
} from './environment-security.js';

export const PERSONAL_TOKEN_SCOPES: readonly PairingScope[] = [
  PAIRING_SCOPE_ORCHESTRATION_READ,
  PAIRING_SCOPE_ORCHESTRATION_OPERATE,
];

/** Active tokens one person may hold at once. */
export const MAX_PERSONAL_TOKENS_PER_PERSON = 20;
/** The longest a token may live: one year. */
export const MAX_PERSONAL_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/** Whether `scope` is one a token may carry: Read, optionally Operate. */
export function isPersonalTokenScope(scope: string): boolean {
  const tokens = parsePairingScope(scope);
  return (
    tokens !== null &&
    tokens.includes(PAIRING_SCOPE_ORCHESTRATION_READ) &&
    tokens.every((token) => PERSONAL_TOKEN_SCOPES.includes(token))
  );
}

/** A token as its owner and the operator see it; never its secret. */
export interface PersonalAccessToken {
  id: string;
  name: string;
  ownerPrincipalId: string;
  /** What it was made with. */
  scope: string;
  /** What it may use now: `scope` capped by the owner's group. */
  effectiveScope: string;
  createdAt: number;
  /** `null`: never expires. */
  expiresAt: number | null;
  lastUsedAt: number | null;
}

/** The answer to a mint: the secret, shown once, and the token. */
export interface MintedPersonalAccessToken {
  token: PersonalAccessToken;
  secret: string;
}
