# Project settings audit

Scope: the Project settings page and its twelve navigation sections, based on
`49479a210` plus this branch. This is a source and focused-behavior audit,
not a claim of live provider, cloud, or native-shell qualification.

## Control inventory

| Section | Purpose and effect | Save owner / evidence |
| --- | --- | --- |
| Workspace | Working directory; suggestions and normalized path preview | Page Save → `buildProjectSavePayload` → project update route/service. Clearing now sends an empty string. Worktree requirements remain server enforced. |
| Basic info | Name, icon, description | Page Save. Invalid icons block Save; unchanged legacy icons are omitted. Blank names cannot be saved. |
| AI model | Ready model connection plus model override | Page Save. Both are needed; clearing a connection clears its model. No connection means Station default. |
| New chats | Fixed versus last-used model/approval; configured approval mode | Page Save. Agent approval settings and explicit composer choices retain precedence. Full access remains permission checked. |
| Thread execution | Current/saved/peer environment and worktree isolation | Page Save. Environment routing and workspace isolation are distinct controls. Inheritance remains an explicit choice. |
| Agents | Default Agent and global Agent availability filter | Page Save. Project-owned Agents are implicitly available. Query failure now offers Retry and disables filter controls. Named labels activate the actual inputs. |
| Tools | Additive integrations and automatic Knowledge tools | Page Save. Agent restrictions still apply; native turns and external sessions adopt changes at their established boundaries. |
| Layouts | Add and remove Project layouts | Immediate mutations; confirmation for removal. Read failure now differs from empty inventory. |
| Sources | Libraries, documents, repositories, S3, workspace selection and operator setup | Each child owns an immediate mutation and authority scope. Existing source tests cover refusals, recovery and capabilities; no live AWS claim. |
| People and access | Membership, sharing and tool/source permissions | Immediate project-access commands; server-owned authority. Existing access tests cover denial and recovery. |
| Project knowledge | Earlier document corpus, directory indexing, migration | Immediate mutations. Failures are now visible, file failures are attributed, and uploads cannot overlap through the dropzone. Canonical store attachment remains in Sources. |
| Danger zone | Delete project | Confirmation plus immediate mutation. Chats/tasks remain in history. |

## Repairs

- Preserve dirty drafts when Project queries refresh; reconcile normalized save responses without discarding edits made while Save is pending.
- Send cleared directory values, reject whitespace-only names, and distinguish draft paths from stored values.
- Add named Agent checkboxes and visible read-retry states for Agents, layouts and documents.
- Report scan/upload/delete/clear failures; keep partial upload failures visible.
- Use the shared Button owner for settings actions and shared spacing/control tokens in the edited layout.
- Preserve mobile bottom padding for the dock reservation; keep icon targets at least 44px.
- Shorten descriptions and distinguish page Save from immediate actions in context.

## Evidence and limits

Focused component tests cover outgoing save payloads, inheritance, model
selection, environment selection, navigation guards, query retry and mutation
failure presentation. Browser captures mount production page/Agent/layout/
knowledge/tool components with explicit query fixtures at 390 and 1440 pixels
in dark and light themes. Source/access and model/environment/path picker
internals are substituted there and have separate owner tests.

The browser fixture uses a 72px dock reservation. It verifies the final action
at maximum body scroll, horizontal overflow, icon target size, and visible
Agent-label activation. It does not qualify actual shell dock hit testing,
provider execution, remote/cloud credentials, or native platforms.

The documentation review retained the default/precedence and migration
contracts in `docs/user/getting-started.md` and `docs/guides/knowledge.md`.
Historical Knowledge ADR/design claims are unchanged: the patch changes error
presentation, not canonical storage, migration guarantees or derived indexing.
The shell-skeleton design's loading policy remains accurate.

## Remaining qualification

