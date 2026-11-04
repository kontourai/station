# Daily throughput review fixes

This supersedes the initial implementation's scope, cache treatment and
always-present empty array. All commands used the Command Line Tools developer
directory override because the default developer-tool selection was unavailable.
No gate was disabled and no live model was called.

## Contract

`engine_tokens_today` counts retained reported tokens only for conversations run
in Station. All read-only-attached/followed sessions are excluded before their
usage history is read. Outside CLI use is excluded. Hosted home-wide totals,
undated usage and undeclared scopes remain omitted.

The canonical allocation is grouped by source event before applying
`cacheInclusivePromptTokens`. Declared disjoint cache reads/writes are included
for Claude/Bedrock; other providers retain reported input without adding cache
again. Codex cache inclusivity remains unverified in the shared declaration.
Output is added once; reasoning is not separately added. This does not certify
provider comparability or billing equivalence beyond the declared rules.

The shared fold is unchanged. A cumulative decrease cannot be distinguished
from a correction, so earlier dated figures become unallocated. The executed
500k → 20k → 40k example contributes only the later 20k increase. Retaining the
500k would overcount corrections in other canonical accounting consumers. The
notice inventory, privacy generator and docs disclose this possible undercount.

Senders omit empty/unavailable throughput. Upgrade Lite receivers before
senders emit positive buckets; older strict receivers reject the new key.
The usage read occurs after releasing the daily-state lock, and a read failure
omits only throughput while sending the remaining ping. Attempt reservation
still occurs atomically before I/O. The corrected catalog re-shows the notice.

## Red before repair

Tests were added before production changes and committed in
`90b07207a3cef24b5ed964fc4ff6f6cc8d6b3672`.

| Finding | Observed failing regression |
| --- | --- |
| 1: followed imports | Real event-store/orchestration read returned 43,000,123 input tokens instead of the owned session's 123; attached Claude, Codex and OpenCode histories were included. |
| 2: disclosure scope | CLI notice, generated privacy policy and mounted UI choice lacked the Station-conversation scope. |
| 3: idle rollout compatibility | Empty ping carried `engine_tokens_today: []` instead of omitting the field. |
| 4: reset limitation | Generated privacy disclosure lacked the conservative cumulative-reset/correction undercount. Existing correction accounting proves why retaining all earlier dates is unsafe; the fold was not changed. |
| 5: cache normalization | Claude's separate canonical input/cache rows yielded `1-10k`, while equivalent Codex reported input yielded `10k-100k`. |
| 7: exception and lock | A throwing accounting callback rejected the entire flush; the lock-boundary regression observed the daily-state mutation lock held during the read. |

The first five-file red run reported 10 failed / 175 passed, 84.31 seconds.
The corrected lock-boundary probe plus runtime baseline reported the four
expected publisher failures / 61 passes, 105.78 seconds. The latter included a
green runtime-composition test on the unmodified production wiring.

## Runtime wiring deletion control (finding 6)

Coverage was missing; production wiring itself worked. After committing the
tests and confirming a clean tree, removed only the `dailyUsage` callback from
`StationRuntime.initializeUsageTelemetry` and ran:

```sh
npm run test:focused -- src-server/runtime/routes/__tests__/runtime-routes-usage-telemetry-late-binding.test.ts
```

The new runtime-to-ping assertion failed for the intended reason: the emitted
ping lacked `claude:10k-100k`. Result: 1 failed / 17 passed, 56.36 seconds.
Restored the exact source bytes while preserving intervening documentation edits.
The six-file post-fix run, including this restored runtime seam, passed 203/203
in 182.27 seconds.

The runtime test constructs the real telemetry service through the production
runtime initializer and observes the outgoing next-day ping after changing its
accounting source. It does not qualify live model execution or native shells.

## Local qualification

The six-file green run covered parser/notice, real canonical accounting and
adapter usage, publisher behavior, generated privacy artifacts, mounted UI
consent routes and the runtime initializer. UI copy ratchet: zero new findings.
The generated privacy policy and store disclosure were regenerated from their
inventory; the Lite reference catalog was regenerated from its owner.

[Corrected notice](lite-engine-tokens-fix-after.png): component markup/styles
at 390 pixels on the left and 1440 pixels on the right, light above and dark
below. All combinations were inspected. Compare the prior
[notice](lite-engine-tokens-after.png). Component renders do not qualify an
installed application journey.

NOT_VERIFIED: live-provider accounting completeness, Codex cache inclusivity,
installed/native behavior, Worker receiver execution, production receiver
rollout, endpoint enablement, billing equivalence and release qualification.
