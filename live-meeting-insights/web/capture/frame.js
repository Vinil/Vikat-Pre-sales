// Browser half of src/server/protocol.ts. Change both together.
export const CHANNEL_IDS = { client: 0, me: 1 };
const HEADER_BYTES = 16;

/** @param {'client'|'me'} channel @param {number} seq @param {number} captureTs @param {Int16Array} pcm */
export function encodeFrame(channel, seq, captureTs, pcm) {
  const out = new Uint8Array(HEADER_BYTES + pcm.byteLength);
  const v = new DataView(out.buffer);
  v.setUint8(0, 1);
  v.setUint8(1, CHANNEL_IDS[channel]);
  v.setUint32(4, seq, true);
  v.setFloat64(8, captureTs, true);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), HEADER_BYTES);
  return out.buffer;
}
