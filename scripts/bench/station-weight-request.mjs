/**
 * Decomposes Messages API requests recorded by the station-weight stub.
 *
 * Sizes are UTF-8 bytes and Unicode code points ("chars"). No tokenizer is
 * applied, so nothing here is a token count or a token estimate.
 *
 * Station's own contribution is isolated by comparing its first turn request
 * with a control request: the same Claude Code executable driven directly
 * through the Agent SDK in the same directory and environment. Text is
 * compared line by line as a multiset, so a line Station adds counts once
 * wherever it lands (system prompt, a system message, or the user turn).
 */

const MCP_TOOL_NAME = /mcp__[A-Za-z0-9_-]+?__[A-Za-z0-9_-]+/g;
const CLAUDE_CODE_VERSION = /cc_version=([0-9]+\.[0-9]+\.[0-9]+)/;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_HEX = /\b[0-9a-f]{24,}\b/gi;
const EXCERPT_CHARS = 160;

const bytes = (text) => Buffer.byteLength(text, 'utf8');
const chars = (text) => [...text].length;

/** POST /v1/messages requests with a parsed body, in arrival order. */
export function messagesRequests(requests) {
  return requests.filter(
    (request) =>
      request.method === 'POST' &&
      request.path === '/v1/messages' &&
      request.body &&
      typeof request.body === 'object',
  );
}

/** Every text block of a request body, labelled by where it sits. */
function textBlocks(body) {
  const blocks = [];
  const push = (where, content) => {
    if (typeof content === 'string') {
      blocks.push({ where, text: content });
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content)
      if (block?.type === 'text' && typeof block.text === 'string')
        blocks.push({ where, text: block.text });
  };
  push('system', body?.system);
  for (const message of Array.isArray(body?.messages) ? body.messages : [])
    push(`message:${message?.role ?? 'unknown'}`, message?.content);
  return blocks;
}

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const user = messages.findLast((message) => message?.role === 'user');
  return user ? textBlocks({ messages: [user] }).map((b) => b.text) : [];
}

/**
 * The agent turn that carries the prompt: the first request with tools whose
 * last user message has a text block ending in the prompt. Side calls (title,
 * branch name, quota probes) do not qualify. `undefined` when none does; the
 * caller reports that as not measured rather than guessing.
 */
export function findTurnRequest(requests, prompt) {
  return messagesRequests(requests).find(
    (request) =>
      Array.isArray(request.body.tools) &&
      request.body.tools.length > 0 &&
      lastUserText(request.body).some((text) =>
        text.trimEnd().endsWith(prompt),
      ),
  );
}

/** Sizes and inventory of one request body. */
export function summarizeRequest(body, requestBytes) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const blocks = textBlocks(body);
  const systemText = blocks
    .filter((block) => block.where === 'system')
    .map((block) => block.text)
    .join('\n');
  const messageText = blocks
    .filter((block) => block.where !== 'system')
    .map((block) => block.text)
    .join('\n');
  const toolBytes = tools.map((tool) => ({
    name: String(tool?.name ?? ''),
    bytes: bytes(JSON.stringify(tool)),
  }));
  const loadedMcp = toolBytes.filter((tool) => tool.name.startsWith('mcp__'));
  const namedMcp = new Set(
    blocks.flatMap((block) => block.text.match(MCP_TOOL_NAME) ?? []),
  );
  for (const tool of loadedMcp) namedMcp.delete(tool.name);
  const byServer = {};
  for (const name of [...loadedMcp.map((tool) => tool.name), ...namedMcp]) {
    const server = name.split('__')[1];
    byServer[server] = (byServer[server] ?? 0) + 1;
  }
  return {
    model: typeof body?.model === 'string' ? body.model : null,
    claudeCodeVersion: systemText.match(CLAUDE_CODE_VERSION)?.[1] ?? null,
    requestBytes,
    systemBytes: bytes(systemText),
    systemChars: chars(systemText),
    systemBlockCount: blocks.filter((block) => block.where === 'system').length,
    messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
    messageTextBytes: bytes(messageText),
    messageTextChars: chars(messageText),
    toolCount: tools.length,
    toolDefinitionBytes: toolBytes.reduce((sum, tool) => sum + tool.bytes, 0),
    tools: toolBytes,
    mcpTools: {
      loadedCount: loadedMcp.length,
      // Named in text (for example a deferred-tool listing) without a schema.
      namedOnlyCount: namedMcp.size,
      byServer,
    },
  };
}

