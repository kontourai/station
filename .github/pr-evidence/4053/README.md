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
