// "Collect M-Force Points!" 배너 검출 워커.
// 프레임을 배율별로 정규화한 뒤 그레이스케일 NCC(정규화 상호상관)로 템플릿을 찾는다.
// 1/4 해상도에서 후보를 고르고 1/2 해상도에서 정밀 확인 + 평균 색상 검증.

const FINE = 0.5;            // 정밀 단계 해상도 (원본 대비)
const MIN_STD = 6;           // 너무 밋밋한 영역은 무시
const COARSE_THR = 0.55;     // 후보 선정 기준
const MAX_CAND = 8;
const COLOR_TOL = 45;        // 템플릿 평균 RGB 와의 허용 거리

// 게임 UI 배율 후보 (0.6 ~ 2.1, 약 6% 간격)
const SCALES = [];
for (let s = 0.6; s <= 2.12; s *= 1.06) SCALES.push(+s.toFixed(3));
const IDX_100 = SCALES.reduce((b, s, i) => Math.abs(s - 1) < Math.abs(SCALES[b] - 1) ? i : b, 0);
SCALES[IDX_100] = 1;

let tpl = null;      // { fine, coarse, meanRGB }
let timer = null;
let cycle = 0;
let busy = false;

function makeCanvas(w, h) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return [c, ctx];
}

function toGray(data, n) {
  const g = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
  return g;
}

function half(g, w, h) {
  const w2 = w >> 1, h2 = h >> 1, o = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    const r0 = 2 * y * w, r1 = r0 + w;
    for (let x = 0; x < w2; x++) {
      const k = 2 * x;
      o[y * w2 + x] = (g[r0 + k] + g[r0 + k + 1] + g[r1 + k] + g[r1 + k + 1]) * 0.25;
    }
  }
  return { g: o, w: w2, h: h2 };
}

function prepTemplate(g, w, h) {
  const n = w * h;
  let m = 0;
  for (let i = 0; i < n; i++) m += g[i];
  m /= n;
  const z = new Float32Array(n);
  let ss = 0;
  for (let i = 0; i < n; i++) { z[i] = g[i] - m; ss += z[i] * z[i]; }
  return { z, w, h, n, norm: Math.sqrt(ss) };
}

async function loadTemplate(url) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob);
  const W = bmp.width, H = bmp.height;
  const [, full] = makeCanvas(W, H);
  full.drawImage(bmp, 0, 0);
  const rgb = full.getImageData(0, 0, W, H).data;
  const meanRGB = [0, 0, 0];
  for (let i = 0; i < rgb.length; i += 4) { meanRGB[0] += rgb[i]; meanRGB[1] += rgb[i + 1]; meanRGB[2] += rgb[i + 2]; }
  meanRGB.forEach((v, i) => meanRGB[i] = v / (W * H));

  const fw = Math.round(W * FINE), fh = Math.round(H * FINE);
  const [, fctx] = makeCanvas(fw, fh);
  fctx.drawImage(bmp, 0, 0, fw, fh);
  const fg = toGray(fctx.getImageData(0, 0, fw, fh).data, fw * fh);
  const c = half(fg, fw, fh);
  tpl = { fine: prepTemplate(fg, fw, fh), coarse: prepTemplate(c.g, c.w, c.h), meanRGB, srcW: W, srcH: H };
}

// 적분 영상 (합, 제곱합)
function integrals(g, w, h) {
  const W = w + 1, S = new Float64Array(W * (h + 1)), S2 = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, rs2 = 0;
    for (let x = 0; x < w; x++) {
      const v = g[y * w + x];
      rs += v; rs2 += v * v;
      S[(y + 1) * W + x + 1] = S[y * W + x + 1] + rs;
      S2[(y + 1) * W + x + 1] = S2[y * W + x + 1] + rs2;
    }
  }
  return { S, S2, W };
}

function nccAt(g, w, T, x, y, sum, sum2) {
  const varI = sum2 - sum * sum / T.n;
  if (varI < T.n * MIN_STD * MIN_STD) return -1;
  let num = 0;
  const z = T.z, tw = T.w;
  for (let ty = 0; ty < T.h; ty++) {
    const ro = (y + ty) * w + x, to = ty * tw;
    for (let tx = 0; tx < tw; tx++) num += z[to + tx] * g[ro + tx];
  }
  return num / (T.norm * Math.sqrt(varI));
}

function boxSums(I, x, y, tw, th) {
  const { S, S2, W } = I;
  const a = y * W + x, b = a + tw, c = (y + th) * W + x, d = c + tw;
  return [S[d] - S[b] - S[c] + S[a], S2[d] - S2[b] - S2[c] + S2[a]];
}

