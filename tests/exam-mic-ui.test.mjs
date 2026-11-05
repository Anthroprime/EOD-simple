/**
 * Exam answer-screen UI test (jsdom).
 *
 * The reported bug: the microphone control was rendered only for questions the
 * stored row happened to flag, so the standard open questions late in the paper
 * (typically 7-10 of a 10-question allocation) showed a bare text box. These
 * tests drive the real `quizView` against a stubbed API and assert that an open
 * question always gets the recorder, that the recording is what unlocks
 * "Lock & continue", and that a browser without capture support is never
 * stranded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { JSDOM, SKIP } from './helpers/jsdom.mjs';
import { syntheticMicrophone } from './helpers/microphone.mjs';
import { confirmPreflight } from './helpers/mic-preflight.mjs';

const flush = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

/** A standard (non-spoken) open question, answer phase, mid-paper. */
function openQuestionPayload({ phase = 'answer', audio_required = true } = {}) {
  const q = {
    id: 'q7', competency_id: 'comp1', type: 'text', order: 6, points: 6,
    prompt: 'A streaming pipeline has grown from one million to one hundred million events a day. Redesign it.',
    help_text: '', options: [], difficulty: 'advanced', pin_first: false, audio_required,
  };
  return {
    assessment: { id: 'asm1', status: 'in_progress', started_at: null, submitted_at: null, role: { name: 'RSA', description: '' } },
    exam: {
      index: 6, total: 10, phase, remaining_ms: 58_000, server_now: new Date().toISOString(),
      budgets: { review_ms: 30_000, answer_ms: 60_000 }, integrity: {}, complete: false,
    },
    current_question: q,
    current_answer: null,
    competency: null,
    questions: [q],
    competencies: [],
    answers: {},
  };
}

function fakeRecorder(window) {
  // Emits a tiny real blob on stop(), i.e. a captured answer that fits storage.
  class FakeMediaRecorder extends window.EventTarget {
    static isTypeSupported(type) { return type.startsWith('audio/webm'); }
    constructor(stream, opts) {
      super();
      FakeMediaRecorder.created.push({ stream, opts, instance: this });
      this.state = 'inactive';
      this.mimeType = (opts && opts.mimeType) || 'audio/webm';
    }
    start() {
      this.state = 'recording';
      FakeMediaRecorder.started += 1;
    }
    stop() {
      this.state = 'inactive';
      const finish = () => {
        if (this.ondataavailable) this.ondataavailable({ data: new window.Blob(['abcd'], { type: 'audio/webm' }) });
        if (this.onstop) this.onstop();
        this.dispatchEvent(new window.Event('stop'));
      };
      if (FakeMediaRecorder.flushDelay) setTimeout(finish, FakeMediaRecorder.flushDelay);
      else finish();
    }
  }
  FakeMediaRecorder.created = [];
  FakeMediaRecorder.started = 0;
  return FakeMediaRecorder;
}

