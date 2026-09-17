# Pane or shell: the criterion

Status: adopted with epic station#4142 (owner direction, 2026-08-25). This is
step 5 of that epic, written early so surfaces stop being argued one at a time.

Station is converging on one composition model: **work surfaces are panes**,
declared through the workspace-pane contract that plugins already use, and the
shell is the fixed machinery that hosts them. This document is the decision
rule for which side of that line a surface sits on, and the current
classification of every surface the shell knows.

## The rule

> **A surface is a pane if a user could reasonably want it beside their other
> work, rearranged, or replaced. A surface is shell if it is the machinery
> that makes panes — or the user's access to Station itself — possible.**

Three tests, applied in order. Any "yes" to 1 or 2 means shell; otherwise
pane.

1. **Does it repair or establish access?** Onboarding, pairing, the auth
   boundary, connection recovery. A user must never be able to compose away
   the surface that fixes their setup — an environment you can break such
   that its repair tool is gone is not customization, it is a trap.
2. **Does it host or configure the composition itself?** The sidebar, the
   page frame, the pane hosts, Settings (including whatever surface manages
   which panes are installed and placed). The machinery that holds panes
   cannot itself be a pane without a fixed point somewhere; Settings is that
   fixed point.
3. **Otherwise it is a pane** — even when today it happens to be a route.
   A route is not an identity; it is a *placement* (this pane, standalone,
   at a stable URL). A pane may keep that placement, or drop it once another
   placement carries the surface — what it may never do is drop the URL (see
   the first invariant below).

## Two invariants the rule depends on

- **URLs survive pane-ization.** A deep link that worked before a surface
  became a pane still resolves to that surface afterwards. It need not
  resolve to the same *placement*: when a pane's standalone host goes away,
  its path joins the retirement table (`getLegacyPathRedirect`) and redirects
  to the surface's canonical placement, carrying its payload. `/activity`
  and `/activity?session=…&focus=evidence` are the worked example —
  station#928 removed the standalone placement and both spellings now land on
  `/?surface=activity[&session=…][&focus=evidence]`, minted by the one builder
  (`activityDeepLink`) every producer of those links already uses. What the
  invariant forbids is a 404 or a silently discarded payload: if converting a
  surface would break a URL, the conversion is wrong, not the URL.
- **Panes consume declared data surfaces.** A pane — first-party or not —
  reaches server state through the same declared surface a plugin could use,
  never through internal service access. This is where plugin compatibility
  is actually won: a first-party pane on a private API is a compatibility
  promise core cannot keep. (Precedent: the `/api/insights` lesson — a second
  reader of an authorized store eventually gets the authorization wrong. One
  exported predicate, consumed; never reimplemented.)

## Classification of today's surfaces

Pane (work surface — target state; most are routes today and stay routable):

| surface | note |
| --- | --- |
| Home | descriptor already exists (`workspace-home-pane.ts`); placement is epic slice M2 |
| Chat | already a pane; the dock and the fullscreen layout are placements |
| Activity | station#3193 asks for exactly this |
| Console Board | already a Console Kit view behind D8; first extraction candidate |
| Agents | list+detail work surface |
| Connections | work surface, though its recovery flows are shell (test 1 splits pages, not areas) |
| Registry | browse/install work surface |
| Review queue | work surface |
| Notifications | work surface (the bell is shell chrome; the page is a pane) |
| Schedule | work surface |
| Guidance (skills/commands) | work surface |
| Coding / evidence / previews / task room / spatial board | panes today |

Shell (fixed machinery):

| surface | which test |
| --- | --- |
| Onboarding, pairing, auth boundary, connect/recovery banners | 1 |
| Settings (all sections, incl. feature previews) | 2 |
| Profile | 1 (credentials and device identity) |
| Developer | 2 (it gates surfaces — the monitoring TAB it hosts is pane-shaped and may move later) |
| Plugins | 2 (it manages what panes exist; the fixed point argument) |
| Sidebar, header, palette, page frame, pane hosts, toasts/banners | 2 |

