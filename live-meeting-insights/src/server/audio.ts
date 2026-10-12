import fs from 'node:fs';
import { SAMPLE_RATE } from './protocol.ts';

/** RMS level of 16-bit PCM in dBFS, floored at -100. */
export function levelDbfs(samples: Int16Array): number {
  if (samples.length === 0) return -100;
  let sum = 0;
  for (const s of samples) sum += s * s;
  const rms = Math.sqrt(sum / samples.length) / 32768;
  return rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}

/** Writes 16 kHz mono 16-bit PCM to a WAV file, patching the header on close. */
export class WavWriter {
  private fd: number;
  private dataBytes = 0;

  constructor(readonly path: string) {
    this.fd = fs.openSync(path, 'w');
    fs.writeSync(this.fd, wavHeader(0));
  }

  write(samples: Int16Array): void {
    fs.writeSync(this.fd, new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
    this.dataBytes += samples.byteLength;
  }

  close(): void {
    fs.writeSync(this.fd, wavHeader(this.dataBytes), 0, 44, 0);
    fs.closeSync(this.fd);
  }
}

export function wavHeader(dataBytes: number): Uint8Array {
  const h = new Uint8Array(44);
  const v = new DataView(h.buffer);
  const ascii = (off: number, s: string) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, dataBytes, true);
  return h;
}

/** p50 / p95 / max of a list of numbers. */
export function percentiles(values: number[]): { n: number; p50: number; p95: number; max: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1]! };
}
