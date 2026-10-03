/**
 * archive#3552: read one credential's quota from the provider that owns it.
 *
 * This module is a READER. It never mints, refreshes, or stores a credential —
 * it borrows the access token an engine already wrote into a config directory,
 * asks that provider how much of the account's quota is spent, and normalizes
 * the two providers' differing shapes into one.
 *
 * ## Why Station does not identify as the CLI
 *
 * The reference implementation for this feature (CLIProxyAPIPlus's management
 * UI) sends `Originator: Codex Desktop` and a `claude-cli/<version>`
 * User-Agent. Both were tested against these endpoints and **neither is
 * load-bearing**: Codex answers 200 on `Authorization` + `Chatgpt-Account-Id`
 * alone, and Claude answers 200 on a bare bearer. Station therefore sends
 * neither. Reading your own account's usage is not the inference path, and it
 * does not need to borrow anyone's identity to work.
 *
 * ## Unknown is not zero
 *
 * Every failure path returns `{ status: 'unknown', reason }` — never a zeroed
 * window. A meter that reads empty because nothing has been used and one that
 * reads empty because the request failed must not be the same value, or the
 * page reports a healthy account when it has no idea.
 *
 * ## The provider's verdict beats a recomputed one
 *
 * Both payloads already carry the provider's own judgement — Claude's
 * `severity` and `extra_usage.spend_limit_reached`, Codex's `allowed` /
 * `limit_reached` / `spend_control.reached`. Those are carried through as
 * `exhausted`, rather than re-deriving "is this account spent?" from a
 * percentage. A locally recomputed threshold that disagrees with the provider
 * is a label nothing derives.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type {
  EngineAccountUsage as CredentialUsage,
  EngineAccountUsageWindow as CredentialUsageWindow,
} from '@kontourai/station-contracts/engine-accounts';
import { projectUsageMetadata } from './credential-usage-metadata.js';

export type { CredentialUsage };

export interface UsageFetchDeps {
  fetch: typeof globalThis.fetch;
  now: () => Date;
  readTextFile: (path: string) => Promise<string>;
  readClaudeSecureCredentials?: (
    configDir: string,
  ) => Promise<string | undefined>;
}

const execFileAsync = promisify(execFile);
async function readClaudeSecureCredentials(
  configDir: string,
  defaultNamespace = configDir === join(homedir(), '.claude') &&
    !process.env.CLAUDE_CONFIG_DIR &&
    !process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
) {
  if (process.platform !== 'darwin') return undefined;
  const account = process.env.USER || userInfo().username;
  if (!/^[a-zA-Z0-9._-]+$/.test(account)) return undefined;
  const suffix = createHash('sha256')
    .update(configDir.normalize('NFC'))
    .digest('hex')
    .slice(0, 8);
  const services = defaultNamespace
    ? ['Claude Code-credentials']
    : [`Claude Code-credentials-${suffix}`];
  for (const service of services) {
    try {
      const { stdout } = await execFileAsync(
        '/usr/bin/security',
        ['find-generic-password', '-a', account, '-w', '-s', service],
        { timeout: 5000, maxBuffer: 65536, windowsHide: true },
      );
      return stdout;
    } catch {
      /* This namespace has no readable Keychain entry. */
    }
  }
  return undefined;
}

export function defaultUsageFetchDeps(namespace?: {
  dir: string;
  defaultNamespace: boolean;
}): UsageFetchDeps {
  return {
    fetch: (...args) => globalThis.fetch(...args),
    now: () => new Date(),
    readTextFile: (path) => readFile(path, 'utf8'),
    readClaudeSecureCredentials: (dir) =>
      namespace
        ? readClaudeSecureCredentials(namespace.dir, namespace.defaultNamespace)
        : readClaudeSecureCredentials(dir),
  };
}

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const REQUEST_TIMEOUT_MS = 10_000;

const unknown = (deps: UsageFetchDeps, reason: string): CredentialUsage => ({
  status: 'unknown',
  fetchedAt: deps.now().toISOString(),
  reason,
});