async function setupDom({ payload, capture = true, gate = false }) {
  const dom = new JSDOM(
    `<!doctype html><html><body>
       <div id="sidebar"></div><div id="topbar"></div><div id="nav-scrim"></div>
       <main id="view"></main><div id="modal-root"></div><div id="toast-root"></div>
     </body></html>`,
    { url: 'http://localhost:3000/#/assessments/asm1/quiz', pretendToBeVisual: true },
  );
  const { window } = dom;
  const calls = { next: [], phase: [], integrity: [], submit: [], paper: [] };
  window.HTMLMediaElement.prototype.pause = function () {};
  if (capture) {
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
    });
    window.MediaRecorder = fakeRecorder(window);
  }
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  globalThis.fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const path = String(url).replace(/^\/api/, '').split('?')[0];
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (path.includes('/meta/bootstrap')) return json({ pipelineStages: [], assessmentStatuses: [], userRoles: [], questionTypes: [], difficulties: [] });
    if (path.includes('/auth/me')) return json({ user: { id: 'u1', name: 'Rohit', role: 'candidate', email: '' }, candidate: { id: 'c1' } });
    if (path === '/candidate/assessments') return json({ assessments: [{ id: 'asm1', status: gate === true ? 'assigned' : gate || 'in_progress', question_count: 10, role_name: 'RSA' }] });
    if (path === '/candidate/assessments/asm1' && method === 'GET') { calls.paper.push({ takeover: String(url).includes('takeover=1') }); return json(payload()); }
    if (path.endsWith('/phase')) { calls.phase.push(body); return json({ phase: 'answer', remaining_ms: 60_000 }); }
    if (path.endsWith('/next')) { calls.next.push(body); return json({ complete: false, index: payload().exam.index + 1, total: 10 }); }
    if (path.endsWith('/submit')) { calls.submit.push(body); return json({ status: 'submitted' }); }
    if (path.endsWith('/integrity')) { calls.integrity.push(body); return json({ integrity: {}, events: [] }); }
    return json({});
  };

  // Node's global `navigator` is getter-only; the exam code reaches for the bare
  // global, so it has to be redefined rather than assigned.
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: window.navigator });
  // The session ticker is a live interval; stub it so the exam can be inspected
  // (and the test process can exit) without a running countdown.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};

  Object.assign(globalThis, {
    window,
    document: window.document,
    location: window.location,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    Blob: window.Blob,
    FileReader: window.FileReader,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    HashChangeEvent: window.HashChangeEvent,
  });
  window.localStorage.setItem('ecod.token', 'test-token');
  if (!gate) window.sessionStorage.setItem('ecod.exam.ack.asm1', 'microphone-confirmed-v1'); // skip the rules gate

  const app = await import('../public/js/app.js');
  app.state.user = { id: 'u1', name: 'Rohit', role: 'candidate', email: '' };
  app.state.meta = {
    pipelineStages: [],
    assessmentStatuses: [],
    questionTypes: [{ key: 'text', label: 'Open / scenario response' }],
    difficulties: ['advanced'],
  };
  return { dom, window, calls, restoreTicker: () => { globalThis.setInterval = realSetInterval; } };
}

function teardown(ctx) {
  ctx.window.document.dispatchEvent(new ctx.window.Event('ecod:view-unmount'));
  ctx.restoreTicker();
  ctx.dom.window.close();
  for (const k of ['window', 'document', 'location', 'localStorage', 'sessionStorage', 'Blob', 'FileReader', 'requestAnimationFrame', 'cancelAnimationFrame', 'HashChangeEvent', 'fetch']) {
    delete globalThis[k];
  }
}

test('an open question renders the mandatory microphone beside the optional text box', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload() });
  try {
    const candidate = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view');
    await candidate.quizView(view, { id: 'asm1' });
    await flush();

    assert.ok(view.querySelector('#rec-btn'), 'the record control is rendered for a standard open question');
    assert.equal(view.querySelector('[data-mic-device]'), null, 'microphone selection belongs before the test, never on each question');
    assert.ok(view.querySelector('[data-mic-level]'), 'live level monitoring remains on answer screens');
    assert.equal(view.querySelector('#rec-label').textContent.trim(), 'Record answer');
    assert.ok(view.querySelector('.exam-answer').classList.contains('has-audio'), 'the answer box uses the mic layout');
    assert.match(view.querySelector('#rec-state').textContent, /Required/i);
    assert.match(view.querySelector('#exam-ta').placeholder, /Optional notes/i, 'the text box is the optional channel');
    assert.equal(view.querySelector('#exam-ta').getAttribute('maxlength'), '20000',
      'the notes box is capped in the browser to match the server limit');
    assert.match(view.innerHTML, /Recorded answer required/, 'the question is labelled as microphone-required');
    assert.match(view.innerHTML, /Recording window · 1 min/);
  } finally {
    teardown(ctx);
  }
});

