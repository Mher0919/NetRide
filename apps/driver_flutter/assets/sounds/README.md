# Sound assets — driver_flutter

Sound effects backed by bundled audio via `audioplayers` (AssetSource).
The four primary driver cues are **original synthesized WAVs** (generated
in-repo with a small PowerShell script — no third-party recordings):

| File                  | Purpose                                         | Approx length |
| --------------------- | ----------------------------------------------- | ------------- |
| countdown_tick.wav    | Short tick blip during the accept window        | ~60ms         |
| incoming_request.wav  | Three-note attention chime for a new request    | ~0.6s         |
| online.wav            | Rising two-note chime when driver goes online   | ~0.44s        |
| offline.wav           | Descending two-note chime when driver goes offline | ~0.44s     |
| order_accepted.mp3    | Played when driver taps ACCEPT (placeholder)    | <1s           |
| order_cancelled.mp3   | Played when driver declines / cancels (placeholder) | <1s       |
| trip_completed.mp3    | Played when driver completes a trip (placeholder) | <2s         |
| tip_received.mp3      | Played when a tipReceived socket event fires (placeholder) | <1s  |

## Generation

The WAVs were synthesized from sine tones (original, no copyrighted
audio) — the script used is in the session temp dir
(`opencode/gen_sounds.ps1`). To regenerate, rerun that script; keep the
same sample rate (44.1 kHz mono PCM) and amplitude envelope so the
effects stay short and subtle.

## Licensing

All audio is original work. The remaining `.mp3` files are still 0-byte
placeholders and must be replaced with real, licensed audio before
shipping; empty files fail silently (try/catch in SoundService).
