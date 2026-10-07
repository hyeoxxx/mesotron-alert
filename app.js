'use strict';

const $ = (id) => document.getElementById(id);

// ───────── 설정 ─────────
const DEFAULTS = {
  sound: 'retro', volume: 60, repeat: 3,
  tts: false, ttsText: '코인 먹어!',
  notify: true, flash: true,
  threshold: 0.78, interval: 500,
  scale: 'auto', lockedScale: null,
  cooldown: 8, preview: true, roi: null,
};
const STORE_KEY = 'mesotron-alert:v1';
let cfg = loadCfg();

function loadCfg() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveCfg() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch { /* 저장 불가 환경 */ }
}

function bindRange(id, key, fmt) {
  const el = $(id), out = $('v' + id.replace('opt', ''));
  const show = () => { if (out) out.textContent = fmt(cfg[key]); };
  el.value = cfg[key];
  show();
  el.addEventListener('input', () => {
    cfg[key] = +el.value; show(); saveCfg();
    if (key === 'interval' && running) worker.postMessage({ type: 'start', interval: cfg.interval });
  });
}
function bindCheck(id, key, onChange) {
  const el = $(id);
  el.checked = !!cfg[key];
  el.addEventListener('change', () => { cfg[key] = el.checked; saveCfg(); onChange && onChange(el.checked); });
}
function bindSelect(id, key, onChange) {
  const el = $(id);
  el.value = String(cfg[key]);
  el.addEventListener('change', () => { cfg[key] = el.value; saveCfg(); onChange && onChange(el.value); });
}

bindRange('optVolume', 'volume', (v) => v + '%');
bindRange('optRepeat', 'repeat', (v) => v + '회');
bindRange('optThreshold', 'threshold', (v) => v.toFixed(2));
bindRange('optInterval', 'interval', (v) => (v / 1000).toFixed(1) + '초');
bindRange('optCooldown', 'cooldown', (v) => v + '초');
bindSelect('optSound', 'sound');
bindSelect('optScale', 'scale', () => { cfg.lockedScale = null; saveCfg(); renderLock(); });
bindCheck('optTts', 'tts');
bindCheck('optNotify', 'notify', (on) => { if (on) askNotify(); });
bindCheck('optFlash', 'flash');
bindCheck('optPreview', 'preview', (on) => { if (!on) clearPreview(); });
$('optTtsText').value = cfg.ttsText;
$('optTtsText').addEventListener('input', (e) => { cfg.ttsText = e.target.value; saveCfg(); });
$('btnReset').addEventListener('click', () => {
  if (!confirm('설정을 기본값으로 되돌릴까요?')) return;
  try { localStorage.removeItem(STORE_KEY); } catch { }
  location.reload();
});

function renderLock() {
  const el = $('lockInfo');
  if (cfg.scale === 'auto' && cfg.lockedScale) {
    el.innerHTML = `자동 감지된 배율 <b>${Math.round(cfg.lockedScale * 100)}%</b>로 고정됨 · <a href="#" id="unlock">다시 찾기</a>`;
    $('unlock').onclick = (e) => { e.preventDefault(); cfg.lockedScale = null; saveCfg(); renderLock(); };
  } else if (cfg.scale === 'auto') {
    el.textContent = '팝업을 처음 찾으면 그 배율로 고정해서 더 빨리 검사해요.';
  } else el.textContent = '';
}
renderLock();

// ───────── 소리 ─────────
let actx = null;
function audio() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
  return actx;
}

