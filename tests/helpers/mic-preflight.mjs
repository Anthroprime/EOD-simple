// Minimal native-capture stand-in for entry workflow tests. Signal/quiet input
// is exercised separately by microphone-input and exam-mic-ui tests.
export function installPreflightCapture(win) {
  win.HTMLMediaElement.prototype.pause = function () {};
  win.URL.createObjectURL = () => 'blob:local-preflight';
  win.URL.revokeObjectURL = () => {};
  Object.defineProperty(win.navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] })
  } });
  win.MediaRecorder = class {
    static isTypeSupported() { return true; }
    constructor(stream, opts) { this.state = 'inactive'; this.mimeType = opts?.mimeType || 'audio/webm'; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new win.Blob(['local-test-audio'], { type: this.mimeType }) });
      this.onstop?.();
    }
  };
}

export async function confirmPreflight(view, win) {
  await view.querySelector('[data-mic-start]').onclick();
  view.querySelector('[data-mic-stop]').click();
  view.querySelector('[data-mic-player]').dispatchEvent(new win.Event('play'));
  const confirm = view.querySelector('[data-mic-confirm]');
  confirm.checked = true;
  confirm.dispatchEvent(new win.Event('change', { bubbles: true }));
}
