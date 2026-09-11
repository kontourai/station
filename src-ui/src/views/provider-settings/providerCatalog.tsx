import {
  type AgentConnectionView,
  type ConnectionReadinessEvidence,
  connectionCheckOutranksSmoke,
  type Prerequisite,
} from '@kontourai/station-contracts/tool';
import type { ReactNode } from 'react';
import type { HostActionId } from '../../components/host-action/host-action-copy';
import type { ProviderTypeOption } from './types';

/**
 * The provider catalog is the one source of truth for provider choices and
 * state language. Agent connections carry a three-way setup observation from
 * the server; catalog-only discovery cards explicitly carry no such
 * observation. Screens must not manufacture a setup state from booleans.
 */

interface ProviderPreset {
  id: string;
  name: string;
  desc: string;
  type: string;
  config: Record<string, string>;
  icon?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    desc: 'GPT models · api.openai.com',
    type: 'openai-compat',
    config: { baseUrl: 'https://api.openai.com/v1', apiKey: '' },
    icon: 'brand:codex',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    desc: 'Many models, one API key',
    type: 'openai-compat',
    config: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: '' },
  },
  {
    id: 'groq',
    name: 'Groq',
    desc: 'Fast open-model inference',
    type: 'openai-compat',
    config: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: '' },
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    desc: 'Open models · api.fireworks.ai',
    type: 'openai-compat',
    config: { baseUrl: 'https://api.fireworks.ai/inference/v1', apiKey: '' },
  },
  {
    id: 'meta',
    name: 'Meta',
    desc: 'Muse Spark models · api.meta.ai',
    type: 'openai-compat',
    config: { baseUrl: 'https://api.meta.ai/v1', apiKey: '' },
  },
  {
    id: 'xai',
    name: 'xAI',
    desc: 'Grok models · api.x.ai',
    type: 'openai-compat',
    config: { baseUrl: 'https://api.x.ai/v1', apiKey: '' },
  },
  {
    id: 'mistral',
    name: 'Mistral',
    desc: 'Mistral models · api.mistral.ai',
    type: 'openai-compat',
    config: { baseUrl: 'https://api.mistral.ai/v1', apiKey: '' },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    desc: 'DeepSeek models · api.deepseek.com',
    type: 'openai-compat',
    config: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '' },
  },
  {
    id: 'together',
    name: 'Together AI',
    desc: 'Open models · api.together.xyz',
    type: 'openai-compat',
    config: { baseUrl: 'https://api.together.xyz/v1', apiKey: '' },
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    desc: 'Fast open-model inference · api.cerebras.ai',
    type: 'openai-compat',
    config: { baseUrl: 'https://api.cerebras.ai/v1', apiKey: '' },
  },
  {
    id: 'vercel-gateway',
    name: 'Vercel AI Gateway',
    desc: 'Many models, one API key · ai-gateway.vercel.sh',
    type: 'openai-compat',
    config: { baseUrl: 'https://ai-gateway.vercel.sh/v1', apiKey: '' },
  },
  {
    id: 'azure-foundry',
    name: 'Azure AI Foundry',
    desc: 'Your resource endpoint + /openai/v1',
    type: 'openai-compat',
    config: { baseUrl: '', apiKey: '' },
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    desc: 'Local models · no API key',
    type: 'openai-compat',
    config: { baseUrl: 'http://localhost:1234/v1', apiKey: '' },
  },
  {
    id: 'litellm',
    name: 'LiteLLM',
    desc: 'Self-hosted model router/proxy',
    type: 'openai-compat',
    config: { baseUrl: 'http://localhost:4000/v1', apiKey: '' },
  },
];

