# Live Meeting Insights

Private, real-time cues during client meetings. Audio is captured on your own
Mac, transcribed live, and read by a Claude agent that puts short insights on a
panel only you can see (a second screen or your iPhone). After the meeting it
writes a summary, action items and a follow-up email draft.

No meeting bot joins the call. Everything stays on your machine, apart from the
audio streamed to the speech-to-text vendor and the transcript text sent to the
Claude API.

**Status: milestone 1 of 6.** The capture client streams two channels to the
backend, which shows levels and can save test audio. Transcription and insights
are not built yet.

| Milestone | State |
| --- | --- |
| 1. Two-channel capture to backend, level meters, test audio | Done |
| 2. Deepgram streaming STT, live transcript, speaker labels from channels | Next |
| 3. Insight agent: fast cues, JSON schema, headline plus lists | |
| 4. Deep analysis loop, running summary, cost counter, throttling | |
| 5. Post-meeting summary, actions, follow-up email | |
| 6. Hardening: reconnects, error states, setup docs | |

## Decisions (from the owner, 2026-10-12)

| Question | Answer |
| --- | --- |
| Operating system | macOS for capture. iPhone for the insights panel. |
| Primary meeting tool | Any. Capture must not depend on the meeting tool, so the default client source is a system audio device (BlackHole), which works for Teams, Zoom, Meet, Webex, and anything else that plays sound. Browser-tab capture is kept as an alternative. |
| Bot-based capture | Not used. Bot-free only. |
| STT vendor | Deepgram. |
| Transcript storage | Local only, under `sessions/`, kept until you delete it (`npm run session:delete`). |

## Quick start

Requires Node.js 22 or later and Chrome (or another Chromium browser).

```sh
cd live-meeting-insights
npm install
cp .env.example .env
npm start
```

Open http://localhost:8787/capture/ in Chrome on the Mac, choose your sources,
tick the consent box, and press Start. Open http://localhost:8787/insights/ in
another window to see what the server receives.

## Capturing meeting audio on macOS

The two sides of the call are captured as separate channels, so speaker
labels come from the channel rather than guesswork:

- **Client**: what the meeting app plays (the other side).
- **Me**: your microphone.

Use headphones. With speakers, your microphone also hears the client, and their
words land on your channel.

### Any meeting app: BlackHole (default)

macOS does not let a browser record what another app is playing. BlackHole is a
free virtual audio device that the meeting audio can be routed through.

1. Install it: `brew install blackhole-2ch` (or download it from
   existential.audio/blackhole). Restart Chrome afterwards.
2. Open **Audio MIDI Setup**, click **+**, and choose **Create Multi-Output
   Device**. Tick your headphones and **BlackHole 2ch**. Put your headphones
   first and turn on **Drift Correction** for BlackHole.
3. In the meeting app's audio settings, set the **speaker** to that
   Multi-Output Device. Leave the microphone as your real microphone. Setting
   it per app, rather than as the macOS system output, keeps notification
   sounds and music out of the transcript and leaves the volume keys working.
4. On the capture page, choose **Audio device**, set **Client audio device** to
   BlackHole 2ch, and set **Your microphone** to your headset or built-in mic.

Meeting apps differ in where the speaker setting lives: Teams under Settings,
Devices; Zoom under Settings, Audio; Meet and Webex in the browser under the
call's audio settings.

### A meeting in a Chrome tab

Choose **Browser tab** and pick the meeting tab in Chrome's share dialog with
**Also share tab audio** on. Chrome asks for video as well; it is never sent
anywhere. This only works for meetings running in Chrome, not desktop apps.

### In person

Choose **None: in-person meeting**. The microphone carries the whole room on
one channel. From milestone 2, speaker labels for this mode come from Deepgram
diarization.

### Windows (not the primary target)

Use a loopback device such as VB-Cable, or WASAPI loopback, in place of
BlackHole. Everything else is the same.

## The insights panel on your iPhone

The panel must never sit on a screen you share. Your iPhone is a good place
for it.

1. In `.env`, set `HOST=0.0.0.0` and an `ACCESS_TOKEN` (`openssl rand -hex 16`).
2. `npm start`. The server prints `http://<mac-ip>:8787/insights/?token=...`.
   Allow incoming connections if the macOS firewall asks.
3. Open that URL in Safari on the iPhone (same Wi-Fi). The token is kept in a
   cookie, so **Add to Home Screen** works.
4. Turn off Auto-Lock for the meeting, or the phone will sleep.

Requests from this Mac (loopback) need no token. Every other request needs it.
If you need the panel off your network, put a tunnel you control in front of
it. The server is never publicly hosted by default.

## Privacy and data

- The capture page will not start until the consent box is ticked, and shows
  **Recording and transcribing** while it runs. The server refuses a start
  without consent as well.
- Session files live in `sessions/<timestamp>/` and are gitignored. This
  repository is public: never force-add anything from `sessions/`.
- Raw audio is not written to disk unless `SAVE_TEST_AUDIO=true`.
- Delete sessions with one command:

  ```sh
  npm run session:list
  npm run session:delete -- 2026-10-12T14-03-22Z
  npm run session:delete -- --all
  ```

- WebSocket connections from other web origins are refused, so a web page open
  in your browser cannot connect to the local server and read the transcript.
- API keys are read from the environment (or `.env`, which is gitignored)
  and never committed.

## What a session folder holds

| File | Milestone | Contents |
| --- | --- | --- |
| `meta.json` | 1 | Source, start and end time, frames, seconds and missing frames per channel, capture-to-server timing (p50, p95, max) |
| `audio-client.wav`, `audio-me.wav` | 1 | Only with `SAVE_TEST_AUDIO=true`. 16 kHz mono. |
| `transcript.jsonl` | 2 | |
| `bookmarks.json` | 3 | |
| `summary.md`, `actions.md`, `followup-email.md` | 5 | |

## How it works

```
Chrome on the Mac (web/capture)
  getUserMedia: microphone, and BlackHole for the client side
  or getDisplayMedia: a meeting tab
  AudioWorklet per channel: mono, downsample to 16 kHz, 100 ms Int16 frames
        |
        |  WebSocket /ws/audio: 16-byte header (channel, sequence, capture time) + PCM
        v
Node.js server (src/server)
  session manager: per-channel stats, missing-frame count, optional WAV
        |
        |  WebSocket /ws/ui: status and levels (later transcript and insights)
        v
Insights panel (web/insights), on a second screen or the iPhone
```

The frame format is documented in `src/server/protocol.ts`. Its browser half
is `web/capture/frame.js`.

## Development

```sh
npm test          # unit and server integration tests
npm run typecheck
npm run dev       # restart on change
```

Logs are one JSON object per line on stdout.
