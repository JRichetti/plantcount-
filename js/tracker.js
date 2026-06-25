/**
 * CentroidTracker — assigns stable IDs to detected blobs across frames so each
 * physical plant is counted once as it crosses the counting line.
 *
 * Same idea as classic "car counting" trackers: match each existing object to
 * the nearest new detection (greedy, within maxDistance), spawn IDs for the
 * unmatched, and retire objects that stay missing for maxDisappeared updates.
 */
class CentroidTracker {
  constructor(maxDistance = 90, maxDisappeared = 14, smoothing = 0.5) {
    this.nextId = 0;
    this.objects = new Map(); // id -> { cx, cy, prevCx, prevCy, box, disappeared, counted, flash, age }
    this.maxDistance = maxDistance;
    this.maxDisappeared = maxDisappeared;
    this.smoothing = smoothing; // EMA weight on the previous position (jitter damping)
  }

  reset() {
    this.nextId = 0;
    this.objects.clear();
  }

  _register(d) {
    this.objects.set(this.nextId++, {
      cx: d.cx, cy: d.cy, prevCx: d.cx, prevCy: d.cy,
      box: d.box, disappeared: 0, counted: false, flash: 0, age: 0,
    });
  }

  /**
   * @param {Array<{cx,cy,box}>} detections
   * @returns {Map} live objects
   */
  update(detections) {
    if (detections.length === 0) {
      for (const obj of this.objects.values()) obj.disappeared++;
      this._cull();
      return this.objects;
    }

    if (this.objects.size === 0) {
      for (const d of detections) this._register(d);
      return this.objects;
    }

    const ids  = [...this.objects.keys()];
    const objs = ids.map(id => this.objects.get(id));

    // All object↔detection distances, matched greedily nearest-first.
    const pairs = [];
    for (let i = 0; i < objs.length; i++) {
      for (let j = 0; j < detections.length; j++) {
        const dist = Math.hypot(objs[i].cx - detections[j].cx, objs[i].cy - detections[j].cy);
        pairs.push({ dist, i, j });
      }
    }
    pairs.sort((a, b) => a.dist - b.dist);

    const usedObj = new Set(), usedDet = new Set();
    for (const p of pairs) {
      if (p.dist > this.maxDistance) break;
      if (usedObj.has(p.i) || usedDet.has(p.j)) continue;
      usedObj.add(p.i); usedDet.add(p.j);
      const obj = objs[p.i], det = detections[p.j];
      const a = this.smoothing;
      obj.prevCx = obj.cx; obj.prevCy = obj.cy;
      // Exponential moving average damps per-frame centroid jitter.
      obj.cx = a * obj.cx + (1 - a) * det.cx;
      obj.cy = a * obj.cy + (1 - a) * det.cy;
      obj.box = det.box;
      obj.disappeared = 0;
      obj.age++;
    }

    for (let i = 0; i < objs.length; i++) {
      if (!usedObj.has(i)) objs[i].disappeared++;
    }
    for (let j = 0; j < detections.length; j++) {
      if (!usedDet.has(j)) this._register(detections[j]);
    }

    this._cull();
    return this.objects;
  }

  _cull() {
    for (const [id, obj] of this.objects) {
      if (obj.disappeared > this.maxDisappeared) this.objects.delete(id);
    }
  }
}