function providerTypeIcon(children: ReactNode) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export const PROVIDER_TYPES: ProviderTypeOption[] = [
  {
    type: 'bedrock',
    name: 'Amazon Bedrock',
    desc: 'AWS credentials · Claude, Llama, Mistral',
    icon: providerTypeIcon(
      <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />,
    ),
  },
  {
    type: 'ollama',
    name: 'Ollama',
    desc: 'Local models · free, private',
    icon: providerTypeIcon(
      <>
        <rect x="2" y="2" width="20" height="8" rx="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" />
        <line x1="6" y1="6" x2="6.01" y2="6" />
        <line x1="6" y1="18" x2="6.01" y2="18" />
      </>,
    ),
  },
  {
    type: 'openai-compat',
    name: 'OpenAI-Compatible',
    desc: 'Any OpenAI-compatible endpoint · custom base URL',
    icon: providerTypeIcon(
      <>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </>,
    ),
  },
  {
    type: 'anthropic',
    name: 'Anthropic',
    desc: 'Claude models (API key)',
    icon: providerTypeIcon(
      <>
        <path d="M9 18 3 12l6-6" />
        <path d="m15 6 6 6-6 6" />
      </>,
    ),
  },
  {
    type: 'google',
    name: 'Google',
    desc: 'Gemini models (API key)',
    icon: providerTypeIcon(
      <>
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10z" />
      </>,
    ),
  },
];

const OPENAI_COMPATIBLE_PROVIDER_TYPE = PROVIDER_TYPES.find(
  (option) => option.type === 'openai-compat',
)!;

type ModelProviderChoice = {
  id: string;
  type: string;
  name: string;
  desc: string;
  config?: Record<string, string>;
  icon?: string;
};

export const MODEL_PROVIDER_CHOICES: ModelProviderChoice[] = [
  ...PROVIDER_PRESETS.map((preset) => ({
    ...preset,
    id: `preset:${preset.id}`,
  })),
  ...PROVIDER_TYPES.filter((option) => option.type !== 'openai-compat').map(
    (option) => ({
      id: `type:${option.type}`,
      type: option.type,
      name: option.name,
      desc: option.desc,
    }),
  ),
  {
    id: 'type:openai-compat',
    type: 'openai-compat',
    name: OPENAI_COMPATIBLE_PROVIDER_TYPE.name,
    desc: OPENAI_COMPATIBLE_PROVIDER_TYPE.desc,
  },
];

export function findModelProviderChoice(
  id: string | null,
): ModelProviderChoice | undefined {
  return MODEL_PROVIDER_CHOICES.find((choice) => choice.id === id);
}

export type ProviderReadiness =
  | 'Ready'
  | 'Sign in required'
  /** A key is pasted into this page -- there is no sign-in to perform. */
  | 'API key required'
  /** An ambient credential chain, configured outside Station entirely. */
  | 'Credentials required'
  | 'Found, not connected'
  /**
   * The endpoint answered but exposes no usable model catalogue. Reachability
   * is proven; chat is not. Never Ready, never a refusal.
   */
  | 'Reachable — no model catalog'
  /**
   * RT-06: a model connection's `status` is derived from "a non-empty string
   * is saved in the key box", so a knowingly invalid key read "Ready" on both
   * this hub card and the provider page. This is what the server actually
   * computed until something asks the provider and it answers.
   */
  | 'Saved — not verified'
  /** An explicit check ran against this configuration and was refused. */
  | 'Check failed'
  /**
   * Station could not reach the endpoint on its last try, but a prior pass is
   * still inside the documented grace window, so this is a degraded-
   * reachability notice rather than a verdict.
   */
  | 'Unreachable — retrying'
  /** Unreachable for long enough that Station has stopped calling it transient. */
  | 'Cannot reach provider'
  | 'Setup required'
  | 'Limited'
  | 'Disabled'
  | 'Unreachable';

type ProviderTone = 'ready' | 'warn' | 'error' | 'disabled';

type ProviderCatalogKind = 'model' | 'agent' | 'command';

interface ProviderCatalogInputBase {
  id: string;
  kind: ProviderCatalogKind;
  type: string;
  name: string;
  brand?: string;
  enabled: boolean;
  status: string;
  href: string;
  prerequisites?: Prerequisite[];
  /** Provider-specific setup copy when no stronger readiness applies. */
  description?: string;
  readOnly?: boolean;
  /**
   * The server's own readiness derivation for this connection. Present for a
   * real connection, absent for a catalog discovery card (which names a thing
   * this Station has never observed).
   */
  readinessEvidence?: ConnectionReadinessEvidence;
}

