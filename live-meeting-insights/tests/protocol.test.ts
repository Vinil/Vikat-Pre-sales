import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeFrame as browserEncode } from '../web/capture/frame.js';
import { decodeFrame, encodeFrame, FrameError, HEADER_BYTES, parseControl } from '../src/server/protocol.ts';

test('a frame survives encode and decode', () => {
  const samples = Int16Array.from([0, 1, -1, 32767, -32768]);
  const back = decodeFrame(encodeFrame({ channel: 'me', seq: 42, captureTs: 1_760_000_000_123.5, samples }));
  assert.equal(back.channel, 'me');
  assert.equal(back.seq, 42);
  assert.equal(back.captureTs, 1_760_000_000_123.5);
  assert.deepEqual([...back.samples], [...samples]);
});

test('the browser encoder and the server decoder agree', () => {
  const pcm = Int16Array.from({ length: 1600 }, (_, i) => (i * 37) % 2000 - 1000);
  const back = decodeFrame(new Uint8Array(browserEncode('client', 7, 123.25, pcm)));
  assert.equal(back.channel, 'client');
  assert.equal(back.seq, 7);
  assert.equal(back.captureTs, 123.25);
  assert.deepEqual([...back.samples], [...pcm]);
});

test('decoding works from an unaligned buffer slice', () => {
  const frame = encodeFrame({ channel: 'client', seq: 1, captureTs: 0, samples: Int16Array.from([5, -5]) });
  const padded = new Uint8Array(frame.length + 1);
  padded.set(frame, 1);
  assert.deepEqual([...decodeFrame(padded.subarray(1)).samples], [5, -5]);
});

test('malformed frames are refused', () => {
  assert.throws(() => decodeFrame(new Uint8Array(4)), FrameError);
  const bad = encodeFrame({ channel: 'me', seq: 0, captureTs: 0, samples: new Int16Array(2) });
  bad[0] = 9;
  assert.throws(() => decodeFrame(bad), /version/);
  const badChannel = encodeFrame({ channel: 'me', seq: 0, captureTs: 0, samples: new Int16Array(2) });
  badChannel[1] = 7;
  assert.throws(() => decodeFrame(badChannel), /channel/);
  assert.throws(() => decodeFrame(new Uint8Array(HEADER_BYTES + 3).fill(0).map((v, i) => (i === 0 ? 1 : v))), /16-bit/);
});

test('start requires consent', () => {
  assert.throws(() => parseControl(JSON.stringify({ type: 'start', source: 'tab', consent: false })), /consent/);
  assert.throws(() => parseControl(JSON.stringify({ type: 'start', source: 'tab' })), /consent/);
  assert.deepEqual(parseControl(JSON.stringify({ type: 'start', source: 'device', consent: true })), {
    type: 'start',
    source: 'device',
    consent: true,
  });
  assert.throws(() => parseControl(JSON.stringify({ type: 'start', source: 'zoom-bot', consent: true })), /source/);
  assert.throws(() => parseControl('not json'), /JSON/);
});
