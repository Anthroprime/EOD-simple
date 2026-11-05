import { micCapability, startAudioRecorder } from './exam-audio.js';
import { openMicrophone, microphoneInputMarkup, wireMicrophoneInput, monitorMicrophone, recordingQualityWarning } from './microphone-input.js';

// The test is local and must never fetch/start an exam or upload its clip.
export function wireMicrophoneCheck(root, { win = window, onUnmount, onReadyChange = () => {} } = {}) {
  const start = root.querySelector('[data-mic-start]');
  const stop = root.querySelector('[data-mic-stop]');
  const status = root.querySelector('[data-mic-status]');
  const player = root.querySelector('[data-mic-player]');
  (start.parentElement === root ? start : start.parentElement).insertAdjacentHTML('beforebegin', microphoneInputMarkup());
  const result = root.ownerDocument.createElement('p');
  result.className = 'mic-result'; result.setAttribute('role', 'status'); status.before(result);
  const confirmation = root.ownerDocument.createElement('label');
  confirmation.className = 'check mic-confirm';
  confirmation.innerHTML = '<input type="checkbox" data-mic-confirm disabled><span>I played the test and can hear my voice clearly.</span>';
  player.after(confirmation);
  const confirm = confirmation.querySelector('input');
  const setResult = (state, text) => {
    result.dataset.state = state;
    result.textContent = `${state === 'success' ? '✓' : state === 'failure' ? '✕' : '○'} ${text}`;
  };
  let stream, recorder, monitor, timer, url, disposed = false, ready = false, clipReady = false, played = false;
  const invalidate = () => { ready = false; clipReady = false; played = false; confirm.checked = false; confirm.disabled = true; onReadyChange(false); };
  const input = wireMicrophoneInput(root.querySelector('[data-mic-input]'), { win, onChange: (reason) => {
    invalidate(); setResult('idle', reason === 'selection' ? 'Microphone changed — test this input' : 'Audio devices changed — test your input again');
  } });
  const release = () => { monitor?.dispose(); monitor = null; stream?.getTracks().forEach(t => { try { t.stop(); } catch { /* releasing */ } }); stream = null; };
  const failed = (message) => {
    invalidate(); release(); input.setRecording(false); start.disabled = false; stop.disabled = true;
    setResult('failure', 'Microphone test failed'); status.textContent = message;
  };
  const finish = () => {
    clearTimeout(timer);
    try { if (recorder?.state === 'recording') recorder.stop(); }
    catch { failed('Could not finish recording. Check your input device and test again.'); }
  };
  const onPlay = () => { if (clipReady) { played = true; confirm.disabled = false; } };
  const onPlaybackError = () => { if (!disposed && url) failed('This test recording could not be played. Test again before entering the exam.'); };
  player.addEventListener('play', onPlay); player.addEventListener('error', onPlaybackError);
  confirm.onchange = () => {
    ready = clipReady && played && confirm.checked;
    onReadyChange(ready);
    setResult(ready ? 'success' : 'pending', ready ? 'Microphone test successful · playback confirmed' : 'Listen and confirm your voice before continuing');
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true; clearTimeout(timer); finish(); release(); input.dispose();
    player.removeEventListener('play', onPlay); player.removeEventListener('error', onPlaybackError);
    start.onclick = stop.onclick = confirm.onchange = null;
    player.pause(); player.removeAttribute('src');
    if (url) win.URL.revokeObjectURL(url);
  };
  dispose.isReady = () => ready;
  onUnmount?.(dispose);
  setResult('idle', 'Microphone not tested yet');
  if (!micCapability(win).canRecord) {
    start.disabled = true; setResult('failure', 'Microphone test unavailable');
    status.textContent = 'Audio recording is unavailable. Use a supported browser over HTTPS, or contact your administrator.';
    return dispose;
  }
  stop.onclick = finish;
  start.onclick = async () => {
    if (disposed || start.disabled) return;
    invalidate(); start.disabled = true; input.setRecording(true); player.pause();
    if (url) { win.URL.revokeObjectURL(url); url = null; }
    player.removeAttribute('src'); player.hidden = true;
    setResult('pending', 'Waiting for microphone permission'); status.textContent = 'Allow microphone access in your browser…';
    try {
      const acquired = await openMicrophone(win);
      if (disposed) { acquired.getTracks().forEach(t => t.stop()); return; }
      stream = acquired;
      await input.refresh();
      if (disposed) return;
      const recording = startAudioRecorder(win, stream);
      recorder = recording.recorder;
      const activeRecorder = recorder;
      const chunks = [];
      let recordingFailed = false;
      recorder.ondataavailable = e => { if (e.data?.size) chunks.push(e.data); };
      monitor = monitorMicrophone(win, stream, { onUpdate: snapshot => {
        input.show(snapshot);
        if (['muted', 'ended'].includes(snapshot.state)) { ready = false; onReadyChange(false); }
      } });
      recorder.onstop = () => {
        if (recorder !== activeRecorder) return;
        clearTimeout(timer);
        const health = monitor?.summary(); release();
        if (disposed) return;
        input.setRecording(false); start.disabled = false; stop.disabled = true;
        if (recordingFailed) return;
        const blob = new win.Blob(chunks, { type: recording.mime });
        if (!blob.size) { failed('No audio captured. Check your microphone and try again.'); return; }
        url = win.URL.createObjectURL(blob); player.src = url; player.hidden = false;
        const warning = recordingQualityWarning(health) || (health?.available && health.measuredMs < 1500 ? 'Record a complete short sentence, then stop and listen.' : '');
        clipReady = !warning;
        setResult(warning ? 'failure' : 'pending', warning ? 'Microphone input needs attention' : 'Recording ready · listen to your test');
        status.textContent = warning ? `${warning} Choose an input and test again.`
          : 'Play the recording, then confirm that your voice is clear. Sound detection alone does not verify speech.';
        start.textContent = 'Test again';
      };
      recorder.onerror = () => { if (disposed || recorder !== activeRecorder) return; recordingFailed = true; failed('Recording failed. Check your input device and try again.'); finish(); };
      recorder.start(); stop.disabled = false;
      setResult('pending', 'Recording test · speak a short sentence');
      status.textContent = 'Speak a short sentence. The test stops automatically after 10 seconds.';
      timer = setTimeout(finish, 10_000);
    } catch (err) {
      if (disposed) { release(); return; }
      failed(err.name === 'NotAllowedError' ? 'Microphone blocked. Allow access in your browser’s site settings, then try again.'
        : err.name === 'NotFoundError' || err.name === 'OverconstrainedError' ? 'The selected microphone is unavailable. Choose a connected input and test again.'
        : 'Could not access your microphone. Check that it is connected and available, then try again.');
      if (err.name === 'NotAllowedError') setResult('failure', 'Microphone permission denied');
    }
  };
  return dispose;
}
