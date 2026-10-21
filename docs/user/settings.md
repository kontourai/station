# Settings you may not have found

Most Settings rows explain themselves. This page covers four sections that
change what Station offers rather than how it looks. Open **Settings**, pick a
page in the left rail, or search for a setting by name. You can also find any
Settings row from the [command palette](../guides/keyboard-shortcuts.md#command-palette)
(⌘K or Ctrl+K).

| Section | Page | Saved |
| --- | --- | --- |
| Feature previews | **Advanced** | On this Station |
| Developer tools | **Advanced** | To your account when you are signed in, otherwise on this device |
| Shared answers | **Privacy & sharing** | On this Station |
| Device hosts | **Devices** | On this Station |

## Feature previews

Feature previews are features that are still being evaluated. Each one has a
switch, a name and a description of what turning it on does. A preview is listed
only when this Station's build can run it; if none is, the section says
"No previews are currently offered". Previews start off.

The current preview is **Fleet consumer probes**: before routing work to a
model that another Station contributes, Station sends a test request to it.
That test can spend a completion on the other Station.

Turning a preview on affects everyone who uses this Station.

## Developer tools

**Enable developer tools** shows the **Developer** page in **Customize** and
the command palette, and its **Monitoring** page in the command palette. It is
off by default; a direct `/developer` link still opens when it is off.

Enabling it also reveals three independent previews: **Flow delivery preview**,
**Veritas readiness preview**, and **Trust preview**. Each starts off and is
saved on this device. The tools require both Developer tools and their own
preview switch to be on. Turning Developer tools off makes them unavailable
without clearing those saved choices. These device previews are separate from
the Station-wide Feature previews above.

## Shared answers

This section lists the answer links you have created, with their state and
expiry, and lets you revoke them. See [Share an answer](sharing-answers.md).

## Device hosts

A device host is another Mac or Linux computer that runs iOS simulators or
Android emulators for Station over SSH. Station uses your SSH agent and
configuration and never stores a key. Only the Station operator sees this
section, and only on a personal Station.

1. Confirm the host key once in a terminal: `ssh user@host`.
2. Choose **Add device host** and enter a **Name** and an **SSH target**, such
   as `me@build-host.example` or an alias from your SSH config.
3. Choose **Test connection**. Station checks that it can reach the host and
   that Node.js, Xcode simulators and the Android SDK are available.
4. Choose **Enable device hub** and confirm **Install and enable**. Station
   installs its device hub on the host under `~/.station-device-host`.

Each host's menu also offers **Share devices…**, **Disable hub**, **Edit** and
**Remove**. A Station can have up to 32 hosts. The
[mobile device workspace guide](https://github.com/kontourai/station/blob/main/docs/guides/mobile-device-workspace.md)
explains what you can do with the devices once a host is ready.

## Link to a setting

Every Settings row has a stable address of the form
`/settings?view=<section>&highlight=<row>`, for example
`/settings?view=feature-previews&highlight=feature-previews`. See
[Settings deep links](https://github.com/kontourai/station/blob/main/docs/reference/settings-deep-links.md).