/**
 * Session identifiers and the per-request suffix Claude Code appends to its
 * version stamp differ per request; they are not Station's contribution.
 */
function normalizeLine(line) {
  return line
    .replace(UUID, '<uuid>')
    .replace(LONG_HEX, '<hex>')
    .replace(/(cc_version=[0-9]+\.[0-9]+\.[0-9]+)[^;\s]*/g, '$1');
}

function lineCounts(body) {
  const counts = new Map();
  for (const block of textBlocks(body))
    for (const line of block.text.split('\n')) {
      const key = normalizeLine(line);
      if (!key.trim()) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  return counts;
}

function multisetDifference(left, right) {
  const lines = [];
  for (const [line, count] of left) {
    const extra = count - (right.get(line) ?? 0);
    for (let index = 0; index < extra; index += 1) lines.push(line);
  }
  return lines;
}

function lineReport(lines) {
  return {
    lineCount: lines.length,
    // +1 per line for the newline that separated it.
    bytes: lines.reduce((sum, line) => sum + bytes(line) + 1, 0),
    chars: lines.reduce((sum, line) => sum + chars(line) + 1, 0),
    excerpts: lines
      .slice(0, 40)
      .map((line) =>
        line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS)}…` : line,
      ),
  };
}

/** What Station's turn request carries beyond (and without) the control's. */
export function diffAgainstControl(stationBody, controlBody) {
  const station = lineCounts(stationBody);
  const control = lineCounts(controlBody);
  const stationTools = new Map(
    (stationBody?.tools ?? []).map((tool) => [tool?.name, tool]),
  );
  const controlTools = new Map(
    (controlBody?.tools ?? []).map((tool) => [tool?.name, tool]),
  );
  const addedTools = [...stationTools.keys()].filter(
    (name) => !controlTools.has(name),
  );
  const removedTools = [...controlTools.keys()].filter(
    (name) => !stationTools.has(name),
  );
  const named = (body) =>
    new Set(
      textBlocks(body).flatMap(
        (block) => block.text.match(MCP_TOOL_NAME) ?? [],
      ),
    );
  const controlNamed = named(controlBody);
  const addedNamedTools = [...named(stationBody)].filter(
    (name) => !controlNamed.has(name) && !stationTools.has(name),
  );
  return {
    addedText: lineReport(multisetDifference(station, control)),
    removedText: lineReport(multisetDifference(control, station)),
    addedTools,
    removedTools,
    addedToolDefinitionBytes: addedTools.reduce(
      (sum, name) => sum + bytes(JSON.stringify(stationTools.get(name))),
      0,
    ),
    // Tools Station makes available by name only (deferred schemas).
    addedNamedTools,
  };
}

/** Whether each marker string appears anywhere in the request body. */
export function markersReached(body, markers) {
  const text = JSON.stringify(body ?? null);
  return Object.fromEntries(
    Object.entries(markers).map(([name, marker]) => [
      name,
      text.includes(marker),
    ]),
  );
}

/** A side call is any other Messages request seen during the turn window. */
export function summarizeSideCall(request) {
  const summary = summarizeRequest(request.body, request.bodyBytes);
  return {
    model: summary.model,
    requestBytes: summary.requestBytes,
    systemBytes: summary.systemBytes,
    messageTextBytes: summary.messageTextBytes,
    toolCount: summary.toolCount,
    maxTokens:
      typeof request.body?.max_tokens === 'number'
        ? request.body.max_tokens
        : null,
  };
}
