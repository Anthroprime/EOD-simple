// Deterministic synthetic signal and device events; no hardware or learner audio.
export function syntheticMicrophone(win, { amplitude = .08 } = {}) {
  const BaseTarget = win.EventTarget || EventTarget, EventType = win.Event || Event;
  const track = new BaseTarget();
  Object.assign(track, { kind: 'audio', enabled: true, muted: false, readyState: 'live',
    getSettings: () => ({ deviceId: 'usb-mic', groupId: 'usb-group' }),
    stop() { this.readyState = 'ended'; } });
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const original = { AudioContext: win.AudioContext, setTimeout: win.setTimeout, clearTimeout: win.clearTimeout };
  let clock = 0, sequence = 0, closed = 0, disconnected = 0;
  const callbacks = new Map();
  const signal = { amplitude };
  win.setTimeout = (fn) => { callbacks.set(++sequence, fn); return sequence; };
  win.clearTimeout = id => callbacks.delete(id);
  win.AudioContext = class {
    state = 'running';
    createMediaStreamSource() { return { connect() {}, disconnect() { disconnected++; } }; }
    createAnalyser() {
      return { fftSize: 2048, getFloatTimeDomainData(values) {
        for (let i = 0; i < values.length; i++) values[i] = signal.amplitude * Math.sin(i * .12);
      }, disconnect() { disconnected++; } };
    }
    close() { this.state = 'closed'; closed++; return Promise.resolve(); }
  };
  return {
    stream, track, signal, now: () => clock, closed: () => closed, disconnected: () => disconnected,
    scheduled: () => callbacks.size,
    tick(ms) { for (let passed = 0; passed < ms; passed += 100) { clock += 100; const jobs = [...callbacks.values()]; callbacks.clear(); jobs.forEach(fn => fn()); } },
    event(name) { track.dispatchEvent(new EventType(name)); },
    restore() { win.AudioContext = original.AudioContext; win.setTimeout = original.setTimeout; win.clearTimeout = original.clearTimeout; callbacks.clear(); },
  };
}
