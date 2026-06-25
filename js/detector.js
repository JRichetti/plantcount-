/**
 * PlantDetector — classical (no-ML) seedling detection.
 * Fully offline, tiny, runs on any phone.
 *
 * Pipeline:
 *   1. Excess-Green vegetation index   ExG = 2G − R − B   (separates plant from soil)
 *   2. Otsu automatic threshold         → binary plant mask (self-adjusts to lighting)
 *   3. Morphological close              → fill pinholes
 *   4. Distance transform               → "thickness" of each plant region
 *   5. Peak finding + NMS               → one seed per local maximum
 *                                         (splits touching seedlings into separate counts)
 *
 * Two entry points share the pipeline:
 *   detectFrame(video, …)  → live, cover-mapped, restricted to working area, DISPLAY px.
 *   detectImage(img)       → whole still photo, IMAGE-NATURAL px.
 */
class PlantDetector {
  constructor() {
    // Expected seedling radius as a fraction of the processed frame width.
    // Smaller fraction = detects/splits smaller plants (more sensitive).
    this.sizeFrac = 0.020;
    this.EXG_FLOOR = 12;   // min ExG (0–255) to ever be considered plant
    this.BASE_W = 320;
    this.BASE_H = 240;

    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    this._pw = 0; this._ph = 0;
    this._mask = this._tmp = this._feat = this._dist = null;
    this._ensure(this.BASE_W, this.BASE_H);
  }

  setSizeFrac(f) { this.sizeFrac = f; }

  _ensure(w, h) {
    if (this._pw === w && this._ph === h) return;
    this._pw = w; this._ph = h;
    this._canvas.width = w; this._canvas.height = h;
    const n = w * h;
    this._mask = new Uint8Array(n);   // binary plant mask
    this._tmp  = new Uint8Array(n);   // morphology scratch
    this._feat = new Uint8Array(n);   // ExG, clamped 0–255
    this._dist = new Int32Array(n);   // chamfer distance transform
  }

  _nmsRadius() { return Math.max(2, Math.round(this.sizeFrac * this._pw)); }

  // ── Live frame: cover mapping, restricted to working area ──────────────────
  detectFrame(source, srcW, srcH, wa, dispW, dispH) {
    if (!srcW || !srcH) return [];
    this._ensure(this.BASE_W, this.BASE_H);
    const W = this._pw, H = this._ph;

    const fit = Math.max(W / srcW, H / srcH);
    const dW = srcW * fit, dH = srcH * fit;
    this._ctx.drawImage(source, (W - dW) / 2, (H - dH) / 2, dW, dH);
    const data = this._ctx.getImageData(0, 0, W, H).data;

    const sx = W / dispW, sy = H / dispH;
    const x0 = Math.max(Math.floor(wa.x * sx), 0);
    const y0 = Math.max(Math.floor(wa.y * sy), 0);
    const x1 = Math.min(Math.ceil((wa.x + wa.w) * sx), W);
    const y1 = Math.min(Math.ceil((wa.y + wa.h) * sy), H);

    const peaks = this._pipeline(data, x0, y0, x1, y1);
    return this._peaksToBoxes(peaks, dispW / W, dispH / H);
  }

  // ── Whole still photo: boxes in image-natural pixels ───────────────────────
  detectImage(img) {
    const natW = img.naturalWidth, natH = img.naturalHeight;
    if (!natW || !natH) return [];

    const maxDim = 540;
    const fit = Math.min(maxDim / natW, maxDim / natH, 1);
    const W = Math.max(1, Math.round(natW * fit));
    const H = Math.max(1, Math.round(natH * fit));
    this._ensure(W, H);

    this._ctx.clearRect(0, 0, W, H);
    this._ctx.drawImage(img, 0, 0, W, H);
    const data = this._ctx.getImageData(0, 0, W, H).data;

    const peaks = this._pipeline(data, 0, 0, W, H);
    return this._peaksToBoxes(peaks, natW / W, natH / H);
  }

