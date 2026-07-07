/**
 * studioServer.ts — the studio's message bridge, without SDK help.
 *
 * Evidence from 12.4.5b6 (research/sdk-api-notes.md): showModalDialog(url,
 * w, h, onResult) loads a URL into a WKWebView and calls back ONCE with a
 * payload when the dialog closes — there is no push-messaging API. But the
 * extension runs on full Node with network access, so the bridge is ours:
 * serve the studio over loopback HTTP and pass http://127.0.0.1:<port>/<token>/
 * to showModalDialog. Node→WebView pushes ride Server-Sent Events; WebView→
 * Node messages are POSTs. studioProtocol.ts types ride both unchanged.
 *
 * SSE + POST (not WebSocket) keeps this dependency-free and WKWebView-safe.
 * The random URL token keeps other local processes from wandering in; the
 * server binds to 127.0.0.1 only and lives exactly as long as one studio
 * session (run-once model).
 */

import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { NodeToWebView, WebViewToNode } from './studioProtocol';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export interface StudioServerOptions {
  /** Directory whose index.html is the studio entry; served statically. */
  studioDir: string;
  /** Extra url-path → absolute-file mappings, e.g. { 'audio.wav': '/tmp/…/audio.wav' }. */
  extraFiles?: Record<string, string>;
}

export interface StudioServer {
  /** Tokenized loopback URL of the studio entry — hand this to showModalDialog. */
  url: string;
  /** Push a protocol message to every connected studio page. */
  send(msg: NodeToWebView): void;
  onMessage(handler: (msg: WebViewToNode) => void): void;
  close(): Promise<void>;
}

export async function startStudioServer(opts: StudioServerOptions): Promise<StudioServer> {
  const token = randomBytes(12).toString('hex');
  const root = path.resolve(opts.studioDir);
  const extra = opts.extraFiles ?? {};
  const handlers = new Set<(msg: WebViewToNode) => void>();
  const sseClients = new Set<http.ServerResponse>();

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const [, reqToken, ...rest] = url.pathname.split('/');
      if (reqToken !== token) {
        res.writeHead(404).end();
        return;
      }
      const rel = rest.join('/') || 'index.html';

      if (rel === '__events' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (rel === '__message' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WebViewToNode;
        res.writeHead(204).end();
        for (const h of handlers) h(msg);
        return;
      }

      // Static: extraFiles first, then studioDir (with traversal guard).
      let filePath = extra[rel];
      if (!filePath) {
        const candidate = path.resolve(root, rel);
        if (candidate !== root && !candidate.startsWith(root + path.sep)) {
          res.writeHead(403).end();
          return;
        }
        filePath = candidate;
      }
      const body = await fs.readFile(filePath);
      res.writeHead(200, {
        'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      });
      res.end(body);
    } catch (err: any) {
      res.writeHead(err?.code === 'ENOENT' ? 404 : 500).end();
    }
  };

  // Live's WebView allowlist admits "http://localhost" URLs (SDK docs), and
  // macOS resolves localhost to ::1 and/or 127.0.0.1 — so bind BOTH loopback
  // families on the same port and advertise the literal hostname localhost.
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) =>
    server.listen(0, '127.0.0.1').once('listening', resolve).once('error', reject),
  );
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('studio server failed to bind');

  const server6 = http.createServer(handler);
  await new Promise<void>((resolve) =>
    server6
      .listen(address.port, '::1')
      .once('listening', resolve)
      .once('error', () => resolve()), // IPv6 loopback is best-effort
  );

  return {
    url: `http://localhost:${address.port}/${token}/`,
    send(msg) {
      const frame = `data: ${JSON.stringify(msg)}\n\n`;
      for (const client of sseClients) client.write(frame);
    },
    onMessage(handler) {
      handlers.add(handler);
    },
    close() {
      for (const client of sseClients) client.end();
      sseClients.clear();
      return new Promise((resolve, reject) => {
        server6.close();
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
