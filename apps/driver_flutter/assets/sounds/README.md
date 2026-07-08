# Sound assets — driver_flutter

These MP3s are placeholders (0 bytes). Replace each with a real, licensed
audio file before shipping.

| File                  | Purpose                                         | Approx length |
| --------------------- | ----------------------------------------------- | ------------- |
| countdown_tick.mp3    | Loop tick during 15s accept window              | <500ms        |
| incoming_request.mp3  | Alias for countdown_tick (one-shot variant)     | <500ms        |
| online.mp3            | Played when driver toggles status to online     | <1s           |
| offline.mp3           | Played when driver toggles status to offline    | <1s           |
| order_accepted.mp3    | Played when driver taps ACCEPT                  | <1s           |
| order_cancelled.mp3   | Played when driver declines / cancels           | <1s           |
| trip_completed.mp3    | Played when driver completes a trip              | <2s           |
| tip_received.mp3      | Played when a tipReceived socket event fires    | <1s           |

## Licensing

All audio must be original work or CC0 / permissive-licensed. The
audioplayers package plays these from the bundled asset bundle; empty
files will fail silently (try/catch in SoundService).
