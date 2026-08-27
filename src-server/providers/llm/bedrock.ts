/**
 * Bedrock provider setup for VoltAgent using Vercel AI SDK
 */

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { AppConfig } from '@kontourai/station-contracts/config';
import {
  type BedrockAuthConfig,
  bedrockAiSdkCredentials,
} from './bedrock-credentials.js';
import { resolveBedrockRegion } from './bedrock-region.js';

export interface BedrockProviderOptions {
  appConfig: AppConfig;
  agentSpec?: AgentSpec;
  /**
   * The bedrock connection's auth mode (docs/design/connections-onboarding.md
   * §3.1; HIGH-3, review fix round). Absent = chain, today's behavior.
   */
  auth?: BedrockAuthConfig;
  /** The bound connection's own region, between agent and workspace scope. */
  connectionRegion?: string;
}

/**
 * Create Bedrock provider instance with config
 */
export function createBedrockProvider(
  options: BedrockProviderOptions,
): ReturnType<ReturnType<typeof createAmazonBedrock>['languageModel']> {
  const { appConfig, agentSpec, auth, connectionRegion } = options;

  const model = agentSpec?.model || appConfig.defaultModel;
  // station#1557: one resolver, shared with the model-catalogue route and with
  // the provenance the Settings badge renders.
  const { region } = resolveBedrockRegion({
    agentRegion: agentSpec?.region,
    connectionRegion,
    configRegion: appConfig.region,
    env: process.env,
  });

  const provider = createAmazonBedrock({
    region,
    ...bedrockAiSdkCredentials(auth),
  });

  return provider.languageModel(model);
}

/**
 * Check if AWS credentials are configured
 */
export async function checkBedrockCredentials(): Promise<boolean> {
  try {
    const provider = fromNodeProviderChain();
    // Cap resolution. With no creds configured, the chain falls through to the
    // EC2 IMDS probe, which waits out a ~4s timeout on non-EC2 hosts and stalls
    // the first /api/system/status (the whole app blocks on it). A 2s ceiling
    // keeps real env/profile/SSO creds working while failing fast when none.
    await Promise.race([
      provider(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('bedrock-credentials-timeout')),
          2000,
        ),
      ),
    ]);
    return true;
  } catch (error) {
    // "No credentials configured" is the expected answer for a default install
    // — the documented credential-free path is Ollama — so it is not an error
    // and must not print. Only a genuinely unexpected probe failure is worth
    // surfacing, and never with a stack: this runs on every startup.
    if (!isAbsentCredentials(error)) {
      console.debug(
        `Bedrock credential probe failed unexpectedly: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return false;
  }
}

/**
 * Did the probe simply find no credentials, rather than fail?
 *
 * The AWS provider chain reports exhaustion as `CredentialsProviderError`, and
 * our own 2s ceiling rejects with `bedrock-credentials-timeout` when the chain
 * stalls on the EC2 IMDS probe on a non-EC2 host. Both mean "not configured".
 */
function isAbsentCredentials(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'CredentialsProviderError' ||
    error.message === 'bedrock-credentials-timeout' ||
    /could not load credentials/i.test(error.message)
  );
}
