import type { EngineConnectionId } from '@kontourai/station-contracts/agent-identity';
import type { SystemStatus } from '@kontourai/station-sdk';
import { connectionTypeLabel } from '../utils/execution';

type ConfiguredProvider = NonNullable<
  SystemStatus['providers']
>['configured'][number];

export interface SetupBannerContent {
  title: string;
  description: string;
  actionLabel: string;
  badges: string[];
  /**
   * station#1544: `'runtimes'` used to be a third target here. No branch of
   * `buildSetupBannerContent` has ever returned it since the variants below
   * settled, so the `actionTarget === 'runtimes'` checks in `OnboardingGate`
   * and `ChatEmptyState` were unreachable navigation. Removed with the
   * variant rather than left reading as live.
   */
  actionTarget: 'providers' | 'connections' | 'engine';
  /** Present only for an engine action; this is the owning Agent Apps connection. */
  engineConnectionId?: EngineConnectionId;
}

/**
 * station#1544: `'engine-picker'` was removed from this union. #1387 deleted
 * all three `return 'engine-picker'` statements from `setupBannerVariant`
 * below — a deliberate product reversal ("a verified ready path must never be
 * presented as setup work") — which left the variant unproducible while
 * `buildSetupBannerContent` still carried a copy block for it and
 * `chatSetupNeeded` still filtered on it. Nothing short-circuited the copy;
 * the producer simply stopped producing it. If the picker returns, add the
 * variant back together with the branch that emits it, not ahead of it.
 */
export type SetupBannerVariant =
  | 'hidden'
  | 'engine-needs-attention'
  | 'detected-provider'
  | 'configured-no-chat'
  | 'unconfigured';

function configuredProviders(status: SystemStatus): ConfiguredProvider[] {
  return status.providers?.configured ?? [];
}

/* Duplicate saved connections of the same type (e.g. several "Local Ollama"
   entries accumulated by older builds) must not each render their own badge —
   summarize repeats as one badge with a count. */
function dedupeBadges(labels: string[]): string[] {
  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) =>
    count > 1 ? `${label} ×${count}` : label,
  );
}

function enabledConfiguredProviders(
  status: SystemStatus,
): ConfiguredProvider[] {
  return configuredProviders(status).filter((provider) => provider.enabled);
}

export function configuredLlmProviders(
  status: SystemStatus,
): ConfiguredProvider[] {
  return enabledConfiguredProviders(status).filter((provider) =>
    (provider.capabilities ?? []).includes('llm'),
  );
}

export function setupBannerVariant(status: SystemStatus): SetupBannerVariant {
  // station#chat-dock-maximize-readiness: while system prerequisite
  // discovery is still `pending`, the status snapshot is an all-false
  // placeholder that would otherwise read as 'unconfigured'. Withhold the
  // setup conclusion until discovery settles so a genuinely ready
  // Claude/Codex/ACP/Ollama path can suppress the launcher instead of
  // flashing a false "no chat configured" overlay during first run.
  if (status.prerequisitesState === 'pending') {
    return 'hidden';
  }
  // A verified ready path must never be presented as setup work. Engine
  // choice remains available in Connections and the chat model picker; Home
  // should not interrupt a user who can already start a chat.
  if (status.acp.connected) {
    return 'hidden';
  }

  if (
    status.providers?.configuredChatReady ||
    status.recommendation?.code === 'configured-chat-ready'
  ) {
    return 'hidden';
  }

  // A per-engine failure is setup work only when no engine can already start
  // chat. Keep this before the attention branch: an array `.some()` over
  // unready rows cannot encode the ready-path precedence contract.
  if (status.externalEngines?.some((engine) => engine.ready)) {
    return 'hidden';
  }

  // Per-engine rows are producer-owned readiness facts. Do not replace this
  // with `clis`, `capabilities.runtime`, or a recommendation: each collapses
  // the reason a detected engine cannot yet start a chat.
  if (
    status.externalEngines?.some(
      (engine) =>
        !engine.ready && (engine.detected || engine.reason === 'cannot_verify'),
    )
  ) {
    return 'engine-needs-attention';
  }

  if (status.recommendation?.code === 'configured-no-chat') {
    return 'configured-no-chat';
  }

  if (status.recommendation?.code === 'detected-provider') {
    return 'detected-provider';
  }
  if (status.recommendation?.code === 'runtime-only') {
    return 'hidden';
  }

  const configured = configuredProviders(status);
  if (
    configured.some((provider) =>
      (provider.capabilities ?? []).includes('llm'),
    ) &&
    configuredLlmProviders(status).length === 0
  ) {
    return 'configured-no-chat';
  }

  const detected = status.providers?.detected;
  if (detected?.ollama || detected?.bedrock) {
    return 'detected-provider';
  }

  return 'unconfigured';
}

