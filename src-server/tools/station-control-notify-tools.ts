/**
 * `notify_user` (#2584, epic #2582 section 2): an agent asks Station to
 * notify the people who can read its session.
 *
 * Authority never comes from arguments. The tool resolves its VERIFIED
 * calling session first (`requireStationControlCaller`) and refuses with
 * `caller-required` when this engine's station-control connection carries
 * none. Every assurance is accepted and recorded on the notification: the
 * audience is the session's own readers and the route's rate limits bound
 * what a copied credential can do. Station's REST side re-derives the caller
 * from the forwarded credential (`routes/operations/agent-notifications.ts`),
 * so this module's check is only an early, typed answer.
 *
 * Loaded by the stdio station-control child too, so it imports nothing from
 * Station's services: it speaks REST (`api`).
 */
import {
  NOTIFICATION_BODY_MAX,
  NOTIFICATION_DEDUPE_KEY_PATTERN,
  NOTIFICATION_LINK_MAX,
  NOTIFICATION_TITLE_MAX,
  type NotifyUserResult,
  type NotifyUserStatus,
} from '@kontourai/station-contracts/notification';
import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import {
  api,
  jsonToolResult,
  requireStationControlCaller,
  StationControlCallerRequiredError,
} from './station-control-shared.js';

/** Where Station serves the tool's REST side. */
const NOTIFY_USER_API_PATH = '/api/notifications/agent';

const NOTIFY_USER_TOOL_NAME = 'notify_user';

export const NOTIFY_USER_DESCRIPTION =
  'Send a notification to the user\'s devices (phone, desktop, browser). Use this only when the user would want to know now, even if they are away: you need their input or approval to continue, a long task they are waiting on finished or failed, or something time-sensitive happened. Do not use it for progress updates, routine completions the user is watching, or anything already visible in this conversation. It does not reply to the user; they may never see it if they are muted or it is rate-limited. Keep the title short and outcome-first ("Tests pass on fix-login", "Need approval to run migration"). Never put secrets, tokens, code or file contents in it. Use `dedupeKey` to update an earlier notification instead of sending another. Returns whether it was sent; if it was not, do not retry.';

const NOTIFY_USER_STATUSES: readonly NotifyUserStatus[] = [
  'sent',
  'updated',
  'deduped',
  'muted',
  'rate_limited',
  'unavailable',
  'caller-required',
];

const notifyUserShape = {
  title: z
    .string()
    // Whitespace-only is an input error the model can fix, not a send.
    .trim()
    .min(1)
    .max(NOTIFICATION_TITLE_MAX)
    .describe('Short, outcome-first headline.'),
  body: z
    .string()
    .max(NOTIFICATION_BODY_MAX)
    .optional()
    .describe(
      'One or two sentences of context. No secrets, code or file contents.',
    ),
  urgency: z
    .enum(['info', 'attention', 'done', 'failed'])
    .default('info')
    .describe(
      '`attention`: you need their input to continue. `failed`/`done`: a task they are waiting on ended. `info`: anything else time-sensitive.',
    ),
  dedupeKey: z
    .string()
    .regex(NOTIFICATION_DEDUPE_KEY_PATTERN)
    .optional()
    .describe(
      'Stable key (letters, digits, . _ : -; up to 64) to update your earlier notification instead of sending another.',
    ),
  link: z
    .string()
    .max(NOTIFICATION_LINK_MAX)
    .optional()
    .describe(
      'Relative Station path to open (e.g. "/projects/web"). Defaults to this session.',
    ),
};

function parseResult(value: unknown): NotifyUserResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (!(NOTIFY_USER_STATUSES as readonly unknown[]).includes(record.status))
    return undefined;
  return {
    status: record.status as NotifyUserStatus,
    ...(typeof record.notificationId === 'string'
      ? { notificationId: record.notificationId }
      : {}),
    ...(typeof record.retryAfterSec === 'number'
      ? { retryAfterSec: record.retryAfterSec }
      : {}),
  };
}

export async function notifyUser(args: {
  title: string;
  body?: string;
  urgency?: 'info' | 'attention' | 'done' | 'failed';
  dedupeKey?: string;
  link?: string;
}): Promise<NotifyUserResult> {
  try {
    await requireStationControlCaller();
  } catch (error) {
    if (!(error instanceof StationControlCallerRequiredError)) throw error;
    return { status: 'caller-required' };
  }
  let response: unknown;
  try {
    // `api` forwards this call's caller credential; the route re-verifies it.
    response = await api(NOTIFY_USER_API_PATH, {
      method: 'POST',
      body: JSON.stringify({
        title: args.title,
        urgency: args.urgency ?? 'info',
        ...(args.body === undefined ? {} : { body: args.body }),
        ...(args.dedupeKey === undefined ? {} : { dedupeKey: args.dedupeKey }),
        ...(args.link === undefined ? {} : { link: args.link }),
      }),
    });
  } catch {
    return { status: 'unavailable' };
  }
  // Anything but the route's own answer (an unmounted path, an error
  // envelope) reads as unavailable rather than as a claim it was sent.
  return parseResult(response) ?? { status: 'unavailable' };
}

export function registerNotifyTools(registry: StationControlToolRegistry) {
  registry.tool(
    NOTIFY_USER_TOOL_NAME,
    NOTIFY_USER_DESCRIPTION,
    notifyUserShape,
    async (args) => jsonToolResult(await notifyUser(args)),
  );
}
