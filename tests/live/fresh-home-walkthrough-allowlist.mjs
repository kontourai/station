/**
 * Console-budget allowlist for the fresh-home walkthrough
 * (tests/live/fresh-home-walkthrough.mjs).
 *
 * Every entry names KNOWN noise on a healthy fresh instance, so the suite can
 * hold the line at "nothing new" while the tracked finding is fixed. An entry
 * without a `reason` naming the finding/issue it tracks is a defect — the
 * whole point of the budget is that nobody can park noise here anonymously.
 *
 * Findings are matched as one line: `<kind> <detail>` where kind is one of
 * `console-error`, `page-error`, `request-error` (see recordFinding in the
 * suite; request details are `<METHOD> <status> <pathname>`). Keep patterns
 * anchored and specific: a broad pattern silently absorbs tomorrow's
 * genuinely new failure.
 *
 * Shape: { pattern: RegExp, reason: string }
 */
export const WALKTHROUGH_ALLOWLIST = [
  {
    // The Skills page asks GET /api/setup-imports/sources on every visit to
    // decide whether to offer "Import from Codex…". The route needs the
    // access:manage pairing scope (src-server/security/pairing-route-scopes.ts
    // '/api/setup-imports:manage'). The same-machine local UI session minted
    // from `station open --print` is the operator and is answered 200; a
    // session without that scope (a paired device, or a local UI reached from
    // another machine) is answered 403, and the page simply offers no import.
    // Console-budget class tracked under kontourai/station#766.
    pattern: /^request-error GET 403 \/api\/setup-imports\/sources$/,
    reason:
      'kontourai/station#766: the Skills page asks /api/setup-imports/sources to decide whether to offer the Codex import; a session without the access:manage scope is refused (403) and sees no import',
  },
  {
    // Observed 2026-08-29 while plugin layouts are open: the layout chrome's
    // operating-state availability poll (@kontourai/station-sdk operatingState
    // query domain) GETs /api/projects/<slug>/operating-state/availability and
    // receives 404 for an ordinary project, several times per page. Healthy-
    // instance console-noise class from the kontourai/station#765 audit,
    // tracked under kontourai/station#766's console-budget item.
    pattern:
      /^request-error GET 404 \/api\/projects\/[\w-]+\/operating-state\/availability$/,
    reason:
      'kontourai/station#766: layout chrome polls operating-state availability, which 404s for ordinary projects on a healthy instance',
  },
  {
    // The route sweep deep-links every route with page.goto, so each route is
    // a fresh document on the one paired device: about 17 to 20 a minute.
    // Each document needs two focus reports (focused on load, hidden on
    // unload), and FocusPresence counts every report against a per-device
    // budget of 30 a minute, refusing only reports that raise a state
    // (src-server/services/presence/focus-presence.ts). So the sweep is
    // refused by design; the client honours Retry-After. A person navigates
    // inside one document and does not reach this rate. Over-posting per
    // document (three reports, fixed in src-ui/src/hooks/focusReporter.ts)
    // still fails this suite: checkFocusReports in the walkthrough fails on
    // any document posting one state twice within 1 s, and
    // hooks/__tests__/useFocusReporter.test.tsx pins the client behaviour.
    pattern: /^request-error POST 429 \/api\/presence\/focus$/,
    reason:
      "kontourai/station#4953 — focus presence rate limit refusing the sweep's page-load churn (17-20 fresh documents a minute on one device, two reports each, 30 a minute budget); duplicate per-document reports still fail via checkFocusReports",
  },
];
