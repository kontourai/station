#!/usr/bin/env node
import {
  registerAppResource,
  registerAppTool,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { renderSessionsPanel } from './panel.mjs';

const RESOURCE_URI = 'ui://station-sessions/panel';
const SESSION_LIMIT = 200;
const READ_TIMEOUT_MS = 2_500;
const MAX_REPLY_BYTES = 1024 * 1024;

function target() {
  const credential = process.env.STATION_API_CREDENTIAL;
  if (!credential?.trim() || !process.env.STATION_API_BASE) return;
  try {
    const base = new URL(process.env.STATION_API_BASE);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(
      base.hostname,
    );
    if (
      (base.protocol !== 'https:' &&
        !(base.protocol === 'http:' && loopback)) ||
      base.username ||
      base.password ||
      base.pathname !== '/' ||
      base.search ||
      base.hash
    )
      return;
    return {
      endpoint: new URL(
        `/api/orchestration/sessions/read-model?limit=${SESSION_LIMIT}`,
        base,
      ),
      credential,
    };
  } catch {
    return;
  }
}

function validSession(row) {
  return (
    row &&
    typeof row === 'object' &&
    ['threadId', 'provider', 'status'].every(
      (key) => typeof row[key] === 'string' && row[key].trim(),
    ) &&
    [
      'lifecycleState',
      'projectSlug',
      'assignedAgentSlug',
      'lastEventAt',
      'updatedAt',
    ].every((key) => row[key] == null || typeof row[key] === 'string')
  );
}

async function fetchSessions() {
  const station = target();
  if (!station)
    return { error: 'Configure the Station origin and a read credential.' };
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
  try {
    const response = await fetch(station.endpoint, {
      headers: { authorization: `Bearer ${station.credential}` },
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403)
        return { error: 'The Station refused this session read.' };
      return { error: 'The Station session list is unavailable.' };
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    let json = '';
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > MAX_REPLY_BYTES)
        return { error: 'The Station session reply exceeded its size limit.' };
      json += decoder.decode(chunk, { stream: true });
    }
    const body = JSON.parse(json + decoder.decode());
    if (
      body?.success !== true ||
      body.partial === true ||
      body.hasMore === true ||
      !Array.isArray(body.data) ||
      !body.data.every(validSession)
    )
      return {
        error: 'The Station returned an incomplete or invalid session list.',
      };
    return { sessions: body.data.slice(-SESSION_LIMIT) };
  } catch {
    return {
      error: signal.aborted
        ? 'The Station session read timed out.'
        : 'The Station session list is unavailable.',
    };
  }
}

const server = new McpServer({ name: 'station-sessions', version: '1.0.0' });

registerAppTool(
  server,
  'sessions_panel',
  {
    description:
      'Render a live panel of Station orchestration sessions (state, provider, project, last activity).',
    _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ['model', 'app'] } },
    inputSchema: z.object({}),
  },
  async () => {
    const { sessions, error } = await fetchSessions();
    if (!sessions)
      return { isError: true, content: [{ type: 'text', text: error }] };
    return {
      content: [{ type: 'text', text: `${sessions.length} session(s)` }],
      structuredContent: { count: sessions.length },
    };
  },
);

registerAppResource(server, 'Sessions Panel', RESOURCE_URI, {}, async () => {
  const { sessions, error } = await fetchSessions();
  return {
    contents: [
      {
        uri: RESOURCE_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: renderSessionsPanel(sessions, error),
      },
    ],
  };
});

await server.connect(new StdioServerTransport());
