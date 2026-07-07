# Extensions SDK API surface — extracted from Live 12.4.5b6

Provenance: plaintext JS + symbol strings inside
`/Applications/Ableton Live 12 Beta.app/Contents/Helpers/ExtensionHost/ExtensionHostNodeModule.node`
(build 2026-06-29). The extension host is a bundled **Node v24.14.1**; this
native module embeds the privileged host-side JS. Raw dump:
`research/extensionhost-strings-12.4.5b6.txt` (gitignored, regenerate with
`strings -n 8 - <module> > …`). Authoritative source once available: the SDK
zip's TypeDoc. Treat everything here as strong evidence, not spec.

## Extension lifecycle

- Extension = npm-style package with `package.json`; Live's AddOns process
  scans an "installable extensions folder" (`InstallableExtensionsFolder`;
  exact path TBD — check SDK docs / first-run behavior).
- Host loads the package and calls `context.module.exports.activate(…)`.
- Console output is prefixed `[<name>]:` per extension.

## High-level JS API (verbatim signatures from the embedded source)

```js
withinTransaction(callback)                    // wraps song_begin/end_undo_step_send
registerContextMenuAction(category, title, commandId, onRegisterSuccessful)
  // title auto-prefixed "<ExtensionName>: <title>"; category values not in
  // binary (see SDK docs); callback args are flip refs revived to handles
showModalDialog(url, width, height, onResult, onError)
  // loads a URL into a modal WKWebView; onResult(payload) fires ON CLOSE —
  // single result payload, no visible push-messaging API
showProgressDialog({text, progress}, onShowDialog, onCancelled)
  // dialog.update({text, progress}, cb) / dialog.close(cb); user-cancellable
renderPreFxAudio(lane, {startTime, endTime}, onResult, onError)  // → wav path
importIntoProject(filePath, onResult, onError)                   // → destinationPath
```

Exposed to extensions as `public: { registerContextMenuAction,
showModalDialog, showProgressDialog }` plus the file helpers
(`{ renderPreFxAudio, importIntoProject }`) and a commands registry
(`registerCommand: (commandId, callback)`, `executeCommand`).

## ExtensionHost wire messages (complete vocabulary, 11)

```
extensionhost_register_action            extensionhost_unregister_action
extensionhost_register_action_object_callback
extensionhost_register_action_json_callback
extensionhost_show_modal_web_view
extensionhost_show_progress_dialog       extensionhost_update_progress_dialog
extensionhost_close_progress_dialog
extensionhost_progress_dialog_cancelled_callback
extensionhost_render_pre_fx_audio        extensionhost_import_into_project
```

## Low-level `bindings.*` (all 103 references found)

Object model: flip document (`ableton::push_live_model`), handles
`{user, actor, obj}`, `get_object_is_of_class` / `get_object_parent_object`
for navigation, `commit_and_push_changes` / `pull_changes` / `revert_changes`
for document sync.

```
Song    song_get_tempo/set_tempo · song_get_all_tracks · song_get_main_track ·
        song_get_scenes · song_get_cue_points · song_get_grid_quantization ·
        song_get_grid_is_triplet · song_get_root_note · song_get_scale_* ·
        song_begin_undo_step_send · song_end_undo_step_send
Track   track_get_name/set_name · track_get_arm/set_arm · track_get_mute/
        set_mute · track_get_solo/set_solo · track_get_muted_via_solo ·
        track_get_is_return · track_get_group_track · track_get_devices ·
        track_get_mixer_device · track_get_clip_slots ·
        track_get_arrangement_clips · track_get_take_lanes ·
        track_get_has_audio_input · track_get_is_collapsible
Clip    clip_get_name/set_name · clip_get_color/set_color · clip_get_muted/
        set_muted · clip_get_looping/set_looping · clip_get_start_time/
        end_time · clip_get_loop_start/loop_end · clip_get_start_marker/
        end_marker
MidiClip   midiclip_get_notes / midiclip_set_notes (+ converters
           convertFlipNotesToApiNotes / convertApiNotesToFlipNotes)
AudioClip  audioclip_get_warp_markers · audioclip_get_warp_mode/set_warp_mode ·
           audioclip_get_warping/set_warping · audioclip_get_file_path
CuePoint   cuepoint_get_name/get_time · cuepoint_set_name   (NO create/delete!)
Scene      scene_get_name/set_name · scene_get_tempo ·
           scene_get_signature_numerator/denominator
Devices    device_get_name · device_get_parameters ·
           deviceparameter_get_name/min/max/default_value/is_quantized/
           value_items · rackdevice_get_chains · chain_get_devices ·
           chain_get_mixer_device · simplerdevice_get_sample ·
           sample_get_file_path · drumchain_get/set_receiving_note
Mixer      mixerdevice_get_volume/panning/sends · chainmixerdevice_get_*
TakeLane   takelane_get_clips · takelane_get_name/set_name
Misc       clipslot_get_clip · get_root · root_get_song ·
           root_get_extension_host
Results    audiorenderresult · importintoprojectresult ·
           showmodalwebviewresult · setparametervalueresult ·
           insertionresult · deletionresult · createtakelaneresult ·
           duplicatedeviceresult
```

## Notable ABSENCES in 12.4.5b6 (checked, not found)

- Any automation/envelope read or value-at-time API
- Tempo automation / tempo map (static `song_get_tempo` only)
- Cue point creation or deletion (M4 cue-sheet import at risk)
- Track color; song-level time signature (scene-level only)
- Any WebView push-messaging from Node (only the close payload) — hence the
  loopback-HTTP/WebSocket studio bridge decision in DECISIONS.md
- `deviceparameter_get_value` (current value) — parameters expose
  metadata + a set-result type, so writes likely exist; reads of the live
  value were not found in strings

## WebView (Live main binary)

`WKWebView` + `WKUserContentController` + `TWebViewScriptMessageHandler`
(`addScriptMessageHandler:name:`, `evaluateJavaScript:`) — WebKit, not
Chromium. A native JS bridge exists at the Cocoa level; whether the SDK
exposes it to extensions is TBD (SDK docs). Canvas 2D / WebGL / WebGL2 are
safe; avoid Chromium-only APIs.
