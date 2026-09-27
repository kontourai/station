# Store listing copy

Draft listing copy for owner review before submission. Match the exact channel,
current build, supported workflow and privacy declarations; this file is not
evidence that the consoles contain the copy or that a store approved it.

Support URL: https://kontourai.io/support/
Privacy URL: https://kontourai.io/privacy/station/
Proposed seller: Kontour AI LLC — confirm the legal identity on the provider account
Stable bundle / application ID: `io.kontourai.station` — use the selected channel's identity from [store entry](store-entry.md)
Category: select a current Play category from [Google's category list](https://support.google.com/googleplay/android-developer/answer/9859673) (there is no Developer Tools app category there); Developer Tools is the proposed App Store category
Proposed ads answer: no — verify the submitted build and its integrations
Age: complete the provider questionnaires for the actual build and audience.

Seller, ads, age, privacy and tracking answers require owner review. Source
configuration does not establish the provider account's legal identity or a
complete privacy declaration. Include integrated third-party code in that review;
see [Apple's privacy and data-use guidance](https://developer.apple.com/app-store/user-privacy-and-data-use/).

## Name

Station

## Subtitle (Apple, 30 characters)

Agent work with receipts

## Short description (Play, 80 characters)

Connect to your Station host to continue agent work, Tasks, and Sessions.

## Full description

Station is Kontour's local-first agent workspace. It keeps projects, Tasks,
Sessions, evidence gates, readiness, and receipts in one place while you work
with Station agents or with agent apps you already use.

Station brings work and its recorded context together. Gates and receipts
apply where the selected workflow provides them; their presence is not a
guarantee that every action has been independently verified.

- One project context — Tasks, Sessions, changed files, artifacts, and
  receipts stay connected.
- Your choice of model or agent app — a local model, a hosted model service,
  or an agent application. Transport details are not product concepts.
- Visible trust state — gates, missing evidence, and readiness stay beside
  the work they describe.
- Host-owned work — the mobile app connects to a Station host that stores the
  shared work. The phone also retains its own connection state. Configured
  providers and optional delivery services have separate data boundaries.

The mobile app is a client for a Station you run. Pair it with a host on your
network, then continue the same work from your phone.

See the privacy policy for data handling by the app, your Station host, and
configured providers.

## Keywords (Apple)

agent,workspace,developer,receipts,tasks,local,cli,coding

## What's new

Replace this draft for each actual release with changes present in that build.
Do not keep “first public testing build” as a standing release claim.

## Screenshot shot list

Capture from a paired real device. Do not invent UI or restyle a desktop
screenshot. The content plan below is not a statement of store minimums.
Choose currently accepted device sizes and file formats from
[Apple's screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/)
and [Google's preview-asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151).

| Slot | What to show |
| --- | --- |
| iPhone #1 | Paired home / project with a visible Task |
| iPhone #2 | Chat or Session with a gate or receipt visible |
| iPhone #3 | Pairing / connection screen |
| iPad #1 | Same paired project on tablet |
| Android phone #1–3 | Same three beats as iPhone |
| Play feature graphic 1024×500 | Wordmark + one short line: "Do the work. See the gates. Keep the receipts." |

Store these under a local owner folder, not this repository, until a later
change admits a reviewed capture set. The repository ignores most PNG files,
with named icon, brand and screenshot-baseline exceptions; ignore rules are
not publication permission.

## Reviewer notes (internal testers only)

Internal Play and TestFlight groups do not need these notes. External
TestFlight and App Store review need an actionable review journey. The
[historical unpaired first-launch finding](https://github.com/kontourai/station-archive/issues/1772)
records the original gap. Verify a reachable, authorized host or demo path for
the submitted build; this audit did not qualify one.
