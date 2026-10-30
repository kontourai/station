/**
 * The caller-hint rule (`chatErrorHintFor`), across every branch of
 * `translateChatError`. Full access sees each translation's hint unchanged.
 * A caller the server's open read refused a send (`continue === false`) or a
 * new chat (`startChat === false`) sees only a hint the translation declares
 * for its kind (default-deny), and never advice it was refused.
 */
import {
  CONTINUATION_WORKSPACE_REFUSAL_CODES,
  EXECUTION_ENGINE_CHANGED_CODE,
} from '@kontourai/station-contracts/execution-target';
import { APPROVAL_FULL_ACCESS_NOT_GRANTED_CODE } from '@kontourai/station-contracts/orchestration';
import { PRINCIPAL_UNRESOLVED_CODE } from '@kontourai/station-contracts/principal';
import {
  ACP_APPROVAL_GOVERNANCE_REFUSED_CODE,
  ATTACHMENT_INPUT_UNSUPPORTED_CODE,
  ENGINE_MEMORY_EXHAUSTED_CODE,
  ENGINE_SESSION_BINDING_DEAD_CODE,
  ENGINE_SIGN_IN_REQUIRED_CODE,
  ENGINE_TURN_FAILED_CODE,
  MODEL_NOT_ADVERTISED_CODE,
  MUSE_TURN_IDLE_TIMEOUT_CODE,
  MUSE_TURN_TOTAL_TIMEOUT_CODE,
} from '@kontourai/station-contracts/provider';
import {
  MCP_SIGN_IN_REQUIRED_CODE,
  RESOURCE_ENGINE_START_CAPACITY_CODE,
  SESSION_START_INDETERMINATE_CODE,
} from '@kontourai/station-contracts/provider-failure';
import { SESSION_ENDED_REJECTION_CODE } from '@kontourai/station-contracts/session-lifecycle';
import { describe, expect, it } from 'vitest';
import {
  type ChatErrorTranslation,
  chatErrorHintFor,
  translateChatError,
} from '../chatErrorTranslation';

const RAW = 'No conversation found with session ID: d434e194';
const OAUTH = 'Failed to authenticate: OAuth session expired';

/** One input per branch: every code the table maps, plus the prose-only ones. */
const INPUTS: Array<{
  label: string;
  status?: number;
  message: string;
  code?: string;
}> = [
  ...[
    SESSION_ENDED_REJECTION_CODE,
    ATTACHMENT_INPUT_UNSUPPORTED_CODE,
    ACP_APPROVAL_GOVERNANCE_REFUSED_CODE,
    EXECUTION_ENGINE_CHANGED_CODE,
    MODEL_NOT_ADVERTISED_CODE,
    APPROVAL_FULL_ACCESS_NOT_GRANTED_CODE,
    ENGINE_MEMORY_EXHAUSTED_CODE,
    MUSE_TURN_IDLE_TIMEOUT_CODE,
    MUSE_TURN_TOTAL_TIMEOUT_CODE,
    PRINCIPAL_UNRESOLVED_CODE,
    ...CONTINUATION_WORKSPACE_REFUSAL_CODES,
    ENGINE_TURN_FAILED_CODE,
    MCP_SIGN_IN_REQUIRED_CODE,
    ENGINE_SIGN_IN_REQUIRED_CODE,
    'station_agent_turn_failed',
    ENGINE_SESSION_BINDING_DEAD_CODE,
    RESOURCE_ENGINE_START_CAPACITY_CODE,
    'transport_capacity',
    'transport_timeout',
    'transport_tls',
    'network_changed',
    'transport_reset',
    'transport_dns',
    'transport_refused',
    'transport_unreachable',
    'transport',
  ].map((code) => ({ label: code, code, message: `${code} detail` })),
  {
    label: 'engine auth (turn failed)',
    code: ENGINE_TURN_FAILED_CODE,
    message: OAUTH,
  },
  ...[undefined, RAW, OAUTH].map((cause) => ({
    label: `indeterminate start (cause: ${cause ?? 'none'})`,
    code: SESSION_START_INDETERMINATE_CODE,
    message: `${cause ?? ''} Provider session creation may have completed. Inspect the session before retrying.`,
  })),
  { label: 'uncoded lost session', message: RAW },
  { label: 'unauthorized', status: 401, message: 'Unauthorized' },
  {
    label: 'unreachable',
    message: 'connect ECONNREFUSED 127.0.0.1:11434 ollama',
  },
  { label: 'unclassified', message: 'Something unexpected went wrong' },
];

