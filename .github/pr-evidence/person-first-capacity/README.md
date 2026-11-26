# First-start capacity status

Captured and opened on macOS/Chromium from source revision
`f9ea4205beadf8447e12480947f58bd6c5637b5a` with:

```sh
npm run test:e2e:product -- --spec=tests/mobile-chat-composer.spec.ts '--grep=engine-start capacity wait|first-start wait'
```

All three journeys passed (9.8 seconds of Playwright execution). Each fresh-chat
Stop journey begins at a fixed viewport, so resizing cannot replace its Stop
control between pointer events. The fixture renders the real composer and SSE
consumer; the separate `engine-start-wait.routes.test.ts` reaches the real
foreground route, execution composition, service producer, authorized stream
and UI status consumer. These are local tests with a controlled adapter, not
live-provider or physical-device evidence.

The **before** images show the same build before Station publishes a wait;
the **waiting** images show its received capacity status. They illustrate a
runtime state transition, not two released versions. Both themes were opened
and inspected at 390 and 1440 pixels. The journeys then press Stop, assert its
interrupt command, and require the badge to disappear.

| Width | Before wait publication | Waiting, light | Waiting, dark |
| --- | --- | --- | --- |
| 390 | `engine-start-wait-new-chat-390-before-light.png` | `engine-start-wait-new-chat-390-light.png` | `engine-start-wait-new-chat-390-dark.png` |
| 1440 | `engine-start-wait-new-chat-1440-before-light.png` | `engine-start-wait-new-chat-1440-light.png` | `engine-start-wait-new-chat-1440-dark.png` |

These PNG files are retained locally under `.kontourai/engine-start-capacity-4644/` and are not tracked or uploaded by this manifest. The evidence above belongs to the named earlier revision; later review corrections require new admitted verification.

## Source correction regressions (NOT_RUN)

The follow-up checkpoint preserves the earlier published revision as its
parent. No test, typecheck, build, readiness, browser or provider command was
executed for these source corrections. New claims require their own admitted
evidence; the existing captures remain evidence only for the revision above.

The first proposed serial verification request is limited to:

```sh
npm run test:focused -- src-server/services/orchestration/__tests__/engine-start-capacity-recovery.test.ts src-server/routes/orchestration/__tests__/engine-start-wait.routes.test.ts
```

Named regressions and their intended pre-fix failures:

- `receiver withdrawal while capacity is held refuses the recovered provider start and retains its Session`: first prove the offer and canonical directory are authorized. Withdraw the offer during the published wait, then release capacity. The old path calls the provider; the prepared assertion requires zero calls, the exact receiver refusal, no runtime error and an unchanged retained Session. A later targeted fault removes only the recovered post-wait recheck, keeping the initial check valid.
- `a delayed targeted Stop %j cannot cancel a cold follow-up owned by B`: use the actual command route with A's key, A's turn, and mixed B-key/A-turn identifiers while B waits. The old thread-only abort clears B's wait. The prepared cases require that wait to remain and B's provider turn to start after admission.
- Route cases `stale client Stop` and `stale turn Stop` in `a fresh /chat publishes to the real consumer and preserves accepted-send semantics: %s`: the real foreground start context carries B's accepted key. The old Stop cancels this start despite naming A. The prepared cases require a no-active-target result, a live pending projection and exactly one B provider start.
- `a delayed Stop for source A cannot cancel the credential restart of recorded source B`: emit, server-correlate and persist B, then let the real service recovery coordinator stage its restart behind the held slot. The old thread-only abort clears B's wait. The prepared case leaves B queued after stale A and permits the exact B Stop without another provider launch.
- `an automatic source with interactive attribution keeps retryable background refusal during credential recovery`: the real turn producer replaces a hostile adapter policy with the server's background policy while preserving interactive attribution. After an account failure and real profile staging, the old source drops that policy or re-derives interactive admission. The prepared case requires a retryable capacity refusal, no interactive wait and no second provider start. Later isolate stamp, coordinator-carry and restart-precedence faults separately.
- `Stop retires never-settling post-admission %s preparation and releases its lease before late completion` (fresh/respawn/restart): leave the production workspace resolver unresolved across the actual Stop route. The old code keeps the lease, so another background start is refused. The prepared cases require that next admission to succeed and the caller/pending projection to retire. Finally release preparation and require zero late provider calls.
- `Stop after the adapter was invoked retains the lease and indeterminate provider custody`: hold the provider effect, issue the exact B Stop, and lose its response. An incorrect whole-effect cancellation race releases the lease or reports pre-start cancellation. The prepared control requires the lease to remain held until settlement and the outcome to remain indeterminate.

Manifest link verification is separately bounded:

```sh
node scripts/check-markdown-links.mjs .github/pr-evidence/person-first-capacity/README.md --json
```

At the earlier published revision its six Markdown PNG links target files absent
from the tracked source snapshot. The correction uses plain local filenames,
retains the actual artifacts and does not imply an upload.

Later, separate admissions may cover `client-origin-propagation.test.ts`,
`session-recovery-coordinator.test.ts`, and the keyed-start context fixture in
`execution-target-execution.test.ts`; scoped typechecks; MCP topic regeneration
and review notes; branch-scoped readiness; normal pre-push transfer and publish.
Do not chain those broader stages onto the two-suite request without admission.
