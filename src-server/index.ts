import './runtime/bootstrap/server-compile-cache.js';

/**
 * Station — local-first AI agent system
 * Main entry point.
 *
 * Two things must happen before any other server module evaluates: `.env`
 * is loaded, and the OTel providers are registered (metric instruments made
 * before that stay no-ops for the life of the process). A static import
 * cannot promise either once the bundle is code-split: esbuild evaluates the
 * shared chunks an entry imports before the entry's own modules, and Node
 * evaluates an import's siblings while it awaits. So this entry orders them
 * with awaited dynamic imports instead.
 */

await import('./telemetry.js');
await import('./server-main.js');
