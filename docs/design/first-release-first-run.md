# First-release design: First run and connecting a device

Status: agreed design; delivery in progress under [#5386](https://github.com/kontourai/station/issues/5386). GitHub owns live delivery state.

Part of the [first-release design](first-release.md). The numbered changes on each screen are the acceptance criteria for the slices that deliver them. Slice numbers refer to [the execution plan](../plans/first-release-ui.md).

Home becomes the only first-run screen, with no wizard, and connecting a phone takes one scan.

## What is wrong today

- Five first-run mechanisms overlap on one Home: a setup launcher card, a Finish setup dialog, a three-step tour, a re-entry card, and engine setup inside New Chat. The launcher hides whenever any engine is ready, so the path differs from machine to machine.
- On a fresh install with eight engines found, the wizard pre-checks all 8 with "Connect and set up X" rows. In code, "Set up" means creating an Agent for that engine. That is housekeeping that a person cannot decide.
- The wizard dead-ends. "Set up 8" stays on step 1, two engines fail with "could not be set up. Try again in a moment" and no reason, and "Continue without them" closes the wizard instead of moving on.
- The default model changes during setup as each engine becomes ready. Nothing stores a default. The composer takes the first runnable agent.
- "Choose what powers Station" is technical and opaque. It shows seven identical rows saying "Can operate Station", and it sets the engine that runs Station's own agent.
- "About you" is cramped and does little. Its own note says it only affects Station's own engine.
- The Finish setup card promises a Usage sharing step that a fresh install launched from a terminal never shows. The disclosure appears only while it is outstanding, and a server started from a terminal prints the notice to its log and records it as shown. Browser users of a terminal-launched server never see it in the app.
- The unpaired screen offers 5 routes plus a sample workspace with its own tour. Pair with a code opens on a red "Camera error: Not supported". Pairing by code adds the device on the host while the device shows nothing. Request access fails with "This Station does not allow access requests from this app address", and the only remedy today is a command-line flag.

## Agreed structure

- Home is the first-run surface. There is no wizard, no tour, no launcher card and no re-entry card.
- Home shows the composer plus a short list of what Station found on the computer. Each row offers one step the person takes, such as Add or Sign in. Nothing found is configured until the person adds it.
- Customize › Overview, and the "what can run now" table at the top of Customize › Engines, is where setup lives afterwards.
- Station saves a Default for new chats: the first signed-in engine, in fixed order (Claude Code, Codex, then the others), using that engine's current model. It never changes because another engine becomes ready.
- Every detected and ready engine appears in the picker. Its Agent is created the first time the engine is used, not as a ticked batch.
- Station's own agent runs on the same engine as the default for new chats until the person changes it in Settings.
- When engines are installed but none is signed in, the Start button becomes "Sign in and start", and the message is kept.
- When nothing is installed, there is one choice among Claude Code, Codex, or Station's own engine plus a provider. Then install and sign-in happen from Home.
- Pairing a phone has one primary route: scan the QR with the phone's own camera. Typing a code plus address is the fallback, with an address check before the code is spent. Request access sits one row below.
- Home shows one card under the composer at a time: the usage-sharing choice first, then a tip about apps. Nothing about apps appears on first open.

## Before and after

| Task | Today | Agreed |
| --- | --- | --- |
| First message, an engine installed and signed in | About 8 to 9 decisions over 6+ screens. Skipping setup gives 0 decisions but a wrong default (whichever engine became ready first). | 0 required (type, then Start), 1 optional (usage sharing) |
| First message, installed but none signed in | About 4 to 5 decisions and 5+ clicks, and the composer is left behind (reasoned from code) | 1 (approve the sign-in in the browser), and the message is kept |
| First message, nothing installed | About 3+ decisions plus manual terminal work, with about 15 install commands listed and no engine suggested (reasoned from code) | 1 choice plus install and sign-in, all from Home |
| Pair a phone | 5 routes. The code route ends in a camera error, then a dead end. Request access fails with an address error. | 1 primary route: scan the QR, 0 decisions. Typing the code is the fallback. |
| Connect a device from Home (host) | 4 or more (account menu or Cmd-K, Connections, Computers, Add computer, then "Control this Station from another") | 2 (Station menu in the header, Connect a device) |
| Import Codex prompts | 4 or more (Settings › Advanced › System, then scroll) | 3 (Customize › Skills, New skill, Import from Codex…) |

## Screens

### `first-run-01` Home, an engine ready

On a phone: A single column. The composer gets a full-width project picker, engine picker and a 44px Start button. Status pills drop under the text and the footer separators go. The usage card is hidden, because on a paired device sharing is chosen on the host.

1. **The copy names the machine ("Studio Mac"), not "this Mac".** A phone sees this Home too, so mobile is a first-class viewer. _(copy; slice 1.7)_
2. **The composer picker shows the stored default.** Fixes the default drifting during setup. Station needs to save the default. _(server work; slice 1.1)_
3. **A "Default for new chats" tag marks the chosen engine.** Today nothing computes a default, so the tag marks it as new. _(server work; slice 1.1)_
4. **"Signed in" plus the percentage left, only for Claude Code and Codex.** Only engines with a sign-in check and a usage meter show them. _(layout; slice 1.7)_
5. **Three plain links replace the 4-step wizard and the Finish setup card.** Guided steps appear only where a real decision exists. _(layout; slice 1.7)_
6. **An inline, dismissible usage sharing card with the current setting selected and "See exactly what is sent".** Today's in-app step is skipped whenever a terminal-launched server has printed the notice to its log. This card shows once on the host, and a log line does not count as seen. The components exist. _(server work, new screen state; slice 1.8)_

### `first-run-02` Home, one engine needs sign-in

On a phone: The row actions wrap under the text, aligned to it.

1. **The default is the engine that is signed in (Codex), not the first one detected.** Today the default is the first runnable agent, so it changes as engines become ready. _(server work; slice 1.1)_
2. **A "Sign in" button on the Claude Code row.** The fix is one step on the row, with no trip to Customize › Engines. It is the same sign-in sheet that Customize › Engines uses. _(layout; slice 1.7)_
3. **OpenCode shows "Sign-in not checked", with a reason.** READY never means signed in where Station has no way to check. _(copy; slice 1.7)_

### `first-run-03` Home, no engine signed in

On a phone: Same order. The hint sits under the 44px Start button.

1. **The Start button becomes "Sign in and start".** One action instead of a detour. The draft is held across the sign-in. _(new screen state; slice 1.9)_
2. **The hint says the message is kept and the default will be set.** No silent decision goes unsaid. This needs a held draft and a saved default. _(new screen state, server work; slice 1.9)_
3. **"Use OpenCode" for an engine Station cannot verify, with an honest line about failures.** Station can check sign-in only for Claude Code and Codex. For any other engine it says so instead of showing READY. _(copy; slice 1.9)_

### `first-run-04` Signing in to Claude Code

On a phone: A bottom sheet with a grab handle, a 44px close and a 44px Cancel.

1. **The waiting state names what happens and closes by itself.** Delegated CLI login with status verification exists, but it is written for added profiles. Backend check: the same path signs in the default account. _(new screen state, backend check first; slice 1.9)_
2. **A terminal fallback, `claude auth login`, then an automatic re-check.** There is no dead end if the browser hand-off fails. _(layout; slice 1.9)_
3. **The footer says "Your message is kept".** It ties back to the Sign in and start button. _(copy; slice 1.9)_

### `first-run-05` Nothing installed

On a phone: The cards stack and each button is 44px and full width. The composer moves below the cards.

1. **Three choice cards, nothing pre-picked. Claude Code is the primary button.** This is the one real decision in the whole flow. _(layout; slice 1.10)_
2. **"Station's own engine" needs nothing installed. It uses Station-managed providers: API key, OpenRouter, Ollama and others.** Ownership is stated, and the key goes in a secure field. _(copy; slice 1.10)_
3. **The composer is disabled, with the reason inline ("Choose an engine above to start").** Every disabled control says why. _(copy; slice 1.10)_

### `first-run-06` Install failed

On a phone: A bottom sheet. The action row wraps and the terminal block is full width.

1. **A plain reason and remedy ("Studio Mac doesn't have npm…") replace "could not be set up. Try again in a moment."** No dead ends. The install terminal exists, but today it only says "Installation ended. Review the terminal". Turning its output into a reason needs exit codes and known patterns, falling back to "Installer stopped (exit N)". _(server work, backend check first; slice 1.10)_
2. **Three next steps: Get Node.js, Try again, switch engine.** _(layout; slice 1.10)_
3. **The raw output stays visible under the reason.** Technical detail is available on demand. _(layout; slice 1.10)_

### `first-run-07` First run driven from chat

On a phone: Avatars are hidden and the approval buttons are 44px and full width.

1. **The agent reads setup state with the existing engine-setup tool.** The tool exists but sits behind the "Guided engine setup" preview and a personal host. _(layout; not in the first release)_
2. **A "Your step" card: the person completes the sign-in. The agent never handles it and only navigates to the right screen.** This is the backed pattern of proposing and navigating. _(layout; not in the first release)_
3. **A "Change the default for new chats" proposal, with Before and After.** Needs a new tool that sets the default, plus the saved default itself. _(chat tool, server work; not in the first release)_
4. **The limit is shown honestly. Chat only works once some engine runs Station's agent. The header shows "Station · running on Codex".** With nothing installed there is no agent to talk to, so the screens carry that state. _(copy; not in the first release)_

### `first-run-08` Import Codex prompts as skills

On a phone: A bottom sheet. Row status wraps under the row.

1. **Titled "Import your Codex prompts as skills".** That is all the importer does. There is no Claude Code import, and drawing one would be invented. _(copy; slice 1.11)_
2. **Nothing is pre-selected (two are shown picked), and a name conflict is solved inline.** _(new screen state; slice 1.11)_
3. **The copy promises "undo the whole import".** The rollback exists in the product. _(copy; slice 1.11)_
4. **The entry point is Customize › Skills › New skill › Import from Codex…, and it is offered once on a fresh Home.** It is a menu item on the Skills page's single button, not a second button. We need to check the cost of looking for sources when Home first paints. _(layout, backend check first; slice 1.11)_

### `first-run-09` Unpaired device, connect screen

On a phone: A sticky 48px Connect button, a 10-box code field (one text input), and the steps above the fold.

1. **One primary route: scan the QR with the phone's own camera. The link carries the pairing offer and the existing deep-link exchange does the rest.** Today Pair with a code opens on a camera error. The in-app camera is never the first thing shown. _(layout; slice 2.6)_
2. **A typed code plus address is the fallback.** A code alone cannot locate a Station, and today the address is hidden under "Enter manually". _(layout; slice 2.6)_
3. **"Ask for access" moves to a secondary row.** On a fresh install, Request access failed with "This Station does not allow access requests from this app address." _(layout; slice 2.6)_
4. **The sample workspace is a single text link, in the native phone app only, and without its tour.** It exists for App Store review. It is useless in a desktop browser. _(layout; slice 2.6)_

### `first-run-10` Checking the address

On a phone: The "Found Studio Mac…" sentence wraps as one sentence.

1. **The address is checked as soon as it is typed ("Found Studio Mac, and it accepts this device's address"), before the code is spent.** Needs an address-status check that a browser can read from another origin. Today a forbidden address is a 403 that browser rules may hide. _(server work, backend check first; slice 2.6)_
2. **The device name is editable, with a neutral default.** _(new screen state; slice 2.6)_

### `first-run-11` Address blocked

1. **The headline says what is wrong and that the code is unused.** Today the only message is "This Station does not allow access requests from this app address.", and its only remedy is a command-line flag. _(copy; slice 2.6)_
2. **Two fixes: scan the QR, or allow this address on the host under Station › Devices with access › Allowed addresses.** Scanning opens Station from its own address. The allowed-address list is set only through environment variables or the command line today. A host screen for it is new, and needs a backend check. _(new screen state, server work, backend check first; slice 2.6)_
3. **A copy-this-address row, so the person can complete the second fix.** _(new screen state; slice 2.6)_

### `first-run-12` Device connected

1. **An explicit success screen says what the device can and cannot do.** Today the device shows nothing after pairing. The can and cannot lists need the real permission names, and "Standard" is unexplained today. _(new screen state, backend check first; slice 2.6)_

### `first-run-13` Request access, waiting

1. **A matching number on both screens.** It guards against spoofing when the host approves in one tap. This is new server data plus UI. _(server work, new screen state; slice 2.7)_
2. **The screen says where the host will see the request: notifications, and the top of Station › Devices with access.** The Devices list already shows pending requests. Notifications need a backend check. _(copy, backend check first; slice 2.7)_

## Feature calls

| Feature | Call | Reason |
| --- | --- | --- |
| Setup launcher card | Remove | Home rows replace it. It hides on machines with any ready engine. |
| Finish setup dialog | Remove | Its four steps are redistributed below. |
| Usage sharing step | Simplify | Becomes a one-time inline card on the host's fresh Home, then Settings › Privacy. |
| "Which engines do you use?" | Remove | Ready engines are simply available. The Agent is created on first use. |
| "Choose what powers Station" | Remove | Removed from first run and kept in Settings. By default it is the default engine, and most homes have one valid answer. |
| "About you" | Simplify | Moves to Settings › Profile as optional. It only affects Station's own engine. |
| Coachmark tour | Remove | It points at Notifications, Schedule and Customize before there is any work, and its step ids and titles disagree. |
| Home "Set up Station" re-entry card | Remove | Customize › Overview "needs you" notice and the Customize attention dot are the way back in. |
| Engine setup inside New Chat | Simplify | The picker lists ready engines. "Connect something else" goes to Customize › Engines. |
| Import existing setup | Simplify | Moves to Skills and is renamed to what it does: Codex prompts only. |
| Unpaired sample workspace | Hide for the first release | Only in the native phone app, without its tour. The App Store reason is real, but it is useless in a desktop browser. |
| Pair with a code | Simplify | Code plus address with a pre-check. Camera only where supported. |
| Request access | Keep | Secondary. It works once the address is allowed, and now explains itself. |
| "Open in the Station app", "Other ways to connect" and broker invitation | Hide for the first release | Behind the Station page on the host. SSH and broker routes are hidden for v1. They are not first-run decisions. |
| Pair a Device dialog | Simplify | Same capability, relaid out so it is readable. |

## New work

| Work | Kind | Note |
| --- | --- | --- |
| Stored default for new chats | server work | New saved config field plus UI. Needs a backend check. |
| Picker lists ready engines; Agent created on first use | new screen state | The endpoint exists and is safe to repeat. |
| Rows with per-row Sign in and Install on Home | layout | Sign-in and the install terminal exist. |
| "Sign in and start" holding the draft | new screen state |  |
| Default-account sign-in through CLI delegation | backend check first | The existing code targets added profiles. |
| Install failure reason | server work | Classify the installer output. Fallback copy only. |
| Usage sharing inline card | layout | Layout and copy. The components exist. |
| Chat: set the default | chat tool | A new tool that sets the default engine. The two existing setup tools must leave the feature preview. |
| Codex import entry in Skills | layout |  |
| Device address pre-check | backend check first | Needs an address-status endpoint readable from another origin. |
| Allowed addresses screen on the host | server work | Persist the allowed addresses, plus UI. |
| Matching number for access requests | server work | New server data plus UI. |
| Success screen after pairing | new screen state | Also needs a fix for the device not proceeding (the address). |
| Host dialog relayout and routes list | layout | The routes list needs a backend check. |
| Access level wording | backend check first | Confirm what "Standard" grants. |

## Decisions taken during design

- Considered: importing an existing Claude Code or Codex setup. Chosen: importing Codex prompts as skills, under Skills, because only those can be imported today.
- Setup from chat cannot help when no engine is installed, because there is no agent to talk to. No chat screen is specified for that state.
- A usage sharing disclosure step exists today, but it is skipped when the server was started from a terminal, which records the notice as shown. The design shows the choice once in the app.
- The usage-sharing card shows the real current setting selected instead of nothing selected. Showing no selection while sharing is on would be dishonest.
- Home shows one card under the composer at a time: the usage-sharing choice first, then a tip about apps.
- The host's connect-a-device dialog is specified once, on the Station page.
