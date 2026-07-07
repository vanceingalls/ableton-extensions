/**
 * studioServer tests — the loopback SSE/POST bridge that carries all live
 * Node↔WebView traffic (the SDK modal dialog only returns a close payload).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { startStudioServer, type StudioServer } from '../src/studioServer';
import type { WebViewToNode } from '../src/studioProtocol';

let dir: string;
let server: StudioServer;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c2v-studio-'));
  await fs.writeFile(path.join(dir, 'index.html'), '<h1>studio</h1>');
  await fs.writeFile(path.join(dir, 'app.js'), 'console.log(1)');
  const audioPath = path.join(dir, 'elsewhere.wav');
  await fs.writeFile(audioPath, Buffer.from('RIFFfake'));
  server = await startStudioServer({
    studioDir: dir,
    extraFiles: { 'audio.wav': audioPath },
  });
});

afterAll(async () => {
  await server.close();
});

describe('static serving', () => {
  it('serves index.html at the tokenized root', async () => {
    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('<h1>studio</h1>');
  });

  it('serves sibling assets with correct mime', async () => {
    const res = await fetch(server.url + 'app.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  it('maps extraFiles to url paths', async () => {
    const res = await fetch(server.url + 'audio.wav');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(await res.text()).toBe('RIFFfake');
  });

  it('rejects requests without the session token', async () => {
    const origin = new URL(server.url).origin;
    expect((await fetch(origin + '/index.html')).status).toBe(404);
    expect((await fetch(origin + '/wrongtoken/index.html')).status).toBe(404);
  });

  it('blocks path traversal out of the studio dir', async () => {
    const res = await fetch(server.url + '..%2F..%2Fetc%2Fpasswd');
    expect([403, 404]).toContain(res.status);
  });

  it('404s unknown files', async () => {
    expect((await fetch(server.url + 'nope.js')).status).toBe(404);
  });
});

describe('message bridge', () => {
  it('delivers POSTed WebView→Node messages to handlers', async () => {
    const received: WebViewToNode[] = [];
    server.onMessage((m) => received.push(m));
    const res = await fetch(server.url + '__message', {
      method: 'POST',
      body: JSON.stringify({ type: 'refreshFromSet' }),
    });
    expect(res.status).toBe(204);
    expect(received).toEqual([{ type: 'refreshFromSet' }]);
  });

  it('pushes Node→WebView messages over SSE', async () => {
    const res = await fetch(server.url + '__events');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // First frame is the connect comment; then push a message and read it.
    let buffer = '';
    const readUntil = async (marker: string) => {
      const deadline = Date.now() + 3000;
      while (!buffer.includes(marker)) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${marker}`);
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    };

    await readUntil(': connected');
    server.send({ type: 'renderProgress', phase: 'rendering', pct: 42 });
    await readUntil('}\n\n'); // complete data frame, not the connect comment
    const dataLine = buffer.split('\n').find((l) => l.startsWith('data: '));
    expect(dataLine).toBeDefined();
    expect(JSON.parse(dataLine!.slice(6))).toEqual({
      type: 'renderProgress',
      phase: 'rendering',
      pct: 42,
    });
    await reader.cancel();
  });
});