/**
 * 0-100, integer, or undefined when the value is not a usable number.
 *
 * A NEGATIVE is not clamped to 0 (independent review): -20 is not "nothing
 * used", it is a value this code does not understand, and rendering it as an
 * empty meter is the fail-open the module exists to prevent. Above 100 does
 * clamp, because "more than full" is still unambiguously full.
 */
function percent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0) return undefined;
  return Math.min(100, Math.round(value));
}

function isoFromEpochSeconds(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  // `new Date(1e15 * 1000).toISOString()` throws RangeError. A reset time we
  // cannot represent is an absent reset time, never a thrown request.
  const at = new Date(value * 1000);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

function isoFromIsoString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

async function getJson(
  deps: UsageFetchDeps,
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await deps.fetch(url, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      // 401 is the common, actionable one: the stored token expired and the
      // engine has not refreshed it. Say that rather than "failed".
      return {
        ok: false,
        reason:
          response.status === 401 || response.status === 403
            ? 'The stored credential was rejected. Sign in again for this account.'
            : `The provider returned ${response.status}.`,
      };
    }
    return { ok: true, body: await response.json() };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error && error.name === 'AbortError'
          ? 'The provider did not respond in time.'
          : 'The provider could not be reached.',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** On macOS the CLI's selected Keychain namespace wins over a legacy file. */
async function claudeAccessToken(
  deps: UsageFetchDeps,
  configDir: string,
): Promise<{ token: string; storage: 'secure-store' | 'file' } | undefined> {
  const decode = (contents: string | undefined): string | undefined => {
    try {
      if (!contents) return undefined;
      const parsed = JSON.parse(contents) as {
        claudeAiOauth?: { accessToken?: unknown };
      };
      const token = parsed.claudeAiOauth?.accessToken;
      return typeof token === 'string' && token ? token : undefined;
    } catch {
      return undefined;
    }
  };
  const secure = decode(await deps.readClaudeSecureCredentials?.(configDir));
  if (secure) return { token: secure, storage: 'secure-store' };
  try {
    const token = decode(
      await deps.readTextFile(join(configDir, '.credentials.json')),
    );
    return token ? { token, storage: 'file' } : undefined;
  } catch {
    return undefined;
  }
}

/** `<configDir>/auth.json` — the file `detectCodexAuthState` reads. */
async function codexAuth(
  deps: UsageFetchDeps,
  configDir: string,
): Promise<{ token: string; accountId?: string } | undefined> {
  try {
    const parsed = JSON.parse(
      await deps.readTextFile(join(configDir, 'auth.json')),
    ) as { access_token?: unknown; account_id?: unknown; tokens?: unknown };
    const direct = parsed.access_token;
    const nested = (parsed.tokens as { access_token?: unknown } | undefined)
      ?.access_token;
    const token = typeof direct === 'string' && direct ? direct : nested;
    if (typeof token !== 'string' || !token) return undefined;
    const nestedAccountId = (
      parsed.tokens as { account_id?: unknown } | undefined
    )?.account_id;
    const accountId = parsed.account_id ?? nestedAccountId;
    return {
      token,
      ...(typeof accountId === 'string' && accountId ? { accountId } : {}),
    };
  } catch {
    return undefined;
  }
}

const CLAUDE_PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  pro: 'Pro',
  max: 'Max',
  max_5x: 'Max 5x',
  max_20x: 'Max 20x',
  team: 'Team',
};

/**
 * Independent review (Codex) found three adversarial 200 bodies that threw
 * straight past the "every failure is `unknown`" guarantee — `null`,
 * `{limits:{}}` (`.some` is not a function), and an out-of-range `reset_at`.
 * A throw here does not degrade to unknown, it rejects the request, and the
 * route's `Promise.all` then turned one malformed account into a 500 for every
 * other account too.
 *
 * The parse is therefore fenced: anything the normalizer cannot survive is a
 * reading we do not have, which is exactly `unknown`.
 */
async function normalizedOrUnknown(
  deps: UsageFetchDeps,
  normalize: () => CredentialUsage,
): Promise<CredentialUsage> {
  try {
    return normalize();
  } catch {
    return unknown(
      deps,
      'The provider returned a response this version does not understand.',
    );
  }
}

function withCredentialStorage(
  usage: CredentialUsage,
  storage: 'secure-store' | 'file',
): CredentialUsage {
  return usage.metadata
    ? {
        ...usage,
        metadata: {
          ...usage.metadata,
          capture: { ...usage.metadata.capture, credentialStorage: storage },
        },
      }
    : usage;
}

export async function readClaudeUsage(
  configDir: string,
  deps: UsageFetchDeps = defaultUsageFetchDeps(),
): Promise<CredentialUsage> {
  const auth = await claudeAccessToken(deps, configDir);
  if (!auth) {
    return unknown(deps, 'No signed-in credential was found for this account.');
  }
  const result = await getJson(deps, CLAUDE_USAGE_URL, {
    Authorization: `Bearer ${auth.token}`,
    // The OAuth-scoped read requires the beta opt-in; it is a capability
    // header, not a client identity, and is the only header sent beyond auth.
    'anthropic-beta': 'oauth-2025-04-20',
    Accept: 'application/json',
  });
  if (!result.ok) return unknown(deps, result.reason);
  return withCredentialStorage(
    await normalizedOrUnknown(deps, () => normalizeClaude(deps, result.body)),
    auth.storage,
  );
}

function normalizeClaude(deps: UsageFetchDeps, raw: unknown): CredentialUsage {
  const body = (raw ?? {}) as {
    five_hour?: { utilization?: unknown; resets_at?: unknown };
    seven_day?: { utilization?: unknown; resets_at?: unknown };
    limits?: Array<{
      kind?: unknown;
      percent?: unknown;
      severity?: unknown;
      resets_at?: unknown;
      scope?: { model?: { display_name?: unknown } };
    }>;
    extra_usage?: { spend_limit_reached?: unknown };
    plan?: unknown;
  };

  const windows: CredentialUsageWindow[] = [];
  const fiveHour = percent(body.five_hour?.utilization);
  if (fiveHour !== undefined) {
    windows.push({
      id: 'five-hour',
      label: '5-hour limit',
      usedPercent: fiveHour,
      ...(isoFromIsoString(body.five_hour?.resets_at)
        ? { resetsAt: isoFromIsoString(body.five_hour?.resets_at) as string }
        : {}),
    });
  }
  const sevenDay = percent(body.seven_day?.utilization);
  if (sevenDay !== undefined) {
    windows.push({
      id: 'seven-day',
      label: '7-day limit',
      usedPercent: sevenDay,
      ...(isoFromIsoString(body.seven_day?.resets_at)
        ? { resetsAt: isoFromIsoString(body.seven_day?.resets_at) as string }
        : {}),
    });
  }
  const modelWindows = raw && typeof raw === 'object' ? raw : {};
  for (const [key, label] of [
    ['seven_day_sonnet', 'Weekly · Sonnet'],
    ['seven_day_opus', 'Weekly · Opus'],
    ['seven_day_oauth_apps', 'Weekly · OAuth apps'],
    ['seven_day_cowork', 'Weekly · Cowork'],
  ] as const) {
    if (!(key in modelWindows)) continue;
    const window = (modelWindows as Record<string, unknown>)[key];
    if (!window || typeof window !== 'object') continue;
    const record = window as { utilization?: unknown; resets_at?: unknown };
    const value = percent(record.utilization);
    if (value === undefined) continue;
    const resetsAt = isoFromIsoString(record.resets_at);
    windows.push({
      id: key,
      label,
      usedPercent: value,
      durationSeconds: 604800,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  // Per-model rows: `weekly_scoped` entries name their model in `scope`.
  for (const limit of Array.isArray(body.limits) ? body.limits : []) {
    if (limit?.kind !== 'weekly_scoped') continue;
    const modelName = limit.scope?.model?.display_name;
    const value = percent(limit.percent);
    if (typeof modelName !== 'string' || !modelName || value === undefined) {
      continue;
    }
    windows.push({
      id: `weekly-${modelName}`,
      label: `7-day ${modelName}`,
      usedPercent: value,
      ...(isoFromIsoString(limit.resets_at)
        ? { resetsAt: isoFromIsoString(limit.resets_at) as string }
        : {}),
    });
  }

  // The provider's own verdicts, never a threshold of our own.
  const severeLimit = (Array.isArray(body.limits) ? body.limits : []).some(
    (limit) => limit?.severity === 'exhausted' || limit?.severity === 'blocked',
  );
  const spendLimitReached = body.extra_usage?.spend_limit_reached === true;
  const exhausted = severeLimit || spendLimitReached;

  // Zero derivable windows usually means schema drift, and reporting `ok`
  // there would render a card saying the account is fine when we cannot tell.
  //
  // But "no percentage windows" is NOT "nothing recognizable" (review round 2,
  // Codex): a provider can state an explicit exhaustion verdict with no usable
  // percentages, and the first version of this guard threw that away and hid
  // "Limit reached" behind `unknown`. A recognized verdict is information, so
  // it survives; only a payload that yielded neither is unknown.
  const planKey = typeof body.plan === 'string' ? body.plan : undefined;
  if (windows.length === 0 && !exhausted) {
    return {
      ...unknown(
        deps,
        'The provider reported no limits this version recognizes.',
      ),
      ...(planKey ? { planLabel: CLAUDE_PLAN_LABELS[planKey] ?? planKey } : {}),
      metadata: projectUsageMetadata('claude', raw),
    };
  }
  return {
    status: 'ok',
    fetchedAt: deps.now().toISOString(),
    ...(planKey ? { planLabel: CLAUDE_PLAN_LABELS[planKey] ?? planKey } : {}),
    windows,
    exhausted,
    metadata: projectUsageMetadata('claude', raw),
  };
}

const CODEX_PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
};

export async function readCodexUsage(
  configDir: string,
  deps: UsageFetchDeps = defaultUsageFetchDeps(),
): Promise<CredentialUsage> {
  const auth = await codexAuth(deps, configDir);
  if (!auth) {
    return unknown(deps, 'No signed-in credential was found for this account.');
  }
  const result = await getJson(deps, CODEX_USAGE_URL, {
    Authorization: `Bearer ${auth.token}`,
    ...(auth.accountId ? { 'Chatgpt-Account-Id': auth.accountId } : {}),
    Accept: 'application/json',
  });
  if (!result.ok) return unknown(deps, result.reason);
  return withCredentialStorage(
    await normalizedOrUnknown(deps, () => normalizeCodex(deps, result.body)),
    'file',
  );
}

function durationLabel(seconds: unknown, fallback: string): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0)
    return fallback;
  const duration =
    seconds === 604800
      ? 'Weekly'
      : seconds % 86400 === 0
        ? `${seconds / 86400}-day`
        : seconds % 3600 === 0
          ? `${seconds / 3600}-hour`
          : `${Math.round(seconds / 60)}-minute`;
  return fallback.includes(' · ')
    ? `${fallback.split(' · ')[0]} · ${duration.toLowerCase()}`
    : `${duration} limit`;
}

function normalizeCodex(deps: UsageFetchDeps, raw: unknown): CredentialUsage {
  type CodexWindow = {
    used_percent?: unknown;
    reset_at?: unknown;
    limit_window_seconds?: unknown;
    reset_after_seconds?: unknown;
  };
  type CodexRateLimit = {
    allowed?: unknown;
    limit_reached?: unknown;
    primary_window?: CodexWindow;
    secondary_window?: CodexWindow;
  };
  const body = (raw ?? {}) as {
    plan_type?: unknown;
    rate_limit?: CodexRateLimit;
    additional_rate_limits?: Array<{
      limit_name?: unknown;
      metered_feature?: unknown;
      normal_model_slug?: unknown;
      rate_limit?: CodexRateLimit;
    }>;
    code_review_rate_limit?: CodexRateLimit;
    chatpass?: { windows?: CodexWindow[] };
    spend_control?: { reached?: unknown };
  };

  const windows: CredentialUsageWindow[] = [];
  const pushWindow = (
    id: string,
    label: string,
    window: CodexWindow | undefined,
    verdict?: CodexRateLimit,
    context?: { metered_feature?: unknown; normal_model_slug?: unknown },
  ) => {
    const value = percent(window?.used_percent);
    if (value === undefined) return;
    const resetsAt = isoFromEpochSeconds(window?.reset_at);
    windows.push({
      id,
      label: durationLabel(window?.limit_window_seconds, label),
      usedPercent: value,
      ...(typeof window?.limit_window_seconds === 'number' &&
      Number.isFinite(window.limit_window_seconds) &&
      window.limit_window_seconds > 0
        ? { durationSeconds: window.limit_window_seconds }
        : {}),
      ...(typeof verdict?.allowed === 'boolean'
        ? { allowed: verdict.allowed }
        : {}),
      ...(typeof verdict?.limit_reached === 'boolean'
        ? { limitReached: verdict.limit_reached }
        : {}),
      ...(typeof window?.reset_after_seconds === 'number' &&
      Number.isFinite(window.reset_after_seconds) &&
      window.reset_after_seconds >= 0
        ? { resetAfterSeconds: window.reset_after_seconds }
        : {}),
      ...(typeof context?.normal_model_slug === 'string' &&
      context.normal_model_slug.length <= 128
        ? { model: context.normal_model_slug }
        : {}),
      ...(typeof context?.metered_feature === 'string' &&
      context.metered_feature.length <= 128
        ? { meteredFeature: context.metered_feature }
        : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
  };

  pushWindow(
    'primary',
    'Primary limit',
    body.rate_limit?.primary_window,
    body.rate_limit,
  );
  pushWindow(
    'secondary',
    'Secondary limit',
    body.rate_limit?.secondary_window,
    body.rate_limit,
  );
  for (const [index, extra] of (Array.isArray(body.additional_rate_limits)
    ? body.additional_rate_limits
    : []
  ).entries()) {
    const name =
      typeof extra?.limit_name === 'string' && extra.limit_name
        ? extra.limit_name
        : `Additional ${index + 1}`;
    pushWindow(
      `${name}-primary`,
      `${name} · primary`,
      extra?.rate_limit?.primary_window,
      extra?.rate_limit,
      extra,
    );
    pushWindow(
      `${name}-weekly`,
      `${name} · secondary`,
      extra?.rate_limit?.secondary_window,
      extra?.rate_limit,
      extra,
    );
  }

  pushWindow(
    'code-review-primary',
    'Code review · primary',
    body.code_review_rate_limit?.primary_window,
    body.code_review_rate_limit,
  );
  pushWindow(
    'code-review-secondary',
    'Code review · secondary',
    body.code_review_rate_limit?.secondary_window,
    body.code_review_rate_limit,
  );
  for (const [index, window] of (Array.isArray(body.chatpass?.windows)
    ? body.chatpass.windows
    : []
  ).entries()) {
    pushWindow(`chatpass-${index}`, `Chat pass · window ${index + 1}`, window);
  }

  // The provider says so explicitly; do not infer it from used_percent.
  const exhausted =
    body.rate_limit?.limit_reached === true ||
    body.rate_limit?.allowed === false ||
    body.spend_control?.reached === true;

  // See the Claude normalizer: an explicit exhaustion verdict survives even
  // with no usable percentage windows.
  const planKey =
    typeof body.plan_type === 'string' ? body.plan_type : undefined;
  if (windows.length === 0 && !exhausted) {
    return {
      ...unknown(
        deps,
        'The provider reported no limits this version recognizes.',
      ),
      ...(planKey ? { planLabel: CODEX_PLAN_LABELS[planKey] ?? planKey } : {}),
      metadata: projectUsageMetadata('codex', raw),
    };
  }
  return {
    status: 'ok',
    fetchedAt: deps.now().toISOString(),
    ...(planKey ? { planLabel: CODEX_PLAN_LABELS[planKey] ?? planKey } : {}),
    windows,
    exhausted,
    metadata: projectUsageMetadata('codex', raw),
  };
}

/** Dispatch by the engine a credential belongs to. */
export async function readCredentialUsage(
  engine: 'claude' | 'codex',
  configDir: string,
  deps: UsageFetchDeps = defaultUsageFetchDeps(),
): Promise<CredentialUsage> {
  return engine === 'claude'
    ? readClaudeUsage(configDir, deps)
    : readCodexUsage(configDir, deps);
}
