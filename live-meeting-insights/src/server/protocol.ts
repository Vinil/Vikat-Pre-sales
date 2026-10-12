/**
 * Wire format between the capture client and the backend.
 *
 * Binary audio frame (little endian):
 *   0  u8   version (FRAME_VERSION)
 *   1  u8   channel (0 = client, 1 = me)
 *   2  u16  reserved, 0
 *   4  u32  sequence number, per channel, starts at 0
 *   8  f64  capture timestamp, epoch milliseconds on the capture machine
 *  16  ...  PCM samples, signed 16-bit, 16 kHz, mono
 *
 * Text messages are JSON control messages (see ControlMessage).
 *
 * web/capture/frame.js is the browser half of this file. Change both together.
 */

export const FRAME_VERSION = 1;
export const HEADER_BYTES = 16;
export const SAMPLE_RATE = 16_000;

export const CHANNELS = ['client', 'me'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface AudioFrame {
  channel: Channel;
  seq: number;
  captureTs: number;
  samples: Int16Array;
}

export type ControlMessage =
  | { type: 'start'; source: 'tab' | 'device' | 'mic-only'; consent: true }
  | { type: 'stop' };

export class FrameError extends Error {}

export function decodeFrame(buf: Buffer | ArrayBuffer | Uint8Array): AudioFrame {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  if (bytes.byteLength < HEADER_BYTES) throw new FrameError(`frame too short: ${bytes.byteLength} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== FRAME_VERSION) throw new FrameError(`unsupported frame version ${version}`);
  const channel = CHANNELS[view.getUint8(1)];
  if (!channel) throw new FrameError(`unknown channel ${view.getUint8(1)}`);
  const pcmBytes = bytes.byteLength - HEADER_BYTES;
  if (pcmBytes % 2 !== 0) throw new FrameError('PCM payload is not whole 16-bit samples');
  // Copy so the samples are 2-byte aligned regardless of the socket buffer.
  const samples = new Int16Array(pcmBytes / 2);
  new Uint8Array(samples.buffer).set(bytes.subarray(HEADER_BYTES));
  return { channel, seq: view.getUint32(4, true), captureTs: view.getFloat64(8, true), samples };
}

export function encodeFrame(frame: AudioFrame): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + frame.samples.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, FRAME_VERSION);
  view.setUint8(1, CHANNELS.indexOf(frame.channel));
  view.setUint32(4, frame.seq, true);
  view.setFloat64(8, frame.captureTs, true);
  out.set(new Uint8Array(frame.samples.buffer, frame.samples.byteOffset, frame.samples.byteLength), HEADER_BYTES);
  return out;
}

export function parseControl(text: string): ControlMessage {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    throw new FrameError('control message is not JSON');
  }
  if (typeof msg !== 'object' || msg === null) throw new FrameError('control message is not an object');
  const m = msg as Record<string, unknown>;
  if (m.type === 'stop') return { type: 'stop' };
  if (m.type === 'start') {
    if (m.consent !== true) throw new FrameError('start refused: consent was not confirmed');
    if (m.source !== 'tab' && m.source !== 'device' && m.source !== 'mic-only') {
      throw new FrameError(`unknown source ${String(m.source)}`);
    }
    return { type: 'start', source: m.source, consent: true };
  }
  throw new FrameError(`unknown control type ${String(m.type)}`);
}
