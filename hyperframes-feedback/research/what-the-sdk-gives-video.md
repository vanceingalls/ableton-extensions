# What the Ableton Extensions SDK can give a video

SDK 1.0.0-beta.0, verified against the installed TypeScript definitions and
live testing in Live 12.4.5b6. This is the raw material available to drive
visuals and audio. Everything here is confirmed present unless a line says
otherwise.

Units to keep straight: **positions and durations are in BEATS** (not seconds)
everywhere in the object model. We convert beats→seconds→frames ourselves via
TimeBridge using the tempo. `color` is a packed integer (0xRRGGBB).

---

## 1. The crown jewel: MIDI notes (exact timing)

Per MIDI clip, `clip.notes` returns an array of:

| field | meaning | range |
|---|---|---|
| `pitch` | note number | 0–127 (60 = middle C) |
| `startTime` | position **in beats** | clip-relative |
| `duration` | length in beats | |
| `velocity` | how hard it was hit | 0–127 (optional) |
| `probability` | Live's per-note chance | 0–1 (optional) |
| `velocityDeviation` | velocity randomization range | optional |
| `releaseVelocity` | note-off velocity | optional |
| `muted` | note disabled | optional |

This is the whole reason the project exists: **every note's exact musical
position, pitch, and dynamics** — no audio analysis, no guessing. We can read
this for **every MIDI clip on every track**. That's a full piano-roll of the
composition, per instrument.

What it enables visually: notes firing exactly on the beat; pitch → vertical
position or color; velocity → size/brightness/intensity; chords vs melody vs
bass readable from pitch spread; density of notes → energy of a section.

---

## 2. Structure & arrangement (the shape of the song)

- **Tracks** (`song.tracks`): every regular track, in order. Plus
  `song.returnTracks` and `song.mainTrack`. Each track knows if it's a
  `MidiTrack` or `AudioTrack`.
- **Arrangement clips** (`track.arrangementClips`): every clip placed on the
  timeline, each with `startTime`/`endTime`/`duration` (beats),
  `startMarker`/`endMarker`, loop points, `name`, `color`, `muted`. This is
  the **song's block structure** — where each part enters and exits, per track.
- **Session clips** (`track.clipSlots` → `slot.clip`): the Session-view grid.
- **Take lanes** (`track.takeLanes`): comping lanes with their own clips.
- **Group tracks** (`track.groupTrack`): track grouping / hierarchy.
- **Scenes** (`song.scenes`): each with `name`, and its own `tempo`,
  `signatureNumerator`, `signatureDenominator`. Scenes are the closest thing
  to per-section time signatures.
- **Cue points / locators** (`song.cuePoints`): each has `time` (beats) and
  `name` — e.g. "Intro", "Drop", "Bridge". **The song's section map.** We can
  also *create* them (`createCuePoint`) for the B-side cue-sheet import.

What it enables visually: a song-structure ribbon (Intro→Verse→Drop) from cue
points; per-track entrances/exits as the arrangement plays; "what's playing
right now" by which clips are active at time t.

---

## 3. Identity & color (making it look like *their* song)

- **Clip color** (`clip.color`): the producer's own color-coding, per clip.
- **Names**: `clip.name`, `track.name`, `scene.name`, `cuePoint.name`,
  `device.name`, `deviceParameter.name`.
- **Track type**: MIDI vs Audio (via class).
- ⚠️ **No track color** — color lives only on clips, not tracks. We derive a
  track's color from its clips' colors.

What it enables: every instrument rendered in its own color; on-screen labels
that are the producer's real names; a video that reads as *this* session, not
a generic template.

---

## 4. Instruments & mixer (what's in the rack)

- **Devices** (`track.devices`): the device chain per track, each with a
  `name` (e.g. "Wavetable", "Operator", "Drum Rack", "Reverb") and its
  `parameters`.
- **Device parameters** (`device.parameters`): each has `name`, `min`, `max`,
  `defaultValue`, `isQuantized`, `valueItems` (for stepped params), and
  **`getValue()`** — the current value.
- **Mixer** (`track.mixer`): `volume`, `panning`, and `sends` — each is a
  DeviceParameter, so we can read the current mix (levels, pan positions).
- **Racks**: Drum Racks and instrument/effect racks expose their chains
  (`rackdevice_get_chains`, drum pads with their receiving MIDI note).

What it enables: name the instruments on screen ("Bass: Operator"); show the
mixer as a live board; a per-track VU-ish level from volume; pan positions as
left/right placement of visual elements.

