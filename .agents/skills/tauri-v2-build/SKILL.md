---
name: tauri-v2-build
description: Build, debug, review, or verify Station's Tauri v2 desktop, Android, and iOS shells. Use for changes under src-desktop, native adapters, capabilities, platform configuration, generated Android or Apple projects, native packaging, mobile lifecycle behavior, or claims that require real Tauri shell evidence. Do not use for browser-only Station work with no native boundary.
---

# Tauri v2 build workflow

## Establish current truth

1. Read `AGENTS.md`, `src-desktop/AGENTS.md`, and the instructions for every other touched scope.
2. Work in a fresh sibling worktree based on current `origin/main`; preserve the primary checkout and active native lanes.
3. Run `npm run tauri:context -- --platform <platform>` before proposing a native change. Treat every `failed`, `skipped`, and finding as evidence to resolve or disclose.
   For machine-readable output, call `node scripts/tauri-context.mjs --platform <platform> --json` directly so npm's banner cannot contaminate JSON.
4. Read the pinned Cargo/npm versions and resolved platform configuration from that report before consulting upstream documentation.
5. For upstream behavior, run `npm run tauri:docs -- --topic <topic>`. Use `--list-topics` to discover supported topics. Load one narrow topic; never place Tauri's multi-megabyte full LLM corpus into context.

## Change the owning seam

- Keep React feature code behind `src-ui/src/platform/native/`; never add direct Tauri imports or platform-global inference outside the reviewed adapter files.
- Keep Rust domain logic independently testable. Let the Tauri shell own lifecycle, IPC registration, platform facilities, and thin Swift/Kotlin bridges.
- Preserve runtime validation for every IPC response even when compile-time bindings exist. Generate or mirror raw Rust command/event contracts instead of inventing stringly fixtures.
- Treat capabilities and CSP as authority changes. Use least privilege, platform scopes, and exact ratchets; never widen a grant merely to unblock a test.
- Treat `src-desktop/gen/android` and `src-desktop/gen/apple` as reproducible native projects. Put durable customization in the owning config/template/script and prove regeneration retains it.
- Make blocking command work asynchronous or move it through `tauri::async_runtime::spawn_blocking`; avoid panics across mobile IPC.

## Select proportionate evidence

Read [references/platform-proof.md](references/platform-proof.md) before claiming native behavior. Use the smallest lane that can observe the property, then escalate at completion:

1. Run `npm run gate:for -- <paths...>` before editing.
2. Run the selector and exact focused checks while iterating.
3. Exercise a real Tauri shell for IPC, capability, lifecycle, WebView, packaging, or native-window claims. A browser viewport is not shell evidence.
4. Exercise a simulator/emulator for platform integration and a physical device for backgrounding, secure storage, notification, pairing, and OS lifecycle claims.
5. Keep signed-artifact and store-provider receipts separate from compilation and runtime evidence.
6. Freeze the worktree and use Station's canonical completion command only after focused evidence passes.

## Debug live shells

- Android physical device: use the `tauri-mobile-debug` and `b10` skills. Prefer CDP evaluation inside the WebView and single-ABI builds; inspect logcat and process-freezer state before rebuilding.
- macOS/iOS: use Xcode, Safari Web Inspector, LLDB, unified logs, and a simulator or connected device as appropriate.
- Windows: use the `desktop-win` skill and verify the packaged WebView2 shell in the interactive desktop session.
- Use a native automation bridge only when it is debug-only, authenticated per run, Origin-safe, tunnel/loopback constrained, allowlisted, redacted, and proven absent from release artifacts.

## Report honestly

Name the exact revision, configuration, artifact, host, device, and interaction checked. Report absent hardware, skipped lanes, browser-only evidence, unsigned artifacts, and provider processing as `NOT_VERIFIED`; do not promote likely portability into platform proof.