  // ── Shared pipeline ────────────────────────────────────────────────────────
  _pipeline(data, x0, y0, x1, y1) {
    const W = this._pw, H = this._ph, r = 1;
    this._mask.fill(0);
    this._tmp.fill(0);

    const t = this._exgOtsu(data, x0, y0, x1, y1);   // builds _feat + returns threshold
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * W + x;
        if (this._feat[i] > t) this._mask[i] = 1;
      }
    }

    const ex0 = Math.max(x0 - r, 0), ey0 = Math.max(y0 - r, 0);
    const ex1 = Math.min(x1 + r, W),  ey1 = Math.min(y1 + r, H);
    this._morphClose(r, ex0, ey0, ex1, ey1);
    this._distanceTransform(ex0, ey0, ex1, ey1);
    return this._findPeaks(ex0, ey0, ex1, ey1);
  }

  // Excess-Green into _feat, Otsu threshold over the region.
  _exgOtsu(data, x0, y0, x1, y1) {
    const W = this._pw, feat = this._feat;
    const hist = new Int32Array(256);
    let total = 0;

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * W + x, j = i << 2;
        let exg = 2 * data[j + 1] - data[j] - data[j + 2]; // 2G − R − B
        if (exg < 0) exg = 0; else if (exg > 255) exg = 255;
        feat[i] = exg;
        hist[exg]++;
        total++;
      }
    }
    if (!total) return 255;

    // Otsu: maximise between-class variance.
    let sum = 0;
    for (let k = 0; k < 256; k++) sum += k * hist[k];
    let sumB = 0, wB = 0, maxVar = -1, thr = 0;
    for (let k = 0; k < 256; k++) {
      wB += hist[k];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += k * hist[k];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxVar) { maxVar = between; thr = k; }
    }
    return Math.max(thr, this.EXG_FLOOR);
  }

  _morphClose(r, x0, y0, x1, y1) {
    const W = this._pw, src = this._mask, tmp = this._tmp;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let v = 0;
        const ny0 = Math.max(y - r, y0), ny1 = Math.min(y + r, y1 - 1);
        const nx0 = Math.max(x - r, x0), nx1 = Math.min(x + r, x1 - 1);
        outer: for (let ny = ny0; ny <= ny1; ny++)
          for (let nx = nx0; nx <= nx1; nx++)
            if (src[ny * W + nx]) { v = 1; break outer; }
        tmp[y * W + x] = v;
      }
    }
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let v = 1;
        const ny0 = Math.max(y - r, y0), ny1 = Math.min(y + r, y1 - 1);
        const nx0 = Math.max(x - r, x0), nx1 = Math.min(x + r, x1 - 1);
        outer: for (let ny = ny0; ny <= ny1; ny++)
          for (let nx = nx0; nx <= nx1; nx++)
            if (!tmp[ny * W + nx]) { v = 0; break outer; }
        src[y * W + x] = v;
      }
    }
  }

  // Chamfer 3-4 distance transform of _mask into _dist (units ≈ 3× pixels).
  _distanceTransform(x0, y0, x1, y1) {
    const W = this._pw, mask = this._mask, dist = this._dist;
    const BIG = 1 << 28;

    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = y * W + x;
        dist[i] = mask[i] ? BIG : 0;
      }

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * W + x;
        if (!mask[i]) continue;
        let d = dist[i];
        if (x > x0)              d = Math.min(d, dist[i - 1] + 3);
        if (y > y0)              d = Math.min(d, dist[i - W] + 3);
        if (x > x0 && y > y0)    d = Math.min(d, dist[i - W - 1] + 4);
        if (x < x1 - 1 && y > y0) d = Math.min(d, dist[i - W + 1] + 4);
        dist[i] = d;
      }
    }
    for (let y = y1 - 1; y >= y0; y--) {
      for (let x = x1 - 1; x >= x0; x--) {
        const i = y * W + x;
        if (!mask[i]) continue;
        let d = dist[i];
        if (x < x1 - 1)               d = Math.min(d, dist[i + 1] + 3);
        if (y < y1 - 1)               d = Math.min(d, dist[i + W] + 3);
        if (x < x1 - 1 && y < y1 - 1) d = Math.min(d, dist[i + W + 1] + 4);
        if (x > x0 && y < y1 - 1)     d = Math.min(d, dist[i + W - 1] + 4);
        dist[i] = d;
      }
    }
  }

  // Local maxima of the distance map, suppressed within one plant radius.
  _findPeaks(x0, y0, x1, y1) {
    const W = this._pw, mask = this._mask, dist = this._dist;
    const nms = this._nmsRadius();
    const minPeak = Math.max(3, Math.round(nms * 0.4) * 3); // chamfer units

    // Collect local-maximum candidates.
    const cand = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * W + x;
        if (!mask[i]) continue;
        const d = dist[i];
        if (d < minPeak) continue;
        let isMax = true;
        for (let ny = Math.max(y - 1, y0); ny <= Math.min(y + 1, y1 - 1) && isMax; ny++)
          for (let nx = Math.max(x - 1, x0); nx <= Math.min(x + 1, x1 - 1); nx++)
            if (dist[ny * W + nx] > d) { isMax = false; break; }
        if (isMax) cand.push({ x, y, d });
      }
    }
    cand.sort((a, b) => b.d - a.d);

    // Greedy non-maximum suppression on a spatial grid.
    const cell = Math.max(1, nms);
    const grid = new Map();
    const key = (cx, cy) => cx + ',' + cy;
    const peaks = [];
    const r2 = nms * nms;

    for (const c of cand) {
      const gx = (c.x / cell) | 0, gy = (c.y / cell) | 0;
      let blocked = false;
      for (let ay = gy - 1; ay <= gy + 1 && !blocked; ay++) {
        for (let ax = gx - 1; ax <= gx + 1; ax++) {
          const bucket = grid.get(key(ax, ay));
          if (!bucket) continue;
          for (const p of bucket) {
            const dx = p.x - c.x, dy = p.y - c.y;
            if (dx * dx + dy * dy < r2) { blocked = true; break; }
          }
          if (blocked) break;
        }
      }
      if (blocked) continue;
      peaks.push(c);
      const k = key(gx, gy);
      let bucket = grid.get(k);
      if (!bucket) grid.set(k, bucket = []);
      bucket.push(c);
      if (peaks.length >= 600) break; // safety cap
    }
    return peaks;
  }

  _peaksToBoxes(peaks, bx, by) {
    const out = [];
    const cap = this._nmsRadius() * 1.6;          // keep boxes ~plant-sized
    for (const p of peaks) {
      const rPx = Math.min(Math.max((p.d / 3) * 1.4, 3), cap); // chamfer → px, padded & capped
      out.push({
        x:  (p.x - rPx) * bx,
        y:  (p.y - rPx) * by,
        w:  (2 * rPx) * bx,
        h:  (2 * rPx) * by,
        cx: p.x * bx,
        cy: p.y * by,
      });
    }
    return out;
  }
}