/**
 * A provider either has the server's authoritative Agent setup observation,
 * or setup is not applicable to this row (model connections, configured ACP
 * rows, and catalog discovery cards). The latter is intentionally explicit:
 * callers may attach the one discovery fact the row actually observed, but
 * may not synthesize a three-state setup tuple from it.
 */
type ProviderCatalogInput =
  | (ProviderCatalogInputBase & {
      setup: AgentConnectionView['setup'];
      discovery?: never;
    })
  | (ProviderCatalogInputBase & {
      setup: null;
      discovery?: 'detected-unconfigured';
    });

type ProviderCatalogItem = ProviderCatalogInput & {
  brand: string;
  readiness: ProviderReadiness;
  tone: ProviderTone;
  detail: string;
  actionLabel: string;
  accessibleName: string;
  duplicateBrandIndex: number | null;
  duplicateBrandCount: number;
};

interface ProviderChoicePresentation {
  badge?: string;
  detail: string;
}

const BRAND_BY_TYPE: Record<string, string> = {
  anthropic: 'Anthropic',
  bedrock: 'Amazon Bedrock',
  claude: 'Claude',
  codex: 'Codex',
  google: 'Google',
  ollama: 'Ollama',
  openai: 'OpenAI',
  'openai-compat': 'OpenAI compatible',
};

function normalizeBrand(input: ProviderCatalogInput): string {
  if (input.brand?.trim()) return input.brand.trim();
  const type = input.type.toLowerCase();
  if (type === 'openai-compat') {
    const namedService = input.name
      .replace(/\s+(runtime|cli|provider|connection)$/i, '')
      .trim();
    return /openai[\s-]*compat/i.test(namedService)
      ? 'OpenAI compatible'
      : namedService;
  }
  const known = BRAND_BY_TYPE[type];
  if (known) return known;
  return input.name
    .replace(/\s+(runtime|cli|provider|connection)$/i, '')
    .trim();
}

/**
 * What an unmet prerequisite is asking the user to DO. Four remedies, because
 * the four are performed in four different places: a sign-in runs the engine's
 * own login, a key is pasted into this page, an ambient credential chain is
 * configured outside Station entirely, and setup is everything else.
 */
type PrerequisiteRemedy = 'sign-in' | 'api-key' | 'credentials' | 'setup';

/**
 * Matched against `id` and `name` only, never `description`. Descriptions are
 * prose written for a human and they routinely name a remedy they are not
 * asking for -- the missing-binary login prerequisite's own description reads
 * "CLI must be installed before authentication can be verified", which is a
 * sentence about installing that contains the word "authentication". Ids are
 * structured by their producers (`<cmd>-cli`, `<cmd>-auth`,
 * `anthropic-api-key`, `bedrock-credentials`, `ollama-server`), so they are
 * what carries the fact.
 */
export function prerequisiteRemedy(
  prerequisite: Prerequisite,
): PrerequisiteRemedy {
  const subject = `${prerequisite.id} ${prerequisite.name}`;
  if (/api[\s-]?key/i.test(subject)) return 'api-key';
  if (/log[\s-]?in|sign[\s-]?in|auth/i.test(subject)) return 'sign-in';
  if (/credential/i.test(subject)) return 'credentials';
  return 'setup';
}

/**
 * The prerequisite actually blocking this connection: the FIRST unmet one, in
 * the order the server reported it, preferring a required entry over an
 * optional one.
 *
 * ORDER IS THE FACT. Producers emit prerequisites in dependency order --
 * `buildCliRuntimePrerequisites` pushes the CLI's presence before its login,
 * and says why in the login entry it writes when the binary is absent: "CLI
 * must be installed before authentication can be verified." Reading that list
 * as a SET is what made a missing binary report "Sign in required": the former
 * `requiresSignIn` regex-matched the `<cmd>-auth` id and returned before any
 * presence check ran, so a user whose engine was not installed was told to
 * sign in -- naming a remedy they could not perform, and hiding the one they
 * could. It also caught `anthropic-api-key` and `bedrock-credentials`, so a
 * missing API key and an unconfigured AWS credential chain both read as
 * "Sign in" too, for providers that have no sign-in at all.
 */
