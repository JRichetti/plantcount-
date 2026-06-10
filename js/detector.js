/**
 * PlantDetector — green-blob detection via canvas image processing.
 * No external model. Fully offline.
 *
 * Pipeline: green pixel mask → morphological close → connected components → area filter.
 *
 * Two entry points share the same pipeline:
 *   detectFrame(video, …)  → live camera/video, cover-mapped, restricted to working area,
 *                            boxes returned in DISPLAY pixels.
 *   detectImage(img)       → whole still photo, boxes returned in IMAGE-NATURAL pixels.
 */
class PlantDetector {
  constructor() {
    this.minArea = 40;     // at the 320×240 baseline; scaled to actual proc size
    this.maxArea = 14000;
    this.BASE_W = 320;
    this.BASE_H = 240;

    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    this._pw = 0; this._ph = 0;
    this._mask = this._tmp = this._labels = this._stack = null;
    this._ensure(this.BASE_W, this.BASE_H);
  }

  setMinArea(v) { this.minArea = v; }

  _ensure(w, h) {
    if (this._pw === w && this._ph === h) return;
    this._pw = w; this._ph = h;
    this._canvas.width = w; this._canvas.height = h;
    const n = w * h;
    this._mask   = new Uint8Array(n);
    this._tmp    = new Uint8Array(n);
    this._labels = new Int32Array(n);
    this._stack  = new Int32Array(n);
  }

  _areaScale() { return (this._pw * this._ph) / (this.BASE_W * this.BASE_H); }
  _minAreaPx() { return this.minArea * this._areaScale(); }
  _maxAreaPx() { return this.maxArea * this._areaScale(); }

  // ── Live frame: cover mapping, restricted to working area ──────────────────
  detectFrame(source, srcW, srcH, wa, dispW, dispH) {
    if (!srcW || !srcH) return [];
    this._ensure(this.BASE_W, this.BASE_H);
    const W = this._pw, H = this._ph;

    // Replicate object-fit:cover so detector coords line up with what's shown.
    const fit = Math.max(W / srcW, H / srcH);
    const dW = srcW * fit, dH = srcH * fit;
    this._ctx.drawImage(source, (W - dW) / 2, (H - dH) / 2, dW, dH);
    const data = this._ctx.getImageData(0, 0, W, H).data;

    const sx = W / dispW, sy = H / dispH;
    const x0 = Math.max(Math.floor(wa.x * sx), 0);
    const y0 = Math.max(Math.floor(wa.y * sy), 0);
    const x1 = Math.min(Math.ceil((wa.x + wa.w) * sx), W);
    const y1 = Math.min(Math.ceil((wa.y + wa.h) * sy), H);

    const blobs = this._pipeline(data, x0, y0, x1, y1);
    return this._toBoxes(blobs, dispW / W, dispH / H);
  }

  // ── Whole still photo: boxes in image-natural pixels ───────────────────────
  detectImage(img) {
    const natW = img.naturalWidth, natH = img.naturalHeight;
    if (!natW || !natH) return [];

    const maxDim = 540; // cap processing resolution for speed
    const fit = Math.min(maxDim / natW, maxDim / natH, 1);
    const W = Math.max(1, Math.round(natW * fit));
    const H = Math.max(1, Math.round(natH * fit));
    this._ensure(W, H);

    this._ctx.clearRect(0, 0, W, H);
    this._ctx.drawImage(img, 0, 0, W, H);
    const data = this._ctx.getImageData(0, 0, W, H).data;

    const blobs = this._pipeline(data, 0, 0, W, H);
    return this._toBoxes(blobs, natW / W, natH / H);
  }

  // ── Shared pipeline ────────────────────────────────────────────────────────
  _pipeline(data, x0, y0, x1, y1) {
    const W = this._pw, H = this._ph, r = 2;
    this._mask.fill(0);
    this._tmp.fill(0);
    this._buildMask(data, x0, y0, x1, y1);

    const ex0 = Math.max(x0 - r, 0), ey0 = Math.max(y0 - r, 0);
    const ex1 = Math.min(x1 + r, W),  ey1 = Math.min(y1 + r, H);
    this._morphClose(r, ex0, ey0, ex1, ey1);
    return this._connectedComponents(ex0, ey0, ex1, ey1);
  }

