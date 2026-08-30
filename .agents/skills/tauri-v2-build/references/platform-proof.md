# Platform proof ladder

Use this table to select and describe evidence. A higher row does not imply the rows beneath it ran.

| Evidence | Proves | Does not prove |
| --- | --- | --- |
| Pure/unit tests | Contract logic and failure handling | WebView, OS lifecycle, packaging |
| Tauri mock runtime | Rust shell composition without native WebView libraries | Real IPC transport or platform integration |
| Browser/viewport E2E | Responsive UI and mocked adapter journeys | Tauri capability enforcement or native lifecycle |
| Desktop Tauri automation | Real desktop WebView, IPC, window, and capability behavior on that OS | Other desktop WebViews or mobile behavior |
| Simulator/emulator | Platform build, launch, WebView, and simulated OS integration | Physical background limits, signing, hardware, store delivery |
| Physical device | Observed lifecycle, secure storage, networking, hardware, and interaction on that device | Other OS versions/devices or store processing |
| Signed installed artifact | Signing, packaging, install, identity, and runtime on the checked host/device | Store availability or update/rollback |
| Play/TestFlight/provider receipt | Provider accepted and processed the exact build | Real user journey unless separately exercised |

## Required failure distinctions

- Separate compilation failure from artifact upload, quota, signing, installation, provider processing, and runtime failure.
- Treat missing toolchains or hardware as `skipped`/`NOT_VERIFIED`, never success.
- Treat an installed process, listening port, screenshot, or launch event as partial evidence until the claimed user journey and identity are observed.
- Record the source SHA and resolved Tauri configuration with every native artifact.

## Regeneration contract

Before relying on generated Android or Apple changes:

1. Identify the source config, XcodeGen template, Gradle/Kotlin injection, or repository script that owns the customization.
2. Regenerate from a clean copy or run the same init/build path used in CI.
3. Compare generated outputs and prove the customization remains.
4. Run the generated-project drift and permission gates.
5. Reject a fix that exists only in a file overwritten by `tauri android init` or `tauri ios init`.

## Live inspection safety

Never expose an unauthenticated control socket that can execute JavaScript or IPC. Loopback alone is insufficient when a browser can connect to a fixed WebSocket port. Require an ephemeral secret and reject browser Origin handshakes in addition to binding/tunneling controls.
