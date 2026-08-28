/**
 * The one place Station decides which AWS region a Bedrock call uses
 * (archive#1557).
 *
 * Before this module the readers disagreed, and there were more of
 * them than any one reading found — the count in this sentence was wrong
 * three rounds running, so it no longer carries one.
 *
 * `framework-model-factory.ts` — the chain every Station-agent execution path
 * actually runs — resolved `spec.region -> connection.config.region ->
 * appConfig.region -> 'us-east-1'`; `runtime-provider-resolution.ts` had a
 * second copy of that same chain; `bedrock.ts`, `runtime-initialize.ts`,
 * `agent-hooks.ts`, and `tool-execution-usage.ts` each stopped at
 * `appConfig.region || 'us-east-1'`; and the model-catalogue route resolved
 * `process.env.AWS_REGION || 'us-east-1'` with no reference to the stored
 * setting at all. With a stored region of `eu-west-1` and no `AWS_REGION`,
 * Settings displayed "Default AWS region for Bedrock: eu-west-1" while the
 * model list a user picked from was fetched out of `us-east-1`. And a
 * provenance badge described yet another behavior, greying out the stored
 * value as a "doomed edit" because `AWS_REGION` was set, when the stored
 * value was in fact the one that applied.
 *
 * The first fix for archive#1557 unified two of those readers and left the
 * execution path alone, which relocated the disagreement instead of closing
 * it — and made it worse, because the new badge asserted a region the chat
 * turn would not use. Review caught it. Every site that DECIDES a region now
 * calls this function, and `bedrock-region.test.ts` scans each of them.
 *
 * The precedence below is the inference path's, promoted to the whole
 * product, because the serving path is the authoritative one and because a
 * setting Station presents as editable has to actually take effect when
 * edited. `AWS_REGION` is therefore a FALLBACK consulted when nothing is
 * stored — the AWS-conventional default for a machine — not an override.
 *
 * `source` is returned rather than inferred by callers so a surface can state
 * where the value came from instead of guessing from the presence of an env
 * var. That is the whole of the badge fix: the claim is derived from the
 * resolution that actually happens.
 */

export type BedrockRegionSource =
  | 'agent'
  | 'connection'
  | 'config'
  | 'env'
  | 'default';

export interface BedrockRegionResolution {
  region: string;
  source: BedrockRegionSource;
  /** The env var consulted for the `env` source, for surfaces that name it. */
  envVar: typeof BEDROCK_REGION_ENV_VAR;
}

/**
 * Declared here and re-used by the settings registry's `envOverride` entry, so
 * the var the badge names and the var the resolver reads cannot drift apart.
 */
export const BEDROCK_REGION_ENV_VAR = 'AWS_REGION' as const;

/**
 * The region used when nothing is stored, no agent override applies, and the
 * environment says nothing. AWS's own most-common default; retained from the
 * pre-#1557 behavior of both readers rather than newly chosen.
 */
export const BEDROCK_REGION_DEFAULT = 'us-east-1';

export interface BedrockRegionInputs {
  /** `AgentSpec.region` — a per-agent override, the narrowest scope. */
  agentRegion?: string | null;
  /**
   * `ProviderConnectionConfig.config.region` — the bound Bedrock connection's
   * own region. Between the agent and the workspace setting: a connection is
   * a specific account/endpoint, so its region beats the workspace default
   * but not an explicit per-agent choice.
   */
  connectionRegion?: string | null;
  /** `AppConfig.region` — the stored workspace setting. */
  configRegion?: string | null;
  /**
   * The process environment. Passed in rather than read off `process.env`
   * directly so the resolution is testable without mutating global state, and
   * so a caller that has no environment (a pure projection) cannot silently
   * pick one up.
   */
  env?: Readonly<Partial<Record<typeof BEDROCK_REGION_ENV_VAR, string>>>;
}

/**
 * The AWS region id grammar. `normalizeBedrockRegion`
 * (`providers/llm/bedrock-models.ts`) enforces exactly this and THROWS on a
 * miss, so it lives here — the module that decides which region is used is the
 * module that has to know what a region is.
 */
export const BEDROCK_REGION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+){2,4}$/;
const BEDROCK_REGION_MAX_LENGTH = 64;

export function isBedrockRegionId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= BEDROCK_REGION_MAX_LENGTH &&
    BEDROCK_REGION_ID_PATTERN.test(value)
  );
}

function trimmed(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * A malformed `AWS_REGION` is not a decision — it is discarded, exactly as a
 * whitespace-only one is (archive#1557 review round 2, HIGH).
 *
 * This matters because of what routing the environment into the resolver
 * exposed: `BedrockModelCatalog`'s constructor calls `normalizeBedrockRegion`,
 * which THROWS, and `runtime-initialize.ts` builds one at boot with no
 * enclosing try/catch. Before the env reached that path the input was
 * `AppConfig.region`, gated on write by the settings registry's own pattern,
 * so the value was always well-formed. `AWS_REGION` is an arbitrary user
 * environment variable — `export AWS_REGION=US-EAST-1` in a shell profile
 * (uppercase, which several AWS tools accept) would have turned a
 * wrong-region display into an app that cannot start, reporting a "bounded AWS
 * region id" error that never named the variable.
 *
 * The other levels are deliberately NOT validated here: their values reach the
 * same constructors on paths that predate this module, and silently discarding
 * a stored setting is its own dishonesty. Only the newly-admitted, ungated
 * input is filtered, and the filter is the reason it could be admitted at all.
 */
function usableEnvRegion(value: string | undefined): string | undefined {
  const cleaned = trimmed(value);
  if (!cleaned) return undefined;
  return isBedrockRegionId(cleaned) ? cleaned : undefined;
}

/**
 * Resolve the effective Bedrock region and say where it came from.
 *
 * Empty and whitespace-only values are treated as absent at every level: a
 * stored `region: ''` is not a decision, and letting it win would produce an
 * AWS client with no region while the UI reported a configured one.
 */
export function resolveBedrockRegion(
  inputs: BedrockRegionInputs = {},
): BedrockRegionResolution {
  const envVar = BEDROCK_REGION_ENV_VAR;
  const agent = trimmed(inputs.agentRegion);
  if (agent) return { region: agent, source: 'agent', envVar };

  const connection = trimmed(inputs.connectionRegion);
  if (connection) return { region: connection, source: 'connection', envVar };

  const config = trimmed(inputs.configRegion);
  if (config) return { region: config, source: 'config', envVar };

  const fromEnv = usableEnvRegion(inputs.env?.[envVar]);
  if (fromEnv) return { region: fromEnv, source: 'env', envVar };

  return { region: BEDROCK_REGION_DEFAULT, source: 'default', envVar };
}