  _toBoxes(blobs, bx, by) {
    const minA = this._minAreaPx(), maxA = this._maxAreaPx();
    const out = [];
    for (const b of blobs) {
      if (b.area < minA || b.area > maxA) continue;
      out.push({
        x:  b.x0 * bx,
        y:  b.y0 * by,
        w:  (b.x1 - b.x0 + 1) * bx,
        h:  (b.y1 - b.y0 + 1) * by,
        cx: b.cx * bx,
        cy: b.cy * by,
      });
    }
    return out;
  }

  _buildMask(data, x0, y0, x1, y1) {
    const W = this._pw, mask = this._mask;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * W + x) << 2;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        // Green channel dominant with a minimum brightness (loose → sensitive).
        if (g > r + 6 && g > b + 3 && g > 26) mask[y * W + x] = 1;
      }
    }
  }

  _morphClose(r, x0, y0, x1, y1) {
    const W = this._pw, src = this._mask, tmp = this._tmp;

    // Dilate src → tmp
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let v = 0;
        const ny0 = Math.max(y - r, y0), ny1 = Math.min(y + r, y1 - 1);
        const nx0 = Math.max(x - r, x0), nx1 = Math.min(x + r, x1 - 1);
        outer: for (let ny = ny0; ny <= ny1; ny++) {
          for (let nx = nx0; nx <= nx1; nx++) {
            if (src[ny * W + nx]) { v = 1; break outer; }
          }
        }
        tmp[y * W + x] = v;
      }
    }

    // Erode tmp → src
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let v = 1;
        const ny0 = Math.max(y - r, y0), ny1 = Math.min(y + r, y1 - 1);
        const nx0 = Math.max(x - r, x0), nx1 = Math.min(x + r, x1 - 1);
        outer: for (let ny = ny0; ny <= ny1; ny++) {
          for (let nx = nx0; nx <= nx1; nx++) {
            if (!tmp[ny * W + nx]) { v = 0; break outer; }
          }
        }
        src[y * W + x] = v;
      }
    }
  }

  _connectedComponents(x0, y0, x1, y1) {
    const W = this._pw;
    const mask = this._mask, labels = this._labels, stack = this._stack;
    labels.fill(0);
    const blobs = [];
    let label = 0;

    for (let sy = y0; sy < y1; sy++) {
      for (let sx = x0; sx < x1; sx++) {
        const startIdx = sy * W + sx;
        if (!mask[startIdx] || labels[startIdx]) continue;

        label++;
        labels[startIdx] = label;
        const blob = { area: 0, x0: sx, y0: sy, x1: sx, y1: sy, sumX: 0, sumY: 0, cx: 0, cy: 0 };

        let top = 0;
        stack[top++] = startIdx;
        while (top > 0) {
          const idx = stack[--top];
          const px = idx % W, py = (idx / W) | 0;

          blob.area++;
          blob.sumX += px; blob.sumY += py;
          if (px < blob.x0) blob.x0 = px;
          if (px > blob.x1) blob.x1 = px;
          if (py < blob.y0) blob.y0 = py;
          if (py > blob.y1) blob.y1 = py;

          if (px + 1 < W) { const n = idx + 1; if (mask[n] && !labels[n]) { labels[n] = label; stack[top++] = n; } }
          if (px - 1 >= 0) { const n = idx - 1; if (mask[n] && !labels[n]) { labels[n] = label; stack[top++] = n; } }
          if (py + 1 < this._ph) { const n = idx + W; if (mask[n] && !labels[n]) { labels[n] = label; stack[top++] = n; } }
          if (py - 1 >= 0) { const n = idx - W; if (mask[n] && !labels[n]) { labels[n] = label; stack[top++] = n; } }
        }

        blob.cx = blob.sumX / blob.area;
        blob.cy = blob.sumY / blob.area;
        blobs.push(blob);
      }
    }
    return blobs;
  }
}
