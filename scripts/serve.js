#!/usr/bin/env node
/**
 * Static file server for the UI.
 *
 * Uses node:net (not node:http) on purpose: this project's Node runtime has
 * WebAssembly disabled, which makes undici — pulled in by node:http and by
 * fetch — crash on lazy load. node:net has no such dependency, so the server
 * works everywhere while the browser still loads the ES modules normally.
 *
 * Usage: node scripts/serve.js [port]
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.argv[2] ?? 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const ALIASES = new Map([
  ['/', '/index.html'],
  ['/ui/index.html', '/index.html'],
  ['/ui/app.js', '/app.js'],
  ['/ui/styles.css', '/styles.css'],
]);

function resolvePath(pathname) {
  const clean = decodeURIComponent(pathname.split('?')[0]);
  const mapped = ALIASES.get(clean) ?? clean;
  const target = path.join(root, path.normalize(mapped).replace(/^(\.\.[/\\])+/, ''));
  if (!target.startsWith(root)) return null;
  return target;
}

function send(socket, status, body, type) {
  const statusLine = status === 200 ? 'HTTP/1.1 200 OK' : `HTTP/1.1 ${status}`;
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const headers = [
    statusLine,
    `Content-Type: ${type}`,
    `Content-Length: ${payload.length}`,
    'Connection: close',
    'Cache-Control: no-cache',
    '',
    '',
  ].join('\r\n');
  socket.write(headers);
  socket.write(payload);
  socket.end();
}

const server = net.createServer((socket) => {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    if (!buffer.includes('\r\n\r\n')) return;

    const firstLine = buffer.split('\r\n')[0];
    const pathname = firstLine.split(' ')[1] ?? '/';
    const target = resolvePath(pathname);

    if (!target) {
      send(socket, '403 Forbidden', 'forbidden', 'text/plain');
      return;
    }

    fs.readFile(target, (error, data) => {
      if (error) {
        send(socket, '404 Not Found', 'not found: ' + pathname, 'text/plain');
        return;
      }
      send(socket, 200, data, MIME[path.extname(target)] ?? 'application/octet-stream');
    });
  });

  socket.on('error', () => {});
});

server.listen(port, '0.0.0.0', () => {
  const addresses = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  console.log('AI API Manager running:');
  console.log(`  local:   http://localhost:${port}`);
  for (const address of [...new Set(addresses)]) {
    console.log(`  network: http://${address}:${port}`);
  }
});
