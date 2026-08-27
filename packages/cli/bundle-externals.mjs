/**
 * Packages the CLI bundle leaves unresolved (esbuild `external`), shared
 * between the bundler config and the publish-surface test.
 *
 * A separate module rather than a constant inline in `esbuild.config.mjs`:
 * that file runs `esbuild.build(...)` as a side effect of being imported (it
 * is a script, not a library), so a test importing it to read the externals
 * list would trigger a real bundle build on every test run. This module has
 * no side effects and is safe to import from anywhere.
 */
export const CLI_EXTERNALS = ['esbuild', '@napi-rs/keyring'];
