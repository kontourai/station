const COMPLEXITY_MARKERS = [
  'architecture',
  'backward compatibility',
  'compliance',
  'debug',
  'diagnose',
  'migration',
  'multi-step',
  'performance',
  'production',
  'refactor',
  'security',
  'test plan',
  'typescript',
];

const BUDGET_MARKERS = ['cheap', 'fast', 'low cost', 'quick', 'simple'];

function normalizeText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object') {
          return normalizeText(entry.content ?? entry.text ?? entry.prompt);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function extractDecisionText(input) {
  if (!input || typeof input !== 'object') return '';
  return normalizeText(
    input.prompt ??
      input.task ??
      input.input ??
      input.text ??
      input.messages ??
      input.conversation,
  ).trim();
}

function includesAny(text, markers) {
  const lower = text.toLowerCase();
  return markers.some((marker) => lower.includes(marker));
}

export function decideRoute(input) {
  const text = extractDecisionText(input);
  const charCount = text.length;
  const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const explicitTier =
    typeof input?.modelTier === 'string'
      ? input.modelTier
      : typeof input?.tier === 'string'
        ? input.tier
        : null;
  const supportedExplicitTier = ['cheap', 'strong', 'default'].includes(
    explicitTier,
  )
    ? explicitTier
    : null;

  const signals = {
    charCount,
    wordCount,
    hasBudgetIntent: includesAny(text, BUDGET_MARKERS),
    hasCodeBlock:
      text.includes('```') || /(^|\n)\s*(function|class|export)\s/m.test(text),
    hasComplexIntent: includesAny(text, COMPLEXITY_MARKERS),
    hasLongContext: charCount > 800 || wordCount > 120,
  };

  if (supportedExplicitTier) {
    return {
      fallbackUsed: false,
      modelTier: supportedExplicitTier,
      reason: 'explicit-tier',
      signals,
    };
  }

  if (!text) {
    return {
      fallbackUsed: true,
      modelTier: 'default',
      reason: 'no-routable-input',
      signals,
    };
  }

  if (
    signals.hasComplexIntent ||
    signals.hasCodeBlock ||
    signals.hasLongContext
  ) {
    return {
      fallbackUsed: false,
      modelTier: 'strong',
      reason: 'complexity-signals',
      signals,
    };
  }

  return {
    fallbackUsed: false,
    modelTier: 'cheap',
    reason: signals.hasBudgetIntent ? 'budget-intent' : 'short-context',
    signals,
  };
}

async function readDecisionInput(c) {
  if (c.req.method === 'GET') {
    const url = new URL(c.req.url);
    return {
      prompt: url.searchParams.get('prompt') ?? url.searchParams.get('q') ?? '',
      tier: url.searchParams.get('tier') ?? undefined,
    };
  }
  return c.req.json().catch(() => ({}));
}

async function decide(c, context) {
  const input = await readDecisionInput(c);
  const decision = decideRoute(input);
  context.telemetry?.recordRoutingDecision?.({
    fallbackUsed: decision.fallbackUsed,
    modelTier: decision.modelTier,
    reason: decision.reason,
  });
  return c.json(decision);
}

export default function register(app, context) {
  app.get('/decide', (c) => decide(c, context));
  app.post('/decide', (c) => decide(c, context));
}
