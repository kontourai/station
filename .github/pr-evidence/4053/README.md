# Onboarding review captures — PR #4053

Retention: source-pinned visual evidence for this PR; retain with its review history.
These inspected screenshots show UI state, not provider, signing, store or full
native lifecycle qualification.

- `mobile-before.jpg`: a fresh Android emulator install from protected main
  `e3ab846f6c32b4656feb1db7dfbfe573b9362238`, hosted Android run `40002076394`.
  No Station was configured. The workspace mounted and displayed an API setup
  error plus unavailable recent work.
- `mobile-after.jpg`: the same emulator and viewport, fresh onboarding package
  from `745291d461b87184a1d044f43b068174b91b61d6`, hosted Android run
  `40007192891`. It shows the QR-first connection boundary and computer handoff.
  This comparison does not claim emulator camera or physical multicast success.
- `desktop-home.jpg`: the isolated current branch's first-session Home at
  `faefb1de1d79ae2ef120590eb2f31dcebea21ffb`, with agent guidance and optional
  **New Project** retaining repository, folder, document and tool starts.
  No provider turn was sent for this capture.

The test hosts, native package identities, actual permission/scan interactions
and current check outcomes are recorded separately in the PR description.

## Physical B10 journey — 2026-10-23

Pixel 10 Pro XL, Android 17/API 37.1, running the separate
`io.kontourai.station.onboarding.debug` package from hosted Android run
`40007192891` at `745291d461b87184a1d044f43b068174b91b61d6`.
Normal Station packages and their data were preserved.

- `b10-permission-denied.jpg`: denied the actual local-network permission prompt.
  Station showed the refusal and retained **Check again**. Retrying and allowing
  the prompt returned to an explicit check, without starting a scan.
- `b10-nearby.jpg`: a subsequent foreground scan received the real isolated
  publisher at its bound API listener, `192.168.50.16:18791`. It remained an
  untrusted hint. Selecting it opened address review with **Request access**
  disabled until explicit HTTP consent.
- Pressing Home during a fresh scan, then reopening the test app, showed
  **Discovery stopped. Keep Station open and check again.** A subsequent check
  found the publisher again.
- Denying the actual camera prompt retained retry and manual entry. Retrying
  with a one-time camera grant opened a live preview. Brian pointed the camera
  at the isolated host's QR; the app decoded it and presented endpoint/identity
  review before sending the request.
- Completing that invitation reached connected Home. The host independently
  listed the test device with **Read-only** access. `b10-paired-home.jpg` shows
  the saved connection working after force-stopping and reopening the test app.
  The scanner had no remaining video element after completion. No chat/provider
  turn was sent.

Cleanup disabled the isolated host's LAN publication, revoked only this test
device's credential, stopped the test host, and removed only the temporary
HTTPS Serve mapping. The complete Serve configuration matched its pre-test
JSON afterward. The test app was stopped and the device panel closed without
shutting down the phone.

These are observations of the named artifact and device. The later static-type
repair extracts the same visibility checks into a fresh-read predicate; its
focused tests and typechecks are separate evidence. Physical iPhone, signed
distribution, store processing and other Android versions remain unverified.