- Live AWS acceptance remains explicitly unverified by the existing S3 owner.
- Real provider/environment execution, shared-member permissions, and restart
  persistence require the established live journey qualification. Passing a
  fixture test does not establish those outcomes.
- The Sources and older Project knowledge sections retain separate functions:
  canonical store management versus the earlier corpus and migration. Combining
  them would require a storage/migration journey change, not just deleting UI.

## Final validation — 2026-10-28

Production changes: `bc040c03b`; documentation review notes: `0179312f1`;
browser fixture correction: `21350ccc1`. Retention: the PNGs beside this note
are inspected, source-pinned component captures for this audit, retained with
its review history. They are after-change captures, not live-shell acceptance.

- PASS: 142 tests in all 15 focused settings files, including Sources/access
  owner tests and browser layout/interaction checks.
- PASS: E2E typecheck after building the missing Station Connect declarations.
- PASS: repository lint, governance, code hygiene, component-style hygiene,
  and verification-policy checks in the completed readiness run.
- PASS: documentation freshness after recording seven reviewed source changes:
  467 reviews and 33 captures checked, zero advisories. The documentation
  index/reachability recheck passes.
- PASS: controlled regressions for dirty-draft refresh, cleared directory
  serialization and partial upload failure each fail for their intended
  reason with the old behavior injected; restored focused run passes.
- PASS: removing mobile dock padding fails the corrected browser geometry
  assertion (842.86px exceeds the 828px boundary); restored browser test passes.
  The earlier fixture allowed ancestor scrolling and failed this effectiveness
  check; its corrected viewport frame and ordinary Delete/Cancel interaction
  were independently reviewed. No production changes followed the review.
- Deslop: no additional behavior-neutral cleanup was needed in the final diff.
  Independent production review and the browser delta review found no blockers.

Readiness is **not fully green**. Its documentation lane initially found stale
reviews (repaired above) and a learning-media timeout. The targeted recheck
has 38 passing tests and that one remaining timeout: the phase trace spends
46.2 seconds in `read-review-state`, exceeding its 30-second deadline. Its
assertion phase completes, but the test remains failed; no deadline was raised.
The required code-health attempt also remains unverified: Fallow received
SIGTERM before producing its report (exit 2). These are retained verification
limits, not passing receipts. Broad selector output executed no tests and is
not counted as completion evidence.

Live qualification still needs real provider/environment execution, AWS,
shared-member permission journeys, persistence across restart, native shells,
and the actual shell dock. A refresh skipped during a dirty draft is retained
until another query change; reverting the draft alone does not adopt that
skipped remote snapshot.

The branch is local; no PR, deployment, or merge was performed.

## PR #4278 capture and hosted-check follow-up

Compared the same fixture against `origin/main` at `8718e01c72a5a39778e1ebeed607b0a5b9bf66cf`
and the submitted branch. Retained baseline captures accompany this note.

- At 1440 light, switching from Danger zone back to Workspace and capturing
  before transitions settle reproduces two filled-looking links on **main**:
  Danger zone has no `aria-current` and background alpha 0.54 while fading out.
  The branch reproduces the same inherited transition. Product tab styles are
  unchanged. Captures now wait for animations to finish and verify exactly one
  current link and a transparent inactive Danger zone.
- At 390 dark, main keeps `station` intact while the branch's shorter `path`
  label exposed a mid-word break. Explicit separator break opportunities now
  keep this leaf together without changing the copied path. The new browser
  assertion failed with two leaf lines before the repair and passes afterward.
- Hosted shard failures were reproduced locally in ProjectLayoutsSection:
  three tests used the former `+ Add Layout` label. The assertions now use
  `Add Layout`; the redundant empty-state button was removed because the header
  already offers that action. All 24 owner tests pass. The browser and settings
  owner tests pass (45 tests combined).
- Hosted documentation failure was a stale Knowledge guide review after the
  post-merge assertion edit, rather than the earlier local timing limit.
  Updated source review notes accompany this follow-up.
