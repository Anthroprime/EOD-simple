import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monitorMicrophone, recordingQualityWarning, openMicrophone, selectedMicrophone, selectMicrophone } from '../public/js/microphone-input.js';
import { syntheticMicrophone } from './helpers/microphone.mjs';

test('near-silent input like the reported files never passes as healthy input', () => {
  const win = {}; const f = syntheticMicrophone(win, { amplitude: .0002 });
  const monitor = monitorMicrophone(win, f.stream, { now: f.now });
  f.tick(5000);
  assert.equal(monitor.summary().state, 'quiet');
  assert.equal(monitor.summary().inputMs, 0);
  assert.match(recordingQualityWarning(monitor.summary()), /very little audible input/);
  monitor.dispose(); f.restore();
});

test('device-start clicks do not count as sustained voice-level input', () => {
  const win = {}; const f = syntheticMicrophone(win, { amplitude: .8 });
  const monitor = monitorMicrophone(win, f.stream, { now: f.now });
  f.tick(200); f.signal.amplitude = .0001; f.tick(4000);
  assert.equal(monitor.summary().inputMs, 0);
  assert.equal(monitor.summary().state, 'quiet');
  monitor.dispose(); f.restore();
});

test('sustained input is detected; a thinking pause warns without invalidating earlier audio', () => {
  const win = {}; const f = syntheticMicrophone(win);
  const monitor = monitorMicrophone(win, f.stream, { now: f.now });
  f.tick(3000); assert.equal(monitor.summary().state, 'good');
  assert.equal(recordingQualityWarning(monitor.summary()), '');
  f.signal.amplitude = .0001; f.tick(8500);
  assert.equal(monitor.summary().state, 'paused');
  assert.equal(recordingQualityWarning(monitor.summary()), '', 'a pause is not a failed answer');
  monitor.dispose(); assert.equal(f.closed(), 1); assert.equal(f.disconnected(), 2);
  assert.equal(f.track.readyState, 'live', 'the caller owns the stream');
  assert.equal(f.scheduled(), 0); monitor.dispose(); assert.equal(f.closed(), 1); f.restore();
});

test('mute, disabled tracks and disconnects are detected and survive recovery in the take summary', () => {
  const win = {}; const f = syntheticMicrophone(win); const states = [];
  const monitor = monitorMicrophone(win, f.stream, { now: f.now, onUpdate: s => states.push(s.state) });
  f.tick(3000); f.track.muted = true; f.event('mute');
  assert.equal(states.at(-1), 'muted'); f.tick(500);
  assert.equal(monitor.summary().interruptions, 1);
  f.track.muted = false; f.event('unmute'); f.tick(500);
  assert.equal(monitor.summary().state, 'good');
  assert.match(recordingQualityWarning(monitor.summary()), /muted or disconnected/);
  f.track.enabled = false; f.tick(100); assert.equal(monitor.summary().state, 'muted');
  f.track.readyState = 'ended'; f.event('ended'); assert.equal(states.at(-1), 'ended');
  monitor.dispose(); f.restore();
});

test('clipping and very short takes produce review warnings, not speech claims', () => {
  const win = {}; const f = syntheticMicrophone(win, { amplitude: 1 });
  const monitor = monitorMicrophone(win, f.stream, { now: f.now });
  f.tick(200); assert.match(recordingQualityWarning(monitor.summary()), /very short/);
  f.tick(3000); assert.match(recordingQualityWarning(monitor.summary()), /distorted/);
  monitor.dispose(); f.restore();
});

test('browsers without Web Audio retain capture and require manual playback; no monitor timer leaks', () => {
  const track = new EventTarget(); Object.assign(track, { enabled: true, readyState: 'live' });
  const monitor = monitorMicrophone({}, { getTracks: () => [track] });
  assert.equal(monitor.summary().available, false); assert.equal(monitor.summary().state, 'unavailable');
  assert.equal(recordingQualityWarning(monitor.summary()), ''); monitor.dispose();
});

test('input choice is pinned to a device, including when session storage is blocked', async () => {
  const requests = [];
  const stream = { getAudioTracks: () => [{ getSettings: () => ({ deviceId: 'usb-mic' }) }] };
  const win = { navigator: { mediaDevices: { getUserMedia: async c => { requests.push(c); return stream; } } } };
  await openMicrophone(win); assert.equal(selectedMicrophone(win), 'usb-mic');
  await openMicrophone(win); assert.deepEqual(requests[1].audio.deviceId, { exact: 'usb-mic' });
  selectMicrophone(win, 'headset');
  win.navigator.mediaDevices.getUserMedia = async c => { assert.equal(c.audio.deviceId.exact, 'headset'); throw Object.assign(new Error(), { name: 'NotFoundError' }); };
  await assert.rejects(openMicrophone(win), { name: 'NotFoundError' });
  assert.equal(selectedMicrophone(win), 'headset', 'never silently fall back to a different mic');
});

test('default device aliases resolve to the same physical microphone', async () => {
  const win = { navigator: { mediaDevices: {
    getUserMedia: async () => ({ getAudioTracks: () => [{ getSettings: () => ({ deviceId: 'default', groupId: 'g' }) }] }),
    enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'default', groupId: 'g' }, { kind: 'audioinput', deviceId: 'physical', groupId: 'g' }],
  } } };
  await openMicrophone(win); assert.equal(selectedMicrophone(win), 'physical');
});
