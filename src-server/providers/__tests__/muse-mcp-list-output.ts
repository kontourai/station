/**
 * `muse mcp list --json`, Muse Code 1.4.18 (1.4.18-R8587.1), captured live on
 * 2026-11-13 against a throwaway `XDG_CONFIG_HOME` holding two user servers
 * added with `muse mcp add` (one then disabled in `settings.json`). Byte-exact
 * apart from the stdio entry's second argument, replaced with a secret-shaped
 * one; the names, command path and URL were invented for the capture. Muse
 * masked the env and header values itself (`"[REDACTED]"`), but `args` and
 * `url` come back verbatim, so a secret in an argument must never leave the
 * adapter.
 */
export const MUSE_MCP_LIST_JSON =
  '{"servers":[{"name":"http-one","status":"enabled","enabled":true,"required":false,"type":"streamable-http","command":null,"args":[],"env":{},"framing":null,"cwd":null,"url":"https://mcp.example.test/mcp","headers":{"authorization":"[REDACTED]"},"startup_timeout_sec":30.0,"tool_timeout_sec":300.0,"enabled_tools":null,"disabled_tools":null,"source":"user","token":[],"auth":"none"},{"name":"stdio-one","status":"disabled","enabled":false,"required":false,"type":"stdio","command":"node","args":["/tmp/fake-server.js","--token=canary-arg-secret"],"env":{"API_TOKEN":"[REDACTED]"},"framing":"auto","cwd":null,"url":null,"headers":{},"startup_timeout_sec":30.0,"tool_timeout_sec":300.0,"enabled_tools":null,"disabled_tools":null,"source":"user","token":[],"auth":"none"}]}\n';

/** The same command with nothing configured (a fresh config home). */
export const MUSE_MCP_LIST_EMPTY_JSON = '{"servers":[]}\n';
