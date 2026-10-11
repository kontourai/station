#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, join, resolve } from 'node:path';

const [portText, directory] = process.argv.slice(2);
const port = Number(portText);
if (!directory || !Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error('Usage: install-smoke-file-server.mjs <port> <directory>');
const root = resolve(directory);
if (!(await stat(root)).isDirectory())
  throw new Error('Fixture directory required');

const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let name;
  try {
    name = decodeURIComponent(
      new URL(request.url, 'http://127.0.0.1').pathname,
    ).slice(1);
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (!name || basename(name) !== name || name.includes('\\')) {
    response.writeHead(404).end();
    return;
  }
  const file = join(root, name);
  let info;
  try {
    info = await stat(file);
  } catch {
    response.writeHead(404).end();
    return;
  }
  if (!info.isFile()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    'Content-Length': info.size,
    'Content-Type': 'application/octet-stream',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
});
server.listen(port, '127.0.0.1', () => {
  console.log(
    `Fixture files ready at http://127.0.0.1:${server.address().port}`,
  );
});
