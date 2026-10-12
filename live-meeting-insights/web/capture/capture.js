import { encodeFrame } from './frame.js';

const $ = (id) => document.getElementById(id);
const els = {
  clientSource: $('clientSource'), clientDevice: $('clientDevice'), clientDeviceRow: $('clientDeviceRow'),
  micDevice: $('micDevice'), deviceHint: $('deviceHint'), unlock: $('unlockDevices'),
  consent: $('consent'), start: $('start'), stop: $('stop'), conn: $('conn'), err: $('err'),
  rec: $('rec'), stats: $('stats'),
};

// Frames waiting while the socket drains. Past this, frames are dropped and
// counted rather than letting latency grow without bound.
const MAX_BUFFERED_BYTES = 512 * 1024;
const PREFS_KEY = 'lmi.capture.prefs';

let run = null; // { ctx, streams, ws, seq, sent, dropped, sessionId }

// ---------- devices ----------

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
}
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      clientSource: els.clientSource.value, clientDevice: els.clientDevice.value, micDevice: els.micDevice.value,
    }));
  } catch { /* private window */ }
}

async function refreshDevices() {
  const prefs = loadPrefs();
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const labelled = inputs.some((d) => d.label);
  const fill = (sel, preferred, guess) => {
    const keep = sel.value || preferred;
    sel.replaceChildren(...inputs.map((d, i) => new Option(d.label || `Input ${i + 1}`, d.deviceId)));
    const match = inputs.find((d) => d.deviceId === keep) || inputs.find((d) => guess.test(d.label));
    if (match) sel.value = match.deviceId;
  };
  fill(els.clientDevice, prefs.clientDevice, /blackhole|loopback|vb-?cable|soundflower|aggregate/i);
  fill(els.micDevice, prefs.micDevice, /^(?!.*(blackhole|loopback|vb-?cable)).*(microphone|mic|airpods|headset)/i);
  if (prefs.clientSource && !run) els.clientSource.value = prefs.clientSource;
  els.unlock.hidden = labelled;
  els.deviceHint.textContent = !labelled
    ? 'Device names appear after you allow microphone access.'
    : inputs.some((d) => /blackhole/i.test(d.label))
      ? ''
      : 'No BlackHole device found. For desktop meeting apps, install BlackHole (see the README) or pick "Browser tab".';
  syncForm();
}

els.unlock.onclick = async () => {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    await refreshDevices();
  } catch (e) { showError(`Microphone access was refused: ${e.message}`); }
};
navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

// ---------- form state ----------

function syncForm() {
  els.clientDeviceRow.hidden = els.clientSource.value !== 'device';
  els.start.disabled = !!run || !els.consent.checked;
  els.stop.disabled = !run;
  for (const el of [els.clientSource, els.clientDevice, els.micDevice, els.consent]) el.disabled = !!run;
  els.rec.classList.toggle('on', !!run);
}
els.clientSource.onchange = () => { savePrefs(); syncForm(); };
els.clientDevice.onchange = savePrefs;
els.micDevice.onchange = savePrefs;
els.consent.onchange = syncForm;

function setConn(text, cls) {
  els.conn.textContent = text;
  els.conn.className = `pill ${cls || ''}`;
}
function showError(msg) {
  els.err.textContent = msg;
  els.err.hidden = !msg;
}

// ---------- capture ----------

const micConstraints = (deviceId) => ({
  audio: {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1,
  },
});
// The far side is already processed by the meeting app. Leave it untouched.
const rawConstraints = (deviceId) => ({
  audio: {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: false, noiseSuppression: false, autoGainControl: false,
  },
});

async function openClientStream(source) {
  if (source === 'device') {
    if (!els.clientDevice.value) throw new Error('Pick the audio device that carries the meeting audio.');
    if (els.clientDevice.value === els.micDevice.value) throw new Error('Client audio and your microphone are the same device. Pick two different inputs.');
    return navigator.mediaDevices.getUserMedia(rawConstraints(els.clientDevice.value));
  }
  if (source === 'tab') {
    // Chrome requires video to be requested; it is never sent anywhere.
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1 },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
      preferCurrentTab: false, selfBrowserSurface: 'exclude', systemAudio: 'include',
    });
    if (s.getAudioTracks().length === 0) {
      s.getTracks().forEach((t) => t.stop());
      throw new Error('No audio was shared. Pick the meeting tab and turn on "Also share tab audio".');
    }
    return s;
  }
  return null;
}