test('new exam entry waits for a spoken test and playback confirmation without starting the paper clock', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload(), gate: true });
  const f = syntheticMicrophone(ctx.window);
  ctx.window.URL.createObjectURL = () => 'blob:preflight'; ctx.window.URL.revokeObjectURL = () => {};
  ctx.window.navigator.mediaDevices.getUserMedia = async () => f.stream;
  const previousNow = Date.now; Date.now = () => 1_000_000 + f.now();
  try {
    const { quizView } = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view'); await quizView(view, { id: 'asm1' }); await flush();
    const ack = view.querySelector('#exam-ack'); ack.checked = true; ack.onchange();
    assert.equal(view.querySelector('#exam-enter').disabled, true);
    assert.equal(ctx.calls.paper.length, 0);
    await view.querySelector('[data-mic-start]').onclick(); f.tick(3000); view.querySelector('[data-mic-stop]').click();
    assert.equal(view.querySelector('#exam-enter').disabled, true, 'nonempty audio and signal detection alone do not pass');
    const confirm = view.querySelector('[data-mic-confirm]'); assert.equal(confirm.disabled, true);
    view.querySelector('[data-mic-player]').dispatchEvent(new ctx.window.Event('play'));
    confirm.checked = true; confirm.dispatchEvent(new ctx.window.Event('change'));
    assert.equal(view.querySelector('#exam-enter').disabled, false);
    await view.querySelector('#exam-enter').onclick();
    assert.equal(ctx.calls.paper.length, 1, 'only entry starts the paper'); assert.equal(f.closed(), 1);
    assert.ok(view.querySelector('#rec-btn'));
  } finally { teardown(ctx); Date.now = previousNow; f.restore(); }
});

test('a deliberate device takeover is preserved through the mandatory microphone gate', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload(), gate: 'in_progress' });
  ctx.window.URL.createObjectURL = () => 'blob:takeover-test'; ctx.window.URL.revokeObjectURL = () => {};
  try {
    const { quizView } = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view'); await quizView(view, { id: 'asm1', takeover: true });
    const ack = view.querySelector('#exam-ack'); ack.checked = true; ack.onchange();
    assert.equal(ctx.calls.paper.length, 0, 'taking over cannot skip the mandatory test');
    await confirmPreflight(view, ctx.window);
    await view.querySelector('#exam-enter').onclick();
    assert.deepEqual(ctx.calls.paper, [{ takeover: true }], 'the explicitly requested takeover reaches the server after confirmation');
  } finally { teardown(ctx); }
});

test('resuming in a fresh browser session requires a microphone test and explains the running deadline', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload(), gate: 'in_progress' });
  try {
    const { quizView } = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view'); await quizView(view, { id: 'asm1' });
    const ack = view.querySelector('#exam-ack'); ack.checked = true; ack.onchange();
    assert.equal(view.querySelector('#exam-enter').disabled, true);
    assert.match(view.textContent, /existing exam clock continues running/);
    await view.querySelector('#exam-enter').onclick();
    assert.equal(ctx.calls.paper.length, 0, 'rules acknowledgement cannot bypass the test on resume');
  } finally { teardown(ctx); }
});

test('an older rules-only acknowledgement cannot bypass the mandatory microphone test', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload(), gate: true });
  try {
    ctx.window.sessionStorage.setItem('ecod.exam.ack.asm1', '1');
    const { quizView } = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view'); await quizView(view, { id: 'asm1' });
    const ack = view.querySelector('#exam-ack'); ack.checked = true; ack.onchange();
    assert.equal(view.querySelector('#exam-enter').disabled, true);
    assert.ok(view.querySelector('[data-mic-start]'));
    assert.equal(ctx.calls.paper.length, 0);
  } finally { teardown(ctx); }
});

test('a browser without microphone capture cannot enter by acknowledging the rules', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload(), gate: true, capture: false });
  try {
    const { quizView } = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view'); await quizView(view, { id: 'asm1' });
    const ack = view.querySelector('#exam-ack'); ack.checked = true; ack.onchange();
    assert.equal(view.querySelector('#exam-enter').disabled, true);
    assert.match(view.textContent, /cannot enter without a microphone test/);
    await view.querySelector('#exam-enter').onclick();
    assert.equal(ctx.calls.paper.length, 0);
  } finally { teardown(ctx); }
});

test('denied microphone access keeps exam entry locked and never starts the paper', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload(), gate: true });
  ctx.window.navigator.mediaDevices.getUserMedia = async () => { throw Object.assign(new Error('Blocked'), { name: 'NotAllowedError' }); };
  try {
    const { quizView } = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view'); await quizView(view, { id: 'asm1' });
    const ack = view.querySelector('#exam-ack'); ack.checked = true; ack.onchange();
    await view.querySelector('[data-mic-start]').onclick();
    assert.match(view.querySelector('[data-mic-status]').textContent, /Allow access/);
    assert.equal(view.querySelector('#exam-enter').disabled, true);
    assert.equal(ctx.calls.paper.length, 0);
  } finally { teardown(ctx); }
});