export function blockingPrerequisite(
  prerequisites: Prerequisite[],
): Prerequisite | undefined {
  // Required only. An optional prerequisite does not block by definition, and
  // the one the server actually emits (`acp-connection`, a custom engine that
  // is not currently available) never matched the former regex either -- so
  // widening to it here would change a state this fix has no business
  // touching.
  const unmet = prerequisites.filter(
    (prerequisite) =>
      prerequisite.category === 'required' &&
      prerequisite.status !== 'installed',
  );
  // Presence outranks credential, explicitly rather than by emission order: a
  // credential cannot be verified until the thing that holds it exists, which
  // is what the server's own login entry says when the binary is absent. Left
  // implicit, this guarantee would rest on every producer happening to list
  // its prerequisites in dependency order -- a contract nothing enforces.
  return (
    unmet.find(
      (prerequisite) => prerequisiteRemedy(prerequisite) === 'setup',
    ) ?? unmet[0]
  );
}

/**
 * Which host-naming entry describes this remedy. The map owns the sentences;
 * this owns only the choice of which one applies, and it is deliberately the
 * ONE place that choice is made -- `HostAction` reads `reach` from the entry
 * rather than from the call site, precisely so that a surface cannot decide
 * that something requiring the host's hands is remote-safe.
 *
 * An engine that is not installed takes `engine-missing`, whose copy is about
 * agent CLIs specifically. A model provider's unmet setup is not that -- its
 * remedy is a field on this very page -- so it takes the api-key entry, which
 * is remote-safe and names the machine that will hold the value.
 */
export function hostActionIdForRemedy(
  remedy: PrerequisiteRemedy,
  kind: ProviderCatalogKind,
): HostActionId {
  switch (remedy) {
    case 'sign-in':
      return 'connection-sign-in';
    case 'credentials':
      return 'connection-credentials';
    case 'api-key':
      return 'connection-api-key';
    default:
      return kind === 'agent' ? 'engine-missing' : 'connection-api-key';
  }
}

const REMEDY_PRESENTATION: Record<
  PrerequisiteRemedy,
  { readiness: ProviderReadiness; actionLabel: string; fallbackDetail: string }
> = {
  'sign-in': {
    readiness: 'Sign in required',
    actionLabel: 'Sign in',
    fallbackDetail: 'Sign in to finish connecting.',
  },
  'api-key': {
    readiness: 'API key required',
    actionLabel: 'Add key',
    fallbackDetail: 'Add an API key to finish connecting.',
  },
  credentials: {
    readiness: 'Credentials required',
    actionLabel: 'Set up',
    fallbackDetail: 'Configure credentials to finish connecting.',
  },
  setup: {
    readiness: 'Setup required',
    actionLabel: 'Set up',
    fallbackDetail: 'Finish setup before using it.',
  },
};

export function resolveProviderPresentation(
  input: ProviderCatalogInput,
): Pick<
  ProviderCatalogItem,
  'brand' | 'readiness' | 'tone' | 'detail' | 'actionLabel'
