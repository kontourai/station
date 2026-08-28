// @vitest-environment jsdom
import { PRINCIPAL_UNRESOLVED_CODE } from '@kontourai/station-contracts/principal';
import { describe, expect, it } from 'vitest';
import {
  formatChatErrorDisplay,
  translateChatError,
} from '../chatErrorTranslation';

// Fixture-based per the plan's Stop-short risks: the real AWS Bedrock
// "model not enabled" exception text could not be captured live in
// planning, so these are representative, pattern-matched fixtures —
// (archive#196) is where the live text gets confirmed against these patterns.
describe('translateChatError', () => {
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

  // archive#1207 2 : the orchestration bridge's stall
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

  // archive#3089/archive#3120: the observed value must be the one
  // `admitEngineStart`'s decision used, not a client-side re-derivation.
  // This message shape is the exact literal `CriticalResourcePostureError`
  // builds (`src-server/services/infra/resource-posture.ts`). archive#3120 changed
  // the BODY from the raw engineering string to a human sentence — this
  // test proves the sentence carries the server's own observed value (97),
  // not an invented one, and that the raw string is not lost: it still
  // reaches the user verbatim via `disclosureRaw` +
  // `formatChatErrorDisplay`'s existing de-emphasized blockquote.
  //
  // thresholdPercent is 85 here because that is what the server actually
  // sends — it is the DEGRADED threshold, while the refusal is decided
  // against the CRITICAL one (95). The earlier fixture used 95, the single
  // value at which the old "above its N% threshold" sentence read correctly,
  // so it could not have caught the sentence blaming the wrong comparison
  // (review of archive#3120). The assertion below is now that the sentence
  // does NOT claim a threshold at all.
  it('classifies a critical-resource-posture refusal by code, as a human sentence carrying the exact observed value', () => {
    const rawMessage =
      'Engine start refused: resource posture=critical, observed busyPercent=97, thresholdPercent=85, cpuCount=8';
    const result = translateChatError({
      code: 'resource_posture_critical',
      message: rawMessage,
    });

    expect(result.title).not.toBe('Error');
    expect(result.title).toMatch(/capacity/i);
    // A human sentence, not the raw engineering string, as the headline...
    expect(result.body).not.toBe(rawMessage);
    expect(result.body).not.toMatch(/busyPercent=/);
    //.but still carrying the server's own numbers, not a re-derivation.
    expect(result.body).toContain('97%');
    // The refusal threshold is 95, the carried thresholdPercent is 85, and the
    // sentence must attribute the refusal to neither: naming 85 as the reason
    // would teach the reader that Station refuses above 85%, which it does not.
    expect(result.body).not.toContain('85%');
    expect(result.body).not.toMatch(/threshold/i);
    expect(result.hint).toMatch(/retry/i);
    // Distinct from the scheduler's own deferred/refused copy — an engine
    // refusal and a deferred scheduled job must not collapse into one
    // message.
    expect(result.body).not.toMatch(/Scheduler job/);

    // The raw string is not lost — it is retrievable verbatim for bug
    // reports, just no longer the headline.
    expect(result.disclosureRaw).toBe(true);
    const rendered = formatChatErrorDisplay(result, rawMessage);
    expect(rendered).toContain(rawMessage);
  });

  it('falls back to showing the raw message verbatim when it does not match the expected shape', () => {
    const result = translateChatError({
      code: 'resource_posture_critical',
      message: 'some unexpected refusal shape with no percentages',
    });

    expect(result.title).toMatch(/capacity/i);
    expect(result.body).toBe(
      'some unexpected refusal shape with no percentages',
    );
  });

  it('falls back to a neutral capacity message when no detail text is supplied', () => {
    const result = translateChatError({
      code: 'resource_posture_critical',
      message: '',
    });

    expect(result.title).toMatch(/capacity/i);
    expect(result.body).toBeTruthy();
    expect(result.body).not.toBe('');
  });

  it('falls back gracefully when message is empty', () => {
    const result = translateChatError({ message: '' });

    expect(result.body).toBeTruthy();
    expect(result.hint).toBeTruthy();
  });

  // archive#3120: every structured `code` check must run before every
  // prose-pattern check — genuinely, not just by claim in a comment. Prove
  // it by giving a structured code a message that ALSO matches a prose
  // pattern checked later in the function (ABORTED_PATTERN, STALLED_PATTERN)
  // and confirming the code wins. Today's real text can't collide (
  // already confirmed that for archive#3120), but this guards the ORDERING itself
  // against a future prose pattern addition, not just today's fixtures.
  it('a structured code wins even when the message ALSO matches a later prose pattern', () => {
    const collidingWithAborted = translateChatError({
      code: 'resource_posture_critical',
      message: 'Stream aborted by client (posture critical)',
    });
    expect(collidingWithAborted.title).toMatch(/capacity/i);
    expect(collidingWithAborted.title).not.toMatch(/response stopped/i);

    const collidingWithStalled = translateChatError({
      code: 'resource_posture_critical',
      message: 'stalled — no response for 45s (posture critical)',
    });
    expect(collidingWithStalled.title).toMatch(/capacity/i);
    expect(collidingWithStalled.title).not.toMatch(/stopped responding/i);
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
      expect(result.title).toMatch(/history is gone/i);
      expect(result.body).not.toContain(rawMessage);
      expect(result.hint).toMatch(/new chat/i);
      expect(result.terminalSession).toBe(true);
      expect(result.disclosureRaw).toBe(true);
    });

    it('classifies via the prose fallback ONLY when no code is supplied', () => {
      const withoutCode = translateChatError({ message: rawMessage });
      expect(withoutCode.terminalSession).toBe(true);

      // A code that does NOT match must never fall through to the prose
      // fallback net — the structured signal, when present, is
      // authoritative even if it disagrees with what the text looks like.
      const wrongCode = translateChatError({
        message: rawMessage,
        code: 'some-other-code',
      });
      expect(wrongCode.terminalSession).toBeUndefined();
    });

    it('does not misclassify an unrelated "not found"-shaped message', () => {
      const result = translateChatError({
        message: 'Agent not found: some-agent',
      });
      expect(result.terminalSession).toBeUndefined();
    });
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

  // archive#1827
  it('appends the raw message as a de-emphasized blockquote when disclosureRaw is set', () => {
    const rendered = formatChatErrorDisplay(
      {
        title: "This conversation's history is gone",
        body: "Can't reach native session.",
        hint: 'New chat.',
        disclosureRaw: true,
      },
      'No conversation found with session ID: dead-id',
    );

    expect(rendered).toContain(
      '> No conversation found with session ID: dead-id',
    );
    // The raw text is never the headline: it must appear strictly after
    // the translated title.
    expect(rendered.indexOf('dead-id')).toBeGreaterThan(
      rendered.indexOf("This conversation's history is gone"),
    );
  });

  it('never appends a disclosure section when disclosureRaw is unset (every existing translation)', () => {
    const rendered = formatChatErrorDisplay(
      { title: 'Error', body: 'Synthetic provider failure' },
      'Synthetic provider failure',
    );

    expect(rendered).not.toContain('Raw engine message');
    expect(rendered).not.toContain('---');
  });
});