test('quiet input warns live; a saved quiet clip needs playback and an explicit keep before manual locking', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload() });
  const f = syntheticMicrophone(ctx.window, { amplitude: .0002 });
  ctx.window.navigator.mediaDevices.getUserMedia = async () => f.stream;
  const previousNow = Date.now; Date.now = () => 1_000_000 + f.now();
  try {
    const { quizView } = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view'); await quizView(view, { id: 'asm1' }); await flush();
    await view.querySelector('#rec-btn').onclick(); f.tick(5000);
    assert.match(view.querySelector('[data-mic-health]').textContent, /very quiet/);
    assert.equal(view.querySelector('#exam-next').disabled, true);
    await view.querySelector('#rec-btn').onclick();
    assert.equal(view.querySelector('#audio-quality-warning').hidden, false);
    assert.equal(view.querySelector('#answer-audio-preview').hidden, false);
    await view.querySelector('#exam-next').onclick(); assert.equal(ctx.calls.next.length, 0);
    const keep = view.querySelector('#keep-question-audio'); assert.equal(keep.disabled, true);
    await keep.onclick(); assert.equal(ctx.calls.next.length, 0, 'cannot confirm before playback');
    view.querySelector('#answer-audio-preview').dispatchEvent(new ctx.window.Event('play'));
    await keep.onclick(); assert.equal(ctx.calls.next.length, 1);
    assert.ok(ctx.calls.next[0].answer.audio_b64 || ctx.calls.next[0].answer.audio_keep);
  } finally { teardown(ctx); Date.now = previousNow; f.restore(); }
});

test('time expiry still saves a quiet live recording instead of stranding the exam', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload() });
  const f = syntheticMicrophone(ctx.window, { amplitude: .0001 });
  ctx.window.navigator.mediaDevices.getUserMedia = async () => f.stream;
  const previousNow = Date.now; Date.now = () => 1_000_000 + f.now();
  try {
    const { quizView } = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view'); await quizView(view, { id: 'asm1' }); await flush();
    await view.querySelector('#rec-btn').onclick(); f.tick(5000);
    const next = view.querySelector('#exam-next'); next.dataset.force = '1'; await next.onclick();
    assert.equal(ctx.calls.next.length, 1); assert.ok(ctx.calls.next[0].answer.audio_b64);
    assert.equal(f.closed(), 1);
  } finally { teardown(ctx); Date.now = previousNow; f.restore(); }
});

test('an unexpected recorder stop finishes the final chunk and offers playback without another stop click', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload() });
  const f = syntheticMicrophone(ctx.window);
  ctx.window.navigator.mediaDevices.getUserMedia = async () => f.stream;
  const previousNow = Date.now; Date.now = () => 1_000_000 + f.now();
  try {
    const { quizView } = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view'); await quizView(view, { id: 'asm1' }); await flush();
    await view.querySelector('#rec-btn').onclick(); f.tick(3000);
    ctx.window.MediaRecorder.created.at(-1).instance.stop(); await flush();
    assert.equal(view.querySelector('#rec-label').textContent, 'Record answer');
    assert.equal(view.querySelector('#answer-audio-preview').hidden, false);
    assert.match(view.querySelector('#audio-quality-message').textContent, /ended unexpectedly/);
    assert.equal(ctx.calls.next.length, 0, 'an input failure must not lock or advance the answer');
    assert.equal(f.closed(), 1);
  } finally { teardown(ctx); Date.now = previousNow; f.restore(); }
});

