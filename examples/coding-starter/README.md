# Coding Starter

A host-only Agent Plugins 1.0 package with two Station Workspace Panes and one
owner-qualified review action. The package ID and source directory remain
`coding-starter`.

**Coding Workspace** shows a labelled sample file list and terminal output. **Coding Diff Review**
shows a labelled example diff and review prompts. These are authored examples,
not a live repository browser, command runner, or current Git diff. Connect an
appropriate provider before presenting real project data.

## Install and place

Use a Station build supporting the `io.kontourai.station` namespace, Project
Pane SDK context, and captured host actions. Candidate SDK/CLI availability does
not imply an npm publication. From this directory:

```sh
station plugin build
station plugin preview .
station plugin install .
```

Review the `navigation.dock` and `agents.invoke` permissions. Open the intended
Project, choose **Add pane**, then **Coding Workspace** or **Coding Diff Review**. Installation makes
the contribution discoverable; placement is an explicit Project action. Both
Panes can also be placed in the host's supported Project Layout regions.

**Open Chat Dock** only opens the existing dock through the public navigation
SDK. It does not submit the sample code or choose an Agent. **Review current
diff** is the separate action in the host action bar. Its authored prompt asks
the package-owned `coding-starter-assistant` to review the current diff; it does
not automatically attach the sample diff shown by the Pane. The Agent needs
appropriate repository access to inspect a real diff.

## Agent and execution

The packaged Agent definition contains its original name and prompt, with no
engine or model override. Configure a compatible native model connection in
Station before invoking it. The host binds the declared own-plugin Agent to
its exact installation and the selected Project; it does not silently select
an unrelated Agent when configuration, permission, or ownership is missing.

For Projects configured with worktree execution, the canonical owner provisions
the Session workspace. Native Bash and relative file operations use that
Session directory; explicitly configured MCP roots retain their own meaning.
This is execution-location propagation, not a universal filesystem sandbox.
An uncertain launch is never automatically retried.

An unavailable Pane or action displays its host reason. Pending activation can
require recovery; an uninstalled package withdraws its rendered controls. There
is no whole-plugin enable/disable workflow implied by this example.

## Package and migration

The package includes `plugin.json`, authored source/CSS, `agents/`, and this
README. No install hook copies files into Station's checkout. Building a copied
source directory requires compatible candidate tooling and its dependencies;
no independently resolved public-registry install is claimed here.

| Previous input | Current input |
| --- | --- |
| Legacy `layout.json` with Workspace and Diff tabs | Two explicit Project Pane descriptors with stable descriptor and renderer IDs. |
| Top-level Station fields | The Agent Plugins 1.0 Station namespace. |
| Global review action and default Agent | The same single `workspacePaneHost` contribution and own-plugin Agent reference, never duplicated per Pane. |
| Optional legacy `onShowChat` callback | The existing public SDK dock navigation call; the unused callback is removed. |
| Agent source missing from package files | The exact authored Agent file is packaged. |

This slice does not remove compatibility parsers or complete
[the example migration](https://github.com/kontourai/station/issues/265). It adds
no command-palette protocol and does not resolve
[#1419](https://github.com/kontourai/station/issues/1419).