> {
  const brand = normalizeBrand(input);
  const prerequisites = input.prerequisites ?? [];

  if (!input.enabled || input.status === 'disabled') {
    return {
      brand,
      readiness: 'Disabled',
      tone: 'disabled',
      detail: 'Turn this on when you want to use it.',
      actionLabel: input.readOnly ? 'Details' : 'Enable',
    };
  }

  const blocker = blockingPrerequisite(prerequisites);
  if (blocker) {
    const presentation = REMEDY_PRESENTATION[prerequisiteRemedy(blocker)];
    return {
      brand,
      readiness: presentation.readiness,
      tone: 'warn',
      // The server authored a description FOR this prerequisite. Preferring it
      // to the generic sentence is what turns "Sign in to finish connecting."
      // into the reason this particular connection is not usable.
      detail: blocker.description?.trim() || presentation.fallbackDetail,
      actionLabel: presentation.actionLabel,
    };
  }

  if (input.setup?.state === 'ready') {
    return {
      brand,
      readiness: 'Ready',
      tone: 'ready',
      detail: 'Ready to use in chats and agents.',
      actionLabel: 'Details',
    };
  }

  if (input.setup?.state === 'configured') {
    return {
      brand,
      readiness: 'Setup required',
      tone: 'warn',
      detail: input.description ?? 'Finish setup before using it.',
      actionLabel: 'Set up',
    };
  }

  if (input.setup?.state === 'available' && input.setup.detected) {
    return {
      brand,
      readiness: 'Found, not connected',
      tone: 'warn',
      detail: 'Found on the computer Station runs on — not yet connected.',
      actionLabel: 'Connect',
    };
  }

  if (input.setup === null && input.discovery === 'detected-unconfigured') {
    return {
      brand,
      readiness: 'Found, not connected',
      tone: 'warn',
      detail: 'Found on the computer Station runs on — not yet connected.',
      actionLabel: 'Connect',
    };
  }

  /*
   * RT-06 / 6-OPS-27 — one readiness derivation, read by the hub card and the
   * provider page alike. `status: 'ready'` on a model connection only means
   * its prerequisites are satisfied, and the only required prerequisite is a
   * saved key; the server already computes what actually happened
   * (`readinessEvidence`) and every consumer used to discard it. A connection
   * whose explicit check was refused cannot read as usable, and one nothing
   * has asked yet says so rather than claiming Ready.
   */
  const evidence = input.readinessEvidence;
  if (input.kind === 'model' && evidence) {
    // a passed smoke is a complete chat turn against this
    // connection — strictly stronger evidence than any catalogue answer — so
    // it is read BEFORE a refusal, not after it. Ordering these the other way
    // meant a smoke could never repair the presentation.
    //
    // only before an OLDER one. Smoke receipts stay fresh
    // for 24 hours, so unconditional precedence rendered "Ready" over a
    // genuine refusal observed after the smoke. `connectionCheckOutranksSmoke`
    // is the same derivation the server used to compute `level`, imported
    // rather than restated, so this screen cannot reach a different verdict
    // about the same two timestamps.
    const checkSpeaks =
      evidence.level !== 'smoke-passed' ||
      connectionCheckOutranksSmoke(evidence.check, evidence.smoke);
    if (checkSpeaks) {
      if (evidence.check?.status === 'failed') {
        return {
          brand,
          readiness: 'Check failed',
          tone: 'error',
          detail:
            evidence.summary ||
            'The last connection test was refused by the service.',
          actionLabel: 'Fix and test again',
        };
      }
      /*
       * the endpoint answered and has no usable model
       * catalogue. That proves reachability and nothing about chat, so it is
       * neither a refusal nor Ready — an OpenAI-compatible server that serves
       * chat and no `/models` lives here until an explicit test drives its
       * chat route.
       */
      /*
       * Station could not reach the endpoint. While the
       * server says it is still retrying (a prior pass, inside the documented
       * grace window) this is a degraded-reachability notice, not a refusal —
       * one DNS blip on one listing must not read as "this connection is
       * broken". Once the grace window closes the server stops setting
       * `retrying`, and the same status reads as a fault.
       */
      if (evidence.check?.status === 'unreachable') {
        return evidence.check.retrying
          ? {
              brand,
              readiness: 'Unreachable — retrying',
              tone: 'warn',
              detail:
                evidence.summary ||
                'Station could not reach this connection on its last try, and is still retrying.',
              actionLabel: 'Test connection',
            }
          : {
              brand,
              readiness: 'Cannot reach provider',
              tone: 'error',
              detail:
                evidence.summary || 'Station could not reach this connection.',
              actionLabel: 'Fix and test again',
            };
      }
      if (evidence.check?.status === 'catalog-unavailable') {
        return {
          brand,
          readiness: 'Reachable — no model catalog',
          tone: 'warn',
          detail:
            'The service answered but offers no model list. Run Test Connection or start a chat to verify it can actually run work.',
          actionLabel: 'Test connection',
        };
      }
    }
    /*
     * `catalog-ready` alone used to be enough, and every listing
     * runs catalogue discovery — so a connection could read "Ready" with
     * `check.status: 'not-checked'`, which is the claim exists to remove.
     * Discovery is now recorded as a real bound check
     * (`source: 'catalog-discovery'`), so the ONLY things that make a model
     * connection Ready are a provider that answered and a smoke that passed.
     * A level with no receipt behind it means nobody reached the provider —
     * a timeout, an abort, or a fallback to configured selectors.
     */
    if (
      (input.status === 'ready' || input.status === 'available') &&
      evidence.level !== 'smoke-passed' &&
      evidence.check?.status !== 'passed'
    ) {
      return {
        brand,
        readiness: 'Saved — not verified',
        tone: 'warn',
        detail:
          'Settings are saved. Nothing has asked this connection yet — test it to be sure.',
        actionLabel: 'Test connection',
      };
    }
  }

  if (input.status === 'ready' || input.status === 'available') {
    return {
      brand,
      readiness: 'Ready',
      tone: 'ready',
      detail: 'Ready to use in chats and agents.',
      actionLabel: 'Details',
    };
  }

  if (input.status === 'degraded') {
    return {
      brand,
      readiness: 'Limited',
      tone: 'warn',
      detail: 'Available with limited capabilities. Review the details.',
      actionLabel: 'Review',
    };
  }

  if (input.status === 'error' || input.status === 'disconnected') {
    return {
      brand,
      readiness: 'Unreachable',
      tone: 'error',
      detail: 'Station cannot reach it right now.',
      actionLabel: input.readOnly ? 'Details' : 'Reconnect',
    };
  }

  return {
    brand,
    readiness: 'Setup required',
    tone: 'warn',
    detail:
      input.description ??
      (input.setup?.detected
        ? 'Station found it on the computer it runs on. Finish setup to use it.'
        : 'Finish setup before using it.'),
    actionLabel: 'Set up',
  };
}

