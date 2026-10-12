import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.ts';
import { isAuthorized, isSameOrigin } from '../src/server/auth.ts';
import { startServer, type App } from '../src/server/index.ts';
import { encodeFrame } from '../src/server/protocol.ts';
import { deleteSessions, listSessions } from '../src/scripts/sessions.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lmi-test-'));

async function boot(overrides: Record<string, string> = {}) {
  const dir = tmp();
  const app = await startServer({ ...loadConfig({ PORT: '0', SESSIONS_DIR: dir, ...overrides }), sessionsDir: dir });
  return { app, dir, ws: app.url.replace('http', 'ws') };
}

function open(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Resolves with the first JSON message matching the predicate. */
function next(ws: WebSocket, pred: (m: any) => boolean): Promise<any> {
  return new Promise((resolve) => {
    const on = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      const m = JSON.parse(data.toString());
      if (pred(m)) {
        ws.off('message', on);
        resolve(m);
      }
    };
    ws.on('message', on);
  });
}

const tone = (n: number) => Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin(i / 5) * 8000));

let ctx: Awaited<ReturnType<typeof boot>>;
before(async () => {
  ctx = await boot();
});
after(async () => {
  await ctx.app.close();
});

test('two channels stream into a session; the panel sees levels; stop writes meta', async () => {
  const ui = await open(`${ctx.ws}/ws/ui`);
  const audio = await open(`${ctx.ws}/ws/audio`);
  const started = next(audio, (m) => m.type === 'started');
  audio.send(JSON.stringify({ type: 'start', source: 'device', consent: true }));
  const { id, rawAudioSaved } = await started;
  assert.equal(rawAudioSaved, false);

  const levels = next(ui, (m) => m.type === 'levels' && m.session.channels.me.frames >= 3);
  const now = Date.now();
  for (let seq = 0; seq < 3; seq++) {
    audio.send(encodeFrame({ channel: 'client', seq, captureTs: now, samples: tone(1600) }));
    audio.send(encodeFrame({ channel: 'me', seq, captureTs: now, samples: new Int16Array(1600) }));
  }
  // Sequence 4 skips 3: one frame lost in transit.
  audio.send(encodeFrame({ channel: 'client', seq: 4, captureTs: now, samples: tone(1600) }));
  const { session } = await levels;
  assert.equal(session.id, id);
  assert.equal(session.channels.me.levelDb, -100);

  const ended = next(ui, (m) => m.type === 'session-ended');
  audio.send(JSON.stringify({ type: 'stop' }));
  const done = await ended;
  assert.equal(done.session.channels.client.frames, 4);
  assert.equal(done.session.channels.client.missing, 1);
  assert.equal(done.session.channels.client.seconds, 0.4);
  assert.ok(done.session.channels.client.levelDb > -20);

  const meta = JSON.parse(fs.readFileSync(path.join(ctx.dir, id, 'meta.json'), 'utf8'));
  assert.ok(meta.endedAt);
  assert.equal(meta.rawAudioSaved, false);
  assert.equal(meta.timing['capture_to_server_ms.client'].n, 4);
  // Raw audio stays off disk by default.
  assert.deepEqual(fs.readdirSync(path.join(ctx.dir, id)), ['meta.json']);
  ui.close();
  audio.close();
});

test('start without consent is refused and no session opens', async () => {
  const audio = await open(`${ctx.ws}/ws/audio`);
  const err = next(audio, (m) => m.type === 'error');
  audio.send(JSON.stringify({ type: 'start', source: 'tab', consent: false }));
  assert.match((await err).message, /consent/);
  assert.equal(ctx.app.activeSession(), null);
  audio.close();
});

test('closing the capture socket ends the session', async () => {
  const ui = await open(`${ctx.ws}/ws/ui`);
  const audio = await open(`${ctx.ws}/ws/audio`);
  const started = next(audio, (m) => m.type === 'started');
  audio.send(JSON.stringify({ type: 'start', source: 'mic-only', consent: true }));
  await started;
  const ended = next(ui, (m) => m.type === 'session-ended');
  audio.close();
  assert.equal((await ended).reason, 'capture disconnected');
  ui.close();
});

