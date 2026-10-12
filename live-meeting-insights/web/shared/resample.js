/**
 * Streaming downsampler: float32 at the device rate to 16 kHz.
 *
 * Each output sample is the mean of the input samples it covers (a box
 * filter), which is enough anti-aliasing for speech going to STT and costs
 * almost nothing in the audio thread. State carries across process() calls,
 * so chunk boundaries do not click or drift.
 *
 * Shared by the AudioWorklet and the unit tests.
 */
export class Downsampler {
  /** @param {number} inRate @param {number} outRate */
  constructor(inRate, outRate = 16000) {
    if (inRate < outRate) throw new Error(`input rate ${inRate} is below output rate ${outRate}`);
    this.ratio = inRate / outRate;
    // Absolute counters, not a running fractional offset: window boundaries
    // are recomputed from them, so the output is identical however the input
    // is chunked, and rounding never accumulates over a long meeting.
    this.consumed = 0;
    this.produced = 0;
    this.acc = 0;
    this.count = 0;
  }

  /** @param {Float32Array} input @returns {Float32Array} */
  process(input) {
    const out = new Float32Array(Math.ceil(input.length / this.ratio) + 1);
    let n = 0;
    let end = (this.produced + 1) * this.ratio; // Absolute input index where the pending window ends.
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.count++;
      if (++this.consumed >= end) {
        out[n++] = this.acc / this.count;
        this.produced++;
        this.acc = 0;
        this.count = 0;
        end = (this.produced + 1) * this.ratio;
      }
    }
    return out.subarray(0, n);
  }
}

/** @param {Float32Array} f @returns {Int16Array} */
export function floatTo16(f) {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
