# Microphone selection and input checks

Exam entry requires a microphone selector, local recording test, native playback and an explicit confirmation before the paper is fetched. Permission and nonempty file bytes are not treated as proof of a usable voice recording. The candidate must listen to the test and confirm their voice, then acknowledge the rules. Older rules-only acknowledgements do not bypass this check. The confirmation is retained for this assessment in the browser tab's session, so it is not repeated on every question or an ordinary same-tab refresh. Test audio is never uploaded and the test does not start the paper clock. An existing scheduled closing time still applies.

The selected physical input is retained in session storage, with an in-memory fallback if storage is unavailable. Selection is shown only before the test, in the journey/preflight check. Question screens show a read-only input name, level meter and warnings, with no microphone switcher. A missing selected microphone produces an actionable error instead of silently choosing another device; the candidate can reconnect the chosen input and record again. Changing audio devices invalidates a confirmed preflight. Resuming in a fresh browser session requires the check and explicitly warns that the existing server clock continues running. An immediate failed entry request can be retried using the check just completed; beginning another mic test or changing devices invalidates that retry readiness. No server deadline is extended.

`public/js/microphone-input.js` taps the existing input stream with Web Audio; it never routes the input to speakers or changes the samples sent to MediaRecorder. The meter measures RMS level. The initial 500 ms are ignored for sustained-input counting, and at least 800 ms above -50 dBFS are needed to register input. Very short takes, sustained clipping and microphone interruptions trigger review warnings. Initial silence warns after four seconds; a later eight-second pause warns but does not invalidate earlier input. These are conservative signal checks, not speech recognition or proof of intelligibility.

On an answer screen, a quiet or interrupted take stays available. The candidate can listen and explicitly keep it or record again while time remains. Unexpected recorder stops are finalized only after the stop event, following the final data event, so the partial clip can be previewed and autosaved. Time expiry still preserves available audio and advances under the existing server rules. No assessment marks, server timer budgets or stored historic recordings are changed by these UI checks.

Browsers without Web Audio retain native capture and manual playback confirmation; the UI identifies the missing automatic check. Browsers without microphone capture cannot pass the entry gate and are directed to a supported browser and connected microphone. The legacy in-question typed fallback remains defensive handling for a capture capability lost after entry. Speech recognition remains optional and separate from the signal monitor.

All device selection, level measurements and practice playback stay on the device. No device labels, device IDs or raw level traces are sent to the server. On stop, navigation or unmount, timers, event listeners, input tracks and AudioContexts are released. Permission responses arriving after unmount are closed without creating a new recorder.

## Local verification

Deterministic tests use synthetic quiet input, sustained input, start clicks, clipping, mute/unmute and disconnect events. UI tests cover preflight timing, playback confirmation, resuming an existing exam, explicit keep, re-recording, unexpected stop/final chunks, expiry, captions failing independently, permission denial and cleanup. No private learner recordings are fixtures in the repository.

Browser verification uses an isolated loopback fixture with the real client modules, Web Audio, native MediaRecorder/playback and the actual API/domain over disposable synthetic accounts. It generates a test tone or near-silent input; it does not access a physical microphone or start a browser speech service. This verifies capture plumbing, warnings and UI behavior, not human speech intelligibility or every headset/browser combination. Screenshots and the fixture remain in the ignored `.probe` directory.

Run the suite with bounded concurrency on a busy development machine:

```powershell
node --test --test-concurrency=4 tests/*.test.mjs
```

Physical headset/microphone testing and a production rollout remain separate checks. The production website has not been changed as part of this local implementation.