/** Projects the catalog resolver result into the compact picker shape. */
export function resolveProviderChoicePresentation(
  input: ProviderCatalogInput,
): ProviderChoicePresentation {
  const presentation = resolveProviderPresentation(input);
  return { badge: presentation.readiness, detail: presentation.detail };
}

export function buildProviderCatalog(
  inputs: ProviderCatalogInput[],
): ProviderCatalogItem[] {
  const byId = new Map<string, ProviderCatalogInput>();
  for (const input of inputs) {
    if (!byId.has(input.id)) byId.set(input.id, input);
  }

  const resolved = Array.from(byId.values()).map((input) => ({
    input,
    presentation: resolveProviderPresentation(input),
  }));
  const brandCounts = new Map<string, number>();
  for (const { presentation } of resolved) {
    brandCounts.set(
      presentation.brand,
      (brandCounts.get(presentation.brand) ?? 0) + 1,
    );
  }
  const sorted = resolved.sort((left, right) => {
    const brandOrder = left.presentation.brand.localeCompare(
      right.presentation.brand,
    );
    return brandOrder !== 0
      ? brandOrder
      : left.input.name.localeCompare(right.input.name) ||
          left.input.id.localeCompare(right.input.id);
  });
  const brandIndexes = new Map<string, number>();

  return sorted.map(({ input, presentation }): ProviderCatalogItem => {
    const duplicateBrandCount = brandCounts.get(presentation.brand) ?? 1;
    const duplicateBrandIndex =
      duplicateBrandCount > 1
        ? (brandIndexes.get(presentation.brand) ?? 0) + 1
        : null;
    if (duplicateBrandIndex !== null) {
      brandIndexes.set(presentation.brand, duplicateBrandIndex);
    }
    const identity =
      input.name === presentation.brand
        ? presentation.brand
        : `${presentation.brand} — ${input.name}`;
    const duplicateIdentity =
      duplicateBrandIndex === null
        ? identity
        : `${identity} — instance ${duplicateBrandIndex} of ${duplicateBrandCount}`;

    return {
      ...input,
      ...presentation,
      duplicateBrandIndex,
      duplicateBrandCount,
      accessibleName: `${duplicateIdentity} — ${presentation.readiness} — ${presentation.actionLabel}`,
    };
  });
}
