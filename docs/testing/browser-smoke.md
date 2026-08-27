# Deterministic PR browser smoke

Every ordinary pull request runs `npm run test:e2e:pr-smoke` against a unique
Station instance with a temporary home and dynamically allocated loopback-only
API/UI ports. It cannot share state or ports with an always-on dogfood
environment on the same host.

The normative manifest is `PR_BROWSER_SMOKE_CONTRACT` in
`tests/e2e-manifest.mjs`. Its three journeys cover:

1. production-built shell startup, CSP, and connection-recovery navigation;
2. live project and connected-agent CRUD through the isolated server; and
3. canonical chat transcript, tool activity, and tool approval behavior.

Each selected spec also monitors browser page errors, console errors, failed
document/fetch/XHR/script/stylesheet requests, and HTTP 5xx responses. The lane
runs with one worker, zero retries, and a ten-minute execution budget. A failure
blocks the lane and must be fixed; retrying until green is not the flake policy.
CI retains the HTML report, traces, and failure screenshots for 14 days.

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
