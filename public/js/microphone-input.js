// Input selection and signal checks stay on this device. Signal != intelligible speech.
const DEVICE_KEY = 'ecod.microphone.device';
const memorySelection = new WeakMap();
export const QUIET_INPUT_DB = -50;
export const MIN_INPUT_MS = 800;

export function selectedMicrophone(win) {
  if (memorySelection.has(win)) return memorySelection.get(win);
  try { return win.sessionStorage?.getItem(DEVICE_KEY) || ''; } catch { return ''; }
}
export function selectMicrophone(win, id) {
  memorySelection.set(win, id || '');
  try { if (id) win.sessionStorage?.setItem(DEVICE_KEY, id); else win.sessionStorage?.removeItem(DEVICE_KEY); } catch { /* session storage can be disabled */ }
}
export async function openMicrophone(win) {
  const id = selectedMicrophone(win);
  const stream = await win.navigator.mediaDevices.getUserMedia({ audio: {
    channelCount: { ideal: 1 }, ...(id ? { deviceId: { exact: id } } : {}),
  } });
  // Pin the physical device after the first grant rather than following OS default changes.
  try {
    const settings = stream.getAudioTracks?.()[0]?.getSettings?.() || {};
    let actual = settings.deviceId;
    if (['default', 'communications'].includes(actual)) {
      const devices = await win.navigator.mediaDevices.enumerateDevices?.() || [];
      actual = settings.groupId && devices.find(d => d.kind === 'audioinput' && d.groupId === settings.groupId
        && !['default', 'communications'].includes(d.deviceId))?.deviceId;
    }
    if (actual) selectMicrophone(win, actual);
  } catch { /* retaining a working stream is more important than device naming */ }
  return stream;
}

export function microphoneInputMarkup({ selectable = true } = {}) {
  return `<div class="microphone-input" data-mic-input>
    ${selectable ? '<label class="mic-input-picker">Microphone<select data-mic-device aria-label="Microphone"><option value="">System default microphone</option></select></label>' : '<p class="mic-device-name small muted" data-mic-device-name>Selected microphone</p>'}
    <div class="mic-level-row"><meter data-mic-level min="0" max="100" low="35" high="90" optimum="65" value="0" aria-label="Microphone input level"></meter><span data-mic-level-text>Not listening</span></div>
    <p class="mic-input-status small muted" data-mic-health role="status">${selectable ? 'Select a microphone, then record a short sentence.' : 'Press record and watch your input level.'}</p>
  </div>`;
}

export function wireMicrophoneInput(root, { win = window, onChange = () => {} } = {}) {
  const picker = root.querySelector('[data-mic-device]');
  const deviceName = root.querySelector('[data-mic-device-name]');
  const meter = root.querySelector('[data-mic-level]');
  const level = root.querySelector('[data-mic-level-text]');
  const status = root.querySelector('[data-mic-health]');
  const media = win.navigator?.mediaDevices;
  let disposed = false, refreshId = 0;
  const refresh = async () => {
    const request = ++refreshId;
    let devices;
    try { devices = await media?.enumerateDevices?.(); } catch { return; }
    if (disposed || request !== refreshId || !devices) return;
    const chosen = selectedMicrophone(win);
    const inputs = devices.filter(d => d.kind === 'audioinput' && !['default', 'communications'].includes(d.deviceId));
    if (!picker) {
      const name = inputs.find(d => d.deviceId === chosen)?.label || (chosen ? 'Selected microphone' : 'System microphone');
      deviceName.textContent = name; deviceName.title = name;
      return;
    }
    picker.replaceChildren();
    const option = (value, text) => { const o = root.ownerDocument.createElement('option'); o.value = value; o.textContent = text; picker.append(o); };
    option('', 'System default microphone');
    inputs.forEach((d, i) => option(d.deviceId, d.label || `Microphone ${i + 1} — allow access to see its name`));
    if (chosen && !inputs.some(d => d.deviceId === chosen)) option(chosen, 'Selected microphone unavailable — choose another');
    picker.value = chosen;
  };
  const deviceChange = async () => {
    await refresh();
    if (!disposed) onChange('devices');
  };
  if (picker) picker.onchange = () => { selectMicrophone(win, picker.value); onChange('selection'); };
  media?.addEventListener?.('devicechange', deviceChange);
  refresh();
  let lastMessage = '';
  return {
    refresh,
    setRecording(active) {
      if (picker) picker.disabled = active;
      meter.setAttribute('aria-label', active ? 'Live microphone input level' : 'Last recorded microphone input level');
      if (!active && /dBFS$/.test(level.textContent) && !level.textContent.startsWith('Last:')) level.textContent = `Last: ${level.textContent}`;
    },
    show(s) {
      if (disposed) return;
      root.dataset.state = s.state;
      meter.value = Math.max(0, Math.min(100, (s.db + 80) / 80 * 100));
      level.textContent = s.available && Number.isFinite(s.db) ? `${Math.round(s.db)} dBFS` : 'Level check unavailable';
      const messages = {
        checking: 'Speak a short sentence. Checking microphone input…',
        good: 'Input detected. The level meter checks sound, not the words you say.',
        quiet: picker ? 'Input is very quiet. Speak closer or stop and select another microphone.' : 'Input is very quiet. Speak closer or check your microphone input volume.',
        paused: 'No input detected recently. If you are speaking, stop and check your microphone.',
        muted: 'Microphone input is interrupted or muted. Stop and check your device.',
        ended: picker ? 'Microphone disconnected. Stop, choose a connected input and record again.' : 'Microphone disconnected. Reconnect your selected input and record again.',
        clipped: 'Input is too loud. Move back or lower the microphone input volume.',
        unavailable: 'Automatic level checking is unavailable. Listen to the recording before confirming it.',
      };
      if (lastMessage !== messages[s.state]) { lastMessage = messages[s.state]; status.textContent = lastMessage; }
    },
    dispose() { disposed = true; media?.removeEventListener?.('devicechange', deviceChange); if (picker) picker.onchange = null; },
  };
}

