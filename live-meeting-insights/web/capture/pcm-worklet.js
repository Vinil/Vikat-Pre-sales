// AudioWorklet: one instance per channel. Mixes to mono, downsamples to
// 16 kHz, and posts 100 ms Int16 frames plus a level reading to the page.
import { Downsampler, floatTo16 } from '../shared/resample.js';

const OUT_RATE = 16000;
const FRAME_SAMPLES = 1600; // 100 ms

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global in the AudioWorklet scope.
    this.down = new Downsampler(sampleRate, OUT_RATE);
    this.buf = new Int16Array(FRAME_SAMPLES);
    this.fill = 0;
    this.sumSq = 0;
    this.peak = 0;
  }

  process(inputs) {
    const chans = inputs[0];
    if (!chans || chans.length === 0 || !chans[0]) return true;
    const len = chans[0].length;
    const mono = new Float32Array(len);
    for (const c of chans) for (let i = 0; i < len; i++) mono[i] += c[i] / chans.length;

    const pcm = floatTo16(this.down.process(mono));
    for (let i = 0; i < pcm.length; i++) {
      const s = pcm[i];
      this.buf[this.fill++] = s;
      this.sumSq += s * s;
      const a = Math.abs(s);
      if (a > this.peak) this.peak = a;
      if (this.fill === FRAME_SAMPLES) {
        const rms = Math.sqrt(this.sumSq / FRAME_SAMPLES) / 32768;
        this.port.postMessage({ pcm: this.buf, rms, peak: this.peak / 32768 }, [this.buf.buffer]);
        this.buf = new Int16Array(FRAME_SAMPLES);
        this.fill = 0;
        this.sumSq = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