const SOUNDS = {
  // [주파수, 시작(초), 길이(초), 파형]
  beep: [[880, 0, 0.18, 'square'], [880, 0.25, 0.18, 'square']],
  alarm: [[960, 0, 0.12, 'sawtooth'], [720, 0.13, 0.12, 'sawtooth'], [960, 0.26, 0.12, 'sawtooth'], [720, 0.39, 0.12, 'sawtooth']],
  chime: [[1046.5, 0, 0.5, 'sine'], [1318.5, 0.15, 0.5, 'sine'], [1568, 0.3, 0.7, 'sine']],
  ding: [[1760, 0, 0.6, 'triangle']],
  retro: [[988, 0, 0.08, 'square'], [1319, 0.08, 0.35, 'square']],
  soft: [[523, 0, 0.35, 'sine'], [659, 0.18, 0.35, 'sine'], [784, 0.36, 0.5, 'sine']],
};
const SOUND_LEN = (k) => Math.max(...SOUNDS[k].map(([, s, d]) => s + d));

function playOnce(kind, at) {
  const ctx = audio();
  const vol = (cfg.volume / 100) * 0.5;
  for (const [f, s, d, type] of SOUNDS[kind]) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.value = f;
    const t = at + s;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + d + 0.02);
  }
}

function playAlarm() {
  if (cfg.volume > 0) {
    const ctx = audio();
    const gap = SOUND_LEN(cfg.sound) + 0.25;
    for (let i = 0; i < cfg.repeat; i++) playOnce(cfg.sound, ctx.currentTime + 0.05 + i * gap);
  }
  if (cfg.tts && 'speechSynthesis' in window && cfg.ttsText.trim()) {
    const u = new SpeechSynthesisUtterance(cfg.ttsText);
    u.lang = 'ko-KR'; u.volume = Math.min(1, cfg.volume / 100 + 0.2);
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }
}

// ───────── 알림 ─────────
function askNotify() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}
function notify() {
  if (!cfg.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification('🪙 이벤트 코인 타이밍!', {
      body: 'Collect M-Force Points! 팝업이 떴어요.',
      tag: 'mesotron', renotify: true, silent: true,
    });
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(() => n.close(), 8000);
  } catch { /* 일부 환경은 페이지 알림 미지원 */ }
}

const BASE_TITLE = document.title;
let flashTimer = null;
function flashTitle(on) {
  clearInterval(flashTimer);
  document.title = BASE_TITLE;
  if (!on || !cfg.flash) return;
  let k = 0;
  flashTimer = setInterval(() => { document.title = (k++ % 2) ? BASE_TITLE : '🪙🪙 코인 획득! 🪙🪙'; }, 600);
}

// ───────── 상태 표시 ─────────
let alertCount = 0;
function setStatus(kind, text) {
  $('statusIcon').className = 'dot ' + (kind || '');
  $('statusText').textContent = text;
  $('status').classList.toggle('hit', kind === 'hit');
  const b = $('badge');
  b.className = 'badge ' + (kind === 'hit' ? 'hit' : running ? 'run' : 'idle');
  b.textContent = kind === 'hit' ? '코인 획득!' : running ? '감시 중' : '대기 중';
  updatePip(kind, text);
}

// ───────── 미리보기 / 영역 지정 ─────────
const pv = $('preview'), pctx = pv.getContext('2d');
let lastFrameSize = null;

function drawPreview(src, w, h) {
  if (!cfg.preview && !testing) return;
  const W = Math.min(960, w), H = Math.round(h * W / w);
  if (pv.width !== W || pv.height !== H) { pv.width = W; pv.height = H; }
  pctx.drawImage(src, 0, 0, W, H);
  $('previewEmpty').hidden = true;
  drawRoi();
}
function clearPreview() {
  pctx.clearRect(0, 0, pv.width, pv.height);
  $('previewEmpty').hidden = false;
}
function drawBox(res) {
  if ((!cfg.preview && !testing) || !res.best || !res.best.box) return;
  const k = pv.width / res.width, b = res.best.box;
  pctx.lineWidth = 3;
  pctx.strokeStyle = res.found ? '#f43f5e' : 'rgba(251,191,36,.8)';
  pctx.strokeRect(b.x * k - 3, b.y * k - 3, b.w * k + 6, b.h * k + 6);
  pctx.font = 'bold 14px sans-serif';
  pctx.fillStyle = pctx.strokeStyle;
  pctx.fillText((res.found ? '발견 ' : '후보 ') + res.best.score.toFixed(2), b.x * k, Math.max(14, b.y * k - 8));
}
function drawRoi() {
  const r = dragRect || cfg.roi;
  if (!r) return;
  pctx.save();
  pctx.strokeStyle = '#22d3ee'; pctx.setLineDash([6, 4]); pctx.lineWidth = 2;
  pctx.strokeRect(r.x * pv.width, r.y * pv.height, r.w * pv.width, r.h * pv.height);
  pctx.restore();
}