test('muting or an unexpected recorder stop warns immediately and a fresh take resets the warning', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload() });
  const f = syntheticMicrophone(ctx.window);
  ctx.window.navigator.mediaDevices.getUserMedia = async () => f.stream;
  const previousNow = Date.now; Date.now = () => 1_000_000 + f.now();
  try {
    const { quizView } = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view'); await quizView(view, { id: 'asm1' }); await flush();
    await view.querySelector('#rec-btn').onclick(); f.tick(3000);
    f.track.muted = true; f.event('mute');
    assert.match(view.querySelector('[data-mic-health]').textContent, /interrupted or muted/);
    await view.querySelector('#rec-btn').onclick();
    assert.match(view.querySelector('#audio-quality-message').textContent, /muted or disconnected/);
    f.track.muted = false; f.track.readyState = 'live';
    await view.querySelector('#rec-btn').onclick(); f.tick(3000);
    await view.querySelector('#rec-btn').onclick();
    assert.equal(view.querySelector('#audio-quality-warning').hidden, true);
    assert.equal(view.querySelector('#exam-next').disabled, false);
  } finally { teardown(ctx); Date.now = previousNow; f.restore(); }
});

test('SAMA microphone capture still starts when optional speech recognition throws', { skip: SKIP }, async () => {
  const payload = openQuestionPayload();
  payload.assessment.role.name = 'Technology Risk Consultant - SAMA';
  const ctx = await setupDom({ payload: () => payload });
  ctx.window.SpeechRecognition = class { start() { throw new Error('Speech recognition service unavailable'); } };
  try {
    const candidate = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view');
    await candidate.quizView(view, { id: 'asm1' });
    await flush();
    await assert.doesNotReject(view.querySelector('#rec-btn').onclick());
    assert.equal(ctx.window.MediaRecorder.started, 1);
    await view.querySelector('#rec-btn').onclick();
    await view.querySelector('#exam-next').onclick();
    assert.ok(ctx.calls.next.at(-1)?.answer.audio_b64, 'actual audio survives transcription failure');
  } finally { teardown(ctx); }
});

test('SAMA stopping waits for a delayed final audio chunk before enabling the lock', { skip: SKIP }, async () => {
  const payload = openQuestionPayload();
  payload.assessment.role.name = 'Technology Risk Consultant - SAMA';
  const ctx = await setupDom({ payload: () => payload });
  ctx.window.MediaRecorder.flushDelay = 1200;
  try {
    const candidate = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view');
    await candidate.quizView(view, { id: 'asm1' });
    await flush();
    await view.querySelector('#rec-btn').onclick();
    await view.querySelector('#rec-btn').onclick();
    assert.equal(view.querySelector('#exam-next').disabled, false);
    await view.querySelector('#exam-next').onclick();
    assert.ok(ctx.calls.next.at(-1)?.answer.audio_b64, 'final chunk must be sent instead of reporting no recording');
  } finally { teardown(ctx); }
});

test('locking includes the final caption delivered after speech recognition stops', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload() });
  ctx.window.SpeechRecognition = class {
    start() {}
    stop() { setTimeout(() => {
      this.onresult?.({ results: [[{ transcript: 'The final spoken sentence.' }]] });
      this.onend?.();
    }, 70); }
  };
  try {
    const candidate = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view');
    await candidate.quizView(view, { id: 'asm1' });
    await flush();
    await view.querySelector('#rec-btn').onclick();
    await view.querySelector('#exam-next').onclick();
    assert.equal(ctx.calls.next[0].answer.transcript, 'The final spoken sentence.');
    assert.ok(ctx.calls.next[0].answer.audio_b64);
  } finally { await flush(90); teardown(ctx); }
});

test('a speech service failure remains explained after stopping and does not lose recorded audio', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload() });
  ctx.window.SpeechRecognition = class {
    start() { this.onerror?.({ error: 'network' }); }
    stop() { this.onend?.(); }
  };
  try {
    const candidate = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view');
    await candidate.quizView(view, { id: 'asm1' });
    await flush();
    await view.querySelector('#rec-btn').onclick();
    await view.querySelector('#rec-btn').onclick();
    assert.match(view.querySelector('#caption-status').textContent, /speech service could not be reached/);
    await view.querySelector('#exam-next').onclick();
    assert.ok(ctx.calls.next[0].answer.audio_b64);
    assert.equal(ctx.calls.next[0].answer.transcript, '');
  } finally { teardown(ctx); }
});