test('a second capture client is turned away', async () => {
  const first = await open(`${ctx.ws}/ws/audio`);
  const second = await open(`${ctx.ws}/ws/audio`);
  const code = await new Promise((r) => second.once('close', (c) => r(c)));
  assert.equal(code, 4409);
  first.close();
});

test('a cross-origin page cannot open the transcript socket', async () => {
  await assert.rejects(open(`${ctx.ws}/ws/ui`, { origin: 'https://evil.example' }), /403/);
  const ok = await open(`${ctx.ws}/ws/ui`, { origin: ctx.app.url });
  ok.close();
});

test('static files are served and paths cannot escape web/', async () => {
  const page = await fetch(`${ctx.app.url}/capture/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Meeting capture/);
  assert.equal((await fetch(`${ctx.app.url}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${ctx.app.url}/../.env`)).status, 404);
});

test('SAVE_TEST_AUDIO writes one WAV per channel', async () => {
  const b = await boot({ SAVE_TEST_AUDIO: 'true' });
  try {
    const audio = await open(`${b.ws}/ws/audio`);
    const started = next(audio, (m) => m.type === 'started');
    audio.send(JSON.stringify({ type: 'start', source: 'tab', consent: true }));
    const { id } = await started;
    audio.send(encodeFrame({ channel: 'client', seq: 0, captureTs: Date.now(), samples: tone(1600) }));
    const stopped = next(audio, (m) => m.type === 'stopped');
    audio.send(JSON.stringify({ type: 'stop' }));
    await stopped;
    const wav = fs.readFileSync(path.join(b.dir, id, 'audio-client.wav'));
    assert.equal(wav.readUInt32LE(40), 3200);
    assert.equal(fs.readFileSync(path.join(b.dir, id, 'audio-me.wav')).readUInt32LE(40), 0);
    audio.close();
  } finally {
    await b.app.close();
  }
});

test('non-loopback callers need the access token', () => {
  const req = (remote: string, url = '/', cookie?: string) =>
    ({ socket: { remoteAddress: remote }, url, headers: cookie ? { cookie } : {} }) as unknown as IncomingMessage;
  assert.equal(isAuthorized(req('127.0.0.1'), undefined), true);
  assert.equal(isAuthorized(req('::1'), 's3cret'), true);
  assert.equal(isAuthorized(req('192.168.1.20'), undefined), false);
  assert.equal(isAuthorized(req('192.168.1.20'), 's3cret'), false);
  assert.equal(isAuthorized(req('192.168.1.20', '/?token=wrong'), 's3cret'), false);
  assert.equal(isAuthorized(req('192.168.1.20', '/?token=s3cret'), 's3cret'), true);
  assert.equal(isAuthorized(req('192.168.1.20', '/x.js', 'a=1; lmi_token=s3cret'), 's3cret'), true);
});

test('same-origin check', () => {
  const req = (origin: string | undefined, host: string) => ({ headers: { origin, host } }) as unknown as IncomingMessage;
  assert.equal(isSameOrigin(req(undefined, 'localhost:8787')), true);
  assert.equal(isSameOrigin(req('http://localhost:8787', 'localhost:8787')), true);
  assert.equal(isSameOrigin(req('http://192.168.1.5:8787', '192.168.1.5:8787')), true);
  assert.equal(isSameOrigin(req('http://localhost:9999', 'localhost:8787')), false);
  assert.equal(isSameOrigin(req('null', 'localhost:8787')), false);
});

test('session delete only removes session directories', () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '2026-10-12T14-03-22Z'));
  fs.mkdirSync(path.join(dir, '2026-10-12T15-00-00Z'));
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
  assert.deepEqual(listSessions(dir), ['2026-10-12T14-03-22Z', '2026-10-12T15-00-00Z']);
  assert.throws(() => deleteSessions(dir, ['..']), /Not a session id/);
  assert.throws(() => deleteSessions(dir, ['2026-01-01T00-00-00Z']), /No such session/);
  assert.deepEqual(deleteSessions(dir, ['2026-10-12T14-03-22Z']), ['2026-10-12T14-03-22Z']);
  assert.deepEqual(listSessions(dir), ['2026-10-12T15-00-00Z']);
  assert.ok(fs.existsSync(path.join(dir, 'keep.txt')));
});
