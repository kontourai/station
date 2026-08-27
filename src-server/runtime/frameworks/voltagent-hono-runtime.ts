/**
 * VoltAgent's Hono surface mutates Zod's object helpers while loading its
 * vendored OpenAPI adapter. MCP builds its auth schemas with those helpers, so
 * MCP must initialize first. Keep that compatibility ordering at this one
 * production seam; runtime callers only need VoltAgent's narrow Hono interface.
 */
import '@modelcontextprotocol/server';

export type { HonoServerConfig } from '@voltagent/server-hono';
export { honoServer } from '@voltagent/server-hono';