test('locking a live recording waits for its final chunk and ignores duplicate lock clicks', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload() });
  ctx.window.MediaRecorder.flushDelay = 1200;
  try {
    const candidate = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view');
    await candidate.quizView(view, { id: 'asm1' });
    await flush();
    await view.querySelector('#rec-btn').onclick();
    await flush(450);
    const next = view.querySelector('#exam-next');
    const pending = next.onclick();
    await next.onclick();
    assert.equal(ctx.calls.next.length, 0, 'locking must wait for audio');
    await pending;
    assert.equal(ctx.calls.next.length, 1, 'only one lock request');
    assert.ok(ctx.calls.next[0].answer.audio_b64);
  } finally { teardown(ctx); }
});

test('a restored transcript without audio cannot satisfy the recording requirement', { skip: SKIP }, async () => {
  const payload = openQuestionPayload();
  payload.current_answer = { text: '', transcript: 'Words without a saved recording', source: 'audio' };
  const ctx = await setupDom({ payload: () => payload });
  try {
    const candidate = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view');
    await candidate.quizView(view, { id: 'asm1' });
    await flush();
    assert.match(view.querySelector('#rec-state').textContent, /no audio recording is saved/i);
    assert.equal(view.querySelector('#exam-next').disabled, true);
  } finally { teardown(ctx); }
});

test('permission denial when re-recording preserves the previously saved audio', { skip: SKIP }, async () => {
  const payload = openQuestionPayload();
  payload.current_answer = { text: '', transcript: '', audio_ref: 'saved-clip', audio_mime: 'audio/webm' };
  const ctx = await setupDom({ payload: () => payload });
  ctx.window.navigator.mediaDevices.getUserMedia = async () => { throw new Error('Permission denied'); };
  try {
    const candidate = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view');
    await candidate.quizView(view, { id: 'asm1' });
    await flush();
    await view.querySelector('#rec-btn').onclick();
    assert.match(view.querySelector('#rec-state').textContent, /Microphone unavailable/);
    assert.equal(view.querySelector('#exam-next').disabled, false);
    await view.querySelector('#exam-next').onclick();
    assert.equal(ctx.calls.next[0].answer.audio_keep, true);
  } finally { teardown(ctx); }
});

test('a microphone permission request resolving after leaving the exam releases the stream', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload() });
  let grant;
  let stopped = 0;
  ctx.window.navigator.mediaDevices.getUserMedia = () => new Promise((resolve) => { grant = resolve; });
  try {
    const candidate = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view');
    await candidate.quizView(view, { id: 'asm1' });
    await flush();
    const pending = view.querySelector('#rec-btn').onclick();
    document.dispatchEvent(new ctx.window.Event('ecod:view-unmount'));
    grant({ getTracks: () => [{ stop() { stopped++; } }] });
    await pending;
    assert.equal(stopped, 1);
    assert.equal(ctx.window.MediaRecorder.started, 0);
  } finally { teardown(ctx); }
});

test('a replacement recording does not submit the previous take\'s transcript', { skip: SKIP }, async () => {
  const payload = openQuestionPayload();
  payload.current_answer = { text: '', transcript: 'Previous take', source: 'audio', audio_ref: 'old-clip' };
  const ctx = await setupDom({ payload: () => payload });
  try {
    const candidate = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view');
    await candidate.quizView(view, { id: 'asm1' });
    await flush();
    await view.querySelector('#rec-btn').onclick();
    await view.querySelector('#rec-btn').onclick();
    await view.querySelector('#exam-next').onclick();
    assert.equal(ctx.calls.next[0].answer.transcript, '', 'old transcript must not describe a new audio take');
    assert.ok(ctx.calls.next[0].answer.audio_b64);
  } finally { teardown(ctx); }
});