**Important limit:** `getValue()` reads the **current** value only. There is
**no automation/envelope read** — we cannot get a filter-cutoff curve over
time, or any parameter's value at an arbitrary beat. So mixer/device values
are a *snapshot*, not something we can animate from the project.

---

## 5. Audio clips & warp (for audio-track material)

- `audioClip.filePath` — the source sample on disk.
- `audioClip.warpMarkers` — array of `{ sampleTime (s), beatTime (beats) }`
  mapping the sample to musical time. Lets us place a sample's transients on
  the exact beat grid.
- `warpMode` (Beats/Tones/Texture/Repitch/Complex/ComplexPro), `warping` flag.

What it enables: for audio (not MIDI) tracks, we can still align visuals to the
sample's warped grid — e.g. a vocal or drum loop's hits land on-beat.

---

## 6. Tempo & grid

- `song.tempo` — **a single static BPM.** ⚠️ No tempo-map / tempo-automation
  read: if the song has tempo changes or ramps, we only see one number. Our
  TimeBridge supports ramps, but the SDK won't hand us the ramp data.
- `song.gridQuantization` + `gridIsTriplet` — the current edit grid
  (1/4, 1/8, 1/16, triplet…). Minor, but usable for grid-aligned visuals.
- Time signature: only per **scene** (numerator/denominator), not a global
  arrangement signature.

---

## 7. Audio rendering (the sound in the video)

- **`resources.renderPreFxAudio(audioTrack, startBeat, endBeat)`** → WAV path.
  Renders the **pre-effects** audio of **one AudioTrack** over a beat range.
  Confirmed working (the strip-silence example uses it).
- ⚠️ **AudioTrack only.** It does **not** accept MIDI tracks or the main/master
  track (we tested `mainTrack` — it fails). So there is **no SDK path to the
  full mix** and **no way to render a MIDI instrument's audio** (synths, drum
  racks driven by MIDI).

Consequences for "use the real audio":
- If the song has audio tracks, we can render each and mix them with ffmpeg —
  but that misses every MIDI instrument (often most of the song).
- The only way to get the **complete master mix** (MIDI instruments included)
  is Live's own **File → Export Audio**, done once by the user, which we then
  consume. This is the reliable full-fidelity path.
- `resources.importIntoProject(path)` — puts the finished MP4 (or any file)
  into the Live project folder so the user owns it. This is how we deliver.

---

## 8. What we CANNOT get (the honest limits)

- **No automation/envelope data** — no parameter value over time; no volume,
  filter, or macro curves. Only current snapshots.
- **No tempo map** — static BPM only, even if the song ramps.
- **No full-mix or MIDI-instrument audio render** — audio tracks only.
- **No real-time transport / playhead** — extensions are an offline editing
  layer; we can't follow Live's playback live (this is why preview uses its own
  WebAudio clock).
- **No global time signature** — scene-level only.
- **No track color, no waveform data** from the SDK (we compute waveforms
  ourselves from rendered/exported audio).
- **No audio analysis** (spectrum, onsets) — by design; we use ground-truth
  MIDI instead, and can FFT the exported audio ourselves if we want spectra.

---

## 9. What this means for a compelling composition video

Data we can reliably assemble for the WHOLE arrangement, today:

- Every MIDI note on every track, exact timing + pitch + velocity
- Each track's name, type, and per-clip colors
- The arrangement block layout (what plays when, per track)
- Section markers with names (cue points)
- Instrument names per track (device chain)
- A mixer snapshot (levels, pan)
- Static tempo; scene time signatures
- Warp-aligned timing for audio-track material

Video concepts that fall straight out of that:

1. **Multi-track piano roll / note rain** — every track a lane in its own
   color, notes streaming and firing exactly on the beat, velocity → brightness.
   Bass low, leads high, drums as pulses. This is the flagship: it literally
   shows the composition's content.
2. **Song-structure ribbon** — a timeline of named sections (from cue points)
   with a playhead, each track's blocks lighting up as they enter/exit.
3. **Instrument roster** — track names + instrument (device) names animating in,
   so viewers see "Bass: Operator, Lead: Wavetable, Drums: Drum Rack."
4. **Energy curve** — note density / total velocity per bar → a rising/falling
   intensity line that peaks on the drop.
5. **Per-instrument bloom** — one visual element per track, pulsing on that
   track's notes, colored by the track's clips.

The audio under all of this is the one real decision: **auto-mix of audio
tracks** (partial, automatic) vs **one manual master export** (complete, one
extra step) — see §7.
