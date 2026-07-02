# ADR 0019: Mobile Local Whisper Audio Contract

Date: 2026-06-28
Status: Accepted

## Context

Mindwtr supports local Whisper transcription on mobile through `whisper.rn`. Two bug histories exposed the same underlying contract problem:

- Android issue #95 was fixed only after quick capture stopped sending compressed recorder output directly to local Whisper and used a PCM/WAV capture path.
- Android issue #424 avoided a production bundle crash by skipping the realtime helper on Android, but that made Android fall back to Expo recorder `.m4a` files. Those files could be saved as audio notes, but local Whisper returned empty or hallucinated bracket text such as `[Intro]`.
- A private iOS app-store feedback report described the app becoming unresponsive after selecting local `whisper-base` or `whisper-tiny` and tapping the microphone, with the model appearing missing afterward. That path must fail softly in production and keep diagnostics useful.
- iOS issue #788 showed two additional native-boundary hazards: app-owned Whisper model storage can be corrupted by ambiguous file/directory writes, and `whisper.rn` can abort if realtime data transcription and file transcription run back-to-back on the same native context for one capture.

The local Whisper dependency supports file transcription, realtime transcription, and direct PCM data paths, but the current native file decoders in `whisper.rn` are stricter than a generic audio-file API: Android and iOS read the file bytes, strip the first 44 WAV header bytes, and interpret the remainder as 16-bit PCM samples. Expo recorder output is normally compressed container audio such as `.m4a`, so letting arbitrary recorder files reach local Whisper is unsafe.

## Decision

Mindwtr treats mobile local ASR as an audio-contract boundary, not a model-loading detail.

1. Local Whisper transcription only accepts `LocalWhisperAudio`, a prepared input produced by `prepareAudioForLocalWhisper(captured: CapturedAudio)`.
2. `prepareAudioForLocalWhisper` reads the file bytes and validates the actual WAV header. It does not trust the file extension alone.
3. The accepted local format is 16 kHz, mono, 16-bit PCM WAV with a RIFF/WAVE header, `fmt ` chunk, `data` chunk, non-empty data, and a minimum duration. Compressed containers, unknown files, empty files, and short files are rejected before native Whisper is called.
4. Rejections log `ASR_INPUT_REJECTED_UNSUPPORTED_FORMAT` with the capture mode, platform, URI scheme, extension, sniffed format, file size, duration, sample rate, channels, bits per sample, fallback reason, and `local_whisper_called: false`.
5. Accepted inputs log `ASR_INPUT_ACCEPTED_LOCAL_WHISPER` before native Whisper is called; native failures log a warning, while successful transcriptions avoid path-heavy success logs.
6. Android quick capture uses the `whisper.rn` realtime helper as a PCM/WAV recorder only. Android sets `onBeginTranscribe` to return `false`, ignores live transcript slices, and after stop runs offline local Whisper against the generated WAV.
7. iOS quick capture also records the WAV path and may use realtime transcript text as a fallback if offline transcription fails. Realtime runtime errors resolve to an empty transcript instead of rejecting mid-recording, so the sheet and inputs stay usable.
8. A successful iOS realtime transcript is the transcript for that capture. Do not immediately run offline file transcription for the same WAV on the same native Whisper context; offline file transcription is reserved for empty/unavailable realtime output and for later user-triggered retry of the saved attachment.
9. `Documents/whisper-models` is a directory invariant. Code may create the directory and model files inside it, but must not create sidecar files or use ambiguous file APIs that can target the directory path itself. If the path is a file, repair it as an app-owned corrupted cache and log the repair.
10. Model readiness checks must use the native-aware model resolver used by Whisper initialization, not only synchronous Expo metadata. A transient metadata miss must not delete or mark a verified model as unavailable.
11. If the realtime PCM helper is unavailable or a file is not valid local input, local Whisper transcription is skipped. The audio note can still be saved with its attachment; cloud/BYOK transcription may handle compressed audio through its existing provider path.
12. Realtime helper module loads must use literal, Metro-visible `require(...)` paths. Computed requires and dynamic imports are not allowed for this path because they caused production/dev-client bundle differences in #424.
13. Local Whisper is a native-module feature. Expo Go is not a supported runtime for it; validation must include development builds and release-like mobile builds.

## Consequences

- `.m4a` can no longer silently reach local Whisper, so the `[Intro]`/empty transcript failure mode is blocked at the input boundary.
- Old compressed audio attachments cannot be retried with local Whisper unless a future native converter normalizes them to 16 kHz mono PCM WAV first. The current behavior is to report unsupported local input rather than produce bad text.
- Android keeps the crash fix from #424 while restoring the working PCM/WAV capture behavior from #95.
- iOS local Whisper failures are non-fatal: missing native helpers, unsupported files, realtime errors, and model-path problems are logged and handled without freezing capture inputs.
- iOS quick capture avoids duplicate native Whisper jobs for one recording. This trades one redundant fallback attempt for native context safety; retrying the saved WAV remains available as a separate user action.
- Model cache repair is allowed only for Mindwtr-owned local Whisper cache paths. It must not be generalized to user-selected files, attachments, or synced data.
- The bracket-only transcript sanitizer remains as defense in depth, not as the primary audio-format fix.
- A future converter must write a validated `LocalWhisperAudio` before it can feed local Whisper.

## References

- whisper.rn introduction: https://mybigday-whisper-rn.mintlify.app/introduction
- whisper.cpp quick-start audio requirement: https://github.com/ggml-org/whisper.cpp#quick-start
- Metro module API: https://metrobundler.dev/docs/module-api/
- Expo custom native code: https://docs.expo.dev/workflow/customizing/
- Internal decoder evidence: `apps/mobile/node_modules/whisper.rn/android/src/main/java/com/rnwhisper/AudioUtils.java` and `apps/mobile/node_modules/whisper.rn/ios/RNWhisperAudioUtils.m`