test('the lock button stays disabled until the candidate has actually spoken', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload() });
  try {
    const candidate = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view');
    await candidate.quizView(view, { id: 'asm1' });
    await flush();

    const next = view.querySelector('#exam-next');
    const ta = view.querySelector('#exam-ta');
    assert.equal(next.disabled, true, 'a typed-only answer cannot lock an open question');
    ta.value = 'Typed notes without a recording.';
    ta.oninput();
    assert.equal(next.disabled, true, 'typing does not satisfy the microphone requirement');
    assert.match(next.title, /Record your spoken answer/);

    view.querySelector('#rec-btn').click();
    await flush(80);
    assert.equal(ctx.window.MediaRecorder.started, 1, 'record was started through the browser recorder');
    assert.equal(ctx.window.MediaRecorder.created.at(-1).opts.audioBitsPerSecond > 0, true, 'a speech-sized recording profile is requested');

    view.querySelector('#rec-btn').click(); // stop -> the clip is captured
    await flush(80);
    assert.match(view.querySelector('#rec-state').textContent, /Audio captured/i);
    assert.equal(next.disabled, false, 'a captured recording unlocks the exam');

    next.click();
    await flush(80);
    const sent = ctx.calls.next[ctx.calls.next.length - 1];
    assert.ok(sent.answer.audio_b64, 'the recording is what gets submitted');
    assert.equal(sent.answer.text, 'Typed notes without a recording.', 'the optional notes travel with it');
  } finally {
    teardown(ctx);
  }
});

test('the review window tells the candidate to record and offers a microphone pre-check', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload({ phase: 'review' }) });
  try {
    const candidate = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view');
    await candidate.quizView(view, { id: 'asm1' });
    await flush();

    assert.ok(view.querySelector('#mic-check'), 'the candidate can grant microphone access before the timer starts');
    assert.match(view.querySelector('.exam-review').textContent, /record your spoken answer/i);
    assert.match(view.querySelector('.exam-review').textContent, /microphone is required/i);
    view.querySelector('#mic-check').click();
    await flush(40);
    assert.match(view.querySelector('#mic-check-state').textContent, /Microphone access granted/i);

    const next = view.querySelector('#exam-next');
    assert.match(next.textContent, /Start answering/);
    next.click();
    await flush(60);
    assert.equal(ctx.calls.phase.at(-1)?.phase, 'answer', 'the review window hands over to the answer phase');
  } finally {
    teardown(ctx);
  }
});

test('multi-select exam copy states that any incorrect choice scores zero', { skip: SKIP }, async () => {
  const q = {
    id: 'q3', competency_id: 'comp1', type: 'mcq_multi', order: 2, points: 4,
    prompt: 'Which statements are true?',
    help_text: '', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
    difficulty: 'foundation', pin_first: false, audio_required: false,
  };
  const payload = () => ({
    assessment: { id: 'asm1', status: 'in_progress', started_at: null, submitted_at: null, role: { name: 'RSA', description: '' } },
    exam: {
      index: 2, total: 10, phase: 'answer', remaining_ms: 28_000, server_now: new Date().toISOString(),
      budgets: { review_ms: 0, answer_ms: 30_000 }, integrity: {}, complete: false,
    },
    current_question: q, current_answer: null, competency: null, questions: [q], competencies: [], answers: {},
  });
  const ctx = await setupDom({ payload });
  try {
    const candidate = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view');
    await candidate.quizView(view, { id: 'asm1' });
    await flush();

    assert.equal(view.querySelectorAll('input[type=checkbox]').length, 3, 'multi-select renders checkboxes');
    assert.match(view.textContent, /no partial credit/i);
    assert.match(view.textContent, /any incorrect choice scores this question at zero/i);
  } finally {
    teardown(ctx);
  }
});

test('a browser that cannot capture audio is never hard-locked by the requirement', { skip: SKIP }, async () => {
  const ctx = await setupDom({ payload: () => openQuestionPayload(), capture: false });
  try {
    assert.equal(ctx.window.MediaRecorder, undefined, 'this browser has no recorder');
    const candidate = await import('../public/js/views/candidate.js');
    const view = document.getElementById('view');
    await candidate.quizView(view, { id: 'asm1' });
    await flush();

    assert.match(view.querySelector('.exam-mic-note').textContent, /cannot capture microphone audio/i);
    const ta = view.querySelector('#exam-ta');
    ta.value = 'Fallback typed answer for a browser without microphone support.';
    ta.oninput();
    const next = view.querySelector('#exam-next');
    assert.equal(next.disabled, false, 'the candidate can still submit instead of timing out');
    next.click();
    await flush(60);
    const sent = ctx.calls.next.at(-1);
    assert.match(sent.answer.text, /Fallback typed answer/, 'the answer is preserved, not discarded');
  } finally {
    teardown(ctx);
  }
});