Classifications above test 3's line are defaults, not verdicts: moving one row
later is a normal decision. Moving something OUT of the shell rows requires
answering its test explicitly.

## What this does not decide

- The order of migration (the epic owns sequencing: modes contract first,
  then Home, then Activity, then Board extraction).
- Multi-mode semantics, per-mode availability, or any new pane mode
  (station#4090).
- Whether officially-extracted plugins ship in-repo or out; that is a
  packaging decision for the Board slice.

## Runtime tiers (owner decision, 2026-08-25, epic station#4142 M4)

"Official surfaces become plugins" raised the question of what runtime a
plugin pane gets — and the answer is tiered, not singular. **The in-process
React + SDK path is a supported, permanent tier, not a transition state**;
the iframe is the boundary for code Station has not trusted, not the
destination for everyone.

1. **Published contracts — everyone.** Descriptors, modes, the manifest, the
   declared data surfaces. Runtime-agnostic; this is the layer the modes
   contract (#4154) and the placed panes ride.
2. **In-process React + SDK — first-party packages.** Full
   `@kontourai/station-sdk` hooks inside Station's own React tree, no
   isolation tax. The Board extraction (M4a) proves this tier: the package
   consumes only published contracts, so core cannot drift under it silently,
   while rendering stays native. A trusted/signed third-party tier here is a
   possible future, not a promise.
3. **Sandboxed iframe — untrusted third parties.** A plugin here can still
   be BUILT with React and an SDK; what it cannot do is reach into Station's
   live component tree — its SDK speaks across the boundary. Dogfooding this
   tier means one official plugin eventually ships through it, so the path
   third parties actually use is one whose breakage first-party work feels.
   That is a follow-up, and it does not migrate anything out of tier 2.

### What the iframe defends, precisely (owner question, 2026-08-25)

It is NOT the server side. A plugin's server half already runs real code on
the host under install-time consent — MCP servers, providers, integrations —
and the iframe does nothing about that. The iframe addresses the OPERATOR'S
BROWSER SESSION, where in-process code would run not with what the plugin
declared but with everything the page has:

- **Ambient session authority** — the device cookie is in scope, so
  in-process plugin UI could call ANY API as the operator, not its declared
  surface. Consent lists what a plugin says it does; the boundary is what
  makes the list enforced on the client.
- **Cross-pane reach** — reading other panes' DOM (another project's secrets
  on screen), observing keystrokes app-wide, repainting other surfaces.
- **Updates** — consent at install of v1.0 says nothing about v1.4; the
  boundary caps the blast radius of a later-compromised update, which is how
  marketplace supply-chain incidents actually happen.
- **Paired devices** — Station scopes devices deliberately (redacted logs
  for paired readers, scoped grants). In-process plugin UI runs with
  whatever the RENDERING device's session holds, on every device; the
  boundary keeps a plugin's client surface equal to its declaration
  regardless of who is looking.

Plus two non-security effects: crash containment (an in-process failure
takes the shell down; an iframe's does not) and toolchain decoupling
(in-process demands exact React/reconciler compatibility with Station's
bundle, forever).

**The tier boundary is therefore trust, not authorship.** The real-world
case for the iframe is the arbitrary Registry install and its day-two
update — nothing else. A trusted in-process third-party tier
(signed/reviewed, or an operator explicitly granting full UI trust) remains
a possible future; so does the opposite position, where install consent IS
full trust and the boundary is skipped — that is a product decision with
known costs, and nothing built here forecloses either answer.

The compatibility promise decomposes accordingly: tier 1 is guaranteed by
first-party surfaces riding it (M2/M3/M4a); tier 3's runtime is guaranteed
only once something official rides it too. Stating the split keeps either
half from being mistaken for the whole.