/**
 * station#1194 (epic #1191, slice B) introduced a second, narrower predicate
 * (`chatSetupNeeded`) that excluded the 'engine-picker' variant, because that
 * variant meant "chat already works, pick which engine backs it" and a chat
 * surface must not read it as setup work. station#1544 removed that variant,
 * which made the two predicates identical — so there is one again, and every
 * caller uses it. Re-introduce the narrower one only alongside a variant it
 * actually excludes.
 */
export function shouldShowSetupBanner(status: SystemStatus): boolean {
  return setupBannerVariant(status) !== 'hidden';
}

export function buildSetupBannerContent(
  status: SystemStatus,
): SetupBannerContent {
  const configured = configuredProviders(status).filter((provider) =>
    (provider.capabilities ?? []).includes('llm'),
  );
  const enabledProviders = configuredLlmProviders(status);

  switch (setupBannerVariant(status)) {
    case 'engine-needs-attention': {
      const engine = status.externalEngines?.find(
        (item) =>
          !item.ready && (item.detected || item.reason === 'cannot_verify'),
      );
      if (!engine) {
        return {
          title: 'Choose what powers Station',
          description: 'Add a provider for chat, agents, or both.',
          actionLabel: 'Open Connections',
          badges: [],
          actionTarget: 'providers',
        };
      }
      const detail =
        engine.reason === 'sign_in_required'
          ? `Sign in to ${engine.name}, then Station will be ready to use it.`
          : engine.reason === 'disabled'
            ? `${engine.name} is turned off. Turn it on to use it in Station.`
            : engine.reason === 'cannot_verify'
              ? `Station cannot verify that ${engine.name} is ready yet.`
              : `${engine.name} needs its required setup completed before Station can use it.`;
      const actionLabel =
        engine.reason === 'sign_in_required'
          ? `Sign in to ${engine.name}`
          : engine.reason === 'disabled'
            ? `Enable ${engine.name}`
            : `Review ${engine.name}`;
      return {
        title: `${engine.name} needs attention`,
        description: detail,
        actionLabel,
        badges: engine.detected
          ? [`Detected: ${engine.name}`]
          : [`Could not verify: ${engine.name}`],
        actionTarget: engine.engineConnectionId ? 'engine' : 'connections',
        engineConnectionId: engine.engineConnectionId,
      };
    }
    case 'detected-provider': {
      const detectedProviderLabel =
        status.recommendation?.detectedProviderLabel ||
        (status.providers?.detected?.ollama
          ? 'Ollama'
          : status.providers?.detected?.bedrock
            ? 'Amazon Bedrock'
            : 'Provider');
      return {
        title:
          status.recommendation?.title ||
          `${detectedProviderLabel} is available`,
        description:
          status.recommendation?.detail ||
          `Open Connections to review or add ${detectedProviderLabel} for chat.`,
        actionLabel: 'Review Connections',
        badges: [`Detected: ${detectedProviderLabel}`],
        actionTarget: 'providers',
      };
    }
    case 'configured-no-chat':
      return {
        title: 'A provider needs attention',
        description:
          'Choose or repair a provider in Connections before starting a chat.',
        actionLabel: 'Manage Connections',
        badges: dedupeBadges(
          configured.map((provider) =>
            provider.enabled
              ? `Configured: ${connectionTypeLabel(provider.type)}`
              : `Disabled: ${connectionTypeLabel(provider.type)}`,
          ),
        ),
        actionTarget: 'providers',
      };
    case 'hidden':
      return {
        title: '',
        description: '',
        actionLabel: '',
        badges: [],
        actionTarget: 'connections',
      };
    default:
      return {
        title: 'Choose what powers Station',
        description: 'Add a provider for chat, agents, or both.',
        actionLabel: 'Open Connections',
        badges: dedupeBadges(
          enabledProviders.map(
            (provider) => `Configured: ${connectionTypeLabel(provider.type)}`,
          ),
        ),
        actionTarget: 'providers',
      };
  }
}
