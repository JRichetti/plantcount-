'use strict';

// ── DOM refs ─────────────────────────────────────────────────────────────────
const video       = document.getElementById('video');
const photo       = document.getElementById('photo');
const overlay     = document.getElementById('overlay');
const ctx         = overlay.getContext('2d');
const countEl     = document.getElementById('count-number');
const countLabel  = document.getElementById('count-label');
const hintEl      = document.getElementById('hint');
const splash      = document.getElementById('splash');
const splashError = document.getElementById('splash-error');
const settingsPanel     = document.getElementById('settings-panel');
const sensitivitySlider = document.getElementById('sensitivity');

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  mode:       'idle',     // 'camera' | 'video' | 'photo'
  facing:     'environment',
  stream:     null,
  videoURL:   null,
  photoURL:   null,
  count:      0,          // cumulative plants counted (live modes)
  photoBoxes: [],         // image-coord boxes (photo mode)
  photoRect:  null,       // displayed photo rect (contain fit)
  waScale:    0.82,       // working-area fraction of screen
  wa:         null,       // {x,y,w,h}
  lineFrac:   0.5,        // counting-line position within working area (0..1)
  frameId:    null,
  lastDetect: 0,
  DETECT_MS:  70,
};

const detector = new PlantDetector();
const tracker  = new CentroidTracker();

const MIN_AGE = 2;        // frames a track must persist before it may be counted
const CROSS_DEADBAND = 2; // px of movement required to accept a line crossing

// ── Geometry helpers ──────────────────────────────────────────────────────────
function computeWA() {
  const W = overlay.width, H = overlay.height;
  const ww = W * state.waScale, wh = H * Math.min(state.waScale * 0.72, 0.82);
  state.wa = { x: (W - ww) / 2, y: (H - wh) / 2, w: ww, h: wh };
}

function containRect(natW, natH, dispW, dispH) {
  const scale = Math.min(dispW / natW, dispH / natH);
  const w = natW * scale, h = natH * scale;
  return { x: (dispW - w) / 2, y: (dispH - h) / 2, w, h, scale };
}

// ── Mode / UI ──────────────────────────────────────────────────────────────────
function setMode(mode) {
  state.mode = mode;
  video.style.display = mode === 'photo' ? 'none'  : 'block';
  photo.style.display = mode === 'photo' ? 'block' : 'none';

  document.getElementById('video-controls').classList.toggle('hidden', mode !== 'video');
  document.getElementById('btn-flip').classList.toggle('hidden',  mode !== 'camera');
  document.getElementById('btn-reset').classList.toggle('hidden', mode === 'photo');

  countLabel.textContent = mode === 'photo' ? 'in photo' : 'counted';
  hintEl.textContent = mode === 'photo'
    ? 'Total green plants detected in the photo'
    : 'Sweep the camera left↔right — plants are counted as they cross the line';
}

function showSplash() {
  if (state.mode === 'video' || state.mode === 'camera') { try { video.pause(); } catch (e) {} }
  splashError.style.display = 'none';
  splash.classList.remove('hidden');
}

// ── Camera ───────────────────────────────────────────────────────────────────
function stopCamera() {
  if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
  video.srcObject = null;
}

function stopVideoFile() {
  if (state.videoURL) { URL.revokeObjectURL(state.videoURL); state.videoURL = null; }
  video.removeAttribute('src');
  video.load?.();
}

