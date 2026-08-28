/**
 * Bedrock connection auth-mode resolution (docs/design/connections-onboarding.md
 * §3.1). A single home for mapping the connection's `authMode` to the
 * constructor options each Bedrock-facing SDK expects, so every construction
 * site (raw `@aws-sdk/client-bedrock*` clients, the `@ai-sdk/amazon-bedrock`
 * builder) applies the same three modes the same way:
 *
 *  - `chain` (default, today's behavior): the default AWS credential chain.
 *  - `profile`: a named profile from `~/.aws/config`/`~/.aws/credentials`,
 *    resolved via `fromIni` — never reads the profile's secret material here,
 *    only its name (see `aws-profiles.ts`).
 *  - `api-key`: a pasted Bedrock API key, used for bearer-token auth.
 *
 * Fail-closed by design (HIGH-2, review fix round): an unknown `authMode`, a
 * `profile` mode with no profile name, or an `api-key` mode with no key
 * THROWS rather than silently resolving to the default credential chain.
 * Falling through to chain auth on a misconfigured non-chain connection
 * would run requests as the wrong (or an unintended default) AWS identity
 * without any signal to the caller — worse than a loud, early failure. The
 * connection-save path (`connectionSchema` in
 * `routes/schemas/schema-definitions/runtime.ts`) also rejects a
 * mode/field mismatch before it is ever persisted, so this should only ever
 * throw on a corrupted or hand-edited config, not from the normal save flow.
 */

import { fromIni, fromNodeProviderChain } from '@aws-sdk/credential-providers';

export type BedrockAuthMode = 'chain' | 'profile' | 'api-key';

/**
 * A connection whose auth settings cannot produce a request at all.
 *
 * Named so a catch site can tell it apart from an AWS answer without matching
 * on message text (archive#3654): it is a settings fault the operator can fix, and
 * reporting it as "could not reach AWS" would be a claim about the network
 * that nothing observed.
 */
export class BedrockAuthConfigurationError extends Error {
  readonly name = 'BedrockAuthConfigurationError';
}

export interface BedrockAuthConfig {
  authMode?: BedrockAuthMode;
  profile?: string;
  apiKey?: string;
}

function cleanString(value?: string): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** Shared validation: resolves to a definite mode + its required value, or throws. */
function resolveAuthMode(config: BedrockAuthConfig):
  | { mode: 'chain' }
  | { mode: 'profile'; profile: string }
  | {
      mode: 'api-key';
      apiKey: string;
    } {
  const mode = config.authMode ?? 'chain';

  if (mode === 'profile') {
    const profile = cleanString(config.profile);
    if (!profile) {
      throw new BedrockAuthConfigurationError(
        'Bedrock connection is set to "profile" auth but has no named AWS profile configured.',
      );
    }
    return { mode: 'profile', profile };
  }

  if (mode === 'api-key') {
    const apiKey = cleanString(config.apiKey);
    if (!apiKey) {
      throw new BedrockAuthConfigurationError(
        'Bedrock connection is set to "api-key" auth but has no API key configured.',
      );
    }
    return { mode: 'api-key', apiKey };
  }

  if (mode !== 'chain') {
    throw new BedrockAuthConfigurationError(
      `Bedrock connection has an unrecognized authMode: '${mode}'.`,
    );
  }

  return { mode: 'chain' };
}

/**
 * Options to spread into a `@aws-sdk/client-bedrock` (`BedrockClient`) or
 * `@aws-sdk/client-bedrock-runtime` (`BedrockRuntimeClient`) constructor.
 * Chain mode returns `{}` — the client's own default credential resolution
 * already matches `fromNodeProviderChain()`, so no override is needed.
 */
export function bedrockClientAuth(config: BedrockAuthConfig = {}): {
  credentials?: ReturnType<typeof fromIni>;
  token?: { token: string };
  authSchemePreference?: string[];
} {
  const resolved = resolveAuthMode(config);

  if (resolved.mode === 'profile') {
    return { credentials: fromIni({ profile: resolved.profile }) };
  }

  if (resolved.mode === 'api-key') {
    return {
      token: { token: resolved.apiKey },
      authSchemePreference: ['httpBearerAuth'],
    };
  }

  return {};
}

/**
 * Options to spread into `createAmazonBedrock` (`@ai-sdk/amazon-bedrock`).
 * That builder's constructor shape differs from the raw AWS SDK clients: it
 * takes a bare `apiKey` string for bearer auth (there is no
 * `authSchemePreference`/`token` concept at this layer) and a
 * `credentialProvider` function for SigV4 auth.
 */
export function bedrockAiSdkCredentials(config: BedrockAuthConfig = {}): {
  apiKey?: string;
  credentialProvider?: ReturnType<typeof fromIni>;
} {
  const resolved = resolveAuthMode(config);

  if (resolved.mode === 'profile') {
    return { credentialProvider: fromIni({ profile: resolved.profile }) };
  }

  if (resolved.mode === 'api-key') {
    return { apiKey: resolved.apiKey };
  }

  return { credentialProvider: fromNodeProviderChain() };
}

/**
 * Options for `@strands-agents/sdk`'s `BedrockModel` (HIGH-3, review fix
 * round): its constructor accepts a bare `apiKey` for bearer auth (same
 * bearer semantics as the ai-sdk builder) and a `clientConfig.credentials`
 * field for SigV4 auth (same `AwsCredentialIdentityProvider` shape
 * `fromIni`/`fromNodeProviderChain` return — verified against the installed
 * `@strands-agents/sdk` `BedrockModelOptions` type). Chain mode returns
 * `{}` so the default construction path is unchanged (Strands' own default
 * resolution already matches `fromNodeProviderChain()`).
 */
export function bedrockStrandsCredentials(config: BedrockAuthConfig = {}): {
  apiKey?: string;
  clientConfig?: { credentials: ReturnType<typeof fromIni> };
} {
  const resolved = resolveAuthMode(config);

  if (resolved.mode === 'profile') {
    return {
      clientConfig: { credentials: fromIni({ profile: resolved.profile }) },
    };
  }

  if (resolved.mode === 'api-key') {
    return { apiKey: resolved.apiKey };
  }

  return {};
}
