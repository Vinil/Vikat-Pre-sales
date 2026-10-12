import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// API keys come from the environment only. .env is a convenience for local
// runs and is gitignored.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export interface Config {
  host: string;
  port: number;
  accessToken: string | undefined;
  sessionsDir: string;
  webDir: string;
  saveTestAudio: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    // Loopback by default. Set HOST=0.0.0.0 to open the insights panel on a
    // phone on the same Wi-Fi; non-loopback requests then need ACCESS_TOKEN.
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 8787),
    accessToken: env.ACCESS_TOKEN || undefined,
    sessionsDir: path.resolve(ROOT, env.SESSIONS_DIR || 'sessions'),
    webDir: path.join(ROOT, 'web'),
    // Raw audio is never written to disk unless this is on (milestone 1 checks).
    saveTestAudio: bool(env.SAVE_TEST_AUDIO, false),
  };
}