function searchScale(bmp, scale, roi) {
  const f = FINE / scale;
  const fw = Math.max(1, Math.round(bmp.width * f)), fh = Math.max(1, Math.round(bmp.height * f));
  const T = tpl.fine, C = tpl.coarse;
  if (fw < T.w + 2 || fh < T.h + 2) return null;
  const [, ctx] = makeCanvas(fw, fh);
  ctx.drawImage(bmp, 0, 0, fw, fh);
  const rgba = ctx.getImageData(0, 0, fw, fh).data;
  const fg = toGray(rgba, fw * fh);
  const cg = half(fg, fw, fh);
  const CI = integrals(cg.g, cg.w, cg.h);

  // 1) 1/4 해상도 전체 탐색
  const cands = [];
  let x0 = 0, y0 = 0, x1 = cg.w - C.w, y1 = cg.h - C.h;
  if (roi) {
    x0 = Math.max(0, Math.floor(roi.x * cg.w)); y0 = Math.max(0, Math.floor(roi.y * cg.h));
    x1 = Math.min(x1, Math.ceil((roi.x + roi.w) * cg.w) - C.w); y1 = Math.min(y1, Math.ceil((roi.y + roi.h) * cg.h) - C.h);
  }
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const [s, s2] = boxSums(CI, x, y, C.w, C.h);
      const v = nccAt(cg.g, cg.w, C, x, y, s, s2);
      if (v > COARSE_THR) cands.push([v, x, y]);
    }
  }
  cands.sort((a, b) => b[0] - a[0]);
  const picked = [];
  for (const c of cands) {
    if (picked.every(p => Math.abs(p[1] - c[1]) > C.w / 2 || Math.abs(p[2] - c[2]) > C.h)) picked.push(c);
    if (picked.length >= MAX_CAND) break;
  }

  // 2) 1/2 해상도 정밀 확인
  let best = null;
  for (const [, cx, cy] of picked) {
    for (let y = Math.max(0, 2 * cy - 3); y <= Math.min(fh - T.h, 2 * cy + 3); y++) {
      for (let x = Math.max(0, 2 * cx - 3); x <= Math.min(fw - T.w, 2 * cx + 3); x++) {
        let s = 0, s2 = 0;
        for (let ty = 0; ty < T.h; ty++) {
          const ro = (y + ty) * fw + x;
          for (let tx = 0; tx < T.w; tx++) { const v = fg[ro + tx]; s += v; s2 += v * v; }
        }
        const v = nccAt(fg, fw, T, x, y, s, s2);
        if (!best || v > best.score) best = { score: v, x, y };
      }
    }
  }
  if (!best) return { scale, score: 0 };

  // 3) 평균 색상 검증
  const m = [0, 0, 0];
  for (let ty = 0; ty < T.h; ty++) for (let tx = 0; tx < T.w; tx++) {
    const j = ((best.y + ty) * fw + best.x + tx) * 4;
    m[0] += rgba[j]; m[1] += rgba[j + 1]; m[2] += rgba[j + 2];
  }
  const colorDist = Math.hypot(...m.map((v, i) => v / T.n - tpl.meanRGB[i]));

  return {
    scale,
    score: best.score,
    colorDist,
    colorOk: colorDist <= COLOR_TOL,
    // 원본 프레임 좌표
    box: { x: best.x / f, y: best.y / f, w: T.w / f, h: T.h / f },
  };
}

function scalesForTick(opts) {
  if (opts.fixedScale) {
    const i = nearestIdx(opts.fixedScale);
    return [SCALES[i]];
  }
  if (opts.lockedScale) {
    const i = nearestIdx(opts.lockedScale);
    return [SCALES[i], SCALES[i - 1], SCALES[i + 1]].filter(Boolean);
  }
  if (opts.fullScan) return SCALES.slice();
  // 자동: 100% 는 매번, 나머지는 돌아가며
  const out = [1];
  const per = opts.scalesPerTick || 3;
  for (let k = 0; k < per; k++) {
    cycle = (cycle + 1) % SCALES.length;
    if (cycle === IDX_100) cycle = (cycle + 1) % SCALES.length;
    out.push(SCALES[cycle]);
  }
  return out;
}

function nearestIdx(s) {
  let b = 0;
  SCALES.forEach((v, i) => { if (Math.abs(Math.log(v / s)) < Math.abs(Math.log(SCALES[b] / s))) b = i; });
  return b;
}

function detect(bmp, opts) {
  const t0 = performance.now();
  let best = null;
  const scales = scalesForTick(opts);
  for (const s of scales) {
    const r = searchScale(bmp, s, opts.roi);
    if (!r) continue;
    const eff = r.colorOk === false ? r.score - 0.3 : r.score;
    if (!best || eff > best.eff) best = { ...r, eff };
    if (!opts.fullScan && r.score >= opts.threshold && r.colorOk) break;
  }
  return {
    width: bmp.width, height: bmp.height,
    best, scales, ms: Math.round(performance.now() - t0),
    found: !!(best && best.score >= opts.threshold && best.colorOk),
  };
}

self.onmessage = async (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      try {
        await loadTemplate(msg.templateUrl);
        self.postMessage({ type: 'ready', scales: SCALES });
      } catch (err) {
        self.postMessage({ type: 'error', message: String(err) });
      }
      break;
    case 'start':
      clearInterval(timer);
      // 워커 타이머는 백그라운드 탭에서도 크게 느려지지 않는다
      timer = setInterval(() => { if (!busy) self.postMessage({ type: 'tick' }); }, msg.interval);
      break;
    case 'stop':
      clearInterval(timer);
      timer = null;
      break;
    case 'frame': {
      if (!tpl) { msg.bitmap.close(); break; }
      busy = true;
      try {
        const res = detect(msg.bitmap, msg.opts);
        self.postMessage({ type: 'result', id: msg.id, ...res });
      } catch (err) {
        self.postMessage({ type: 'error', message: String(err), id: msg.id });
      } finally {
        msg.bitmap.close();
        busy = false;
      }
      break;
    }
  }
};
