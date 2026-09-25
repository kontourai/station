// @vitest-environment jsdom
import { PRINCIPAL_UNRESOLVED_CODE } from '@kontourai/station-contracts/principal';
import {
  MUSE_TURN_IDLE_TIMEOUT_CODE,
  MUSE_TURN_TOTAL_TIMEOUT_CODE,
} from '@kontourai/station-contracts/provider';
import { describe, expect, it } from 'vitest';
import {
  formatChatErrorDisplay,
  SESSION_START_INDETERMINATE_CODE,
  translateChatError,
  translateProjectedRuntimeError,
} from '../chatErrorTranslation';

// Fixture-based per the plan's Stop-short risks: the real AWS Bedrock
// "model not enabled" exception text could not be captured live in
// planning, so these are representative, pattern-matched fixtures —
// (archive#196) is where the live text gets confirmed against these patterns.
describe('translateChatError', () => {
  it('an unconfirmed start with no engine cause says what is known, not "unknown"', () => {
    const translation = translateChatError({
      status: 400,
      code: SESSION_START_INDETERMINATE_CODE,
      message:
        'Provider session creation may have completed. Inspect the session before retrying.',
    });
    expect(translation.title).toBe("The chat's start wasn't confirmed");
    expect(translation.body).not.toMatch(/unknown/i);
    expect(translation.hint).toBe(
      'Station may already have started this session. Check it before sending again.',
    );
  });

  // #2269: a Station-owned deadline is not a transient engine failure, so
  // the fallback's retry hint must not appear, and the headline names the
  // deadline rather than a generic "Error". The codes come from the same
  // contract the Muse adapter publishes them from.
  it.each([
    [
      MUSE_TURN_IDLE_TIMEOUT_CODE,
      'Muse turn was idle for 1800000ms with no verified protocol activity and no tool running (last activity at 2026-09-22T18:05:05.000Z), so Station stopped it.',
      /going quiet/i,
    ],
    [
      MUSE_TURN_TOTAL_TIMEOUT_CODE,
      'Muse did not finish the turn within the 3600000ms turn budget declared for it, so Station stopped it.',
      /time budget/i,
    ],
  ])('names a %s deadline without a retry claim', (code, message, title) => {
    const result = translateChatError({ code, message });
    expect(result.title).toMatch(title);
    expect(result.hint).toBeUndefined();
    expect(formatChatErrorDisplay(result)).not.toMatch(/retrying may help/i);
    expect(result.disclosureRaw).toBe(true);
    // The same message without the code still reaches the honest fallback.
    expect(translateChatError({ message }).hint).toMatch(/retrying may help/i);
  });

  it('classifies an ended-session refusal by backend code as a Station-side end, not an error', () => {
    const result = translateChatError({
      code: 'session_ended',
      message:
        'This session has already ended, so it cannot take another message. Start a new chat to continue.',
    });

    expect(result.title).toBe('This chat has ended');
    expect(result.body).toMatch(/already ended/i);
    expect(result.hint).toMatch(/new chat/i);
    expect(result.terminalSession).toBe(true);
    // The internal lifecycle vocabulary must not be the classification basis
    // or the headline.
    expect(result.title).not.toMatch(/terminal/i);
  });

  // archive#4518: a device session's chat request that could not be
  // resolved to a principal (`PrincipalUnresolvedError`,
  // `principal-resolver.ts`) is a deterministic authz failure, never a
  // transient one — the generic fallback's "Retrying may help if this was a
  // temporary failure" hint would be actively false here.
  //
  // imports `PRINCIPAL_UNRESOLVED_CODE` from the SAME
  // contract the server stamps `PrincipalUnresolvedError.code` from and the
  // client module matches against — a rename on either side reds this test
  // instead of the two silently drifting apart. The body must be a CANNED
  // human string, never the raw server message forwarded verbatim (the
  // discriminating assertion below).
  //
  //NO `disclosureRaw` pin here — this
  // error's only delivery path (the pre-stream `/chat` 400 handled by
  // `useActiveChatSessionMessaging`) never calls `formatChatErrorDisplay`,
  // the only reader of that flag, so setting it here would be inert: a flag
  // nothing derives. The canned body is the whole delivery.
  it('classifies a principal-resolution refusal by backend code as non-retryable, with a canned body — never the raw server message', () => {
    const rawServerMessage =
      'Unable to resolve a principal: personal-mode request carries no verified identity and no home-possession authority fact';
    const result = translateChatError({
      code: PRINCIPAL_UNRESOLVED_CODE,
      message: rawServerMessage,
    });

    expect(result.title).not.toBe('Error');
    expect(result.hint).toBeDefined();
    expect(result.hint).not.toMatch(/retrying may help/i);
    expect(result.hint).not.toMatch(/temporary failure/i);
    // The discriminating assertion: the body is canned copy, not the raw
    // engineering string forwarded verbatim.
    expect(result.body.startsWith('Unable to resolve a principal:')).toBe(
      false,
    );
    expect(result.body).not.toBe(rawServerMessage);
    expect(result.body).toMatch(/authorized|paired|approved/i);
  });

  it('classifies a continuation workspace refusal by backend code, not its message', () => {
    const result = translateChatError({
      code: 'continuation_workspace_worktree_gone',
      message: 'Synthetic provider failure',
    });

    expect(result.title).toBe("Can't resume");
    expect(result.body).toBe('Synthetic provider failure');
    expect(result.hint).not.toMatch(/Model connection settings/i);
  });

  it('classifies a 401 status as a bad-credentials failure', () => {
    const result = translateChatError({
      status: 401,
      message:
        'UnrecognizedClientException: The security token included in the request is invalid',
    });

    expect(result.title).toMatch(/credentials/i);
    expect(result.body).not.toContain('UnrecognizedClientException');
    expect(result.hint).toMatch(/Connections.*Models/);
  });

  it('classifies a credential-shaped message even without a 401 status', () => {
    const result = translateChatError({
      message: 'Error: Missing credentials in config',
    });

    expect(result.title).toMatch(/credentials/i);
  });

  it('classifies a Bedrock access-denied fixture as a region/model-access failure', () => {
    const result = translateChatError({
      message:
        'AccessDeniedException: User is not authorized to perform: bedrock:InvokeModel',
    });

    expect(result.title).toMatch(/not enabled/i);
    expect(result.hint).toMatch(/AWS Bedrock console/i);
  });

  it('classifies a Bedrock on-demand throughput fixture as a region/model-access failure', () => {
    const result = translateChatError({
      message:
        "ValidationException: Invocation of model ID some-model with on-demand throughput isn't supported",
    });

    expect(result.title).toMatch(/not enabled/i);
  });

  it('classifies a fetch-failed/ECONNREFUSED fixture naming Ollama as Ollama-unreachable', () => {
    const result = translateChatError({
      message:
        'TypeError: fetch failed (cause: connect ECONNREFUSED 127.0.0.1:11434 to Ollama)',
    });

    expect(result.title).toMatch(/Ollama/i);
    expect(result.hint).toMatch(/Ollama is running/i);
  });

  it('classifies a generic fetch-failed fixture without Ollama context as a generic local-server failure', () => {
    const result = translateChatError({
      message: 'TypeError: fetch failed',
    });

    expect(result.title).toMatch(/Local model server/i);
    expect(result.title).not.toMatch(/Ollama/i);
  });

  it('falls back to the raw message plus a hedged retry hint for an unrecognized error, never asserting a Model-connection cause', () => {
    const result = translateChatError({
      status: 500,
      message: 'Synthetic provider failure',
    });

    expect(result.body).toContain('Synthetic provider failure');
    // archive#3299: the fallback classified NOTHING, so its hint must not
    // assert that retrying helps — a stale credential does not improve on
    // retry, and telling the user it will is an unfounded claim.
    expect(result.hint).not.toBe('Retry your request.');
    expect(result.hint).toMatch(/temporary/i);
    expect(`${result.title} ${result.body} ${result.hint}`).not.toMatch(
      /Model connection/i,
    );
  });

  // archive#3299: the stream ended without a well-formed body — the client
  // opened an SSE stream and received a short non-SSE error body instead.
  // The raw text is a browser internal naming a JS API; it must never be the
  // headline the user reads.
  describe('a stream that ended without a parseable body (station#3299)', () => {
    const RAW_STREAM_ERROR =
      "Failed to execute 'close' on 'ReadableStreamDefaultController': Unexpected end of JSON input";

    it('REPRO: translates the ReadableStreamDefaultController exception instead of passing it through verbatim', () => {
      const result = translateChatError({ message: RAW_STREAM_ERROR });

      // Not the bare fallback: a real classification with product copy.
      expect(result.title).not.toBe('Error');
      const headline = `${result.title} ${result.body} ${result.hint ?? ''}`;
      expect(headline).not.toContain('ReadableStreamDefaultController');
      expect(headline).not.toContain("Failed to execute 'close'");
      expect(headline).not.toContain('Unexpected end of JSON input');
      // The raw text stays available for bug reports, behind the existing
      // archive#1827 disclosure mechanism — never as the headline.
      expect(result.disclosureRaw).toBe(true);
      // The client cannot know a retry helps here (archive#3297: the underlying
      // cause in the observed instance was a stale credential).
      expect(result.hint).not.toBe('Retry your request.');
    });

    it('REPRO: a bare "Unexpected end of JSON input" (no stream-controller wrapper) classifies the same way', () => {
      const result = translateChatError({
        message: 'Unexpected end of JSON input',
      });

      expect(result.title).not.toBe('Error');
      expect(`${result.title} ${result.body}`).not.toContain(
        'Unexpected end of JSON input',
      );
    });

    it('prefers the underlying HTTP condition when one is known: a 401 wins over the stream-shape prose', () => {
      const result = translateChatError({
        status: 401,
        message: RAW_STREAM_ERROR,
      });

      expect(result.title).toBe('Model connection credentials were rejected');
    });
  });

  it('classifies native transport capacity by code, never by its detail', () => {
    const result = translateChatError({
      code: 'transport_capacity',
      message: 'Synthetic transport detail.',
    });

    expect(result.title).toBe('Station is handling too many requests');
    expect(result.body).toBe('Synthetic transport detail.');
    expect(result.hint).toBe('Retry your request in a moment.');
  });

  it.each([
    [
      'transport_dns',
      'Connection timed out unexpectedly.',
      'Station address could not be resolved',
    ],
    [
      'transport_timeout',
      'TLS certificate changed unexpectedly.',
      'Connection to this Station timed out',
    ],
    [
      'transport_tls',
      'Station host could not be resolved unexpectedly.',
      'Secure connection to this Station failed',
    ],
    [
      'transport_refused',
      'Connection reset unexpectedly.',
      'Station is unreachable',
    ],
    [
      'transport_reset',
      'Station refused unexpectedly.',
      'Connection to this Station was interrupted',
    ],
    [
      'transport_unreachable',
      'Connection timed out unexpectedly.',
      'Station is unreachable',
    ],
  ])(
    'classifies native %s by code despite deliberately mismatched detail (detail must not classify)',
    (code, message, title) => {
      const result = translateChatError({ message, code });

      expect(result.title).toBe(title);
      expect(result.body).toBe(message);
      expect(result.hint).not.toMatch(/Model connection settings/i);
    },
  );

  it('keeps unclassified native transport on the generic Station connection message', () => {
    const result = translateChatError({
      message: 'Unexpected transport detail.',
      code: 'transport',
    });

    expect(result.title).toBe('Station is unreachable');
    expect(result.body).toBe('Unexpected transport detail.');
  });

  it("classifies the stall watchdog's own message as a silent connection drop, not a stopped response (station#1207)", () => {
    const result = translateChatError({
      message: 'The connection to Station stalled — no response for 60s.',
    });

    expect(result.title).toMatch(/stopped responding/i);
    expect(result.hint).toMatch(/Retry/);
    expect(`${result.title} ${result.body}`).not.toMatch(/credential/i);
  });

  // archive#1207: the orchestration bridge's stall
  // (station-agent-adapter.ts's consumeChatStream watchdog) surfaces as a
  // `turnRejectionMessage`-wrapped runtime.error, not the direct path's
  // raw `ChatStreamStallError` text. Under `managed-chat-orchestration`
  // (the exact config this whole rework targets) this wrapped shape used
  // to fall through to the generic "Error… check your Model connection
  // settings" fallback, silently defeating the stall-specific copy for
  // that path.
  it("classifies the orchestration bridge's turnRejectionMessage-wrapped stall the same as the direct path's (station#1207 review round 2)", () => {
    const result = translateChatError({
      message:
        'Station agent did not accept the task turn: station-agent chat bridge stalled — no response for 45s',
    });

    expect(result.title).toMatch(/stopped responding/i);
    expect(result.hint).toMatch(/Retry/);
    expect(`${result.title} ${result.body}`).not.toMatch(/credential/i);
    expect(`${result.title} ${result.body}`).not.toMatch(
      /check your Model connection settings/i,
    );
  });

  it('classifies a client abort as a stopped response, not a connection problem (#797)', () => {
    const result = translateChatError({
      message: 'Stream aborted by client',
    });

    expect(result.title).toMatch(/stopped/i);
    expect(result.hint).not.toMatch(/Model connection settings/i);
    expect(`${result.title} ${result.body} ${result.hint ?? ''}`).not.toMatch(
      /credential|unreachable/i,
    );
  });

  it('does not classify an ordinary connection failure as an abort (#797)', () => {
    const result = translateChatError({
      message: 'ECONNREFUSED connecting to ollama',
    });

    expect(result.title).toMatch(/unreachable/i);
  });

  it('classifies a not-launchable 409 as a model-availability issue, not a connection problem', () => {
    const result = translateChatError({
      status: 409,
      message: "Agent 'demo-layout:assistant' is not currently launchable.",
    });

    expect(result.title).toMatch(/model is not available/i);
    expect(result.hint).toMatch(/model picker/i);
    expect(result.hint).not.toMatch(/Model connection settings/i);
  });

  it('falls back gracefully when message is empty', () => {
    const result = translateChatError({ message: '' });

    expect(result.body).toBeTruthy();
    expect(result.hint).toBeTruthy();
  });

  it("classifies the station-agent adapter's retriable turn failure by code, with a retry hint and no invented cause", () => {
    const result = translateChatError({
      message: 'Station agent turn failed',
      code: 'station_agent_turn_failed',
    });

    expect(result.title).toBe('This turn did not complete');
    expect(result.body).toMatch(/could not finish/i);
    // The event carries `retriable: true`, so the hint may promise a retry;
    // it must not invent a cause (no model-connection claim from this code).
    expect(result.hint).toMatch(/send it again to retry/i);
    expect(`${result.title} ${result.body}`).not.toMatch(
      /model connection|ollama|credential/i,
    );
    expect(result.terminalSession).toBeUndefined();
    // The raw text adds nothing beyond the headline, so there is no
    // disclosure section to demote it into.
    expect(result.disclosureRaw).toBeUndefined();
  });

  // archive#1827
  describe('a dead engine session binding', () => {
    const rawMessage =
      'No conversation found with session ID: d434e194-cc2e-4edc-8733-d8645c512fab';

    it('classifies by the structured code, never the raw message, as the headline', () => {
      const result = translateChatError({
        message: rawMessage,
        code: 'engine-session-binding-dead',
      });

      expect(result.title).not.toContain(rawMessage);
      expect(result.title).toMatch(/engine session was lost/i);
      expect(result.body).not.toContain(rawMessage);
      // #765 A1: the hint offers a resend FIRST — the server's continuation
      // seam now recovers this class with a fresh child session — and keeps
      // "new chat" as the explicit alternative.
      expect(result.hint).toMatch(/send your message again/i);
      expect(result.hint).toMatch(/new chat/i);
      // #765 A1: no longer `terminalSession` — the conversation survives; only
      // the engine-native binding died, and continuation replaces it.
      expect(result.terminalSession).toBeUndefined();
      expect(result.disclosureRaw).toBe(true);
    });

    it('classifies via the prose fallback ONLY when no code is supplied', () => {
      const withoutCode = translateChatError({ message: rawMessage });
      expect(withoutCode.title).toMatch(/engine session was lost/i);

      // A code that does NOT match must never fall through to the prose
      // fallback net — the structured signal, when present, is
      // authoritative even if it disagrees with what the text looks like.
      const wrongCode = translateChatError({
        message: rawMessage,
        code: 'some-other-code',
      });
      expect(wrongCode.title).not.toMatch(/engine session was lost/i);
    });

    it('does not misclassify an unrelated "not found"-shaped message', () => {
      const result = translateChatError({
        message: 'Agent not found: some-agent',
      });
      expect(result.title).not.toMatch(/engine session was lost/i);
    });
  });
});

