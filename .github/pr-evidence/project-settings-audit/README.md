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
