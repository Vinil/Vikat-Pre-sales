import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Downsampler, floatTo16 } from '../web/shared/resample.js';
import { levelDbfs, percentiles, WavWriter } from '../src/server/audio.ts';

const sine = (rate: number, hz: number, seconds: number) =>
  Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / rate) * 0.5);

for (const rate of [48_000, 44_100, 16_000]) {
  test(`downsampling ${rate} Hz gives 16 kHz output with no drift across chunk sizes`, () => {
    const input = sine(rate, 440, 2);
    const whole = new Downsampler(rate).process(input);
    // Same signal in the odd-sized chunks an AudioWorklet and a real device produce.
    const d = new Downsampler(rate);
    const parts: number[] = [];
    for (let i = 0; i < input.length; i += 128 + (i % 7)) parts.push(...d.process(input.subarray(i, i + 128 + (i % 7))));
    assert.ok(Math.abs(whole.length - 32_000) <= 1, `got ${whole.length} samples`);
    assert.equal(parts.length, whole.length);
    for (let i = 0; i < whole.length; i++) assert.ok(Math.abs(parts[i]! - whole[i]!) < 1e-6);
  });
}

test('a 440 Hz tone keeps its amplitude after downsampling', () => {
  const out = new Downsampler(48_000).process(sine(48_000, 440, 1));
  const peak = Math.max(...out.map(Math.abs));
  assert.ok(peak > 0.45 && peak <= 0.5, `peak ${peak}`);
});

test('content above 8 kHz is attenuated', () => {
  // 15 kHz would alias to 1 kHz at full strength without a filter.
  const out = new Downsampler(48_000).process(sine(48_000, 15_000, 1));
  const rms = Math.sqrt(out.reduce((a, v) => a + v * v, 0) / out.length);
  assert.ok(rms < 0.354 * 0.5, `rms ${rms}`);
});

test('float to 16-bit clips and scales', () => {
  assert.deepEqual([...floatTo16(Float32Array.from([0, 1, -1, 2, -2, 0.5]))], [0, 32767, -32768, 32767, -32768, 16383]);
});

test('level of silence, full scale and half scale', () => {
  assert.equal(levelDbfs(new Int16Array(100)), -100);
  assert.equal(levelDbfs(new Int16Array(0)), -100);
  assert.ok(Math.abs(levelDbfs(new Int16Array(100).fill(16384)) - -6.02) < 0.01);
});

test('WAV writer produces a valid 16 kHz mono header', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmi-wav-'));
  const file = path.join(dir, 'a.wav');
  const w = new WavWriter(file);
  w.write(Int16Array.from([1, 2, 3]));
  w.write(Int16Array.from([4]));
  w.close();
  const buf = fs.readFileSync(file);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.readUInt32LE(4), 36 + 8);
  assert.equal(buf.readUInt32LE(24), 16_000);
  assert.equal(buf.readUInt16LE(22), 1);
  assert.equal(buf.readUInt32LE(40), 8);
  assert.deepEqual([...new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + 52))], [1, 2, 3, 4]);
  fs.rmSync(dir, { recursive: true });
});

test('percentiles', () => {
  assert.equal(percentiles([]), null);
  const p = percentiles(Array.from({ length: 100 }, (_, i) => i + 1))!;
  assert.equal(p.p50, 51);
  assert.equal(p.p95, 96);
  assert.equal(p.max, 100);
});