const KINDS = {
  noSend: { continue: false, startChat: true },
  noNewChat: { continue: true, startChat: false },
  neither: { continue: false, startChat: false },
} as const;

/** Advice a caller of each kind was refused, and so must never be told. */
const REFUSED_ADVICE = {
  noSend: /\bsend\b|sending|resend|retry|try again|Continue picks/i,
  noNewChat: /new chat|another agent|switch to/i,
  neither:
    /\bsend\b|sending|resend|retry|try again|Continue picks|new chat|another agent|switch to/i,
} as const;

function declared(t: ChatErrorTranslation, kind: keyof typeof KINDS) {
  const value = t.callerHints?.[kind];
  return value === true ? t.hint : (value ?? undefined);
}

describe('chatErrorHintFor, every translation, every restricted caller kind', () => {
  it.each(INPUTS)('$label', ({ status, message, code }) => {
    const translation = translateChatError({ status, message, code });
    // Full access: unknown, or both halves allowed, sees the hint unchanged.
    expect(chatErrorHintFor(translation)).toBe(translation.hint);
    expect(
      chatErrorHintFor(translation, { continue: true, startChat: true }),
    ).toBe(translation.hint);
    for (const kind of Object.keys(KINDS) as Array<keyof typeof KINDS>) {
      const shown = chatErrorHintFor(translation, KINDS[kind]);
      // Default-deny: only what the translation declares for this kind.
      expect(shown, `${kind}`).toBe(declared(translation, kind));
      // And never advice this kind of caller was refused.
      if (shown)
        expect(shown, `${kind}: ${shown}`).not.toMatch(REFUSED_ADVICE[kind]);
    }
  });
});

describe("full access keeps main's hints exactly", () => {
  it.each([
    [
      { message: RAW, code: ENGINE_SESSION_BINDING_DEAD_CODE },
      'Send your message again — the conversation continues in a fresh engine session — or start a new chat.',
    ],
    [
      { message: 'x', code: SESSION_ENDED_REJECTION_CODE },
      'Start a new chat to continue.',
    ],
    [
      { message: 'x', code: ENGINE_MEMORY_EXHAUSTED_CODE },
      'Continue picks the task up where it stopped.',
    ],
    [
      { message: 'Something unexpected went wrong' },
      'Retrying may help if this was a temporary failure.',
    ],
    [
      { message: OAUTH, code: ENGINE_TURN_FAILED_CODE },
      'Sign in on that computer, then try again — or switch to another agent.',
    ],
    [
      {
        message: `${RAW} Provider session creation may have completed. Inspect the session before retrying.`,
        code: SESSION_START_INDETERMINATE_CODE,
      },
      'Station may already have started this session. Check it before sending again.',
    ],
  ] as const)('%j', (input, hint) => {
    expect(chatErrorHintFor(translateChatError(input))).toBe(hint);
  });
});

describe('an unconfirmed start keeps its warning for every caller', () => {
  it.each([undefined, RAW, OAUTH, 'Something unexpected went wrong'])(
    'inner cause %s',
    (cause) => {
      const translation = translateChatError({
        code: SESSION_START_INDETERMINATE_CODE,
        message: `${cause ?? ''} Provider session creation may have completed. Inspect the session before retrying.`,
      });
      for (const kind of Object.keys(KINDS) as Array<keyof typeof KINDS>) {
        const shown = chatErrorHintFor(translation, KINDS[kind]) ?? '';
        expect(shown, kind).toContain(
          'Station may already have started this session',
        );
        expect(shown, kind).not.toMatch(
          /Send your message again|Retrying may help|switch to/i,
        );
      }
    },
  );
});