async function startCamera() {
  stopCamera();
  stopVideoFile();

  const constraints = {
    video: { facingMode: { ideal: state.facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  };

  try {
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = state.stream;
    await video.play();
    resetCount();
    setMode('camera');
    splash.classList.add('hidden');
    resize();
    if (!state.frameId) loop();
  } catch (err) {
    splashError.textContent = `Camera error: ${err.message}`;
    splashError.style.display = 'block';
  }
}

// ── Video file ────────────────────────────────────────────────────────────────
function loadVideoFile(file) {
  if (!file) return;
  stopCamera();
  if (state.videoURL) URL.revokeObjectURL(state.videoURL);

  state.videoURL = URL.createObjectURL(file);
  video.srcObject = null;
  video.src = state.videoURL;
  video.loop = true;
  video.playbackRate = Number(document.getElementById('video-speed').value);
  video.play();

  resetCount();
  setMode('video');
  splash.classList.add('hidden');
  resize();
  if (!state.frameId) loop();
}

// ── Photo file ────────────────────────────────────────────────────────────────
function loadPhotoFile(file) {
  if (!file) return;
  stopCamera();
  stopVideoFile();
  if (state.photoURL) URL.revokeObjectURL(state.photoURL);

  state.photoURL = URL.createObjectURL(file);
  photo.onload = () => {
    setMode('photo');
    splash.classList.add('hidden');
    resize();
    analyzePhoto();
    if (!state.frameId) loop();
  };
  photo.onerror = () => {
    splashError.textContent = 'Could not load that image.';
    splashError.style.display = 'block';
  };
  photo.src = state.photoURL;
}

function analyzePhoto() {
  if (!photo.naturalWidth) return;
  state.photoBoxes = detector.detectImage(photo);
  state.count = state.photoBoxes.length;
  countEl.textContent = state.count;
}

// ── Count reset ────────────────────────────────────────────────────────────────
function resetCount() {
  state.count = 0;
  tracker.reset();
  countEl.textContent = '0';
}

// ── Resize ───────────────────────────────────────────────────────────────────
function resize() {
  overlay.width  = window.innerWidth;
  overlay.height = window.innerHeight;
  computeWA();
  if (state.mode === 'photo' && photo.naturalWidth) {
    state.photoRect = containRect(photo.naturalWidth, photo.naturalHeight, overlay.width, overlay.height);
  }
}
window.addEventListener('resize', resize);

// ── Render loop ──────────────────────────────────────────────────────────────
function loop(ts = 0) {
  state.frameId = requestAnimationFrame(loop);
  const W = overlay.width, H = overlay.height;
  ctx.clearRect(0, 0, W, H);

  if (state.mode === 'photo') { drawPhoto(W, H); return; }
  if (!state.wa || !video.videoWidth) return;

  if (ts - state.lastDetect > state.DETECT_MS) {
    state.lastDetect = ts;
    runDetection(W, H);
  }
  drawLive(W, H);
}

// ── Live detection + line-crossing count ───────────────────────────────────────
function runDetection(W, H) {
  const dets = detector
    .detectFrame(video, video.videoWidth, video.videoHeight, state.wa, W, H)
    .map(b => ({ cx: b.cx, cy: b.cy, box: b }));

  tracker.update(dets);

  const lineX = state.wa.x + state.wa.w * state.lineFrac;
  for (const obj of tracker.objects.values()) {
    if (obj.counted || obj.age < MIN_AGE) continue;
    const moved = Math.abs(obj.cx - obj.prevCx);
    const crossed =
      (obj.prevCx < lineX && obj.cx >= lineX) ||
      (obj.prevCx > lineX && obj.cx <= lineX);
    if (crossed && moved > CROSS_DEADBAND) {
      obj.counted = true;
      obj.flash = 1;
      state.count++;
    }
  }
  countEl.textContent = state.count;
}

// ── Drawing ──────────────────────────────────────────────────────────────────
function dimOutside(wa, W, H) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  ctx.fillRect(0, 0, W, wa.y);
  ctx.fillRect(0, wa.y + wa.h, W, H - wa.y - wa.h);
  ctx.fillRect(0, wa.y, wa.x, wa.h);
  ctx.fillRect(wa.x + wa.w, wa.y, W - wa.x - wa.w, wa.h);
  ctx.restore();
}

function strokeWA(wa) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 2;
  ctx.setLineDash([12, 8]);
  ctx.strokeRect(wa.x, wa.y, wa.w, wa.h);
  ctx.restore();
}

