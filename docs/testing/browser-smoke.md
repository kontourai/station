# Deterministic PR browser smoke

The `fast-checks-statics` job runs `npm run test:e2e:pr-smoke` for
same-repository pull requests and merge-group candidates. The required
`fast-checks` aggregator requires that job and the affected-test plan/shards to
succeed; it also validates their exact-plan receipts. Fork pull requests
use a separate isolated job. The smoke runner creates its own Station instance,
temporary home, and dynamically allocated loopback API/UI ports, keeping it
separate from an always-on dogfood environment on the same host.

The normative manifest is
[`PR_BROWSER_SMOKE_CONTRACT`](../../tests/e2e-manifest.mjs). Its seven selected
specs cover these journeys:

| Spec | Journey |
| --- | --- |
| `connect-modal` | Manual connection consent, keyboard access, and saved hosts |
| `connect-remote-auth-recovery` | Phone-sized connection access and authentication recovery before protected bootstrap |
| `csp-shell` | Production-built shell startup, CSP, and connection-recovery navigation |
| `ui-crud-smoke` | Project and connected-Agent CRUD through the isolated server |
| `orchestration-chat-flow` | Transcript, tool activity, and approval UI driven by synthetic canonical events |
| `cross-runtime-chat-switching` | Deterministic provider continuity and mobile layout containment, including the required 320/390/412-pixel switcher observations |
| `pr-smoke-live-chat-send` | A real orchestration HTTP dispatch and rendered reply from a local Ollama-compatible fixture server |

The last journey tests Station's request and rendering path; the fixture returns
fixed text and does not run a model or contact a provider. A phone-sized browser
viewport is not physical-phone evidence.

[`monitorBrowserHealth`](../../tests/helpers/browser-health.ts) catches page
errors, application console errors, HTTP 5xx responses, and selected failed
resource requests where a test installs it and calls `assertHealthy()`. It
excludes ordinary HTTP 4xx console reports, aborted requests, and failed
`/events` requests. It is not a global fixture: the two connection specs do not
use it, and the cross-runtime spec uses it for one test. Read each journey's
own assertions before treating the lane as general browser-health coverage.
[#2812](https://github.com/kontourai/station/issues/2812) tracks an explicit
health policy for every admitted journey, including expected connection refusals.

The runner uses one worker and zero Playwright retries. The
[required CI step](../../.github/workflows/ci.yml) has a ten-minute timeout;
the local command does not impose that aggregate deadline. Test-specific
timeouts and bounded retries through product controls still apply. A failure
blocks the lane; rerunning until green is not the flake policy. CI attempts to
retain reports, traces, and failure screenshots for 14 days, but artifact
upload is allowed to fail without changing the test verdict.

## Verification and flake checks

Run the normal lane:

```bash
npm run test:e2e:pr-smoke
```

Prove that browser-health regressions fail closed:

```bash
STATION_E2E_SEED_REGRESSION=console npm run test:e2e:pr-smoke
```

The seeded command must fail with
`STATION_E2E_SEEDED_CONSOLE_REGRESSION`. Remove the environment variable and
run the normal lane three consecutive times before changing the manifest,
runner, or shared browser-health policy. Record all three durations in the PR.
Arbitrary sleeps, conditional early-return passes, and retry increases are not
accepted flake fixes.
