import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { isAbsolute, join } from 'node:path';
import type { ToolCallResponse } from '@kontourai/station-contracts/runtime';
import type { MCPManager } from '@kontourai/station-shared/mcp';
import {
  DEV_HEADERS_TIMEOUT_MS,
  DEV_REQUEST_TIMEOUT_MS,
  type DevFetchDependencies,
  DevHttpError,
  isCanonicalPathContained,
  MAX_RELOAD_CLIENTS,
  proxyPublicHttp,
  readJsonBody,
  validateRequestBoundary,
} from './security.js';

interface DevHttpContext {
  cwd: string;
  pluginsDir: string;
  bundleJs: string;
  bundleCss: string;
  bundleCssFallback: string;
  reactBundle: string;
  sdkBundle: string;
  getHtml: () => string;
  getMcpManager: () => MCPManager | null;
  fetchDependencies?: DevFetchDependencies;
}

export function getOpenFileMime(relPath: string) {
  const ext = relPath.split('.').pop() || '';
  const mime: Record<string, string> = {
    json: 'application/json',
    md: 'text/markdown',
    ts: 'text/plain',
    tsx: 'text/plain',
    js: 'text/plain',
  };
  return mime[ext] || 'text/plain';
}

export function isAllowedOpenFilePath(
  absPath: string,
  cwd: string,
  pluginsDir: string,
) {
  return [cwd, pluginsDir].some((root) =>
    isCanonicalPathContained(absPath, root),
  );
}

