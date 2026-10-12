import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, type Config } from '../config.ts';
import { isAuthorized, isLoopback, isSameOrigin, presentedToken } from './auth.ts';
import { log } from './log.ts';
import { decodeFrame, FrameError, parseControl } from './protocol.ts';
import { Session } from './session.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const LEVEL_PUSH_MS = 200;

export interface App {
  server: http.Server;
  url: string;
  close(): Promise<void>;
  activeSession(): Session | null;
}

export async function startServer(config: Config = loadConfig()): Promise<App> {
  fs.mkdirSync(config.sessionsDir, { recursive: true });

  let session: Session | null = null;
  let captureSocket: WebSocket | null = null;
  const uiSockets = new Set<WebSocket>();

  const broadcast = (msg: unknown) => {
    const text = JSON.stringify(msg);
    for (const ws of uiSockets) if (ws.readyState === ws.OPEN) ws.send(text);
  };

  const status = () => ({ type: 'status', capturing: session !== null, session: session?.snapshot() ?? null });

  const endSession = (reason: string) => {
    if (!session) return;
    const snap = session.close();
    log('session.end', { id: snap.id, reason, channels: snap.channels });
    broadcast({ type: 'session-ended', session: snap, reason });
    session = null;
  };

  const levelTimer = setInterval(() => {
    if (session) broadcast({ type: 'levels', session: session.snapshot() });
  }, LEVEL_PUSH_MS);

  const server = http.createServer((req, res) => {
    if (!isAuthorized(req, config.accessToken)) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('Access token required. Open the URL the server printed.');
      return;
    }
    const headers: Record<string, string> = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    const token = presentedToken(req);
    if (!isLoopback(req) && token) headers['set-cookie'] = `lmi_token=${token}; HttpOnly; SameSite=Strict; Path=/`;

    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/') {
      // The phone lands on the panel, this machine on the capture page.
      res.writeHead(302, { ...headers, location: isLoopback(req) ? '/capture/' : '/insights/' }).end();
      return;
    }
    if (url.pathname === '/healthz') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
      return;
    }
    serveStatic(config.webDir, url.pathname, res, headers);
  });

  const audioWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const uiWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://x');
    const wss = pathname === '/ws/audio' ? audioWss : pathname === '/ws/ui' ? uiWss : null;
    if (!wss || !isAuthorized(req, config.accessToken) || !isSameOrigin(req)) {
      log('ws.reject', { pathname, remote: req.socket.remoteAddress, origin: req.headers.origin });
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  audioWss.on('connection', (ws, req) => {
    if (captureSocket && captureSocket.readyState === captureSocket.OPEN) {
      ws.close(4409, 'Another capture client is already connected');
      return;
    }
    captureSocket = ws;
    log('capture.connect', { remote: req.socket.remoteAddress });
    broadcast({ type: 'capture-connected' });

    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          if (!session) return; // Frames in flight after a stop.
          session.ingest(decodeFrame(data as Buffer));
          return;
        }
        const msg = parseControl(data.toString());
        if (msg.type === 'start') {
          endSession('restarted');
          session = new Session(config.sessionsDir, msg.source, { saveTestAudio: config.saveTestAudio });
          log('session.start', { id: session.id, source: msg.source, dir: session.dir, rawAudioSaved: config.saveTestAudio });
          ws.send(JSON.stringify({ type: 'started', id: session.id, rawAudioSaved: config.saveTestAudio }));
          broadcast(status());
        } else {
          endSession('stopped');
          ws.send(JSON.stringify({ type: 'stopped' }));
        }
      } catch (err) {
        const message = err instanceof FrameError ? err.message : 'internal error';
        if (!(err instanceof FrameError)) log('capture.error', { error: String(err) });
        ws.send(JSON.stringify({ type: 'error', message }));
      }
    });

    ws.on('close', () => {
      if (captureSocket === ws) captureSocket = null;
      log('capture.disconnect');
      broadcast({ type: 'capture-disconnected' });
      endSession('capture disconnected');
    });
  });

  uiWss.on('connection', (ws, req) => {
    uiSockets.add(ws);
    log('ui.connect', { remote: req.socket.remoteAddress });
    ws.send(JSON.stringify({ ...status(), captureConnected: captureSocket !== null }));
    ws.on('close', () => uiSockets.delete(ws));
  });

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${port}`;

  return {
    server,
    url,
    activeSession: () => session,
    close: async () => {
      clearInterval(levelTimer);
      endSession('server shutdown');
      for (const ws of [...uiSockets, ...(captureSocket ? [captureSocket] : [])]) ws.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function serveStatic(webDir: string, pathname: string, res: http.ServerResponse, headers: Record<string, string>) {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(webDir, '.' + rel);
  if (!file.startsWith(webDir + path.sep)) {
    res.writeHead(404).end();
    return;
  }
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { ...headers, 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' }).end(body);
  });
}

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = loadConfig();
  const app = await startServer(config);
  log('server.listening', { url: app.url, sessionsDir: config.sessionsDir, rawAudioSaved: config.saveTestAudio });
  console.log(`\n  Capture (this Mac):   ${app.url}/capture/`);
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    if (config.accessToken) {
      for (const ip of lanAddresses()) console.log(`  Insights (iPhone):    http://${ip}:${config.port}/insights/?token=${config.accessToken}`);
    } else {
      console.log('  Insights on the phone are blocked: set ACCESS_TOKEN in .env to allow non-loopback access.');
    }
  } else {
    console.log(`  Insights (this Mac):  ${app.url}/insights/`);
    console.log('  For the iPhone, set HOST=0.0.0.0 and ACCESS_TOKEN in .env.');
  }
  console.log('');
  const shutdown = () => void app.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
