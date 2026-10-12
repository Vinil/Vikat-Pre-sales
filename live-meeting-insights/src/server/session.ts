import fs from 'node:fs';
import path from 'node:path';
import { levelDbfs, percentiles, WavWriter } from './audio.ts';
import { CHANNELS, SAMPLE_RATE, type AudioFrame, type Channel } from './protocol.ts';

interface ChannelStats {
  frames: number;
  samples: number;
  /** Frames the sequence numbers say were sent but never arrived. */
  missing: number;
  lastSeq: number;
  levelDb: number;
  /** Capture timestamp to server receipt, ms. Clock skew applies if capture runs on another machine. */
  transitMs: number[];
}

export interface ChannelSnapshot {
  frames: number;
  seconds: number;
  missing: number;
  levelDb: number;
}

export interface SessionSnapshot {
  id: string;
  source: string;
  startedAt: string;
  channels: Record<Channel, ChannelSnapshot>;
}

const TRANSIT_SAMPLES_KEPT = 10_000;

/** Session ids double as directory names: sortable, filesystem safe. */
export function sessionId(d = new Date()): string {
  return d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

export class Session {
  readonly id: string;
  readonly dir: string;
  readonly startedAt = new Date();
  private stats = {} as Record<Channel, ChannelStats>;
  private wavs = new Map<Channel, WavWriter>();
  private closed = false;

  constructor(
    sessionsDir: string,
    readonly source: string,
    private opts: { saveTestAudio: boolean },
  ) {
    this.id = sessionId(this.startedAt);
    this.dir = path.join(sessionsDir, this.id);
    fs.mkdirSync(this.dir, { recursive: true });
    for (const ch of CHANNELS) {
      this.stats[ch] = { frames: 0, samples: 0, missing: 0, lastSeq: -1, levelDb: -100, transitMs: [] };
      if (opts.saveTestAudio) this.wavs.set(ch, new WavWriter(path.join(this.dir, `audio-${ch}.wav`)));
    }
    this.writeMeta();
  }

  ingest(frame: AudioFrame, receivedAt = Date.now()): void {
    if (this.closed) return;
    const s = this.stats[frame.channel];
    if (s.lastSeq >= 0 && frame.seq > s.lastSeq + 1) s.missing += frame.seq - s.lastSeq - 1;
    s.lastSeq = Math.max(s.lastSeq, frame.seq);
    s.frames += 1;
    s.samples += frame.samples.length;
    s.levelDb = levelDbfs(frame.samples);
    if (s.transitMs.length < TRANSIT_SAMPLES_KEPT) s.transitMs.push(receivedAt - frame.captureTs);
    this.wavs.get(frame.channel)?.write(frame.samples);
  }

  snapshot(): SessionSnapshot {
    const channels = {} as Record<Channel, ChannelSnapshot>;
    for (const ch of CHANNELS) {
      const s = this.stats[ch];
      channels[ch] = {
        frames: s.frames,
        seconds: Math.round((s.samples / SAMPLE_RATE) * 10) / 10,
        missing: s.missing,
        levelDb: Math.round(s.levelDb),
      };
    }
    return { id: this.id, source: this.source, startedAt: this.startedAt.toISOString(), channels };
  }

  close(): SessionSnapshot {
    const snap = this.snapshot();
    if (this.closed) return snap;
    this.closed = true;
    for (const w of this.wavs.values()) w.close();
    this.writeMeta(new Date());
    return snap;
  }

  private writeMeta(endedAt?: Date): void {
    const timing: Record<string, unknown> = {};
    for (const ch of CHANNELS) timing[`capture_to_server_ms.${ch}`] = percentiles(this.stats[ch].transitMs);
    const meta = {
      ...this.snapshot(),
      endedAt: endedAt?.toISOString() ?? null,
      sampleRate: SAMPLE_RATE,
      rawAudioSaved: this.opts.saveTestAudio,
      timing,
    };
    fs.writeFileSync(path.join(this.dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  }
}