let roiMode = false, dragStart = null, dragRect = null;
function updateRoiButtons() {
  $('btnRoiClear').hidden = !cfg.roi;
  $('btnRoi').classList.toggle('on', roiMode);
  pv.classList.toggle('roi-mode', roiMode);
}
$('btnRoi').addEventListener('click', () => {
  if ($('previewEmpty').hidden === false) { alert('먼저 캡처를 시작하거나 테스트 이미지를 불러오세요.'); return; }
  roiMode = !roiMode; updateRoiButtons();
});
$('btnRoiClear').addEventListener('click', () => { cfg.roi = null; saveCfg(); updateRoiButtons(); });
function relPos(e) {
  const r = pv.getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
}
pv.addEventListener('pointerdown', (e) => { if (!roiMode) return; dragStart = relPos(e); pv.setPointerCapture(e.pointerId); });
pv.addEventListener('pointermove', (e) => {
  if (!dragStart) return;
  const p = relPos(e);
  dragRect = { x: Math.min(p.x, dragStart.x), y: Math.min(p.y, dragStart.y), w: Math.abs(p.x - dragStart.x), h: Math.abs(p.y - dragStart.y) };
  if (testBitmap) { drawPreview(testBitmap, testBitmap.width, testBitmap.height); }
});
pv.addEventListener('pointerup', () => {
  if (!dragStart) return;
  if (dragRect && dragRect.w > 0.03 && dragRect.h > 0.02) { cfg.roi = dragRect; saveCfg(); }
  dragStart = null; dragRect = null; roiMode = false; updateRoiButtons();
  if (testBitmap) drawPreview(testBitmap, testBitmap.width, testBitmap.height);
});
updateRoiButtons();

// ───────── 로그 ─────────
function addLog(res, thumb) {
  const ul = $('log');
  ul.querySelector('.empty')?.remove();
  const li = document.createElement('li');
  const t = new Date().toLocaleTimeString('ko-KR', { hour12: false });
  li.innerHTML = `${thumb ? `<img src="${thumb}" alt="">` : ''}<div><div class="t">${t}</div><div class="s">일치도 ${res.best.score.toFixed(2)} · 배율 ${Math.round(res.best.scale * 100)}%</div></div>`;
  ul.prepend(li);
  while (ul.children.length > 50) ul.lastChild.remove();
}
$('btnClearLog').addEventListener('click', () => { $('log').innerHTML = '<li class="empty">아직 기록이 없어요.</li>'; });

function thumbOf(res) {
  try {
    const k = pv.width / res.width, b = res.best.box;
    const pad = 20, sx = Math.max(0, b.x * k - pad * 2), sy = Math.max(0, b.y * k - pad * 2);
    const sw = Math.min(pv.width - sx, b.w * k + pad * 4), sh = Math.min(pv.height - sy, b.h * k + pad * 3);
    const c = document.createElement('canvas'); c.width = sw; c.height = sh;
    c.getContext('2d').drawImage(pv, sx, sy, sw, sh, 0, 0, sw, sh);
    return c.toDataURL('image/jpeg', 0.7);
  } catch { return null; }
}

// ───────── 워커 ─────────
const worker = new Worker('detector.worker.js');
let workerReady = false, frameId = 0, inFlight = false;
worker.postMessage({ type: 'init', templateUrl: new URL('assets/template.png', location.href).href });
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'ready') { workerReady = true; }
  else if (m.type === 'tick') { grabAndSend(); }
  else if (m.type === 'result') { inFlight = false; onResult(m); }
  else if (m.type === 'error') { inFlight = false; console.error('[detector]', m.message); }
};