function drawLive(W, H) {
  const wa = state.wa;
  dimOutside(wa, W, H);
  strokeWA(wa);

  // Counting line (vertical — pan the camera left↔right across it)
  const lineX = wa.x + wa.w * state.lineFrac;
  ctx.save();
  ctx.strokeStyle = '#00e5ff';
  ctx.lineWidth = 3;
  ctx.setLineDash([]);
  ctx.shadowColor = '#00e5ff';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.moveTo(lineX, wa.y);
  ctx.lineTo(lineX, wa.y + wa.h);
  ctx.stroke();
  ctx.restore();

  // Line grip handle (draggable)
  ctx.save();
  ctx.fillStyle = '#00e5ff';
  ctx.beginPath();
  ctx.arc(lineX, wa.y + 14, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Detected plant boxes (drawn from tracker so they stay stable between detections)
  for (const obj of tracker.objects.values()) {
    if (obj.disappeared > 0 || obj.age < 1 || !obj.box) continue;
    const b = obj.box;
    ctx.save();
    if (obj.flash > 0) {
      ctx.strokeStyle = '#ffeb3b';
      ctx.fillStyle   = 'rgba(255,235,59,0.28)';
      obj.flash -= 0.08;
    } else {
      ctx.strokeStyle = '#4cff4c';
      ctx.fillStyle   = 'rgba(76,255,76,0.12)';
    }
    ctx.lineWidth = 2.5;
    ctx.setLineDash([]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.restore();
  }
}

function drawPhoto(W, H) {
  const r = state.photoRect;
  if (!r) return;
  for (const b of state.photoBoxes) {
    const x = r.x + b.x * r.scale, y = r.y + b.y * r.scale;
    const w = b.w * r.scale, h = b.h * r.scale;
    ctx.save();
    ctx.strokeStyle = '#4cff4c';
    ctx.fillStyle   = 'rgba(76,255,76,0.12)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }
}

// ── Counting-line drag (live modes) ─────────────────────────────────────────────
let draggingLine = false;

overlay.addEventListener('pointerdown', e => {
  if (state.mode === 'photo' || !state.wa) return;
  const lineX = state.wa.x + state.wa.w * state.lineFrac;
  if (Math.abs(e.clientX - lineX) < 32) {
    draggingLine = true;
    overlay.setPointerCapture?.(e.pointerId);
  }
});

overlay.addEventListener('pointermove', e => {
  if (!draggingLine || !state.wa) return;
  const f = (e.clientX - state.wa.x) / state.wa.w;
  state.lineFrac = Math.max(0.1, Math.min(0.9, f));
});

overlay.addEventListener('pointerup',     () => { draggingLine = false; });
overlay.addEventListener('pointercancel', () => { draggingLine = false; });

// ── Bottom controls ────────────────────────────────────────────────────────────
document.getElementById('btn-settings').addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
});

document.getElementById('btn-reset').addEventListener('click', () => {
  resetCount();
  settingsPanel.classList.add('hidden');
});

document.getElementById('btn-flip').addEventListener('click', () => {
  state.facing = state.facing === 'environment' ? 'user' : 'environment';
  startCamera();
});

document.getElementById('btn-source').addEventListener('click', () => {
  settingsPanel.classList.add('hidden');
  showSplash();
});

// ── Settings ────────────────────────────────────────────────────────────────────
// Slider is 0–100 sensitivity. Higher = smaller expected plant size = detects and
// splits smaller seedlings (more sensitive). Maps to the detector's size fraction.
const SIZE_FRAC_MAX = 0.045; // least sensitive (slider 0) — bigger plants only
const SIZE_FRAC_MIN = 0.011; // most sensitive  (slider 100) — tiny seedlings
function sensToSizeFrac(s) {
  return SIZE_FRAC_MAX - (s / 100) * (SIZE_FRAC_MAX - SIZE_FRAC_MIN);
}
function applySensitivity() {
  detector.setSizeFrac(sensToSizeFrac(Number(sensitivitySlider.value)));
  if (state.mode === 'photo') analyzePhoto();
}
sensitivitySlider.addEventListener('input', applySensitivity);
applySensitivity(); // sync detector with the slider's initial value

document.getElementById('btn-area-smaller').addEventListener('click', () => {
  state.waScale = Math.max(0.4, state.waScale - 0.1);
  computeWA();
});
document.getElementById('btn-area-larger').addEventListener('click', () => {
  state.waScale = Math.min(1.0, state.waScale + 0.1);
  computeWA();
});

// ── Splash + file inputs ────────────────────────────────────────────────────────
const videoInput = document.getElementById('file-input-video');
const photoInput = document.getElementById('file-input-photo');

videoInput.addEventListener('change', () => loadVideoFile(videoInput.files[0]));
photoInput.addEventListener('change', () => loadPhotoFile(photoInput.files[0]));

function pickVideo() { videoInput.value = ''; videoInput.click(); }
function pickPhoto() { photoInput.value = ''; photoInput.click(); }

document.getElementById('btn-start-camera').addEventListener('click', startCamera);
document.getElementById('btn-load-video-splash').addEventListener('click', pickVideo);
document.getElementById('btn-load-photo-splash').addEventListener('click', pickPhoto);

// ── Video playback controls ───────────────────────────────────────────────────
const scrubber = document.getElementById('video-scrubber');
const timeEl   = document.getElementById('video-time');
const speedSel = document.getElementById('video-speed');
const playBtn  = document.getElementById('btn-playpause');

function fmtTime(s) {
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
}

video.addEventListener('timeupdate', () => {
  if (state.mode !== 'video' || !video.duration) return;
  scrubber.value = (video.currentTime / video.duration) * 100;
  timeEl.textContent = fmtTime(video.currentTime);
});

scrubber.addEventListener('input', () => {
  if (video.duration) video.currentTime = (scrubber.value / 100) * video.duration;
});

playBtn.addEventListener('click', () => {
  if (video.paused) video.play(); else video.pause();
});
video.addEventListener('play',  () => { playBtn.textContent = '⏸'; });
video.addEventListener('pause', () => { playBtn.textContent = '▶'; });

speedSel.addEventListener('change', () => { video.playbackRate = Number(speedSel.value); });

// ── Service worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