export function parseToolCallResponse(raw: any) {
  let response: unknown = raw;
  if (raw?.content?.[0]?.text) {
    try {
      const parsed = JSON.parse(raw.content[0].text);
      response = parsed?.content?.[0]?.text
        ? JSON.parse(parsed.content[0].text)
        : parsed;
    } catch {
      response = raw.content[0].text;
    }
  }
  return response;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function jsonError(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  error: DevHttpError,
  body: unknown,
) {
  if (error.code === 'body_too_large') {
    res.shouldKeepAlive = false;
    res.setHeader('Connection', 'close');
    res.once('finish', () => req.destroy());
  }
  json(res, error.status, body);
}

function routeMethod(
  path: string,
): { allow: string; privileged: boolean } | null {
  if (path === '/api/open-file' || path === '/api/reload')
    return { allow: 'GET', privileged: true };
  if (path === '/api/plugins/fetch') return { allow: 'POST', privileged: true };
  if (/^\/agents\/[^/]+\/tools$/.test(path))
    return { allow: 'GET', privileged: true };
  if (/^\/agents\/[^/]+\/tools\/[^/]+$/.test(path))
    return { allow: 'POST', privileged: true };
  return null;
}

export function createDevHttpServer(context: DevHttpContext): {
  close: () => Promise<void>;
  reloadClients: Set<ServerResponse>;
  server: Server;
} {
  const cwd = realpathSync(context.cwd);
  mkdirSync(context.pluginsDir, { recursive: true });
  const pluginsDir = realpathSync(context.pluginsDir);
  const reloadClients = new Set<ServerResponse>();

  const server = createServer(async (req, res) => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      res.writeHead(503);
      res.end('server_not_ready');
      return;
    }
    const requestUrl = new URL(
      req.url || '/',
      `http://127.0.0.1:${address.port}`,
    );
    const path = requestUrl.pathname;
    const route = routeMethod(path);
    const boundaryError = validateRequestBoundary(
      req,
      address.port,
      route?.privileged ?? false,
    );
    if (boundaryError) {
      res.writeHead(403);
      res.end(boundaryError);
      return;
    }

    if (req.method === 'OPTIONS') {
      if (!route) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const origin = `http://127.0.0.1:${address.port}`;
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': route.allow,
        'Access-Control-Allow-Headers': 'Content-Type',
        Vary: 'Origin',
      });
      res.end();
      return;
    }
    if (route && req.method !== route.allow) {
      res.writeHead(405, { Allow: route.allow });
      res.end('Method not allowed');
      return;
    }

    if (path === '/api/open-file') {
      const requested = requestUrl.searchParams.get('path');
      if (requested) {
        try {
          const candidate = realpathSync(
            isAbsolute(requested) ? requested : join(cwd, requested),
          );
          if (
            isAllowedOpenFilePath(candidate, cwd, pluginsDir) &&
            statSync(candidate).isFile()
          ) {
            res.writeHead(200, {
              'Content-Type': getOpenFileMime(requested),
              'Cache-Control': 'no-cache',
            });
            res.end(readFileSync(candidate, 'utf-8'));
            return;
          }
        } catch {
          /* Uniform 404 below avoids path disclosure. */
        }
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    if (path === '/api/reload') {
      if (reloadClients.size >= MAX_RELOAD_CLIENTS) {
        res.writeHead(503, { 'Retry-After': '1' });
        res.end('reload_limit');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('data: connected\n\n');
      reloadClients.add(res);
      const cleanup = () => reloadClients.delete(res);
      req.once('close', cleanup);
      req.once('aborted', cleanup);
      res.once('close', cleanup);
      res.once('error', cleanup);
      return;
    }

    if (/^\/agents\/[^/]+\/tools$/.test(path)) {
      const tools =
        context
          .getMcpManager()
          ?.listTools()
          .map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })) || [];
      json(res, 200, tools);
      return;
    }

    const toolMatch = path.match(/^\/agents\/[^/]+\/tools\/([^/]+)$/);
    if (toolMatch) {
      try {
        const manager = context.getMcpManager();
        const args = await readJsonBody(req);
        if (!manager) {
          json(res, 503, {
            success: false,
            error: 'MCP not connected',
          } satisfies ToolCallResponse);
          return;
        }
        const raw = await manager.callTool(
          decodeURIComponent(toolMatch[1]),
          args,
        );
        json(res, 200, {
          success: true,
          response: parseToolCallResponse(raw),
        } satisfies ToolCallResponse);
      } catch (error) {
        const httpError = error instanceof DevHttpError ? error : null;
        const resolvedError =
          httpError || new DevHttpError(400, 'tool_call_failed');
        jsonError(req, res, resolvedError, {
          success: false,
          error: resolvedError.code,
        });
      }
      return;
    }

    if (path === '/api/plugins/fetch') {
      try {
        const body = await readJsonBody(req, false);
        if (typeof body.url !== 'string')
          throw new DevHttpError(400, 'url_required');
        const result = await proxyPublicHttp(
          body as unknown as Parameters<typeof proxyPublicHttp>[0],
          context.fetchDependencies,
        );
        json(res, 200, result);
      } catch (error) {
        const httpError =
          error instanceof DevHttpError
            ? error
            : new DevHttpError(502, 'proxy_error');
        jsonError(req, res, httpError, {
          success: false,
          error: httpError.code,
        });
      }
      return;
    }

    if (path.startsWith('/api/') || path.startsWith('/agents/')) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end('Method not allowed');
      return;
    }

    const assets: Array<[string, string, string]> = [
      ['/react-dev.js', context.reactBundle, 'application/javascript'],
      ['/sdk-dev.js', context.sdkBundle, 'application/javascript'],
      ['/sdk-dev.css', join(cwd, 'dist/.sdk-dev.css'), 'text/css'],
      ['/bundle.js', context.bundleJs, 'application/javascript'],
    ];
    for (const [assetPath, file, contentType] of assets) {
      if (path === assetPath && existsSync(file)) {
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache',
        });
        if (req.method !== 'HEAD') res.end(readFileSync(file));
        else res.end();
        return;
      }
    }
    if (
      (path === '/bundle.css' || path === '/bundle-dev.css') &&
      (existsSync(context.bundleCss) || existsSync(context.bundleCssFallback))
    ) {
      res.writeHead(200, {
        'Content-Type': 'text/css',
        'Cache-Control': 'no-cache',
      });
      if (req.method !== 'HEAD')
        res.end(
          readFileSync(
            existsSync(context.bundleCss)
              ? context.bundleCss
              : context.bundleCssFallback,
          ),
        );
      else res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    if (req.method !== 'HEAD') res.end(context.getHtml());
    else res.end();
  });

  server.headersTimeout = DEV_HEADERS_TIMEOUT_MS;
  server.requestTimeout = DEV_REQUEST_TIMEOUT_MS;
  const close = async () => {
    for (const client of reloadClients) client.end();
    reloadClients.clear();
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  server.on('close', () => reloadClients.clear());
  return { close, reloadClients, server };
}