// #765 A1: the durable-projection entry point — see
// `translateProjectedRuntimeError`'s doc comment.
describe('translateProjectedRuntimeError', () => {
  const RAW =
    'No conversation found with session ID: d434e194-cc2e-4edc-8733-d8645c512fab';

  it('translates a coded ⚠️-prefixed projection part like the live path', () => {
    const result = translateProjectedRuntimeError(
      `⚠️ ${RAW}`,
      'engine-session-binding-dead',
    );
    expect(result).toMatch(/engine session was lost/i);
    // Raw host text is offered via Details, not inlined in the card markdown.
    expect(result).not.toContain(RAW);
    expect(result).not.toContain('Raw engine message');
  });

  it('preserves a repeat-compaction suffix', () => {
    const result = translateProjectedRuntimeError(
      `⚠️ ${RAW} (repeated 3×)`,
      'engine-session-binding-dead',
    );
    expect(result).toMatch(/engine session was lost/i);
    expect(result).toContain('(repeated 3×)');
  });

  it('returns null for a code the table does not map — verbatim prose stays', () => {
    expect(
      translateProjectedRuntimeError(`⚠️ ${RAW}`, 'some-unmapped-code'),
    ).toBeNull();
  });

  it('translates the station-agent retriable turn failure instead of quoting it verbatim', () => {
    const result = translateProjectedRuntimeError(
      '⚠️ Station agent turn failed',
      'station_agent_turn_failed',
    );

    expect(result).toMatch(/did not complete/i);
    expect(result).toMatch(/send it again to retry/i);
    // No cause to disclose: the raw text must not reappear as a blockquote.
    expect(result).not.toContain('Raw engine message');
  });
});

