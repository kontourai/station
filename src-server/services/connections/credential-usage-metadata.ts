import type { EngineAccountUsageMetadata } from '@kontourai/station-contracts/engine-accounts';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    ? value
    : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
function boolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
function range(value: unknown): number[] | undefined {
  return Array.isArray(value) &&
    value.length === 2 &&
    value.every((v) => number(v) !== undefined)
    ? value
    : undefined;
}
function date(value: unknown): string | undefined {
  const at =
    typeof value === 'number'
      ? new Date(value * 1000)
      : typeof value === 'string'
        ? new Date(value)
        : undefined;
  return at && Number.isFinite(at.getTime()) ? at.toISOString() : undefined;
}

// These paths describe fields consumed by the projection, not arbitrary values.
const codexPaths =
  /^(user_id|account_id|email|plan_type|rate_limit\.(allowed|limit_reached|(?:primary_window|secondary_window)\.(used_percent|limit_window_seconds|reset_after_seconds|reset_at))|additional_rate_limits\[\]\.(limit_name|metered_feature|normal_model_slug|rate_limit\.(allowed|limit_reached|(?:primary_window|secondary_window)\.(used_percent|limit_window_seconds|reset_after_seconds|reset_at)))|code_review_rate_limit\.(allowed|limit_reached|(?:primary_window|secondary_window)\.(used_percent|limit_window_seconds|reset_after_seconds|reset_at))|chatpass\.windows\[\]\.(used_percent|limit_window_seconds|reset_after_seconds|reset_at)|model_usage\[\]\.(available|available_at|credits_would_enable)|credits\.(has_credits|unlimited|overage_limit_reached|balance|approx_local_messages\[\]|approx_cloud_messages\[\])|spend_control\.reached|rate_limit_reset_credits\.(available_count|applicable_available_count))$/;
const claudePaths =
  /^(plan|(?:five_hour|seven_day|seven_day_sonnet|seven_day_opus|seven_day_oauth_apps|seven_day_cowork)\.(utilization|resets_at)|limits\[\]\.(kind|percent|severity|resets_at|scope\.model\.display_name)|extra_usage\.(is_enabled|used_credits|monthly_limit|utilization|spend_limit_reached))$/;
const excluded =
  /^(promo(?:\.|$)|spend_control\.individual_limit(?:\.|$)|rate_limit_reached_type$)/;

function audit(
  engine: 'claude' | 'codex',
  raw: unknown,
): EngineAccountUsageMetadata['capture'] {
  const unhandled = new Set<string>(),
    exclusions = new Set<string>();
  let leaves = 0,
    visited = 0,
    truncated = false;
  const walk = (value: unknown, path: string, depth: number) => {
    if (++visited > 2048 || leaves >= 256 || depth > 8) {
      truncated = true;
      return;
    }
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 32)) walk(item, `${path}[]`, depth + 1);
      if (value.length > 32) truncated = true;
    } else if (typeof value === 'object') {
      const keyLimit = path === 'model_usage' ? 32 : 64;
      const entries = Object.entries(value).slice(0, keyLimit);
      for (const [key, item] of entries) {
        if (
          !(
            path === 'model_usage'
              ? /^[a-zA-Z0-9_.-]{1,128}$/
              : /^[a-zA-Z0-9_-]{1,128}$/
          ).test(key)
        ) {
          truncated = true;
          continue;
        }
        walk(
          item,
          path === 'model_usage' ? `${path}[]` : path ? `${path}.${key}` : key,
          depth + 1,
        );
      }
      if (Object.keys(value).length > keyLimit) truncated = true;
    } else {
      leaves++;
      if (excluded.test(path)) exclusions.add(path);
      else if (!(engine === 'codex' ? codexPaths : claudePaths).test(path))
        unhandled.add(path);
    }
  };
  walk(raw, '', 0);
  return {
    source: engine === 'codex' ? 'codex-wham-usage' : 'claude-oauth-usage',
    unhandledFields: [...unhandled].sort(),
    excludedFields: [...exclusions].sort(),
    truncated,
  };
}

export function projectUsageMetadata(
  engine: 'claude' | 'codex',
  raw: unknown,
): EngineAccountUsageMetadata {
  const body = record(raw);
  const capture = audit(engine, raw);
  if (engine === 'claude') {
    const extra = record(body.extra_usage);
    return {
      capture,
      ...(Object.keys(extra).length
        ? {
            extraUsage: {
              enabled: boolean(extra.is_enabled),
              used: number(extra.used_credits),
              monthlyLimit: number(extra.monthly_limit),
              usedPercent: number(extra.utilization),
              limitReached: boolean(extra.spend_limit_reached),
            },
          }
        : {}),
    };
  }
  const credits = record(body.credits),
    resets = record(body.rate_limit_reset_credits);
  const balance =
    typeof credits.balance === 'string' &&
    /^\d+(?:\.\d+)?$/.test(credits.balance)
      ? number(Number(credits.balance))
      : number(credits.balance);
  return {
    capture,
    identity: {
      email: text(body.email),
      accountId: text(body.account_id),
      userId: text(body.user_id),
    },
    ...(Object.keys(credits).length
      ? {
          credits: {
            available: boolean(credits.has_credits),
            unlimited: boolean(credits.unlimited),
            balance,
            overageLimitReached: boolean(credits.overage_limit_reached),
            approximateLocalMessages: range(credits.approx_local_messages),
            approximateCloudMessages: range(credits.approx_cloud_messages),
          },
        }
      : {}),
    ...(Object.keys(resets).length
      ? {
          resetCredits: {
            available: number(resets.available_count),
            applicable: number(resets.applicable_available_count),
          },
        }
      : {}),
    models: Object.entries(record(body.model_usage))
      .slice(0, 32)
      .map(([id, value]) => {
        const model = record(value);
        return {
          id: id.slice(0, 128),
          available: boolean(model.available),
          availableAt: date(model.available_at),
          creditsWouldEnable: boolean(model.credits_would_enable),
        };
      }),
  };
}
