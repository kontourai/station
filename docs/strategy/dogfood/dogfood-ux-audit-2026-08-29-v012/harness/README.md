# UX-audit walkthrough harness (issue #765)

Reproducible driver used to collect the evidence in `../evidence/`. Re-run it
against a fixed build to verify findings before checking them off on #765 —
**a finding is closed only with a fresh-home re-run showing the behavior
changed**, not with a merged PR alone.

## Re-run recipe

```bash
# from a station checkout at the build under test
./station start --home=$(mktemp -d) --port=18541 --ui-port=18500 --consent-port=18544

# mint a browser bootstrap token (home = the temp home above)
curl -s -X POST http://127.0.0.1:18541/.well-known/station/v1/pairing/mint-ui-bootstrap \
  -H 'content-type: application/json' \
  -d "{\"secret\":\"$(cat <home>/runtime/local-grant.secret)\",\"deviceName\":\"ux-verify\"}"

# first steps file must open http://localhost:18500/#station-ui-bootstrap=<token>
node drive.mjs steps-<flow>.json   # needs playwright linked into node_modules
```

Screenshots land in `shots/` next to `drive.mjs`. Step files are ordered
roughly as the audit ran: routes sweep, chat flows, project/layout flows,
schedule, overlays, dock, delegation. Compare against `../evidence/` images.

The durable version of this loop is issue #766 item 1 (fresh-home release
walkthrough in CI); this directory is the manual seed for it.