describe('formatChatErrorDisplay', () => {
  it('renders title, body, and hint as markdown', () => {
    const rendered = formatChatErrorDisplay({
      title: 'Something broke',
      body: 'Details about the break.',
      hint: 'Try this.',
    });

    expect(rendered).toContain('**Something broke**');
    expect(rendered).toContain('Details about the break.');
    expect(rendered).toContain('Try this.');
  });

  it('omits the hint section when no hint is present', () => {
    const rendered = formatChatErrorDisplay({
      title: 'Title',
      body: 'Body',
    });

    expect(rendered).not.toContain('undefined');
  });

  it('never inlines host stderr in the card markdown', () => {
    const rendered = formatChatErrorDisplay({
      title: "This conversation's history is gone",
      body: "Can't reach native session.",
      hint: 'New chat.',
      disclosureRaw: true,
    });

    expect(rendered).toContain("This conversation's history is gone");
    expect(rendered).not.toContain('Raw engine message');
    expect(rendered).not.toContain('---');
  });
});

describe('engine OAuth / sign-in classification', () => {
  it('classifies an expired OAuth session as sign-in, not a generic turn failure', () => {
    const raw =
      'Failed to authenticate: OAuth session expired and could not be refreshed';
    const result = translateChatError({
      code: 'engine-turn-failed',
      message: raw,
    });
    expect(result.title).toMatch(/signed in/i);
    expect(result.retryable).toBe(false);
    expect(result.disclosureRaw).toBe(true);
    expect(result.body).not.toContain(raw);
    expect(result.hint).not.toMatch(/send again/i);
  });
});