function detectOpts(extra = {}) {
  const fixed = cfg.scale !== 'auto' ? +cfg.scale : null;
  return {
    threshold: cfg.threshold,
    fixedScale: fixed,
    lockedScale: fixed ? null : cfg.lockedScale,
    roi: cfg.roi,
    scalesPerTick: 3,
    ...extra,
  };
}

// ───────── 캡처 ─────────
let stream = null, track = null, imageCapture = null, video = null, running = false;

async function start() {
  audio(); // 사용자 클릭 시점에 오디오 잠금 해제
  askNotify();
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 5, max: 10 }, displaySurface: 'window' },
      audio: false,
      selfBrowserSurface: 'exclude',
    });
  } catch (err) {
    if (err.name !== 'NotAllowedError') alert('화면 캡처를 시작할 수 없어요: ' + err.message);
    return;
  }
  track = stream.getVideoTracks()[0];
  track.addEventListener('ended', () => stop('화면 공유가 종료됐어요.'));
  imageCapture = ('ImageCapture' in window) ? new ImageCapture(track) : null;
  video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.srcObject = stream;
  await video.play().catch(() => { });

  stopTest();
  running = true;
  state = { active: false, lastSeen: 0, lastAlert: 0 };
  $('btnStart').disabled = true; $('btnStop').disabled = false;
  setStatus('run', '감시 중… 팝업이 뜨면 알려드릴게요.');
  worker.postMessage({ type: 'start', interval: cfg.interval });
}

function stop(reason) {
  worker.postMessage({ type: 'stop' });
  running = false; inFlight = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = track = imageCapture = null;
  if (video) { video.srcObject = null; video = null; }
  flashTitle(false);
  $('btnStart').disabled = false; $('btnStop').disabled = true;
  setStatus(reason ? 'warn' : '', reason || '중지됨. 다시 시작하려면 캡처 시작을 누르세요.');
}

async function grabFrame() {
  if (imageCapture && track && track.readyState === 'live') {
    try { return await imageCapture.grabFrame(); } catch { /* 비디오로 대체 */ }
  }
  if (video && video.videoWidth) return await createImageBitmap(video);
  return null;
}

async function grabAndSend() {
  if (!running || inFlight || !workerReady) return;
  inFlight = true;
  let bmp = null;
  try { bmp = await grabFrame(); } catch { bmp = null; }
  if (!bmp || !running) { inFlight = false; bmp && bmp.close(); return; }
  lastFrameSize = [bmp.width, bmp.height];
  if (cfg.preview && !document.hidden) drawPreview(bmp, bmp.width, bmp.height);
  worker.postMessage({ type: 'frame', id: ++frameId, bitmap: bmp, opts: detectOpts() }, [bmp]);
}

$('btnStart').addEventListener('click', start);
$('btnStop').addEventListener('click', () => stop());

// ───────── 결과 처리 ─────────
let state = { active: false, lastSeen: 0, lastAlert: 0 };