async function start() {
  showError('');
  const source = els.clientSource.value;
  const streams = {};
  let ctx;
  try {
    streams.me = await navigator.mediaDevices.getUserMedia(micConstraints(els.micDevice.value));
    const client = await openClientStream(source);
    if (client) streams.client = client;
    await refreshDevices(); // Labels are available now.

    ctx = new AudioContext();
    await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
    const sink = ctx.createGain();
    sink.gain.value = 0; // Pull the graph without playing anything back.
    sink.connect(ctx.destination);

    run = { ctx, streams, ws: null, seq: { client: 0, me: 0 }, sent: 0, dropped: 0, sessionId: null, nodes: [] };
    for (const [channel, stream] of Object.entries(streams)) {
      const src = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'pcm-processor', { numberOfOutputs: 1, outputChannelCount: [1] });
      node.port.onmessage = (e) => onFrame(channel, e.data);
      src.connect(node).connect(sink);
      run.nodes.push(node, src);
      for (const t of stream.getTracks()) t.addEventListener('ended', () => stop(`${channel === 'me' ? 'Microphone' : 'Shared audio'} stopped.`));
    }
    syncForm();
    connect(source);
  } catch (e) {
    for (const s of Object.values(streams)) s.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close();
    run = null;
    syncForm();
    showError(e.name === 'NotAllowedError' ? 'Permission was refused. Allow microphone (and screen sharing for tab audio) and try again.' : e.message);
  }
}

function connect(source) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = new URLSearchParams(location.search).get('token');
  const ws = new WebSocket(`${proto}//${location.host}/ws/audio${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  ws.binaryType = 'arraybuffer';
  run.ws = ws;
  setConn('Connecting', 'warn');
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'start', source, consent: els.consent.checked }));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'started') {
      run.sessionId = msg.id;
      setConn(`Connected: ${msg.id}`, 'ok');
    } else if (msg.type === 'error') {
      showError(`Server: ${msg.message}`);
    }
  };
  ws.onclose = (e) => {
    if (run && run.ws === ws) stop(e.code === 4409 ? 'Another capture page is already running.' : 'Connection to the server was lost. Capture stopped.');
  };
}

function onFrame(channel, { pcm, rms, peak }) {
  drawLevel(channel, rms, peak);
  if (!run || !run.ws || run.ws.readyState !== WebSocket.OPEN || !run.sessionId) return;
  const seq = run.seq[channel]++;
  if (run.ws.bufferedAmount > MAX_BUFFERED_BYTES) { run.dropped++; return; }
  run.ws.send(encodeFrame(channel, seq, Date.now(), pcm));
  run.sent++;
}

function stop(reason) {
  if (!run) return;
  const r = run;
  run = null;
  if (r.ws && r.ws.readyState === WebSocket.OPEN) {
    r.ws.send(JSON.stringify({ type: 'stop' }));
    r.ws.close(1000);
  }
  for (const s of Object.values(r.streams)) s.getTracks().forEach((t) => t.stop());
  r.ctx.close();
  setConn(r.sessionId ? `Stopped: ${r.sessionId}` : 'Not connected', '');
  els.stats.textContent = `Last session: ${r.sent} frames sent, ${r.dropped} dropped.`;
  for (const ch of ['client', 'me']) drawLevel(ch, 0, 0);
  if (typeof reason === 'string') showError(reason);
  syncForm();
}

// ---------- meters ----------

// Meters fall back at 3 dB per 100 ms frame instead of snapping to silence,
// so speech reads as a level rather than a flicker.
const shown = { client: -60, me: -60 };

function drawLevel(channel, rms, peak) {
  const raw = rms > 0 ? Math.max(-60, 20 * Math.log10(rms)) : -60;
  const db = run ? Math.max(raw, shown[channel] - 3) : raw;
  shown[channel] = db;
  const fill = $(`lvl-${channel}`);
  fill.style.width = `${((db + 60) / 60) * 100}%`;
  fill.classList.toggle('hot', peak > 0.95);
  $(`db-${channel}`).textContent = db > -60 ? `${Math.round(db)} dB` : '-';
  if (run) els.stats.textContent = `${run.sent} frames sent${run.dropped ? `, ${run.dropped} dropped` : ''}.`;
}

els.start.onclick = start;
els.stop.onclick = () => stop();
window.addEventListener('beforeunload', () => stop());
refreshDevices().catch((e) => showError(e.message));