/** Non-invasive Web Audio tap: never connects the microphone to speakers. */
export function monitorMicrophone(win, stream, { onUpdate = () => {}, now = () => Date.now() } = {}) {
  const tracks = stream.getAudioTracks?.() || stream.getTracks?.() || [];
  let context, source, analyser, timer, disposed = false, monitoring = false;
  let measuredMs = 0, inputMs = 0, clippedMs = 0, interruptions = 0, db = -100;
  const started = now();
  let previous = started, lastInput = started, previousInterrupted = false;
  const state = () => {
    if (tracks.some(t => t.readyState === 'ended')) return 'ended';
    if (tracks.some(t => t.muted || t.enabled === false)) return 'muted';
    if (!monitoring || context?.state === 'suspended') return 'unavailable';
    if (clippedMs >= 500 && db > -6) return 'clipped';
    if (inputMs < MIN_INPUT_MS) return now() - started >= 4000 ? 'quiet' : 'checking';
    return now() - lastInput >= 8000 ? 'paused' : 'good';
  };
  const summary = () => ({ available: monitoring, measuredMs, inputMs, clippedMs, interruptions, db, state: state() });
  const publish = () => {
    if (disposed) return;
    const interrupted = tracks.some(t => t.readyState === 'ended' || t.muted || t.enabled === false);
    if (interrupted && !previousInterrupted) interruptions++;
    previousInterrupted = interrupted;
    onUpdate(summary());
  };
  const sample = () => {
    if (disposed) return;
    const time = now(), delta = Math.max(0, Math.min(250, time - previous)); previous = time;
    if (analyser && context.state === 'running') {
      try {
        const values = new Float32Array(analyser.fftSize);
        if (analyser.getFloatTimeDomainData) analyser.getFloatTimeDomainData(values);
        else {
          const bytes = new Uint8Array(values.length); analyser.getByteTimeDomainData(bytes);
          for (let i = 0; i < values.length; i++) values[i] = (bytes[i] - 128) / 128;
        }
        let squares = 0, peak = 0;
        for (const value of values) { squares += value * value; peak = Math.max(peak, Math.abs(value)); }
        db = 20 * Math.log10(Math.max(1e-6, Math.sqrt(squares / values.length)));
        monitoring = true;
        const usable = !tracks.some(t => t.readyState === 'ended' || t.muted || t.enabled === false);
        // Ignore device-start clicks; require sustained input, not a single peak.
        if (usable && time - started >= 500) {
          measuredMs += delta;
          if (db >= QUIET_INPUT_DB) { inputMs += delta; lastInput = time; }
          if (peak >= .98) clippedMs += delta;
        }
      } catch { monitoring = false; }
    }
    publish();
    if (analyser) timer = (win.setTimeout?.bind(win) || setTimeout)(sample, 100);
  };
  const changed = () => publish();
  tracks.forEach(t => ['mute', 'unmute', 'ended'].forEach(event => t.addEventListener?.(event, changed)));
  try {
    const Ctor = win.AudioContext || win.webkitAudioContext;
    if (Ctor) {
      context = new Ctor();
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser(); analyser.fftSize = 2048;
      source.connect(analyser);
      if (context.state === 'suspended') Promise.resolve(context.resume()).catch(() => {});
    }
  } catch { /* capture remains usable with manual playback confirmation */ }
  sample();
  return {
    summary,
    dispose() {
      if (disposed) return;
      disposed = true; (win.clearTimeout?.bind(win) || clearTimeout)(timer);
      tracks.forEach(t => ['mute', 'unmute', 'ended'].forEach(event => t.removeEventListener?.(event, changed)));
      try { source?.disconnect(); analyser?.disconnect(); } catch { /* releasing */ }
      try { Promise.resolve(context?.close()).catch(() => {}); } catch { /* releasing */ }
    },
  };
}

export function recordingQualityWarning(summary) {
  if (!summary) return '';
  if (summary.interruptions) return 'The microphone was muted or disconnected during this recording. Listen to the saved audio or record again.';
  if (summary.available && summary.measuredMs < 1500) return 'This recording is very short. Record a complete sentence, then check playback.';
  if (summary.available && summary.measuredMs >= 1500 && summary.inputMs < MIN_INPUT_MS)
    return 'This recording had very little audible input. Check playback and your selected microphone before continuing.';
  if (summary.clippedMs >= 500) return 'The input was very loud and may be distorted. Check playback or record again.';
  return '';
}