function onResult(res) {
  $('mScore').textContent = res.best ? res.best.score.toFixed(2) : '-';
  $('mScale').textContent = res.best ? Math.round(res.best.scale * 100) + '%' : '-';
  $('mMs').textContent = res.ms + 'ms';
  if (cfg.preview && !document.hidden) drawBox(res);

  if (testing) {
    setStatus(res.found ? 'hit' : 'warn', res.found
      ? `테스트: 팝업 발견! (일치도 ${res.best.score.toFixed(2)}, 배율 ${Math.round(res.best.scale * 100)}%)`
      : `테스트: 팝업을 찾지 못했어요. (최고 ${res.best ? res.best.score.toFixed(2) : '-'})`);
    if (res.found) playAlarm();
    return;
  }
  if (!running) return;

  const now = Date.now();
  if (res.found) {
    state.lastSeen = now;
    if (cfg.scale === 'auto' && cfg.lockedScale !== res.best.scale) {
      cfg.lockedScale = res.best.scale; saveCfg(); renderLock();
    }
    if (!state.active) {
      state.active = true;
      state.lastAlert = now;
      alertCount++;
      $('mCount').textContent = alertCount;
      playAlarm(); notify(); flashTitle(true);
      addLog(res, cfg.preview && !document.hidden ? thumbOf(res) : null);
      setStatus('hit', '🪙 코인 획득 타이밍! (Collect M-Force Points!)');
    }
  } else if (state.active && now - state.lastSeen > cfg.cooldown * 1000) {
    state.active = false;
    flashTitle(false);
    setStatus('run', '감시 중… 팝업이 뜨면 알려드릴게요.');
  }
}

// ───────── 테스트 (스크린샷) ─────────
let testing = false, testBitmap = null;
function stopTest() { testing = false; if (testBitmap) { testBitmap.close(); testBitmap = null; } }

async function runTest(blob) {
  if (running) { alert('감시 중에는 테스트할 수 없어요. 먼저 중지해 주세요.'); return; }
  if (!workerReady) { alert('인식기를 준비 중이에요. 잠시 후 다시 시도하세요.'); return; }
  audio();
  stopTest();
  testing = true;
  testBitmap = await createImageBitmap(blob);
  drawPreview(testBitmap, testBitmap.width, testBitmap.height);
  setStatus('run', '테스트 이미지 분석 중… (전체 배율 탐색)');
  const copy = await createImageBitmap(testBitmap);
  worker.postMessage({ type: 'frame', id: ++frameId, bitmap: copy, opts: detectOpts({ fullScan: true, fixedScale: null, lockedScale: null }) }, [copy]);
}
$('fileTest').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) runTest(f); e.target.value = ''; });
document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) runTest(item.getAsFile());
});
$('btnTest').addEventListener('click', () => { playAlarm(); notify(); });

// ───────── Document PIP 상태창 ─────────
let pipWin = null;
$('btnPip').addEventListener('click', async () => {
  if (pipWin) { pipWin.close(); return; }
  if (!('documentPictureInPicture' in window)) { alert('이 브라우저는 PIP 상태창을 지원하지 않아요. (크롬 116+ 필요)'); return; }
  pipWin = await documentPictureInPicture.requestWindow({ width: 280, height: 110 });
  pipWin.document.head.innerHTML = `<style>
    body{margin:0;font:600 15px/1.4 "Malgun Gothic",system-ui,sans-serif;background:#171b2e;color:#e7e9f5;display:flex;align-items:center;gap:12px;padding:14px;height:100vh;box-sizing:border-box;transition:background .2s}
    body.hit{background:#f43f5e;animation:p .5s infinite alternate}
    .d{width:16px;height:16px;border-radius:50%;background:#9aa0c0;flex:none}
    .run .d{background:#34d399;box-shadow:0 0 10px #34d399}.hit .d{background:#fff}
    .warn .d{background:#fbbf24}
    @keyframes p{to{background:#9f1239}}
  </style>`;
  pipWin.document.body.innerHTML = '<span class="d"></span><span id="t"></span>';
  pipWin.addEventListener('pagehide', () => { pipWin = null; $('btnPip').classList.remove('on'); });
  $('btnPip').classList.add('on');
  updatePip($('statusIcon').className.replace('dot', '').trim(), $('statusText').textContent);
});
function updatePip(kind, text) {
  if (!pipWin) return;
  pipWin.document.body.className = kind || '';
  pipWin.document.getElementById('t').textContent = text;
}

// 브라우저 지원 체크
if (!navigator.mediaDevices?.getDisplayMedia) {
  setStatus('warn', '이 브라우저는 화면 캡처를 지원하지 않아요. PC 크롬/엣지에서 열어 주세요.');
  $('btnStart').disabled = true;
}
